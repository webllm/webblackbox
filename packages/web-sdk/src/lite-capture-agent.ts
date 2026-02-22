import type { RawRecorderEvent } from "@webblackbox/recorder";
import html2canvas from "html2canvas-pro";

import type { LiteCaptureAgentOptions, LiteCaptureSampling, LiteCaptureState } from "./types.js";
import { INJECTED_MESSAGE_SOURCE, type InjectedCaptureWindowMessage } from "./injected-hooks.js";

const PRE_RECORDING_BUFFER_MAX = 400;
const SCREENSHOT_MAX_DATA_URL_LENGTH = 10 * 1024 * 1024;
const SCREENSHOT_POINTER_STALE_MS = 2_500;
const SCREENSHOT_ACTION_COOLDOWN_MS = 450;
const SCREENSHOT_MAX_DIMENSION_PX = 1_440;
const SCREENSHOT_MAX_SCALE = 1.5;
const SCREENSHOT_MIN_SCALE = 0.45;
const DOM_SNAPSHOT_MAX_HTML_CHARS = 300_000;
const STORAGE_SNAPSHOT_MAX_ITEMS = 150;
const STORAGE_SNAPSHOT_MAX_VALUE_CHARS = 512;

const DEFAULT_SAMPLING: LiteCaptureSampling = {
  mousemoveHz: 20,
  scrollHz: 15,
  domFlushMs: 100,
  snapshotIntervalMs: 20_000,
  screenshotIdleMs: 8_000
};

const INPUT_OPTIONS_TRUE: AddEventListenerOptions = {
  capture: true
};

export class LiteCaptureAgent {
  private readonly eventBuffer: RawRecorderEvent[] = [];
  private readonly preRecordingBuffer: RawRecorderEvent[] = [];
  private readonly mutationBuffer: Array<Record<string, unknown>> = [];
  private readonly cleanupCallbacks: Array<() => void> = [];

  private recordingActive = false;
  private sid = "";
  private tabId = -1;
  private mode: LiteCaptureState["mode"] = "lite";
  private sampling: LiteCaptureSampling = { ...DEFAULT_SAMPLING };
  private indicator: HTMLDivElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private snapshotTimer = 0;
  private screenshotTimer = 0;
  private mutationFlushTimer = 0;
  private flushTimer = 0;
  private lastScrollTime = 0;
  private lastPointerTime = 0;
  private screenshotInFlight = false;
  private screenshotPendingReason: string | null = null;
  private lastActionScreenshotMono = Number.NEGATIVE_INFINITY;
  private lastPointerState: { x: number; y: number; t: number; mono: number } | null = null;
  private disposed = false;

  public constructor(private readonly options: LiteCaptureAgentOptions) {
    this.installInputAndLifecycleCapture();
    this.installPerformanceCapture();
    this.installInjectedMessageBridge();
    this.emitLifecycleEvent("visibilitychange", { state: document.visibilityState });
  }

  public setRecordingStatus(state: LiteCaptureState): void {
    if (this.disposed) {
      return;
    }

    const wasRecording = this.recordingActive;
    this.recordingActive = state.active;
    this.mode = state.mode ?? this.mode;
    this.sampling = sanitizeSamplingConfig(state.sampling);

    if (typeof state.sid === "string") {
      this.sid = state.sid;
    }

    if (typeof state.tabId === "number" && Number.isFinite(state.tabId)) {
      this.tabId = Math.round(state.tabId);
    }

    if (this.recordingActive) {
      if (!wasRecording) {
        this.flushPreRecordingBuffer();
      }

      this.ensureIndicator(this.sid, this.mode);
      this.startMutationAndSnapshots();
      return;
    }

    this.stopMutationAndSnapshots();
    this.removeIndicator();
    this.flush();
  }

  public emitMarker(message: string): void {
    if (this.disposed) {
      return;
    }

    this.options.onMarker?.(message);
    this.queueEvent("marker", {
      message
    });
    this.emitDomSnapshot("marker");
    this.emitStorageSnapshots("marker");
    this.scheduleScreenshotCapture("marker", true);
  }

