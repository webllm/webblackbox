import type { RawRecorderEvent } from "@webblackbox/recorder";

import { getChromeApi } from "../shared/chrome-api.js";
import { PORT_NAMES, type ExtensionOutboundMessage } from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.content });

const eventBuffer: RawRecorderEvent[] = [];
const preRecordingBuffer: RawRecorderEvent[] = [];
const mutationBuffer: Array<Record<string, unknown>> = [];
const PRE_RECORDING_BUFFER_MAX = 400;

type ContentSampling = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  snapshotIntervalMs: number;
  screenshotIdleMs: number;
};

const DEFAULT_SAMPLING: ContentSampling = {
  mousemoveHz: 20,
  scrollHz: 15,
  domFlushMs: 100,
  snapshotIntervalMs: 20_000,
  screenshotIdleMs: 8_000
};

let flushTimer = 0;
let recordingActive = false;
let indicator: HTMLDivElement | null = null;
let mutationObserver: MutationObserver | null = null;
let snapshotTimer = 0;
let mutationFlushTimer = 0;
let lastScrollTime = 0;
let lastPointerTime = 0;
let sampling: ContentSampling = { ...DEFAULT_SAMPLING };

if (port) {
  port.onMessage.addListener((message) => {
    handleSwMessage(message as ExtensionOutboundMessage);
  });
}

chromeApi?.runtime?.onMessage.addListener((message) => {
  handleSwMessage(message as ExtensionOutboundMessage);

  if (isMarkerCommand(message)) {
    emitMarker("Keyboard marker");
  }

  return false;
});

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data as {
    source?: string;
    kind?: string;
    rawType?: string;
    payload?: unknown;
    t?: number;
    mono?: number;
    message?: string;
  };

  if (data.source !== "webblackbox-injected") {
    return;
  }

  if (data.kind === "capture-event" && typeof data.rawType === "string") {
    queueRawEvent({
      source: "content",
      rawType: data.rawType,
      tabId: -1,
      sid: "",
      t: typeof data.t === "number" ? data.t : Date.now(),
      mono: typeof data.mono === "number" ? data.mono : monotonicTime(),
      payload: data.payload ?? {}
    });
    return;
  }

  if (data.kind === "marker") {
    emitMarker(typeof data.message === "string" ? data.message : "Marker");
  }
});

installInputAndLifecycleCapture();
installPerformanceCapture();
emitLifecycleEvent("visibilitychange", { state: document.visibilityState });

function installInputAndLifecycleCapture(): void {
  document.addEventListener(
    "click",
    (event) => {
      queueEvent("click", clickPayload(event));
    },
    true
  );

  document.addEventListener(
    "dblclick",
    (event) => {
      queueEvent("dblclick", clickPayload(event));
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        emitMarker("Keyboard marker");
      }

      queueEvent("keydown", {
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target;

      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }

      const isSensitive =
        target.type === "password" ||
        target.type === "email" ||
        target.type === "tel" ||
        target.type === "number";

      queueEvent("input", {
        inputType: target.type,
        length: target.value.length,
        value: isSensitive ? "[MASKED]" : target.value.slice(0, 256),
        target: toTargetPayload(target)
      });
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      queueEvent("input", {
        kind: "change",
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  document.addEventListener(
    "focus",
    (event) => {
      queueEvent("focus", {
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  document.addEventListener(
    "blur",
    (event) => {
      queueEvent("blur", {
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      queueEvent("submit", {
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  document.addEventListener(
    "scroll",
    (event) => {
      const now = performance.now();
      const scrollGapMs = Math.max(16, Math.round(1000 / Math.max(1, sampling.scrollHz)));

      if (now - lastScrollTime < scrollGapMs) {
        return;
      }

      lastScrollTime = now;

      const target = event.target;

      queueEvent("scroll", {
        target: toTargetPayload(target),
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });
    },
    true
  );

  document.addEventListener(
    "pointermove",
    (event) => {
      const now = performance.now();
      const pointerGapMs = Math.max(16, Math.round(1000 / Math.max(1, sampling.mousemoveHz)));

      if (now - lastPointerTime < pointerGapMs) {
        return;
      }

      lastPointerTime = now;

      queueEvent("mousemove", {
        x: event.clientX,
        y: event.clientY,
        target: toTargetPayload(event.target)
      });
    },
    true
  );

  window.addEventListener("resize", () => {
    emitViewportSnapshot("resize");
  });

  window.addEventListener("visibilitychange", () => {
    emitLifecycleEvent("visibilitychange", {
      state: document.visibilityState
    });
  });
}

function installPerformanceCapture(): void {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        queueEvent("longtask", {
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration
        });
      }
    });

    longTaskObserver.observe({ entryTypes: ["longtask"] });
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
          queueEvent(item.rawType, {
            metric: item.type,
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            value: (entry as PerformanceEntry & { value?: number }).value
          });
        }
      });

      observer.observe({ type: item.type, buffered: true });
    } catch {
      void 0;
    }
  }
}

function handleSwMessage(message: ExtensionOutboundMessage): void {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.kind === "sw.recording-status") {
    const wasRecording = recordingActive;
    recordingActive = message.active;
    sampling = sanitizeSamplingConfig(message.sampling);

    if (recordingActive) {
      if (!wasRecording) {
        flushPreRecordingBuffer();
      }

      ensureIndicator(message.sid, message.mode);
      startMutationAndSnapshots();
    } else {
      stopMutationAndSnapshots();
      removeIndicator();
      flushEvents();
    }

    return;
  }

  if (message.kind === "sw.freeze") {
    ensureIndicator(message.sid, "freeze");
  }
}

function startMutationAndSnapshots(): void {
  if (!mutationObserver) {
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        mutationBuffer.push({
          type: record.type,
          target: safeSelector(record.target),
          addedNodes: record.addedNodes.length,
          removedNodes: record.removedNodes.length,
          attributeName: record.attributeName,
          oldValue: typeof record.oldValue === "string" ? record.oldValue.slice(0, 120) : undefined
        });
      }

      scheduleMutationFlush();
    });

    mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: false,
      attributeOldValue: false
    });
  }

  if (snapshotTimer === 0) {
    const snapshotIntervalMs = Math.max(500, Math.round(sampling.snapshotIntervalMs));
    snapshotTimer = window.setInterval(() => {
      emitDomSnapshot("interval");
    }, snapshotIntervalMs);
  }

  emitViewportSnapshot("start");
}

