import type { RawRecorderEvent } from "@webblackbox/recorder";
import { snapdom } from "@zumer/snapdom";

import type { LiteCaptureAgentOptions, LiteCaptureSampling, LiteCaptureState } from "./types.js";
import { INJECTED_MESSAGE_SOURCE, type InjectedCaptureWindowMessage } from "./injected-hooks.js";

const PRE_RECORDING_BUFFER_MAX = 400;
const SCREENSHOT_MAX_DATA_URL_LENGTH = 10 * 1024 * 1024;
const SCREENSHOT_POINTER_STALE_MS = 2_500;
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const BACKGROUND_CAPTURE_IDLE_MS = 1_500;
const START_CAPTURE_STORAGE_DELAY_MS = 400;
const START_CAPTURE_SCREENSHOT_DELAY_MS = 1_000;
const SCROLL_BURST_DEBOUNCE_MS = 140;
const POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS = 220;
const MUTATION_PRESSURE_RECORD_LIMIT = 220;
const MUTATION_PRESSURE_BUFFER_LIMIT = 280;
const MUTATION_PRESSURE_SUMMARY_LIMIT = 320;
const MUTATION_PRESSURE_SAMPLE_LIMIT = 80;
const MUTATION_PRESSURE_COOLDOWN_MS = 2_500;
const MUTATION_PRESSURE_FLUSH_MS = 300;
const INPUT_PRESSURE_BURST_WINDOW_MS = 900;
const INPUT_PRESSURE_BURST_COUNT = 6;
const INPUT_PRESSURE_COOLDOWN_MS = 1_800;
const INPUT_PRESSURE_EDITOR_COOLDOWN_MS = 2_400;
const INPUT_PRESSURE_MUTATION_SAMPLE_LIMIT = 16;
const QUIET_MODE_MUTATION_RECORD_LIMIT = 360;
const QUIET_MODE_EVENT_BUFFER_LIMIT = 560;
const QUIET_MODE_COOLDOWN_MS = 3_000;
const QUIET_MODE_EDITOR_COOLDOWN_MS = 4_200;
const SCREENSHOT_MAX_DIMENSION_PX = 1_200;
const SCREENSHOT_MAX_SCALE = 1.5;
const SCREENSHOT_MIN_SCALE = 0.45;
const SCREENSHOT_WEBP_QUALITY = 0.66;
const DOM_SNAPSHOT_MAX_HTML_CHARS = 300_000;
const DOM_SNAPSHOT_SUMMARY_NODE_THRESHOLD = 3_500;
const STORAGE_SNAPSHOT_MAX_ITEMS = 150;
const STORAGE_SNAPSHOT_MAX_VALUE_CHARS = 512;
const START_CAPTURE_DEFER_MS = 2_000;
const ACTION_CAPTURE_DEFER_MS = 0;
const EVENT_BUFFER_FLUSH_DELAY_MS = 180;
const EVENT_BUFFER_FORCE_FLUSH_SIZE = 120;
const EVENT_BUFFER_EMIT_CHUNK_SIZE = 80;
const EVENT_BUFFER_SOFT_LIMIT = 420;
const EVENT_BUFFER_HARD_LIMIT = 1_200;
const MUTATION_DETAIL_RECORD_LIMIT = 160;
const MUTATION_DETAIL_BUFFER_LIMIT = 240;
const MUTATION_SAMPLE_TARGETS_MAX = 24;
const MUTATION_SAMPLE_ATTRIBUTES_MAX = 16;
const SELECTOR_CACHE_MAX = 1_500;
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const OBSERVED_MUTATION_ATTRIBUTES = [
  "hidden",
  "open",
  "disabled",
  "checked",
  "selected",
  "aria-expanded",
  "aria-hidden",
  "aria-pressed",
  "aria-selected",
  "aria-current",
  "aria-busy",
  "href",
  "src"
];

const LOW_PRIORITY_RAW_TYPES = new Set([
  "mousemove",
  "scroll",
  "mutation",
  "rrweb",
  "vitals",
  "longtask",
  "snapshot",
  "screenshot"
]);

const FULL_MODE_SKIPPED_RAW_TYPES = new Set([
  "mousemove",
  "scroll",
  "mutation",
  "vitals",
  "longtask",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
]);

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

type MutationBatchSummary = {
  count: number;
  sampledCount: number;
  truncated: boolean;
  childListCount: number;
  attributeCount: number;
  characterDataCount: number;
  addedNodes: number;
  removedNodes: number;
  sampleTargets: string[];
  attributeNames: string[];
};

type TargetPayloadDetail = "action" | "input" | "fast";

/**
 * Browser-side event capture agent used by `WebBlackboxLiteSdk`.
 * It collects DOM/input/network/error/perf signals and emits buffered raw events.
 */
export class LiteCaptureAgent {
  private readonly eventBuffer: RawRecorderEvent[] = [];
  private readonly preRecordingBuffer: RawRecorderEvent[] = [];
  private readonly cleanupCallbacks: Array<() => void> = [];
  private readonly frameMarker = resolveContentFrameMarker();