  public setIndicatorState(sid?: string, mode?: string): void {
    if (this.disposed) {
      return;
    }

    this.ensureIndicator(sid, mode);
  }

  public flush(): void {
    this.flushEvents();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopMutationAndSnapshots();
    this.removeIndicator();

    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    for (const cleanup of this.cleanupCallbacks.splice(0, this.cleanupCallbacks.length)) {
      cleanup();
    }

    this.eventBuffer.length = 0;
    this.preRecordingBuffer.length = 0;
    this.mutationBuffer.length = 0;
  }

  private installInjectedMessageBridge(): void {
    this.listen(window, "message", (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data as InjectedCaptureWindowMessage | undefined;

      if (!data || data.source !== INJECTED_MESSAGE_SOURCE) {
        return;
      }

      if (data.kind === "capture-event" && typeof data.rawType === "string") {
        this.queueRawEvent({
          source: "content",
          rawType: data.rawType,
          tabId: this.tabId,
          sid: this.sid,
          t: typeof data.t === "number" ? data.t : Date.now(),
          mono: typeof data.mono === "number" ? data.mono : monotonicTime(),
          payload: data.payload ?? {}
        });
        return;
      }

      if (data.kind === "marker") {
        this.emitMarker(typeof data.message === "string" ? data.message : "Marker");
      }
    });
  }