function stopMutationAndSnapshots(): void {
  mutationObserver?.disconnect();
  mutationObserver = null;

  if (snapshotTimer > 0) {
    clearInterval(snapshotTimer);
    snapshotTimer = 0;
  }

  if (mutationFlushTimer > 0) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = 0;
  }

  if (mutationBuffer.length > 0) {
    flushMutationBuffer();
  }
}

function scheduleMutationFlush(): void {
  if (mutationFlushTimer > 0) {
    return;
  }

  mutationFlushTimer = window.setTimeout(
    () => {
      mutationFlushTimer = 0;
      flushMutationBuffer();
    },
    Math.max(25, Math.round(sampling.domFlushMs))
  );
}

function flushMutationBuffer(): void {
  if (mutationBuffer.length === 0) {
    return;
  }

  const records = mutationBuffer.splice(0, mutationBuffer.length);

  queueEvent("mutation", {
    count: records.length,
    records
  });
}

function emitDomSnapshot(reason: string): void {
  const html = document.documentElement.outerHTML;

  queueEvent("snapshot", {
    reason,
    href: location.href,
    title: document.title,
    nodeCount: document.getElementsByTagName("*").length,
    htmlLength: html.length,
    htmlSnippet: html.slice(0, 16_000)
  });
}

function emitViewportSnapshot(reason: string): void {
  queueEvent("resize", {
    reason,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio
  });
}

function emitLifecycleEvent(rawType: string, payload: Record<string, unknown>): void {
  queueEvent(rawType, payload);
}

function emitMarker(message: string): void {
  if (!port) {
    return;
  }

  port.postMessage({
    kind: "content.marker",
    message
  });

  emitDomSnapshot("marker");
}

function queueEvent(rawType: string, payload: Record<string, unknown>): void {
  queueRawEvent({
    source: "content",
    rawType,
    tabId: -1,
    sid: "",
    t: Date.now(),
    mono: monotonicTime(),
    payload
  });
}

function queueRawEvent(event: RawRecorderEvent): void {
  if (!port) {
    return;
  }

  if (!recordingActive) {
    if (shouldBufferBeforeRecording(event)) {
      preRecordingBuffer.push(event);

      if (preRecordingBuffer.length > PRE_RECORDING_BUFFER_MAX) {
        preRecordingBuffer.splice(0, preRecordingBuffer.length - PRE_RECORDING_BUFFER_MAX);
      }
    }

    return;
  }

  eventBuffer.push(event);

  if (flushTimer > 0) {
    return;
  }

  flushTimer = window.setTimeout(() => {
    flushEvents();
  }, 200);
}

function shouldBufferBeforeRecording(event: RawRecorderEvent): boolean {
  if (event.source !== "content") {
    return false;
  }

  return (
    event.rawType === "console" ||
    event.rawType === "pageError" ||
    event.rawType === "unhandledrejection" ||
    event.rawType === "resourceError"
  );
}

function flushPreRecordingBuffer(): void {
  if (!recordingActive || !port || preRecordingBuffer.length === 0) {
    return;
  }

  eventBuffer.push(...preRecordingBuffer.splice(0, preRecordingBuffer.length));

  if (flushTimer > 0) {
    return;
  }

  flushTimer = window.setTimeout(() => {
    flushEvents();
  }, 0);
}

function flushEvents(): void {
  if (!port || eventBuffer.length === 0) {
    return;
  }

  const events = eventBuffer.splice(0, eventBuffer.length);
  port.postMessage({
    kind: "content.events",
    events
  });

  if (flushTimer > 0) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
}

function ensureIndicator(sid?: string, mode?: string): void {
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.setAttribute("data-webblackbox-indicator", "true");
    indicator.style.position = "fixed";
    indicator.style.right = "12px";
    indicator.style.bottom = "12px";
    indicator.style.zIndex = "2147483647";
    indicator.style.padding = "6px 10px";
    indicator.style.borderRadius = "8px";
    indicator.style.background = "rgba(173, 29, 42, 0.92)";
    indicator.style.color = "#fff";
    indicator.style.font = "600 12px/1.2 'IBM Plex Sans', sans-serif";
    indicator.style.boxShadow = "0 6px 20px rgba(0,0,0,0.22)";
    indicator.style.pointerEvents = "none";
    document.documentElement.appendChild(indicator);
  }

  const suffix = sid ? ` ${sid.slice(0, 8)}` : "";
  indicator.textContent = `WebBlackbox REC ${mode ?? "lite"}${suffix}`;
}

function removeIndicator(): void {
  if (!indicator) {
    return;
  }

  indicator.remove();
  indicator = null;
}

function sanitizeSamplingConfig(raw: unknown): ContentSampling {
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

  if (target.id) {
    return `#${target.id}`;
  }

  const classes = [...target.classList].slice(0, 3).join(".");
  const base = target.tagName.toLowerCase();
  return classes ? `${base}.${classes}` : base;
}

function isMarkerCommand(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  return (message as { kind?: unknown }).kind === "sw.marker-command";
}