  private recordingActive = false;
  private sid = "";
  private tabId = -1;
  private mode: LiteCaptureState["mode"] = "lite";
  private sampling: LiteCaptureSampling = { ...DEFAULT_SAMPLING };
  private indicator: HTMLDivElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private snapshotTimer = 0;
  private screenshotTimer = 0;
  private startCaptureTimer = 0;
  private backgroundCaptureRetryTimer = 0;
  private quietModeRecoveryTimer = 0;
  private deferredActionCaptureTimer = 0;
  private deferredStartTaskTimers: number[] = [];
  private trailingScrollTimer = 0;
  private mutationFlushTimer = 0;
  private flushTimer = 0;
  private lastScrollTime = 0;
  private lastPointerTime = 0;
  private screenshotInFlight = false;
  private screenshotPendingReason: string | null = null;
  private lastActionScreenshotMono = Number.NEGATIVE_INFINITY;
  private lastUserActivityMono = monotonicTime();
  private scrollBurstActiveUntilMono = Number.NEGATIVE_INFINITY;
  private mutationPressureUntilMono = Number.NEGATIVE_INFINITY;
  private inputPressureUntilMono = Number.NEGATIVE_INFINITY;
  private editorPressureUntilMono = Number.NEGATIVE_INFINITY;
  private quietModeUntilMono = Number.NEGATIVE_INFINITY;
  private recentEditableInteractionMonos: number[] = [];
  private lastPointerState: { x: number; y: number; t: number; mono: number } | null = null;
  private pendingScrollPayload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  } | null = null;
  private lastEmittedScrollPosition: { scrollX: number; scrollY: number } | null = null;
  private hasDomSnapshot = false;
  private hasLocalStorageSnapshot = false;
  private mutationSummary: MutationBatchSummary = createEmptyMutationSummary();
  private selectorCache = new WeakMap<Element, string>();
  private selectorCacheSize = 0;
  private droppedLowPriorityEvents = 0;
  private disposed = false;
  private pendingQuietRecoverySummary = false;

  /** Creates and installs capture hooks for the current page context. */
  public constructor(private readonly options: LiteCaptureAgentOptions) {
    this.installInputAndLifecycleCapture();
    this.installPerformanceCapture();
    this.installInjectedMessageBridge();
    this.emitLifecycleEvent("visibilitychange", { state: document.visibilityState });
  }

  /** Updates recording state and sampling profile from the host SDK. */
  public setRecordingStatus(state: LiteCaptureState): void {
    if (this.disposed) {
      return;
    }

    const wasRecording = this.recordingActive;

    if (state.active && !wasRecording) {
      this.hasDomSnapshot = false;
      this.hasLocalStorageSnapshot = false;
    }

    if (!state.active && wasRecording && this.shouldCaptureDomSnapshots() && !this.hasDomSnapshot) {
      this.emitDomSnapshot("stop");
    }

    if (
      !state.active &&
      wasRecording &&
      this.shouldCaptureStorageSnapshots() &&
      !this.hasLocalStorageSnapshot
    ) {
      this.emitLocalStorageSnapshot("stop");
    }

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

  /** Emits a manual marker event and optional snapshot/screenshot side effects. */
  public emitMarker(message: string): void {
    if (this.disposed) {
      return;
    }

    this.options.onMarker?.(message);
    this.queueEvent("marker", {
      message
    });

    if (this.shouldCaptureDomSnapshots()) {
      this.emitDomSnapshot("marker");
    }

    if (this.shouldCaptureStorageSnapshots()) {
      this.emitStorageSnapshots("marker");
    }

    if (this.shouldCaptureScreenshots()) {
      this.scheduleScreenshotCapture("marker", true);
    }
  }

  /** Forces indicator rendering state regardless of capture state. */
  public setIndicatorState(sid?: string, mode?: string): void {
    if (this.disposed) {
      return;
    }

    this.ensureIndicator(sid, mode);
  }

  /** Flushes the current buffered raw events immediately. */
  public flush(): void {
    this.flushPendingScrollEvent();
    this.drainBufferedEvents();
  }

  /** Tears down listeners/timers and releases all internal buffers. */
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
    this.mutationSummary = createEmptyMutationSummary();
    this.selectorCache = new WeakMap<Element, string>();
    this.selectorCacheSize = 0;
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
        this.queueInjectedRawEvent(data);
        return;
      }

      if (data.kind === "capture-events" && Array.isArray(data.events)) {
        for (const item of data.events) {
          if (item && typeof item.rawType === "string") {
            this.queueInjectedRawEvent(item);
          }
        }

        return;
      }

      if (data.kind === "marker") {
        this.emitMarker(typeof data.message === "string" ? data.message : "Marker");
      }
    });
  }

  private queueInjectedRawEvent(event: {
    rawType: string;
    payload?: Record<string, unknown>;
    t?: number;
    mono?: number;
  }): void {
    this.queueRawEvent({
      source: "content",
      rawType: event.rawType,
      tabId: this.tabId,
      sid: this.sid,
      t: typeof event.t === "number" ? event.t : Date.now(),
      mono: typeof event.mono === "number" ? event.mono : monotonicTime(),
      payload: event.payload ?? {}
    });
  }

  private installInputAndLifecycleCapture(): void {
    this.listen(
      document,
      "click",
      (event: MouseEvent) => {
        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);
        this.queueEvent("click", this.createClickPayload(event));
        this.scheduleDeferredActionCapture("action:click");
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "dblclick",
      (event: MouseEvent) => {
        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);
        this.queueEvent("dblclick", this.createClickPayload(event));
        this.scheduleDeferredActionCapture("action:dblclick");
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        this.markUserActivity();
        this.recordEditableInteraction(event.target);
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
          target: this.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "input",
      (event: Event) => {
        this.markUserActivity();
        const target = event.target;

        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          return;
        }

        this.recordEditableInteraction(target);

        const isSensitive =
          target.type === "password" ||
          target.type === "email" ||
          target.type === "tel" ||
          target.type === "number";

        this.queueEvent("input", {
          inputType: target.type,
          length: target.value.length,
          value: isSensitive ? "[MASKED]" : target.value.slice(0, 256),
          target: this.resolveTargetPayload(target, "input")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "change",
      (event: Event) => {
        this.markUserActivity();
        this.recordEditableInteraction(event.target);
        this.queueEvent("input", {
          kind: "change",
          target: this.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "focus",
      (event: FocusEvent) => {
        this.markUserActivity();
        this.queueEvent("focus", {
          target: this.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "blur",
      (event: FocusEvent) => {
        this.markUserActivity();
        this.queueEvent("blur", {
          target: this.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "submit",
      (event: Event) => {
        this.markUserActivity();
        this.queueEvent("submit", {
          target: this.resolveTargetPayload(event.target, "fast")
        });
        this.scheduleDeferredActionCapture("action:submit");
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "scroll",
      (event: Event) => {
        this.markUserActivity();
        if (this.mode === "full") {
          return;
        }

        const now = performance.now();
        const scrollGapMs = Math.max(16, Math.round(1000 / Math.max(1, this.sampling.scrollHz)));

        if (now - this.lastScrollTime < scrollGapMs) {
          this.queueTrailingScrollEvent(event);
          return;
        }

        this.lastScrollTime = now;
        this.scrollBurstActiveUntilMono =
          monotonicTime() + Math.max(POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS, scrollGapMs);

        const payload = {
          target: toFastTargetPayload(event.target),
          scrollX: window.scrollX,
          scrollY: window.scrollY
        };

        this.pendingScrollPayload = payload;
        this.emitQueuedScrollEvent(payload);
        this.scheduleTrailingScrollFlush(scrollGapMs);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "pointermove",
      (event: PointerEvent) => {
        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);

        if (this.mode === "full") {
          return;
        }

        if (this.shouldSuppressPointerMoveCapture()) {
          return;
        }

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
          target: toFastTargetPayload(event.target)
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(window, "resize", () => {
      this.markUserActivity();
      this.emitViewportSnapshot("resize");
    });

    this.listen(document, "visibilitychange", () => {
      this.markUserActivity();
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
        if (this.mode === "full") {
          return;
        }

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
      { type: "first-input", rawType: "vitals" }
    ];

    for (const item of vitalTypes) {
      try {
        const observer = new PerformanceObserver((list) => {
          if (this.mode === "full") {
            return;
          }

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

  private accumulateMutationRecord(record: MutationRecord, includeDetails: boolean): void {
    this.mutationSummary.count += 1;
    this.mutationSummary.sampledCount += 1;
    this.mutationSummary.addedNodes += record.addedNodes.length;
    this.mutationSummary.removedNodes += record.removedNodes.length;

    if (record.type === "childList") {
      this.mutationSummary.childListCount += 1;
    } else if (record.type === "attributes") {
      this.mutationSummary.attributeCount += 1;
    } else if (record.type === "characterData") {
      this.mutationSummary.characterDataCount += 1;
    }

    if (!includeDetails) {
      return;
    }

    if (record.type === "attributes" && record.attributeName) {
      const names = this.mutationSummary.attributeNames;

      if (names.length < MUTATION_SAMPLE_ATTRIBUTES_MAX && !names.includes(record.attributeName)) {
        names.push(record.attributeName);
      }
    }

    const sampleTargets = this.mutationSummary.sampleTargets;

    if (sampleTargets.length >= MUTATION_SAMPLE_TARGETS_MAX) {
      return;
    }

    const selector = this.readCachedSelector(record.target);

    if (!sampleTargets.includes(selector)) {
      sampleTargets.push(selector);
    }
  }

  private accumulateMutationRecords(records: MutationRecord[]): void {
    if (records.length === 0) {
      return;
    }

    const shouldEnterPressure =
      records.length >= MUTATION_PRESSURE_RECORD_LIMIT ||
      this.eventBuffer.length >= MUTATION_PRESSURE_BUFFER_LIMIT ||
      this.mutationSummary.count >= MUTATION_PRESSURE_SUMMARY_LIMIT;

    if (shouldEnterPressure) {
      this.extendMutationPressureWindow();
    }

    const inputPressureActive = this.isInputPressureActive();
    const pressureActive = this.isMutationPressureActive() || inputPressureActive;
    const includeDetails =
      !pressureActive &&
      records.length <= MUTATION_DETAIL_RECORD_LIMIT &&
      this.eventBuffer.length <= MUTATION_DETAIL_BUFFER_LIMIT;
    const sampleLimit = inputPressureActive
      ? INPUT_PRESSURE_MUTATION_SAMPLE_LIMIT
      : pressureActive
        ? MUTATION_PRESSURE_SAMPLE_LIMIT
        : records.length;
    const sampledCount = Math.min(records.length, sampleLimit);

    for (let index = 0; index < sampledCount; index += 1) {
      this.accumulateMutationRecord(records[index]!, includeDetails);
    }

    if (sampledCount < records.length) {
      this.mutationSummary.count += records.length - sampledCount;
      this.mutationSummary.truncated = true;
    }
  }

  private readCachedSelector(target: EventTarget | null): string {
    if (!(target instanceof Element)) {
      return "unknown";
    }

    const cached = this.selectorCache.get(target);

    if (cached) {
      return cached;
    }

    if (this.selectorCacheSize >= SELECTOR_CACHE_MAX) {
      this.selectorCache = new WeakMap<Element, string>();
      this.selectorCacheSize = 0;
    }

    const selector = safeSelector(target);
    this.selectorCache.set(target, selector);
    this.selectorCacheSize += 1;

    return selector;
  }

  private shouldCaptureScreenshots(): boolean {
    return this.mode !== "full" && this.sampling.screenshotIdleMs > 0;
  }

  private shouldCaptureMutationSignals(): boolean {
    return this.mode !== "full";
  }

  private shouldCaptureDomSnapshots(): boolean {
    return this.mode !== "full";
  }

  private shouldCaptureStorageSnapshots(): boolean {
    return this.mode !== "full";
  }

  private startMutationAndSnapshots(): void {
    if (this.shouldCaptureMutationSignals() && !this.mutationObserver) {
      this.ensureMutationObserverActive();
    }

    if (
      this.snapshotTimer === 0 &&
      (this.shouldCaptureDomSnapshots() || this.shouldCaptureStorageSnapshots())
    ) {
      const snapshotIntervalMs = Math.max(500, Math.round(this.sampling.snapshotIntervalMs));
      this.snapshotTimer = window.setInterval(() => {
        if (this.shouldDeferBackgroundCapture()) {
          return;
        }

        if (this.shouldCaptureDomSnapshots()) {
          this.emitDomSnapshot("interval");
        }

        if (this.shouldCaptureStorageSnapshots()) {
          this.emitStorageSnapshots("interval");
        }
      }, snapshotIntervalMs);
    }

    if (this.screenshotTimer === 0 && this.shouldCaptureScreenshots()) {
      const screenshotIntervalMs = Math.max(250, Math.round(this.sampling.screenshotIdleMs));
      this.screenshotTimer = window.setInterval(() => {
        this.scheduleScreenshotCapture("interval");
      }, screenshotIntervalMs);
    }

    this.emitViewportSnapshot("start");
    this.scheduleDeferredStartCapture();
  }

  private stopMutationAndSnapshots(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.pendingQuietRecoverySummary = false;
    this.quietModeUntilMono = Number.NEGATIVE_INFINITY;
    this.editorPressureUntilMono = Number.NEGATIVE_INFINITY;
    this.inputPressureUntilMono = Number.NEGATIVE_INFINITY;
    this.recentEditableInteractionMonos = [];

    if (this.snapshotTimer > 0) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = 0;
    }

    if (this.screenshotTimer > 0) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = 0;
    }

    if (this.startCaptureTimer > 0) {
      clearTimeout(this.startCaptureTimer);
      this.startCaptureTimer = 0;
    }

    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
      this.trailingScrollTimer = 0;
    }

    if (this.backgroundCaptureRetryTimer > 0) {
      clearTimeout(this.backgroundCaptureRetryTimer);
      this.backgroundCaptureRetryTimer = 0;
    }

    if (this.quietModeRecoveryTimer > 0) {
      clearTimeout(this.quietModeRecoveryTimer);
      this.quietModeRecoveryTimer = 0;
    }

    if (this.deferredActionCaptureTimer > 0) {
      clearTimeout(this.deferredActionCaptureTimer);
      this.deferredActionCaptureTimer = 0;
    }

    for (const timerId of this.deferredStartTaskTimers.splice(
      0,
      this.deferredStartTaskTimers.length
    )) {
      clearTimeout(timerId);
    }

    this.screenshotPendingReason = null;

    if (this.mutationFlushTimer > 0) {
      clearTimeout(this.mutationFlushTimer);
      this.mutationFlushTimer = 0;
    }

    if (this.mutationSummary.count > 0) {
      this.flushMutationBuffer();
    }

    this.flushPendingScrollEvent();
  }

  private scheduleMutationFlush(): void {
    if (this.mutationFlushTimer > 0) {
      return;
    }

    const flushDelayMs = this.resolveMutationFlushDelay();

    this.mutationFlushTimer = window.setTimeout(() => {
      this.mutationFlushTimer = 0;

      if (this.shouldHoldMutationFlush()) {
        this.scheduleMutationFlush();
        return;
      }

      this.flushMutationBuffer();
    }, flushDelayMs);
  }

  private flushMutationBuffer(): void {
    if (this.mutationSummary.count === 0) {
      return;
    }

    const summary = this.mutationSummary;
    this.mutationSummary = createEmptyMutationSummary();

    this.queueEvent("mutation", {
      count: summary.count,
      summary
    });
    this.emitRrwebMutationSummary(summary);
  }

  private emitRrwebMutationSummary(summary: MutationBatchSummary): void {
    this.queueEvent("rrweb", {
      schema: "rrweb-lite/v1",
      event: {
        type: "incremental-snapshot",
        source: "mutation-summary",
        timestamp: Date.now(),
        data: {
          count: summary.count,
          sampledCount: summary.sampledCount,
          truncated: summary.truncated,
          childListCount: summary.childListCount,
          attributeCount: summary.attributeCount,
          characterDataCount: summary.characterDataCount,
          addedNodes: summary.addedNodes,
          removedNodes: summary.removedNodes,
          sampleTargets: [...summary.sampleTargets],
          attributeNames: [...summary.attributeNames]
        }
      },
      href: location.href,
      title: document.title
    });
  }

  private emitDomSnapshot(reason: string): void {
    const nodeCount = document.getElementsByTagName("*").length;
    const summaryMode = this.resolveDomSnapshotSummaryMode(nodeCount);
    const html = summaryMode
      ? buildDomSnapshotSummaryHtml({
          href: location.href,
          title: document.title,
          reason,
          nodeCount,
          summaryMode,
          capturedAtIso: new Date().toISOString()
        })
      : document.documentElement.outerHTML;
    const truncated = summaryMode !== null || html.length > DOM_SNAPSHOT_MAX_HTML_CHARS;
    const sampledHtml = truncated ? html.slice(0, DOM_SNAPSHOT_MAX_HTML_CHARS) : html;

    this.hasDomSnapshot = true;

    this.queueEvent("snapshot", {
      reason,
      href: location.href,
      title: document.title,
      nodeCount,
      htmlLength: html.length,
      truncated,
      html: sampledHtml,
      summaryOnly: summaryMode !== null,
      summaryMode: summaryMode ?? undefined
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

    this.hasLocalStorageSnapshot = true;

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

  private scheduleDeferredStartCapture(delayMs = START_CAPTURE_DEFER_MS): void {
    if (this.startCaptureTimer > 0) {
      clearTimeout(this.startCaptureTimer);
      this.startCaptureTimer = 0;
    }

    if (
      !this.shouldCaptureDomSnapshots() &&
      !this.shouldCaptureStorageSnapshots() &&
      !this.shouldCaptureScreenshots()
    ) {
      return;
    }

    this.startCaptureTimer = window.setTimeout(
      () => {
        this.startCaptureTimer = 0;

        if (!this.recordingActive) {
          return;
        }

        if (this.shouldDeferBackgroundCapture()) {
          this.scheduleDeferredStartCapture(BACKGROUND_CAPTURE_IDLE_MS);
          return;
        }

        if (this.shouldCaptureDomSnapshots()) {
          this.scheduleDeferredStartTask(() => {
            this.emitDomSnapshot("start");
          }, 0);
        }

        if (this.shouldCaptureStorageSnapshots()) {
          this.scheduleDeferredStartTask(() => {
            this.emitStorageSnapshots("start");
          }, START_CAPTURE_STORAGE_DELAY_MS);
        }

        if (this.shouldCaptureScreenshots()) {
          this.scheduleDeferredStartTask(() => {
            this.scheduleScreenshotCapture("start");
          }, START_CAPTURE_SCREENSHOT_DELAY_MS);
        }
      },
      Math.max(0, delayMs)
    );
  }

  private scheduleDeferredStartTask(task: () => void, delayMs: number): void {
    const timerId = window.setTimeout(
      () => {
        this.deferredStartTaskTimers = this.deferredStartTaskTimers.filter(
          (entry) => entry !== timerId
        );

        if (!this.recordingActive || this.shouldDeferBackgroundCapture()) {
          return;
        }

        task();
      },
      Math.max(0, delayMs)
    );

    this.deferredStartTaskTimers.push(timerId);
  }

  private scheduleDeferredActionCapture(reason: string): void {
    if (!this.recordingActive || !this.shouldCaptureScreenshots()) {
      return;
    }

    if (this.deferredActionCaptureTimer > 0) {
      clearTimeout(this.deferredActionCaptureTimer);
    }

    this.deferredActionCaptureTimer = window.setTimeout(() => {
      this.deferredActionCaptureTimer = 0;
      this.scheduleScreenshotCapture(reason, true);
    }, ACTION_CAPTURE_DEFER_MS);
  }

  private scheduleScreenshotCapture(reason: string, prioritize = false): void {
    if (!this.recordingActive || !this.shouldCaptureScreenshots()) {
      return;
    }

    const isAction = reason.startsWith("action:");

    if (!prioritize && !isAction && this.shouldDeferBackgroundCapture()) {
      this.setPendingScreenshotReason(reason);
      this.scheduleBackgroundCaptureRetry();
      return;
    }

    const nowMono = monotonicTime();

    if (isAction && nowMono - this.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
      return;
    }

    if (isAction) {
      this.lastActionScreenshotMono = nowMono;
    }

    if (this.screenshotInFlight) {
      this.setPendingScreenshotReason(reason, prioritize);

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
    if (!this.recordingActive || !this.shouldCaptureScreenshots()) {
      return;
    }

    const root = document.documentElement;
    const viewportWidth = Math.max(1, Math.round(window.innerWidth));
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const scale = computeScreenshotScale(
      viewportWidth,
      viewportHeight,
      window.devicePixelRatio || 1
    );
    const captureWidth = Math.max(1, Math.round(viewportWidth * scale));
    const captureHeight = Math.max(1, Math.round(viewportHeight * scale));
    const snapdomCaptureOptions = createSnapdomCaptureOptions(scale);

    const previousIndicatorVisibility = this.indicator?.style.visibility;

    if (this.indicator) {
      this.indicator.style.visibility = "hidden";
    }

    try {
      const screenshot = await captureSnapdomDataUrl(root, snapdomCaptureOptions, {
        width: captureWidth,
        height: captureHeight
      });

      if (
        !screenshot ||
        typeof screenshot.dataUrl !== "string" ||
        screenshot.dataUrl.length > SCREENSHOT_MAX_DATA_URL_LENGTH
      ) {
        return;
      }

      this.queueEvent("screenshot", {
        reason,
        dataUrl: screenshot.dataUrl,
        format: screenshot.format,
        quality: screenshot.quality,
        w: captureWidth,
        h: captureHeight,
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

  private markUserActivity(): void {
    this.lastUserActivityMono = monotonicTime();
  }

  private recordEditableInteraction(target: EventTarget | null): void {
    if (!isEditableInteractionTarget(target)) {
      return;
    }

    const nowMono = monotonicTime();
    this.recentEditableInteractionMonos = this.recentEditableInteractionMonos.filter(
      (entry) => nowMono - entry <= INPUT_PRESSURE_BURST_WINDOW_MS
    );
    this.recentEditableInteractionMonos.push(nowMono);

    const richTextTarget = isRichTextEditableTarget(target);
    const duration = richTextTarget
      ? INPUT_PRESSURE_EDITOR_COOLDOWN_MS
      : this.recentEditableInteractionMonos.length >= INPUT_PRESSURE_BURST_COUNT
        ? INPUT_PRESSURE_COOLDOWN_MS
        : 0;

    if (duration <= 0) {
      return;
    }

    this.inputPressureUntilMono = Math.max(this.inputPressureUntilMono, nowMono + duration);

    if (richTextTarget) {
      this.editorPressureUntilMono = Math.max(
        this.editorPressureUntilMono,
        nowMono + INPUT_PRESSURE_EDITOR_COOLDOWN_MS
      );
    }
  }

  private queueTrailingScrollEvent(event: Event): void {
    this.pendingScrollPayload = {
      target: toFastTargetPayload(event.target),
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
    this.scrollBurstActiveUntilMono = monotonicTime() + POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS;
    this.scheduleTrailingScrollFlush(SCROLL_BURST_DEBOUNCE_MS);
  }

  private scheduleTrailingScrollFlush(delayMs: number): void {
    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
    }

    this.trailingScrollTimer = window.setTimeout(
      () => {
        this.trailingScrollTimer = 0;
        this.flushPendingScrollEvent();
      },
      Math.max(SCROLL_BURST_DEBOUNCE_MS, delayMs)
    );
  }

  private flushPendingScrollEvent(): void {
    const pending = this.pendingScrollPayload;

    if (!pending) {
      return;
    }

    this.pendingScrollPayload = null;

    if (
      this.lastEmittedScrollPosition &&
      this.lastEmittedScrollPosition.scrollX === pending.scrollX &&
      this.lastEmittedScrollPosition.scrollY === pending.scrollY
    ) {
      return;
    }

    this.emitQueuedScrollEvent(pending);
  }

  private emitQueuedScrollEvent(payload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  }): void {
    this.lastEmittedScrollPosition = {
      scrollX: payload.scrollX,
      scrollY: payload.scrollY
    };

    this.queueEvent("scroll", payload);
  }

  private isScrollBurstActive(): boolean {
    return monotonicTime() < this.scrollBurstActiveUntilMono;
  }

  private isUserRecentlyActive(idleMs = BACKGROUND_CAPTURE_IDLE_MS): boolean {
    return monotonicTime() - this.lastUserActivityMono < idleMs;
  }

  private resolveMutationFlushDelay(): number {
    if (!this.isMutationPressureActive()) {
      return Math.max(25, Math.round(this.sampling.domFlushMs));
    }

    const remainingPressureMs = Math.max(
      0,
      Math.ceil(this.mutationPressureUntilMono - monotonicTime())
    );

    return Math.max(
      Math.max(Math.round(this.sampling.domFlushMs), MUTATION_PRESSURE_FLUSH_MS),
      remainingPressureMs
    );
  }

  private shouldHoldMutationFlush(): boolean {
    return (
      this.recordingActive &&
      this.mutationSummary.count > 0 &&
      (this.isMutationPressureActive() || this.isInputPressureActive() || this.isQuietModeActive())
    );
  }

  private extendMutationPressureWindow(): void {
    this.mutationPressureUntilMono = monotonicTime() + MUTATION_PRESSURE_COOLDOWN_MS;
  }

  private isMutationPressureActive(): boolean {
    return monotonicTime() < this.mutationPressureUntilMono;
  }

  private isInputPressureActive(): boolean {
    return monotonicTime() < this.inputPressureUntilMono;
  }

  private isEditorPressureActive(): boolean {
    return monotonicTime() < this.editorPressureUntilMono;
  }

  private isQuietModeActive(): boolean {
    return monotonicTime() < this.quietModeUntilMono;
  }

  private shouldDeferBackgroundCapture(): boolean {
    return (
      this.isUserRecentlyActive() ||
      this.isQuietModeActive() ||
      this.isMutationPressureActive() ||
      this.isInputPressureActive() ||
      this.eventBuffer.length >= EVENT_BUFFER_SOFT_LIMIT
    );
  }

  private shouldSuppressPointerMoveCapture(): boolean {
    return (
      this.isScrollBurstActive() ||
      this.isQuietModeActive() ||
      this.isMutationPressureActive() ||
      this.eventBuffer.length >= EVENT_BUFFER_FORCE_FLUSH_SIZE
    );
  }

  private resolveDomSnapshotSummaryMode(nodeCount: number): "pressure" | "large-dom" | null {
    if (
      this.isQuietModeActive() ||
      this.isMutationPressureActive() ||
      this.isInputPressureActive() ||
      this.eventBuffer.length >= EVENT_BUFFER_SOFT_LIMIT
    ) {
      return "pressure";
    }

    if (nodeCount >= DOM_SNAPSHOT_SUMMARY_NODE_THRESHOLD) {
      return "large-dom";
    }

    return null;
  }

  private setPendingScreenshotReason(reason: string, prioritize = false): void {
    if (
      prioritize ||
      this.screenshotPendingReason === null ||
      this.screenshotPendingReason === "interval"
    ) {
      this.screenshotPendingReason = reason;
    }
  }

  private scheduleBackgroundCaptureRetry(): void {
    if (this.backgroundCaptureRetryTimer > 0 || !this.recordingActive) {
      return;
    }

    this.backgroundCaptureRetryTimer = window.setTimeout(() => {
      this.backgroundCaptureRetryTimer = 0;

      if (!this.recordingActive || !this.screenshotPendingReason) {
        return;
      }

      if (this.shouldDeferBackgroundCapture()) {
        this.scheduleBackgroundCaptureRetry();
        return;
      }

      const pending = this.screenshotPendingReason;
      this.screenshotPendingReason = null;
      this.scheduleScreenshotCapture(pending);
    }, BACKGROUND_CAPTURE_IDLE_MS);
  }

  private ensureMutationObserverActive(): void {
    if (
      this.mutationObserver ||
      !this.recordingActive ||
      !this.shouldCaptureMutationSignals() ||
      this.isQuietModeActive()
    ) {
      return;
    }

    this.mutationObserver = new MutationObserver((records) => {
      if (this.isQuietModeActive()) {
        this.pendingQuietRecoverySummary = true;
        return;
      }

      if (this.shouldEnterQuietMode(records)) {
        this.enterQuietMode(this.isEditorPressureActive() ? "editor" : "mutation");
        return;
      }

      this.accumulateMutationRecords(records);
      this.scheduleMutationFlush();
    });

    this.mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: false,
      attributeFilter: OBSERVED_MUTATION_ATTRIBUTES,
      characterDataOldValue: false,
      attributeOldValue: false
    });
  }

  private shouldEnterQuietMode(records: MutationRecord[]): boolean {
    if (records.length === 0) {
      return false;
    }

    return (
      records.length >= QUIET_MODE_MUTATION_RECORD_LIMIT ||
      this.eventBuffer.length >= QUIET_MODE_EVENT_BUFFER_LIMIT ||
      this.isEditorPressureActive()
    );
  }

  private enterQuietMode(reason: "mutation" | "editor"): void {
    const duration = reason === "editor" ? QUIET_MODE_EDITOR_COOLDOWN_MS : QUIET_MODE_COOLDOWN_MS;
    this.quietModeUntilMono = Math.max(this.quietModeUntilMono, monotonicTime() + duration);
    this.pendingQuietRecoverySummary = true;

    if (this.mutationFlushTimer > 0) {
      clearTimeout(this.mutationFlushTimer);
      this.mutationFlushTimer = 0;
    }

    if (this.mutationSummary.count > 0) {
      this.flushMutationBuffer();
    }

    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.scheduleQuietModeRecovery();
  }

  private scheduleQuietModeRecovery(): void {
    if (!this.recordingActive || this.quietModeRecoveryTimer > 0) {
      return;
    }

    const delayMs = Math.max(
      BACKGROUND_CAPTURE_IDLE_MS,
      Math.ceil(this.quietModeUntilMono - monotonicTime())
    );

    this.quietModeRecoveryTimer = window.setTimeout(() => {
      this.quietModeRecoveryTimer = 0;

      if (!this.recordingActive) {
        return;
      }

      if (this.isQuietModeActive() || this.shouldDeferBackgroundCapture()) {
        this.scheduleQuietModeRecovery();
        return;
      }

      this.ensureMutationObserverActive();

      if (this.pendingQuietRecoverySummary && this.shouldCaptureDomSnapshots()) {
        this.pendingQuietRecoverySummary = false;
        this.emitPressureRecoverySnapshot();
      }
    }, delayMs);
  }

  private emitPressureRecoverySnapshot(): void {
    const nodeCount = document.getElementsByTagName("*").length;
    const html = buildDomSnapshotSummaryHtml({
      href: location.href,
      title: document.title,
      reason: "pressure-recovery",
      nodeCount,
      summaryMode: "pressure",
      capturedAtIso: new Date().toISOString()
    });

    this.hasDomSnapshot = true;
    this.queueEvent("snapshot", {
      reason: "pressure-recovery",
      href: location.href,
      title: document.title,
      nodeCount,
      htmlLength: html.length,
      truncated: true,
      html,
      summaryOnly: true,
      summaryMode: "pressure"
    });
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
      frame: this.frameMarker,
      payload
    });
  }

  private queueRawEvent(event: RawRecorderEvent): void {
    if (this.mode === "full" && FULL_MODE_SKIPPED_RAW_TYPES.has(event.rawType)) {
      return;
    }

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

    if (this.shouldDropEventForBackpressure(event)) {
      return;
    }

    this.eventBuffer.push(event);
    this.scheduleBufferedFlush(
      this.eventBuffer.length >= EVENT_BUFFER_FORCE_FLUSH_SIZE ? 0 : EVENT_BUFFER_FLUSH_DELAY_MS
    );
  }

  private createClickPayload(event: MouseEvent): Record<string, unknown> {
    return {
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      target: this.resolveTargetPayload(event.target, "action")
    };
  }

  private resolveTargetPayload(
    target: EventTarget | null,
    detail: TargetPayloadDetail
  ): Record<string, unknown> {
    if (this.mode === "full" || detail === "fast") {
      return toFastTargetPayload(target);
    }

    return toLiteTargetPayload(target, {
      selector: this.readCachedSelector(target),
      includeText: detail === "action"
    });
  }

  private flushPreRecordingBuffer(): void {
    if (!this.recordingActive || this.preRecordingBuffer.length === 0) {
      return;
    }

    this.eventBuffer.push(...this.preRecordingBuffer.splice(0, this.preRecordingBuffer.length));
    this.scheduleBufferedFlush(0);
  }

  private flushEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

    if (events.length > 0) {
      this.options.emitBatch(events);
    }

    if (this.eventBuffer.length > 0) {
      this.scheduleBufferedFlush(0);
    }
  }

  private scheduleBufferedFlush(delayMs: number): void {
    if (this.flushTimer > 0) {
      if (delayMs > 0) {
        return;
      }

      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    this.flushTimer = window.setTimeout(
      () => {
        this.flushEvents();
      },
      Math.max(0, delayMs)
    );
  }

  private drainBufferedEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    while (this.eventBuffer.length > 0) {
      const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

      if (events.length === 0) {
        break;
      }

      this.options.emitBatch(events);
    }
  }

  private shouldDropEventForBackpressure(event: RawRecorderEvent): boolean {
    const buffered = this.eventBuffer.length;

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (!LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
      return false;
    }

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (buffered >= EVENT_BUFFER_HARD_LIMIT || this.mode === "full") {
      if (buffered >= EVENT_BUFFER_HARD_LIMIT && this.mode !== "full") {
        this.dropBufferedLowPriorityEvents(buffered - EVENT_BUFFER_SOFT_LIMIT + 1);
        this.scheduleBufferedFlush(0);
      }

      this.droppedLowPriorityEvents += 1;

      if (isPerfLoggingEnabled() && this.droppedLowPriorityEvents % 200 === 0) {
        console.info("[WebBlackbox][perf] dropped low-priority events", {
          mode: this.mode,
          dropped: this.droppedLowPriorityEvents,
          buffered,
          rawType: event.rawType
        });
      }

      return true;
    }

    return false;
  }

  private dropBufferedLowPriorityEvents(targetDropCount: number): void {
    if (targetDropCount <= 0 || this.eventBuffer.length === 0) {
      return;
    }

    let dropped = 0;
    const retained: RawRecorderEvent[] = [];

    for (const event of this.eventBuffer) {
      if (dropped < targetDropCount && LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
        dropped += 1;
        continue;
      }

      retained.push(event);
    }

    if (dropped === 0) {
      return;
    }

    this.eventBuffer.length = 0;
    this.eventBuffer.push(...retained);
    this.droppedLowPriorityEvents += dropped;
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
    screenshotIdleMs: clampOptionalInterval(row.screenshotIdleMs, DEFAULT_SAMPLING.screenshotIdleMs)
  };
}

function clampRate(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 1, 240);
}

function clampInterval(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 25, 120_000);
}

function clampOptionalInterval(value: unknown, fallback: number): number {
  if (value === 0) {
    return 0;
  }

  return clampNumber(value, fallback, 0, 120_000);
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

function resolveContentFrameMarker(): string | undefined {
  try {
    return window.top === window ? undefined : "content-iframe";
  } catch {
    return "content-iframe";
  }
}

function toLiteTargetPayload(
  target: EventTarget | null,
  options: {
    selector: string;
    includeText: boolean;
  }
): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return {};
  }

  return {
    selector: options.selector,
    tag: target.tagName,
    id: target.id || undefined,
    className: readClassName(target),
    text: options.includeText ? target.textContent?.trim().slice(0, 80) : undefined
  };
}

function toFastTargetPayload(target: EventTarget | null): Record<string, unknown> {
  if (!(target instanceof Element)) {
    return {};
  }

  return {
    tag: target.tagName,
    id: target.id || undefined,
    className: readClassName(target)
  };
}

function readClassName(target: Element): string | undefined {
  return typeof target.className === "string" && target.className.length > 0
    ? target.className.slice(0, 80)
    : undefined;
}

function buildDomSnapshotSummaryHtml(options: {
  href: string;
  title: string;
  reason: string;
  nodeCount: number;
  summaryMode: "pressure" | "large-dom";
  capturedAtIso: string;
}): string {
  const body = [
    "<!doctype html>",
    `<html data-webblackbox-summary="true" data-summary-mode="${escapeHtml(options.summaryMode)}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(options.title || "WebBlackbox DOM Summary")}</title>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>WebBlackbox Lite DOM Summary</h1>",
    `<p>mode=${escapeHtml(options.summaryMode)}</p>`,
    `<p>reason=${escapeHtml(options.reason)}</p>`,
    `<p>href=${escapeHtml(options.href)}</p>`,
    `<p>title=${escapeHtml(options.title)}</p>`,
    `<p>nodeCount=${String(options.nodeCount)}</p>`,
    `<p>capturedAt=${escapeHtml(options.capturedAtIso)}</p>`,
    "</main>",
    "</body>",
    "</html>"
  ];

  return body.join("");
}

function isEditableInteractionTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return isRichTextEditableTarget(target);
}

function isRichTextEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const directValue = target.getAttribute("contenteditable");

  if (directValue === "" || directValue === "true" || directValue === "plaintext-only") {
    return true;
  }

  return (
    target.closest(
      "[contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']"
    ) !== null
  );
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

    const classNames = Array.from(current.classList).slice(0, 2);

    if (classNames.length > 0) {
      segment += classNames.map((name) => `.${cssEscape(name)}`).join("");
    }

    const parent: Element | null = current.parentElement;

    if (parent) {
      const index = nthOfType(current);

      if (index > 1) {
        segment += `:nth-of-type(${index})`;
      }
    }

    segments.unshift(segment);
    current = parent;
  }

  return segments.join(" > ");
}

function nthOfType(node: Element): number {
  let index = 1;
  let cursor = node.previousElementSibling;

  while (cursor) {
    if (cursor.tagName === node.tagName) {
      index += 1;
    }

    cursor = cursor.previousElementSibling;
  }

  return index;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createEmptyMutationSummary(): MutationBatchSummary {
  return {
    count: 0,
    sampledCount: 0,
    truncated: false,
    childListCount: 0,
    attributeCount: 0,
    characterDataCount: 0,
    addedNodes: 0,
    removedNodes: 0,
    sampleTargets: [],
    attributeNames: []
  };
}

function isPerfLoggingEnabled(): boolean {
  const flags = window as unknown as Record<string, unknown>;
  return flags[PERF_LOG_FLAG] === true;
}

function computeScreenshotScale(
  viewportWidth: number,
  viewportHeight: number,
  dpr: number
): number {
  const baseScale = Math.max(1, dpr || 1);
  const dimensionScale = Math.min(
    1,
    SCREENSHOT_MAX_DIMENSION_PX / Math.max(viewportWidth, viewportHeight)
  );

  return Math.max(
    SCREENSHOT_MIN_SCALE,
    Math.min(SCREENSHOT_MAX_SCALE, Number((baseScale * dimensionScale).toFixed(3)))
  );
}

type SnapdomBlobOptions = Parameters<typeof snapdom.toBlob>[1];
type SnapdomCaptureOptions = Omit<NonNullable<SnapdomBlobOptions>, "type" | "quality">;
type ScreenshotCropTarget = {
  width: number;
  height: number;
};

function createSnapdomCaptureOptions(scale: number): SnapdomCaptureOptions {
  return {
    fast: true,
    cache: "auto",
    dpr: 1,
    scale,
    backgroundColor: "transparent"
  };
}

async function captureSnapdomDataUrl(
  element: Element,
  options: SnapdomCaptureOptions,
  cropTarget: ScreenshotCropTarget
): Promise<{ dataUrl: string; format: "webp" | "png"; quality?: number } | null> {
  const webpDataUrl = await captureSnapdomFormatDataUrl(
    element,
    {
      ...options,
      type: "webp",
      quality: SCREENSHOT_WEBP_QUALITY
    },
    {
      ...cropTarget,
      mimeType: "image/webp",
      quality: SCREENSHOT_WEBP_QUALITY
    }
  );

  if (webpDataUrl) {
    return {
      dataUrl: webpDataUrl,
      format: "webp",
      quality: Math.round(SCREENSHOT_WEBP_QUALITY * 100)
    };
  }

  const pngDataUrl = await captureSnapdomFormatDataUrl(
    element,
    {
      ...options,
      type: "png"
    },
    {
      ...cropTarget,
      mimeType: "image/png"
    }
  );

  if (!pngDataUrl) {
    return null;
  }

  return {
    dataUrl: pngDataUrl,
    format: "png"
  };
}

async function captureSnapdomFormatDataUrl(
  element: Element,
  options: NonNullable<SnapdomBlobOptions>,
  cropTarget: ScreenshotCropTarget & { mimeType: string; quality?: number }
): Promise<string | null> {
  const blob = await safeSnapdomToBlob(element, options);
  return cropBlobToDataUrl(blob, cropTarget);
}

async function safeSnapdomToBlob(
  element: Element,
  options: NonNullable<SnapdomBlobOptions>
): Promise<Blob | null> {
  try {
    const blob = await snapdom.toBlob(element, options);
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}

async function cropBlobToDataUrl(
  blob: Blob | null,
  options: ScreenshotCropTarget & { mimeType: string; quality?: number }
): Promise<string | null> {
  if (!(blob instanceof Blob)) {
    return null;
  }

  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await loadImageFromUrl(objectUrl);
    const targetWidth = Math.max(1, Math.round(options.width));
    const targetHeight = Math.max(1, Math.round(options.height));
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth || image.width || targetWidth));
    const sourceHeight = Math.max(
      1,
      Math.round(image.naturalHeight || image.height || targetHeight)
    );
    const cropWidth = Math.max(1, Math.min(targetWidth, sourceWidth));
    const cropHeight = Math.max(1, Math.min(targetHeight, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    context.clearRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return safeCanvasToDataUrl(canvas, options.mimeType, options.quality);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("image-load-failed"));
    };
    image.src = url;
  });
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

/** Default sanitized sampling profile used by `LiteCaptureAgent`. */
export { DEFAULT_SAMPLING as DEFAULT_LITE_CAPTURE_SAMPLING };