  private installInputAndLifecycleCapture(): void {
    this.listen(
      document,
      "click",
      (event: MouseEvent) => {
        this.trackPointer(event.clientX, event.clientY);
        this.queueEvent("click", clickPayload(event));
        this.scheduleScreenshotCapture("action:click", true);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "dblclick",
      (event: MouseEvent) => {
        this.trackPointer(event.clientX, event.clientY);
        this.queueEvent("dblclick", clickPayload(event));
        this.scheduleScreenshotCapture("action:dblclick", true);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
          this.emitMarker("Keyboard marker");
        }

        this.queueEvent("keydown", {
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          target: toTargetPayload(event.target)
        });

        this.scheduleScreenshotCapture("action:keydown", true);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "input",
      (event: Event) => {
        const target = event.target;

        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          return;
        }

        const isSensitive =
          target.type === "password" ||
          target.type === "email" ||
          target.type === "tel" ||
          target.type === "number";

        this.queueEvent("input", {
          inputType: target.type,
          length: target.value.length,
          value: isSensitive ? "[MASKED]" : target.value.slice(0, 256),
          target: toTargetPayload(target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "change",
      (event: Event) => {
        this.queueEvent("input", {
          kind: "change",
          target: toTargetPayload(event.target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "focus",
      (event: FocusEvent) => {
        this.queueEvent("focus", {
          target: toTargetPayload(event.target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "blur",
      (event: FocusEvent) => {
        this.queueEvent("blur", {
          target: toTargetPayload(event.target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "submit",
      (event: Event) => {
        this.queueEvent("submit", {
          target: toTargetPayload(event.target)
        });
        this.scheduleScreenshotCapture("action:submit", true);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "scroll",
      (event: Event) => {
        const now = performance.now();
        const scrollGapMs = Math.max(16, Math.round(1000 / Math.max(1, this.sampling.scrollHz)));

        if (now - this.lastScrollTime < scrollGapMs) {
          return;
        }

        this.lastScrollTime = now;

        this.queueEvent("scroll", {
          target: toTargetPayload(event.target),
          scrollX: window.scrollX,
          scrollY: window.scrollY
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "pointermove",
      (event: PointerEvent) => {
        this.trackPointer(event.clientX, event.clientY);
        const now = performance.now();
        const pointerGapMs = Math.max(
          16,
          Math.round(1000 / Math.max(1, this.sampling.mousemoveHz))
        );

        if (now - this.lastPointerTime < pointerGapMs) {
          return;
        }

        this.lastPointerTime = now;

        this.queueEvent("mousemove", {
          x: event.clientX,
          y: event.clientY,
          target: toTargetPayload(event.target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(window, "resize", () => {
      this.emitViewportSnapshot("resize");
    });

    this.listen(document, "visibilitychange", () => {
      this.emitLifecycleEvent("visibilitychange", {
        state: document.visibilityState
      });
    });
  }

  private installPerformanceCapture(): void {
    if (typeof PerformanceObserver === "undefined") {
      return;
    }

    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.queueEvent("longtask", {
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration
          });
        }
      });

      longTaskObserver.observe({ entryTypes: ["longtask"] });
      this.cleanupCallbacks.push(() => longTaskObserver.disconnect());
    } catch {
      void 0;
    }

    const vitalTypes: Array<{ type: string; rawType: string }> = [
      { type: "largest-contentful-paint", rawType: "vitals" },
      { type: "layout-shift", rawType: "vitals" },
      { type: "first-input", rawType: "vitals" },
      { type: "event", rawType: "vitals" }
    ];

    for (const item of vitalTypes) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.queueEvent(item.rawType, {
              metric: item.type,
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
              value: (entry as PerformanceEntry & { value?: number }).value
            });
          }
        });

        observer.observe({ type: item.type, buffered: true });
        this.cleanupCallbacks.push(() => observer.disconnect());
      } catch {
        void 0;
      }
    }
  }

  private startMutationAndSnapshots(): void {
    if (!this.mutationObserver) {
      this.mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          this.mutationBuffer.push({
            type: record.type,
            target: safeSelector(record.target),
            addedNodes: record.addedNodes.length,
            removedNodes: record.removedNodes.length,
            attributeName: record.attributeName,
            oldValue:
              typeof record.oldValue === "string" ? record.oldValue.slice(0, 120) : undefined
          });
        }

        this.scheduleMutationFlush();
      });

      this.mutationObserver.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: false,
        attributeOldValue: false
      });
    }

    if (this.snapshotTimer === 0) {
      const snapshotIntervalMs = Math.max(500, Math.round(this.sampling.snapshotIntervalMs));
      this.snapshotTimer = window.setInterval(() => {
        this.emitDomSnapshot("interval");
        this.emitStorageSnapshots("interval");
      }, snapshotIntervalMs);
    }

    if (this.screenshotTimer === 0) {
      const screenshotIntervalMs = Math.max(250, Math.round(this.sampling.screenshotIdleMs));
      this.screenshotTimer = window.setInterval(() => {
        this.scheduleScreenshotCapture("interval");
      }, screenshotIntervalMs);
    }

    this.emitViewportSnapshot("start");
    this.emitDomSnapshot("start");
    this.emitStorageSnapshots("start");
    this.scheduleScreenshotCapture("start", true);
  }

  private stopMutationAndSnapshots(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;

    if (this.snapshotTimer > 0) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = 0;
    }

    if (this.screenshotTimer > 0) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = 0;
    }

    this.screenshotPendingReason = null;

    if (this.mutationFlushTimer > 0) {
      clearTimeout(this.mutationFlushTimer);
      this.mutationFlushTimer = 0;
    }

    if (this.mutationBuffer.length > 0) {
      this.flushMutationBuffer();
    }
  }

  private scheduleMutationFlush(): void {
    if (this.mutationFlushTimer > 0) {
      return;
    }

    this.mutationFlushTimer = window.setTimeout(
      () => {
        this.mutationFlushTimer = 0;
        this.flushMutationBuffer();
      },
      Math.max(25, Math.round(this.sampling.domFlushMs))
    );
  }

  private flushMutationBuffer(): void {
    if (this.mutationBuffer.length === 0) {
      return;
    }

    const records = this.mutationBuffer.splice(0, this.mutationBuffer.length);

    this.queueEvent("mutation", {
      count: records.length,
      records
    });
  }

  private emitDomSnapshot(reason: string): void {
    const html = document.documentElement.outerHTML;
    const truncated = html.length > DOM_SNAPSHOT_MAX_HTML_CHARS;
    const sampledHtml = truncated ? html.slice(0, DOM_SNAPSHOT_MAX_HTML_CHARS) : html;

    this.queueEvent("snapshot", {
      reason,
      href: location.href,
      title: document.title,
      nodeCount: document.getElementsByTagName("*").length,
      htmlLength: html.length,
      truncated,
      html: sampledHtml
    });
  }

  private emitStorageSnapshots(reason: string): void {
    this.emitCookieSnapshot(reason);
    this.emitLocalStorageSnapshot(reason);
    void this.emitIndexedDbSnapshot(reason);
  }

  private emitCookieSnapshot(reason: string): void {
    const cookieNames = document.cookie
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        return separatorIndex > 0 ? entry.slice(0, separatorIndex).trim() : entry;
      })
      .filter((entry) => entry.length > 0)
      .slice(0, STORAGE_SNAPSHOT_MAX_ITEMS);

    this.queueEvent("cookieSnapshot", {
      reason,
      count: cookieNames.length,
      names: cookieNames,
      redacted: true
    });
  }

  private emitLocalStorageSnapshot(reason: string): void {
    const count = localStorage.length;
    const maxItems = Math.min(count, STORAGE_SNAPSHOT_MAX_ITEMS);
    const entries: Record<string, unknown> = {};

    for (let index = 0; index < maxItems; index += 1) {
      const key = localStorage.key(index);

      if (!key) {
        continue;
      }

      const value = localStorage.getItem(key) ?? "";
      entries[key] = {
        length: value.length,
        sample: value.slice(0, STORAGE_SNAPSHOT_MAX_VALUE_CHARS)
      };
    }

    this.queueEvent("localStorageSnapshot", {
      reason,
      count,
      truncated: count > maxItems,
      entries
    });
  }

  private async emitIndexedDbSnapshot(reason: string): Promise<void> {
    if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") {
      return;
    }

    try {
      const rows = await indexedDB.databases();
      const names = rows
        .map((entry) => entry.name)
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .slice(0, STORAGE_SNAPSHOT_MAX_ITEMS);

      this.queueEvent("indexedDbSnapshot", {
        reason,
        count: names.length,
        databaseNames: names,
        truncated: rows.length > names.length
      });
    } catch {
      void 0;
    }
  }

  private emitViewportSnapshot(reason: string): void {
    this.queueEvent("resize", {
      reason,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio
    });
  }

  private emitLifecycleEvent(rawType: string, payload: Record<string, unknown>): void {
    this.queueEvent(rawType, payload);
  }

  private scheduleScreenshotCapture(reason: string, prioritize = false): void {
    if (!this.recordingActive) {
      return;
    }

    const nowMono = monotonicTime();
    const isAction = reason.startsWith("action:");

    if (isAction && nowMono - this.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
      return;
    }

    if (isAction) {
      this.lastActionScreenshotMono = nowMono;
    }

    if (this.screenshotInFlight) {
      if (prioritize || this.screenshotPendingReason === null) {
        this.screenshotPendingReason = reason;
      }

      return;
    }

    this.screenshotInFlight = true;

    void this.captureScreenshot(reason).finally(() => {
      this.screenshotInFlight = false;

      const pending = this.screenshotPendingReason;
      this.screenshotPendingReason = null;

      if (pending) {
        this.scheduleScreenshotCapture(pending);
      }
    });
  }

  private async captureScreenshot(reason: string): Promise<void> {
    if (!this.recordingActive) {
      return;
    }

    const root = document.documentElement;
    const viewportWidth = Math.max(1, Math.round(window.innerWidth));
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const baseScale = Math.max(1, window.devicePixelRatio || 1);
    const dimensionScale = Math.min(
      1,
      SCREENSHOT_MAX_DIMENSION_PX / Math.max(viewportWidth, viewportHeight)
    );
    const scale = Math.max(
      SCREENSHOT_MIN_SCALE,
      Math.min(SCREENSHOT_MAX_SCALE, Number((baseScale * dimensionScale).toFixed(3)))
    );

    const previousIndicatorVisibility = this.indicator?.style.visibility;

    if (this.indicator) {
      this.indicator.style.visibility = "hidden";
    }

    try {
      const canvas = await html2canvas(root, {
        backgroundColor: null,
        useCORS: true,
        allowTaint: false,
        logging: false,
        scale,
        x: window.scrollX,
        y: window.scrollY,
        width: viewportWidth,
        height: viewportHeight,
        windowWidth: Math.max(document.documentElement.scrollWidth, viewportWidth),
        windowHeight: Math.max(document.documentElement.scrollHeight, viewportHeight),
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });

      const webpDataUrl = safeCanvasToDataUrl(canvas, "image/webp", 0.72);
      const pngDataUrl = webpDataUrl ? null : safeCanvasToDataUrl(canvas, "image/png");
      const dataUrl = webpDataUrl ?? pngDataUrl;

      if (!dataUrl || dataUrl.length > SCREENSHOT_MAX_DATA_URL_LENGTH) {
        return;
      }

      this.queueEvent("screenshot", {
        reason,
        dataUrl,
        format: webpDataUrl ? "webp" : "png",
        quality: webpDataUrl ? 72 : undefined,
        w: canvas.width,
        h: canvas.height,
        viewport: {
          width: viewportWidth,
          height: viewportHeight,
          dpr: Number((window.devicePixelRatio || 1).toFixed(3))
        },
        pointer: this.readPointerSnapshot()
      });
    } catch {
      void 0;
    } finally {
      if (this.indicator) {
        this.indicator.style.visibility = previousIndicatorVisibility ?? "";
      }
    }
  }

  private trackPointer(x: number, y: number): void {
    this.lastPointerState = {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      t: Date.now(),
      mono: monotonicTime()
    };
  }

  private readPointerSnapshot(): Record<string, unknown> | undefined {
    if (!this.lastPointerState) {
      return undefined;
    }

    if (Date.now() - this.lastPointerState.t > SCREENSHOT_POINTER_STALE_MS) {
      return undefined;
    }

    return {
      x: this.lastPointerState.x,
      y: this.lastPointerState.y,
      t: this.lastPointerState.t,
      mono: this.lastPointerState.mono
    };
  }

  private queueEvent(rawType: string, payload: Record<string, unknown>): void {
    this.queueRawEvent({
      source: "content",
      rawType,
      tabId: this.tabId,
      sid: this.sid,
      t: Date.now(),
      mono: monotonicTime(),
      payload
    });
  }

  private queueRawEvent(event: RawRecorderEvent): void {
    if (!this.recordingActive) {
      if (shouldBufferBeforeRecording(event)) {
        this.preRecordingBuffer.push(event);

        if (this.preRecordingBuffer.length > PRE_RECORDING_BUFFER_MAX) {
          this.preRecordingBuffer.splice(
            0,
            this.preRecordingBuffer.length - PRE_RECORDING_BUFFER_MAX
          );
        }
      }

      return;
    }

    this.eventBuffer.push(event);

    if (this.flushTimer > 0) {
      return;
    }

    this.flushTimer = window.setTimeout(() => {
      this.flushEvents();
    }, 200);
  }

  private flushPreRecordingBuffer(): void {
    if (!this.recordingActive || this.preRecordingBuffer.length === 0) {
      return;
    }

    this.eventBuffer.push(...this.preRecordingBuffer.splice(0, this.preRecordingBuffer.length));

    if (this.flushTimer > 0) {
      return;
    }

    this.flushTimer = window.setTimeout(() => {
      this.flushEvents();
    }, 0);
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0, this.eventBuffer.length);
    this.options.emitBatch(events);

    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }
  }

  private ensureIndicator(sid?: string, mode?: string): void {
    if (!this.options.showIndicator) {
      return;
    }

    if (!this.indicator) {
      this.indicator = document.createElement("div");
      this.indicator.setAttribute("data-webblackbox-indicator", "true");
      this.indicator.style.position = "fixed";
      this.indicator.style.right = "12px";
      this.indicator.style.bottom = "12px";
      this.indicator.style.zIndex = "2147483647";
      this.indicator.style.padding = "6px 10px";
      this.indicator.style.borderRadius = "8px";
      this.indicator.style.background = "rgba(173, 29, 42, 0.92)";
      this.indicator.style.color = "#fff";
      this.indicator.style.font = "600 12px/1.2 'IBM Plex Sans', sans-serif";
      this.indicator.style.boxShadow = "0 6px 20px rgba(0,0,0,0.22)";
      this.indicator.style.pointerEvents = "none";
      document.documentElement.appendChild(this.indicator);
    }

    const suffix = sid ? ` ${sid.slice(0, 8)}` : "";
    this.indicator.textContent = `WebBlackbox REC ${mode ?? "lite"}${suffix}`;
  }

  private removeIndicator(): void {
    if (!this.indicator) {
      return;
    }

    this.indicator.remove();
    this.indicator = null;
  }

  private listen<TEvent extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: TEvent) => void,
    options?: AddEventListenerOptions
  ): void {
    const wrapped: EventListener = (event) => {
      listener(event as TEvent);
    };

    target.addEventListener(type, wrapped, options);
    this.cleanupCallbacks.push(() => {
      target.removeEventListener(type, wrapped, options);
    });
  }
}

function sanitizeSamplingConfig(raw: unknown): LiteCaptureSampling {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SAMPLING };
  }

  const row = raw as Record<string, unknown>;

  return {
    mousemoveHz: clampRate(row.mousemoveHz, DEFAULT_SAMPLING.mousemoveHz),
    scrollHz: clampRate(row.scrollHz, DEFAULT_SAMPLING.scrollHz),
    domFlushMs: clampInterval(row.domFlushMs, DEFAULT_SAMPLING.domFlushMs),
    snapshotIntervalMs: clampInterval(row.snapshotIntervalMs, DEFAULT_SAMPLING.snapshotIntervalMs),
    screenshotIdleMs: clampInterval(row.screenshotIdleMs, DEFAULT_SAMPLING.screenshotIdleMs)
  };
}

function clampRate(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 1, 240);
}

function clampInterval(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 25, 120_000);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function monotonicTime(): number {
  return performance.timeOrigin + performance.now();
}

function clickPayload(event: MouseEvent): Record<string, unknown> {
  return {
    x: event.clientX,
    y: event.clientY,
    button: event.button,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    target: toTargetPayload(event.target)
  };
}

function toTargetPayload(target: EventTarget | null): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return {};
  }

  return {
    selector: safeSelector(target),
    tag: target.tagName,
    id: target.id || undefined,
    className: target.className || undefined,
    text: target.textContent?.trim().slice(0, 80)
  };
}

function safeSelector(target: EventTarget | null): string {
  if (!(target instanceof Element)) {
    return "unknown";
  }

  const segments: string[] = [];
  let current: Element | null = target;

  while (current && segments.length < 5) {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      segment += `#${cssEscape(current.id)}`;
      segments.unshift(segment);
      break;
    }

    const classNames = [...current.classList].slice(0, 2);

    if (classNames.length > 0) {
      segment += classNames.map((name) => `.${cssEscape(name)}`).join("");
    }

    const parent: Element | null = current.parentElement;

    if (parent) {
      const siblings = [...parent.children].filter((entry) => entry.tagName === current?.tagName);

      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }

    segments.unshift(segment);
    current = parent;
  }

  return segments.join(" > ");
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeCanvasToDataUrl(
  canvas: HTMLCanvasElement,
  format: string,
  quality?: number
): string | null {
  try {
    return typeof quality === "number"
      ? canvas.toDataURL(format, quality)
      : canvas.toDataURL(format);
  } catch {
    return null;
  }
}

function shouldBufferBeforeRecording(event: RawRecorderEvent): boolean {
  if (event.source !== "content") {
    return false;
  }

  return (
    event.rawType === "console" ||
    event.rawType === "fetch" ||
    event.rawType === "xhr" ||
    event.rawType === "networkBody" ||
    event.rawType === "fetchError" ||
    event.rawType === "pageError" ||
    event.rawType === "unhandledrejection" ||
    event.rawType === "resourceError"
  );
}

export { DEFAULT_SAMPLING as DEFAULT_LITE_CAPTURE_SAMPLING };
