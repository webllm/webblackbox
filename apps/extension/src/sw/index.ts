import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import {
  createSessionId,
  DEFAULT_EXPORT_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CaptureMode,
  type ExportPolicy,
  type FreezeReason,
  type HashesManifest,
  type RedactionProfile,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  createDefaultRecorderPlugins,
  type RawRecorderEvent,
  WebBlackboxRecorder
} from "@webblackbox/recorder";

import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";
import {
  DEFAULT_PERFORMANCE_BUDGET,
  normalizePerformanceBudget,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";
import {
  isLikelyTextualResourceType as isLikelyTextualResourceTypeUtil,
  isMimeAllowed as isMimeAllowedUtil,
  isTextualMimeType as isTextualMimeTypeUtil,
  normalizeMimeType as normalizeMimeTypeUtil,
  redactBodyText as redactBodyTextUtil,
  resolveFullBodyCaptureRule as resolveFullBodyCaptureRuleUtil,
  resolveLiteBodyCaptureRule as resolveLiteBodyCaptureRuleUtil,
  transformResponseBodyForCapture
} from "./body-capture-utils.js";

type SessionRuntime = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  url: string;
  title?: string;
  tags: string[];
  note?: string;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
  stoppedAt?: number;
  recorder: WebBlackboxRecorder;
  pipeline: SessionPipelineClient;
  cdpRouter: CdpRouter | null;
  enabledCdpSessions: Set<string>;
  requestMeta: Map<
    string,
    { url?: string; mimeType?: string; status?: number; resourceType?: string }
  >;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  lastPointer: PointerState | null;
  lastViewport: ViewportState | null;
  lastActionScreenshotMono: number;
  lastIncidentCaptureAt: number;
  lastNavigationSnapshotAt: number;
  queueDepth: number;
  droppedBestEffortTasks: number;
  pipelineEventBuffer: WebBlackboxEvent[];
  pipelineFlushTimer: ReturnType<typeof setTimeout> | null;
  pipelineFlushQueued: boolean;
  stopping: boolean;
  responseBodyCaptures: number;
  responseBodyCaptureTimestamps: number[];
  capturedEventCount: number;
  capturedErrorCount: number;
  capturedSizeBytes: number;
  budgetAlertCount: number;
  performanceBudget: PerformanceBudgetConfig;
  networkBudgetSample: {
    total: number;
    failed: number;
  };
  lastFreezeNotices: Map<string, number>;
  lastBudgetBreachAt: Map<string, number>;
  queue: Promise<void>;
  removeCdpListeners: Array<() => void>;
  heapSnapshotCapture: HeapSnapshotCaptureState | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

type PointerState = {
  x: number;
  y: number;
  t: number;
  mono: number;
};

type ViewportState = {
  width: number;
  height: number;
  dpr: number;
};

type HeapSnapshotCaptureState = {
  chunks: string[];
  bytes: number;
  truncated: boolean;
};

type PipelineExportDownloadResult = {
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  downloadId?: number;
  integrity: HashesManifest;
};

type SessionAnnotation = {
  tags: string[];
  note?: string;
};

type SessionPipelineClient = {
  start: (session: SessionMetadata, redactionProfile: RedactionProfile) => Promise<void>;
  ingest: (event: WebBlackboxEvent) => Promise<void>;
  ingestBatch: (events: WebBlackboxEvent[]) => Promise<void>;
  flush: () => Promise<void>;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  exportAndDownload: (options?: {
    passphrase?: string;
    includeScreenshots?: boolean;
    maxArchiveBytes?: number;
    recentWindowMs?: number;
  }) => Promise<PipelineExportDownloadResult>;
  close: (options?: { purge?: boolean }) => Promise<void>;
};

type OffscreenPipelineRequest = {
  kind: "sw.pipeline-request";
  requestId: string;
  op: "start" | "ingest" | "ingestBatch" | "flush" | "putBlob" | "exportDownload" | "close";
  sid: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  event?: WebBlackboxEvent;
  events?: WebBlackboxEvent[];
  mime?: string;
  bytes?: Uint8Array;
  passphrase?: string;
  includeScreenshots?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
  purge?: boolean;
};

type OffscreenPipelineResponse = {
  kind: "offscreen.pipeline-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type RecordingSampling = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  snapshotIntervalMs: number;
  screenshotIdleMs: number;
};

type LiteBodyCaptureRule = {
  enabled: boolean;
  maxBytes: number;
  mimeAllowlist: string[];
};

const chromeApi = getChromeApi();

const sessionsByTab = new Map<number, SessionRuntime>();
const sessionsBySid = new Map<string, SessionRuntime>();
const sessionAnnotations = new Map<string, SessionAnnotation>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingOffscreenRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const offscreenSessionRecovery = new Map<string, Promise<void>>();
let offscreenRequestSeq = 0;
let freezeBadgeTimer: ReturnType<typeof setTimeout> | null = null;

const OFFSCREEN_PATH = "offscreen.html";
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const POINTER_STALE_MS = 2_500;
const NETWORK_BODY_MAX_BYTES = 256 * 1024;
const FULL_MODE_BODY_CAPTURE_MAX_BYTES = 128 * 1024;
const LITE_MODE_BODY_CAPTURE_MAX_BYTES = 128 * 1024;
const FULL_MODE_BODY_CAPTURE_MAX_PER_MINUTE = 80;
const FULL_MODE_BODY_CAPTURE_MAX_PER_SESSION = 2_000;
const FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS = 15_000;
const FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS = 12_000;
const FULL_MODE_NAV_SNAPSHOT_COOLDOWN_MS = 30_000;
const FREEZE_NOTICE_COOLDOWN_MS = 20_000;
const FREEZE_BADGE_HIGHLIGHT_MS = 15_000;
const PERFORMANCE_BUDGET_BREACH_COOLDOWN_MS = 15_000;
const PERFORMANCE_BUDGET_ERROR_RATE_MIN_SAMPLES = 10;
const BEST_EFFORT_QUEUE_MAX_PENDING = 80;
const PIPELINE_BATCH_MAX_EVENTS = 160;
const PIPELINE_BATCH_DRAIN_CHUNK_EVENTS = 160;
const PIPELINE_BATCH_FLUSH_MS = 120;
const CONTENT_EVENT_SLICE_BUDGET_MS = 8;
const SKIPPED_FULL_MODE_BODY_RESOURCE_TYPES = new Set(["Image", "Media", "Font"]);
const SKIPPED_FULL_MODE_CONTENT_RAW_TYPES = new Set([
  "mousemove",
  "scroll",
  "mutation",
  "vitals",
  "longtask",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot",
  "networkBody",
  "fetch",
  "xhr",
  "fetchError",
  "console",
  "pageError",
  "unhandledrejection",
  "resourceError",
  "sse",
  "notice"
]);
const FULL_MODE_FOLLOWUP_METHODS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Runtime.exceptionThrown",
  "Page.frameNavigated"
]);
const LITE_DEFAULT_BODY_MIME_ALLOWLIST = [
  "text/*",
  "application/json",
  "application/*+json",
  "application/xml",
  "application/*+xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];
const LITE_BODY_REDACTED_TOKEN = "[REDACTED]";
const LITE_SCREENSHOT_MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;
const LITE_SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const LITE_DOM_SNAPSHOT_MAX_BYTES = 1_500 * 1024;
const LITE_STORAGE_SNAPSHOT_MAX_BYTES = 600 * 1024;
const FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS = 300;
const FULL_MODE_LOCAL_STORAGE_SNAPSHOT_EXPR = `(() => {
  const count = localStorage.length;
  const maxItems = Math.min(count, ${FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS});
  const entries = [];
  for (let index = 0; index < maxItems; index += 1) {
    const key = localStorage.key(index);
    if (!key) {
      continue;
    }
    const value = localStorage.getItem(key) ?? "";
    entries.push([key, value.length]);
  }
  return JSON.stringify({ count, truncated: count > maxItems, entries });
})()`;
const CPU_PROFILE_SAMPLE_MS = 350;
const HEAP_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const OPTIONS_STORAGE_KEY = "webblackbox.options";
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";
const SESSION_ANNOTATIONS_STORAGE_KEY = "webblackbox.runtime.sessionAnnotations";
const STOPPED_SESSION_TTL_MS = 10 * 60_000;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const PERF_WARN_MS = 40;
const OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS = 12 * 60_000;
const OFFSCREEN_PORT_READY_MAX_ATTEMPTS = 200;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;

console.info("[WebBlackbox] service worker booted");

void restoreRuntimeState();

chromeApi?.runtime?.onInstalled.addListener(() => {
  void setIdleBadge();
});

chromeApi?.runtime?.onConnect.addListener((port) => {
  if (
    !Object.values(PORT_NAMES).includes(port.name as (typeof PORT_NAMES)[keyof typeof PORT_NAMES])
  ) {
    return;
  }

  connectedPorts.add(port);

  if (port.name === PORT_NAMES.offscreen) {
    offscreenPort = port;
    notifyOffscreenPipelineStatus();
  }

  if (port.name === PORT_NAMES.content) {
    void syncContentPortStateOnConnect(port);
  }

  pushSessionList();

  const onMessage = (rawMessage: unknown) => {
    if (handleOffscreenRuntimeMessage(rawMessage, port)) {
      return;
    }

    const message = parseInboundMessage(rawMessage);

    if (!message) {
      return;
    }

    void handleInboundMessage(message, port);
  };

  const onDisconnect = () => {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
      rejectPendingOffscreenRequests("Offscreen pipeline disconnected.");

      if (sessionsByTab.size > 0) {
        void recoverAllActiveOffscreenPipelines().catch((error) => {
          console.warn("[WebBlackbox] failed to recover active offscreen pipelines", error);
        });
      }
    }

    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
});

async function syncContentPortStateOnConnect(port: PortLike): Promise<void> {
  const tabId = port.sender?.tab?.id;

  if (typeof tabId !== "number") {
    return;
  }

  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  if (shouldInjectHooksForMode(runtime.mode)) {
    await ensureInjectedHooks(tabId);
  }

  syncContentPortRecordingState(port);
}

function syncContentPortRecordingState(port: PortLike): void {
  const tabId = port.sender?.tab?.id;

  if (typeof tabId !== "number") {
    return;
  }

  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  const sampling = toStatusSampling(runtime);

  try {
    port.postMessage({
      kind: "sw.recording-status",
      active: true,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling
    });
  } catch (error) {
    logPortSendFailure("sw.recording-status", error, {
      tabId,
      sid: runtime.sid,
      mode: runtime.mode
    });
  }
}

chromeApi?.runtime?.onMessage.addListener((rawMessage, sender) => {
  const message = parseInboundMessage(rawMessage);

  if (!message) {
    return;
  }

  void handleInboundMessage(message, undefined, sender.tab?.id);
  return false;
});

chromeApi?.commands?.onCommand.addListener((command) => {
  if (command !== "mark-bug") {
    return;
  }

  void relayMarkerCommand();
});

async function handleInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  senderTabId?: number
): Promise<void> {
  if (message.kind === "ui.start") {
    const tabId = await resolveUiActionTabId(message.tabId);

    if (typeof tabId !== "number") {
      return;
    }

    await startSession(tabId, message.mode);
    return;
  }

  if (message.kind === "ui.stop") {
    const tabId = await resolveUiActionTabId(message.tabId);

    if (typeof tabId !== "number") {
      return;
    }

    await stopSession(tabId);
    return;
  }

  if (message.kind === "ui.export") {
    await exportSession(
      message.sid,
      message.passphrase,
      message.saveAs,
      resolveExportPolicy(message.policy)
    );
    return;
  }

  if (message.kind === "ui.delete") {
    await deleteSessionBySid(message.sid);
    return;
  }

  if (message.kind === "ui.annotate") {
    await updateSessionAnnotation(message.sid, message.tags, message.note);
    return;
  }

  if (message.kind === "content.marker") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId === "number") {
      ingestRawEvent({
        source: "content",
        rawType: "marker",
        tabId,
        sid: sessionsByTab.get(tabId)?.sid ?? "",
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          message: message.message
        }
      });
    }

    return;
  }

  if (message.kind === "content.ready") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return;
    }

    const runtime = sessionsByTab.get(tabId);

    if (!runtime || runtime.stoppedAt) {
      return;
    }

    if (shouldInjectHooksForMode(runtime.mode)) {
      await ensureInjectedHooks(tabId);
    }

    if (port?.name === PORT_NAMES.content) {
      syncContentPortRecordingState(port);
      return;
    }

    await notifyTabStatus(tabId, true, runtime.sid, runtime.mode, toStatusSampling(runtime));
    return;
  }

  if (message.kind === "content.events") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return;
    }

    let sliceStartedAt = perfNow();

    for (const rawEvent of message.events) {
      ingestRawEvent({
        ...rawEvent,
        tabId
      });

      if (perfNow() - sliceStartedAt >= CONTENT_EVENT_SLICE_BUDGET_MS) {
        await wait(0);
        sliceStartedAt = perfNow();
      }
    }
  }
}

async function deleteSessionBySid(sid: string): Promise<void> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    if (sessionAnnotations.delete(sid)) {
      await persistSessionAnnotations().catch(() => undefined);
    }
    return;
  }

  if (!runtime.stoppedAt) {
    await stopSession(runtime.tabId);
  }

  await disposeStoppedSession(runtime);

  if (sessionAnnotations.delete(sid)) {
    await persistSessionAnnotations().catch(() => undefined);
    pushSessionList();
  }
}

async function startSession(tabId: number, mode: CaptureMode): Promise<void> {
  const existing = sessionsByTab.get(tabId);

  if (existing) {
    await stopSession(tabId);
  }

  await ensureOffscreenDocument();

  const sid = createSessionId();
  const startedAt = Date.now();
  const tabMetadata = await resolveTabSessionMetadata(tabId);
  const recorderConfig = await loadRecorderConfig(mode);
  const performanceBudget = await loadPerformanceBudgetConfig();
  const annotation = getSessionAnnotation(sid);
  const metadata: SessionMetadata = {
    sid,
    tabId,
    startedAt,
    mode,
    url: tabMetadata.url,
    title: tabMetadata.title,
    tags: [...annotation.tags]
  };

  const recorderPlugins = createDefaultRecorderPlugins();
  const pipeline = createOffscreenPipelineClient(sid);
  await pipeline.start(metadata, recorderConfig.redaction);

  const runtime: SessionRuntime = {
    sid,
    tabId,
    mode,
    url: metadata.url,
    title: metadata.title,
    tags: [...annotation.tags],
    note: annotation.note,
    config: recorderConfig,
    startedAt,
    stoppedAt: undefined,
    recorder: new WebBlackboxRecorder(
      {
        ...recorderConfig,
        mode
      },
      {},
      undefined,
      recorderPlugins
    ),
    pipeline,
    cdpRouter: null,
    enabledCdpSessions: new Set<string>(),
    requestMeta: new Map(),
    screenshotInterval: null,
    lastPointer: null,
    lastViewport: null,
    lastActionScreenshotMono: Number.NEGATIVE_INFINITY,
    lastIncidentCaptureAt: Number.NEGATIVE_INFINITY,
    lastNavigationSnapshotAt: Number.NEGATIVE_INFINITY,
    queueDepth: 0,
    droppedBestEffortTasks: 0,
    pipelineEventBuffer: [],
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    stopping: false,
    responseBodyCaptures: 0,
    responseBodyCaptureTimestamps: [],
    capturedEventCount: 0,
    capturedErrorCount: 0,
    capturedSizeBytes: 0,
    budgetAlertCount: 0,
    performanceBudget,
    networkBudgetSample: {
      total: 0,
      failed: 0
    },
    lastFreezeNotices: new Map<string, number>(),
    lastBudgetBreachAt: new Map<string, number>(),
    queue: Promise.resolve(),
    removeCdpListeners: [],
    heapSnapshotCapture: null,
    cleanupTimer: null
  };

  runtime.recorder = new WebBlackboxRecorder(
    {
      ...recorderConfig,
      mode
    },
    {
      onEvent: (event) => {
        updateSessionMetadataFromEvent(runtime, event);
        trackSessionCounters(runtime, event);
        evaluatePerformanceBudget(runtime, event);
        enqueuePipelineEvent(runtime, event);
      },
      onFreeze: (reason) => {
        handleFreezeNotice(runtime, reason);
      }
    },
    undefined,
    recorderPlugins
  );

  sessionsByTab.set(tabId, runtime);
  sessionsBySid.set(sid, runtime);

  ingestRawEvent({
    source: "system",
    rawType: "config",
    sid,
    tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: recorderConfig
  });

  if (shouldInjectHooksForMode(mode)) {
    await ensureInjectedHooks(tabId);
  }

  if (mode === "full") {
    await attachCdp(runtime);
  }

  const sampling = toStatusSampling(runtime);

  await setRecordingBadge();
  await notifyTabStatus(tabId, true, sid, mode, sampling);
  broadcast({ kind: "sw.recording-status", active: true, sid, mode, sampling });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function stopSession(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stopping) {
    return;
  }

  runtime.stopping = true;
  await flushBufferedPipelineEvents(runtime);
  await teardownCaptureInstrumentation(runtime);
  sessionsByTab.delete(runtime.tabId);
  runtime.stoppedAt = Date.now();
  scheduleStoppedRuntimeCleanup(runtime);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await notifyTabStatus(tabId, false);
  broadcast({ kind: "sw.recording-status", active: false, sid: runtime.sid, mode: runtime.mode });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function exportSession(
  sid: string,
  passphrase: string | undefined,
  saveAs = true,
  policy: ExportPolicy = DEFAULT_EXPORT_POLICY
): Promise<void> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    console.warn("[WebBlackbox] export ignored; unknown session", sid);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: "Session not found for export."
    });
    return;
  }

  try {
    if (!runtime.stoppedAt) {
      await stopSession(runtime.tabId);
    }

    await flushBufferedPipelineEvents(runtime);

    const exported = await enqueueWithResult(runtime, async () => {
      return runtime.pipeline.exportAndDownload({
        passphrase,
        includeScreenshots: policy.includeScreenshots,
        maxArchiveBytes: policy.maxArchiveBytes,
        recentWindowMs: policy.recentWindowMs
      });
    });

    await downloadExportedBundle(exported, saveAs);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: true,
      fileName: exported.fileName
    });

    if (runtime.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  } catch (error) {
    console.warn("[WebBlackbox] export failed", error);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function ingestRawEvent(rawEvent: RawRecorderEvent): void {
  const runtime = sessionsByTab.get(rawEvent.tabId);

  if (!runtime) {
    return;
  }

  if (runtime.stopping && rawEvent.source !== "system") {
    return;
  }

  if (shouldSkipFullModeContentRawEvent(runtime, rawEvent)) {
    return;
  }

  const nextRawEvent: RawRecorderEvent = {
    ...rawEvent,
    sid: runtime.sid
  };

  updateRuntimeInteractionState(runtime, nextRawEvent);

  if (shouldMaterializeLiteContentEvent(runtime, nextRawEvent)) {
    enqueue(runtime, async () => {
      const materialized = await materializeLiteContentEvent(runtime, nextRawEvent);

      if (!materialized) {
        return;
      }

      runtime.recorder.ingest(materialized);
    });

    return;
  }

  if (runtime.mode === "full" && shouldCaptureActionScreenshot(nextRawEvent, runtime)) {
    runtime.lastActionScreenshotMono = nextRawEvent.mono;
    enqueue(
      runtime,
      async () => {
        await captureScreenshot(runtime, `action:${nextRawEvent.rawType}`);
      },
      { bestEffort: true }
    );
  }

  runtime.recorder.ingest(nextRawEvent);
}

function shouldSkipFullModeContentRawEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  return (
    runtime.mode === "full" &&
    rawEvent.source === "content" &&
    SKIPPED_FULL_MODE_CONTENT_RAW_TYPES.has(rawEvent.rawType)
  );
}

function shouldMaterializeLiteContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  if (runtime.mode !== "lite") {
    return false;
  }

  if (rawEvent.source !== "content") {
    return false;
  }

  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return false;
  }

  if (rawEvent.rawType === "screenshot") {
    return typeof payload.dataUrl === "string" && payload.dataUrl.length > 0;
  }

  if (rawEvent.rawType === "snapshot") {
    return typeof payload.html === "string" && payload.html.length > 0;
  }

  if (rawEvent.rawType === "localStorageSnapshot") {
    return asRecord(payload.entries) !== null;
  }

  if (rawEvent.rawType === "indexedDbSnapshot") {
    return Array.isArray(payload.databaseNames);
  }

  if (rawEvent.rawType === "cookieSnapshot") {
    return Array.isArray(payload.names);
  }

  if (rawEvent.rawType === "networkBody") {
    return (
      (typeof payload.reqId === "string" || typeof payload.requestId === "string") &&
      typeof payload.body === "string"
    );
  }

  return false;
}

async function materializeLiteContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(runtime, rawEvent);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(runtime, rawEvent);
  }

  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    return materializeLiteStorageSnapshot(runtime, rawEvent);
  }

  if (rawEvent.rawType === "networkBody") {
    return materializeLiteNetworkBody(runtime, rawEvent);
  }

  return rawEvent;
}

async function materializeLiteScreenshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const dataUrl = asString(payload?.dataUrl);

  if (!payload || !dataUrl || dataUrl.length > LITE_SCREENSHOT_MAX_DATA_URL_LENGTH) {
    return null;
  }

  const decoded = decodeDataUrl(dataUrl);

  if (
    !decoded ||
    decoded.bytes.byteLength === 0 ||
    decoded.bytes.byteLength > LITE_SCREENSHOT_MAX_BYTES
  ) {
    return null;
  }

  const shotId = await runtime.pipeline.putBlob(decoded.mime, decoded.bytes);
  const width = normalizePositiveInt(payload.w) ?? normalizePositiveInt(payload.width);
  const height = normalizePositiveInt(payload.h) ?? normalizePositiveInt(payload.height);
  const quality = normalizePositiveInt(payload.quality);
  const reason = asString(payload.reason) ?? undefined;
  const viewport = normalizeScreenshotViewport(payload.viewport);
  const pointer = normalizeScreenshotPointer(payload.pointer);
  const format = decoded.mime.includes("png") ? "png" : "webp";

  return {
    ...rawEvent,
    payload: {
      shotId,
      format,
      w: width,
      h: height,
      quality: format === "webp" ? quality : undefined,
      size: decoded.bytes.byteLength,
      reason,
      viewport,
      pointer
    }
  };
}

async function materializeLiteDomSnapshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const html = asString(payload?.html);

  if (!payload || !html) {
    return null;
  }

  const encoded = encodeTextWithByteLimit(html, LITE_DOM_SNAPSHOT_MAX_BYTES);
  const contentHash = await runtime.pipeline.putBlob("text/html", encoded.bytes);
  const snapshotId = asString(payload.snapshotId) ?? `D-${Math.round(rawEvent.mono)}`;
  const nodeCount = normalizeNonNegativeInt(payload.nodeCount);
  const reason = asString(payload.reason) ?? undefined;
  const htmlLength = normalizeNonNegativeInt(payload.htmlLength) ?? html.length;
  const truncated = payload.truncated === true || encoded.truncated;

  return {
    ...rawEvent,
    payload: {
      snapshotId,
      contentHash,
      source: "html",
      nodeCount,
      reason,
      htmlLength,
      truncated
    }
  };
}

async function materializeLiteStorageSnapshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reason = asString(payload.reason) ?? undefined;

  if (rawEvent.rawType === "localStorageSnapshot") {
    const entries = asRecord(payload.entries) ?? {};
    const serialized = JSON.stringify(entries);
    const encoded = encodeTextWithByteLimit(serialized, LITE_STORAGE_SNAPSHOT_MAX_BYTES);
    const hash =
      encoded.bytes.byteLength > 0
        ? await runtime.pipeline.putBlob("application/json", encoded.bytes)
        : undefined;
    const count = normalizeNonNegativeInt(payload.count) ?? Object.keys(entries).length;

    return {
      ...rawEvent,
      payload: {
        hash,
        count,
        mode: "sample",
        redacted: true,
        reason,
        truncated: payload.truncated === true || encoded.truncated
      }
    };
  }

  if (rawEvent.rawType === "indexedDbSnapshot") {
    const names = asStringArray(payload.databaseNames, 400);
    const serialized = JSON.stringify(names);
    const encoded = encodeTextWithByteLimit(serialized, LITE_STORAGE_SNAPSHOT_MAX_BYTES);
    const hash =
      encoded.bytes.byteLength > 0
        ? await runtime.pipeline.putBlob("application/json", encoded.bytes)
        : undefined;
    const count = normalizeNonNegativeInt(payload.count) ?? names.length;

    return {
      ...rawEvent,
      payload: {
        hash,
        count,
        mode: "schema-only",
        redacted: true,
        reason,
        truncated: payload.truncated === true || encoded.truncated
      }
    };
  }

  if (rawEvent.rawType === "cookieSnapshot") {
    const names = asStringArray(payload.names, 400);
    const serialized = JSON.stringify(names);
    const encoded = encodeTextWithByteLimit(serialized, LITE_STORAGE_SNAPSHOT_MAX_BYTES);
    const hash =
      encoded.bytes.byteLength > 0
        ? await runtime.pipeline.putBlob("application/json", encoded.bytes)
        : undefined;
    const count = normalizeNonNegativeInt(payload.count) ?? names.length;

    return {
      ...rawEvent,
      payload: {
        hash,
        count,
        mode: "sample",
        redacted: true,
        reason,
        truncated: payload.truncated === true || encoded.truncated
      }
    };
  }

  return rawEvent;
}

async function materializeLiteNetworkBody(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reqId = asString(payload.reqId) ?? asString(payload.requestId);
  const body = asString(payload.body);
  const encoding = asString(payload.encoding) ?? "utf8";
  const url = asString(payload.url) ?? "";
  const mimeType = normalizeMimeType(asString(payload.mimeType));

  if (!reqId || !body || (encoding !== "utf8" && encoding !== "base64")) {
    return null;
  }

  const captureRule = resolveLiteBodyCaptureRule(runtime, url, mimeType);

  if (!captureRule.enabled || !isMimeAllowed(captureRule.mimeAllowlist, mimeType)) {
    return null;
  }

  let bytes: Uint8Array;
  let redacted = payload.redacted === true;

  if (encoding === "utf8") {
    const redaction = redactBodyText(body, runtime.config.redaction.redactBodyPatterns);
    redacted = redacted || redaction.redacted;
    bytes = new TextEncoder().encode(redaction.value);
  } else {
    bytes = decodeBase64(body);
  }

  if (bytes.byteLength === 0) {
    return null;
  }

  const size = normalizeNonNegativeInt(payload.size) ?? bytes.byteLength;
  const truncatedByInput = payload.truncated === true;
  const maxBytes = captureRule.maxBytes;
  const truncatedByLimit = bytes.byteLength > maxBytes;
  const sampledBytes = truncatedByLimit ? bytes.slice(0, maxBytes) : bytes;
  const contentHash = await runtime.pipeline.putBlob(
    mimeType ?? "application/octet-stream",
    sampledBytes
  );

  return {
    ...rawEvent,
    payload: {
      reqId,
      requestId: reqId,
      contentHash,
      mimeType,
      size,
      sampledSize: sampledBytes.byteLength,
      truncated: truncatedByInput || truncatedByLimit || sampledBytes.byteLength < size,
      redacted
    }
  };
}

function updateRuntimeInteractionState(runtime: SessionRuntime, rawEvent: RawRecorderEvent): void {
  if (rawEvent.source !== "content") {
    return;
  }

  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return;
  }

  if (rawEvent.rawType === "resize") {
    const width = asFiniteNumber(payload.width);
    const height = asFiniteNumber(payload.height);
    const dpr = asFiniteNumber(payload.dpr) ?? runtime.lastViewport?.dpr ?? 1;

    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      runtime.lastViewport = {
        width: Math.round(width),
        height: Math.round(height),
        dpr: Number(dpr.toFixed(2))
      };
    }

    return;
  }

  if (
    rawEvent.rawType === "mousemove" ||
    rawEvent.rawType === "click" ||
    rawEvent.rawType === "dblclick"
  ) {
    const x = asFiniteNumber(payload.x);
    const y = asFiniteNumber(payload.y);

    if (typeof x === "number" && typeof y === "number") {
      runtime.lastPointer = {
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        t: rawEvent.t,
        mono: rawEvent.mono
      };
    }
  }
}

function shouldCaptureActionScreenshot(
  rawEvent: RawRecorderEvent,
  runtime: SessionRuntime
): boolean {
  if (rawEvent.source !== "content") {
    return false;
  }

  if (!ACTION_SCREENSHOT_RAW_TYPES.has(rawEvent.rawType)) {
    return false;
  }

  if (rawEvent.mono - runtime.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
    return false;
  }

  if (runtime.queueDepth >= Math.floor(BEST_EFFORT_QUEUE_MAX_PENDING / 3)) {
    return false;
  }

  return true;
}

function trackSessionCounters(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  runtime.capturedEventCount += 1;
  runtime.capturedSizeBytes += estimateSessionEventBytes(event);

  if (event.type === "error.exception" || event.type === "error.unhandledrejection") {
    runtime.capturedErrorCount += 1;
    pushSessionList();
    return;
  }

  if (runtime.capturedEventCount % 50 === 0) {
    pushSessionList();
  }
}

function evaluatePerformanceBudget(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  const budget = runtime.performanceBudget;
  let updated = false;

  if (event.type === "perf.vitals") {
    const lcpMs = readLcpFromVitalsEvent(event.data);

    if (lcpMs !== null && lcpMs >= budget.lcpWarnMs) {
      updated =
        registerPerformanceBudgetBreach(runtime, "lcp", `LCP ${Math.round(lcpMs)}ms`) || updated;
    }
  }

  if (event.type === "network.response") {
    const payload = asRecord(event.data);
    const duration = asFiniteNumber(payload?.duration);
    const status = asFiniteNumber(payload?.status);
    const ok = payload?.ok === true;
    const failed = payload?.failed === true || (typeof status === "number" && status >= 400) || !ok;

    runtime.networkBudgetSample.total += 1;

    if (failed) {
      runtime.networkBudgetSample.failed += 1;
    }

    if (typeof duration === "number" && duration >= budget.requestWarnMs) {
      updated =
        registerPerformanceBudgetBreach(
          runtime,
          "slow-request",
          `Slow request ${Math.round(duration)}ms`
        ) || updated;
    }

    if (runtime.networkBudgetSample.total >= PERFORMANCE_BUDGET_ERROR_RATE_MIN_SAMPLES) {
      const errorRatePct =
        (runtime.networkBudgetSample.failed / runtime.networkBudgetSample.total) * 100;

      if (errorRatePct >= budget.errorRateWarnPct) {
        updated =
          registerPerformanceBudgetBreach(
            runtime,
            "error-rate",
            `Error rate ${errorRatePct.toFixed(1)}%`
          ) || updated;
      }
    }
  }

  if (updated) {
    pushSessionList();
  }
}

function readLcpFromVitalsEvent(payload: unknown): number | null {
  const record = asRecord(payload);
  const metric = asString(record?.metric) ?? asString(record?.name);

  if (
    metric &&
    metric !== "largest-contentful-paint" &&
    metric !== "largest-contentful-paint-render-time" &&
    metric !== "largest-contentful-paint-load-time" &&
    metric !== "lcp"
  ) {
    return null;
  }

  const value = asFiniteNumber(record?.value);
  const startTime = asFiniteNumber(record?.startTime);
  const duration = asFiniteNumber(record?.duration);
  const candidate = Math.max(
    value ?? Number.NEGATIVE_INFINITY,
    startTime ?? Number.NEGATIVE_INFINITY,
    duration ?? Number.NEGATIVE_INFINITY
  );

  return Number.isFinite(candidate) ? candidate : null;
}

function registerPerformanceBudgetBreach(
  runtime: SessionRuntime,
  key: string,
  detail: string
): boolean {
  const now = Date.now();
  const lastBreachAt = runtime.lastBudgetBreachAt.get(key) ?? Number.NEGATIVE_INFINITY;

  if (now - lastBreachAt < PERFORMANCE_BUDGET_BREACH_COOLDOWN_MS) {
    return false;
  }

  runtime.lastBudgetBreachAt.set(key, now);
  runtime.budgetAlertCount += 1;
  console.info("[WebBlackbox] performance budget breach", {
    sid: runtime.sid,
    tabId: runtime.tabId,
    key,
    detail
  });

  if (runtime.performanceBudget.autoFreezeOnBreach) {
    handleFreezeNotice(runtime, "perf");
  }

  return true;
}

function enqueuePipelineEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  runtime.pipelineEventBuffer.push(event);

  if (runtime.pipelineEventBuffer.length >= PIPELINE_BATCH_MAX_EVENTS) {
    queuePipelineBatchFlush(runtime);
    return;
  }

  if (runtime.pipelineFlushTimer !== null || runtime.pipelineFlushQueued) {
    return;
  }

  runtime.pipelineFlushTimer = setTimeout(() => {
    runtime.pipelineFlushTimer = null;
    queuePipelineBatchFlush(runtime);
  }, PIPELINE_BATCH_FLUSH_MS);
}

function queuePipelineBatchFlush(runtime: SessionRuntime): void {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.pipelineFlushQueued || runtime.pipelineEventBuffer.length === 0) {
    return;
  }

  runtime.pipelineFlushQueued = true;

  enqueue(runtime, async () => {
    try {
      await drainPipelineBufferBatches(runtime, "queue");
    } finally {
      runtime.pipelineFlushQueued = false;

      if (runtime.pipelineEventBuffer.length > 0 && !runtime.stopping) {
        queuePipelineBatchFlush(runtime);
      }
    }
  });
}

async function flushBufferedPipelineEvents(runtime: SessionRuntime): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.pipelineEventBuffer.length === 0 && !runtime.pipelineFlushQueued) {
    return;
  }

  await enqueueWithResult(runtime, async () => {
    await drainPipelineBufferBatches(runtime, "drain");
  });
}

async function drainPipelineBufferBatches(
  runtime: SessionRuntime,
  reason: "queue" | "drain"
): Promise<void> {
  let flushed = 0;

  while (runtime.pipelineEventBuffer.length > 0) {
    const batchSize = Math.min(
      runtime.pipelineEventBuffer.length,
      PIPELINE_BATCH_DRAIN_CHUNK_EVENTS
    );
    const batch = runtime.pipelineEventBuffer.slice(0, batchSize);

    if (batch.length === 0) {
      break;
    }

    await runtime.pipeline.ingestBatch(batch);
    runtime.pipelineEventBuffer.splice(0, batch.length);
    flushed += batch.length;

    if (runtime.pipelineEventBuffer.length > 0) {
      await wait(0);
    }
  }

  if (shouldLogPerf() && flushed > 0) {
    console.info("[WebBlackbox][perf] pipeline buffer flushed", {
      sid: runtime.sid,
      reason,
      flushed,
      queueDepth: runtime.queueDepth,
      stopping: runtime.stopping
    });
  }
}

function createOffscreenPipelineClient(sid: string): SessionPipelineClient {
  return {
    start: async (session, redactionProfile) => {
      await requestOffscreenPipeline<void>({
        op: "start",
        sid,
        session,
        redactionProfile
      });
    },
    ingest: async (event) => {
      await requestOffscreenPipeline<void>({
        op: "ingest",
        sid,
        event
      });
    },
    ingestBatch: async (events) => {
      await requestOffscreenPipeline<void>({
        op: "ingestBatch",
        sid,
        events
      });
    },
    flush: async () => {
      await requestOffscreenPipeline<void>({
        op: "flush",
        sid
      });
    },
    putBlob: async (mime, bytes) => {
      return requestOffscreenPipeline<string>({
        op: "putBlob",
        sid,
        mime,
        bytes
      });
    },
    exportAndDownload: async (options = {}) => {
      const exported = await requestOffscreenPipeline<unknown>({
        op: "exportDownload",
        sid,
        passphrase: options.passphrase,
        includeScreenshots: options.includeScreenshots,
        maxArchiveBytes: options.maxArchiveBytes,
        recentWindowMs: options.recentWindowMs
      });

      return normalizePipelineExportDownloadResult(exported);
    },
    close: async (options = {}) => {
      await requestOffscreenPipeline<void>({
        op: "close",
        sid,
        purge: options.purge
      });
    }
  };
}

async function requestOffscreenPipeline<TResult>(
  request: Omit<OffscreenPipelineRequest, "kind" | "requestId">
): Promise<TResult> {
  const startedAt = perfNow();
  const result = await requestOffscreenPipelineWithRecovery<TResult>(request);

  const durationMs = perfNow() - startedAt;

  if (durationMs >= PERF_WARN_MS && shouldLogPerf()) {
    console.info("[WebBlackbox][perf] offscreen request", {
      op: request.op,
      durationMs: Number(durationMs.toFixed(2)),
      queuePending: pendingOffscreenRequests.size
    });
  }

  return result as TResult;
}

async function requestOffscreenPipelineWithRecovery<TResult>(
  request: Omit<OffscreenPipelineRequest, "kind" | "requestId">
): Promise<TResult> {
  try {
    return await requestOffscreenPipelineOnce<TResult>(request);
  } catch (error) {
    if (!shouldRetryOffscreenRequest(request, error)) {
      throw error;
    }

    await recoverOffscreenSession(request.sid);
    return await requestOffscreenPipelineOnce<TResult>(request);
  }
}

async function requestOffscreenPipelineOnce<TResult>(
  request: Omit<OffscreenPipelineRequest, "kind" | "requestId">
): Promise<TResult> {
  const port = await ensureOffscreenPortReady();
  const requestId = `off-${Date.now()}-${offscreenRequestSeq}`;
  const timeoutMs = resolveOffscreenRequestTimeoutMs(request.op);
  offscreenRequestSeq += 1;

  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOffscreenRequests.delete(requestId);
      reject(new Error(`Timed out waiting for offscreen response: ${request.op}`));
    }, timeoutMs);

    pendingOffscreenRequests.set(requestId, {
      resolve,
      reject,
      timeout
    });

    try {
      port.postMessage({
        kind: "sw.pipeline-request",
        requestId,
        ...request
      });
    } catch (error) {
      clearTimeout(timeout);
      pendingOffscreenRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return result as TResult;
}

function shouldRetryOffscreenRequest(
  request: Omit<OffscreenPipelineRequest, "kind" | "requestId">,
  error: unknown
): boolean {
  if (request.op === "start") {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("Pipeline session not found") ||
    message.includes("Offscreen pipeline disconnected") ||
    message.includes("Offscreen pipeline is unavailable")
  );
}

function resolveOffscreenRequestTimeoutMs(requestOp: OffscreenPipelineRequest["op"]): number {
  if (requestOp === "exportDownload") {
    return OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS;
  }

  return OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS;
}

async function ensureOffscreenPortReady(): Promise<PortLike> {
  if (offscreenPort) {
    return offscreenPort;
  }

  await ensureOffscreenDocument();

  for (let attempt = 0; attempt < OFFSCREEN_PORT_READY_MAX_ATTEMPTS; attempt += 1) {
    if (offscreenPort) {
      return offscreenPort;
    }

    await wait(OFFSCREEN_PORT_READY_WAIT_MS);
  }

  throw new Error("Offscreen pipeline is unavailable.");
}

function handleOffscreenRuntimeMessage(rawMessage: unknown, port: PortLike): boolean {
  if (port.name !== PORT_NAMES.offscreen) {
    return false;
  }

  if (rawMessage === null || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    return false;
  }

  const kind = (rawMessage as { kind?: unknown }).kind;

  if (kind === "offscreen.ready") {
    notifyOffscreenPipelineStatus();
    return true;
  }

  if (kind !== "offscreen.pipeline-response") {
    return false;
  }

  const response = rawMessage as OffscreenPipelineResponse;
  const pending = pendingOffscreenRequests.get(response.requestId);

  if (!pending) {
    return true;
  }

  clearTimeout(pending.timeout);
  pendingOffscreenRequests.delete(response.requestId);

  if (response.ok) {
    pending.resolve(response.result);
  } else {
    pending.reject(new Error(response.error ?? "Offscreen pipeline request failed."));
  }

  return true;
}

function estimateSessionEventBytes(event: WebBlackboxEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength;
  } catch {
    return 0;
  }
}

function rejectPendingOffscreenRequests(message: string): void {
  for (const pending of pendingOffscreenRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }

  pendingOffscreenRequests.clear();
}

async function recoverAllActiveOffscreenPipelines(): Promise<void> {
  for (const runtime of sessionsByTab.values()) {
    if (runtime.stopping || runtime.stoppedAt) {
      continue;
    }

    await recoverOffscreenSession(runtime.sid);
  }
}

async function recoverOffscreenSession(sid: string): Promise<void> {
  const existing = offscreenSessionRecovery.get(sid);

  if (existing) {
    await existing;
    return;
  }

  const task = (async () => {
    const runtime = sessionsBySid.get(sid);

    if (!runtime || runtime.stopping || runtime.stoppedAt) {
      return;
    }

    await requestOffscreenPipelineOnce<void>({
      op: "start",
      sid,
      session: toSessionMetadata(runtime),
      redactionProfile: runtime.config.redaction
    });
    notifyOffscreenPipelineStatus();
  })()
    .catch((error) => {
      console.warn("[WebBlackbox] failed to recover offscreen pipeline session", {
        sid,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    })
    .finally(() => {
      offscreenSessionRecovery.delete(sid);
    });

  offscreenSessionRecovery.set(sid, task);
  await task;
}

async function attachCdp(runtime: SessionRuntime): Promise<void> {
  try {
    const router = createCdpRouter(createChromeDebuggerTransport());

    const unsubscribeEvent = router.onEvent((event) => {
      const normalizedPayload = normalizeFullModePayload(event.method, event.params ?? {});

      if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
        const payload = asRecord(normalizedPayload);
        const chunk = typeof payload?.chunk === "string" ? payload.chunk : undefined;

        if (chunk && runtime.heapSnapshotCapture) {
          const chunkBytes = new TextEncoder().encode(chunk).byteLength;
          const nextBytes = runtime.heapSnapshotCapture.bytes + chunkBytes;

          if (nextBytes <= HEAP_SNAPSHOT_MAX_BYTES) {
            runtime.heapSnapshotCapture.chunks.push(chunk);
            runtime.heapSnapshotCapture.bytes = nextBytes;
          } else {
            runtime.heapSnapshotCapture.truncated = true;
          }
        }
      }

      ingestRawEvent({
        source: "cdp",
        rawType: event.method,
        tabId: runtime.tabId,
        sid: runtime.sid,
        t: Date.now(),
        mono: monotonicTime(),
        cdpSessionId: event.sessionId,
        payload: normalizedPayload
      });

      if (!FULL_MODE_FOLLOWUP_METHODS.has(event.method)) {
        return;
      }

      enqueue(
        runtime,
        async () => {
          await processFullModeEvent(runtime, event.method, event.params ?? {}, event.sessionId);
        },
        { bestEffort: true }
      );
    });

    const unsubscribeDetach = router.onDetach((event) => {
      if (event.tabId === runtime.tabId) {
        void stopSession(runtime.tabId);
      }
    });

    runtime.removeCdpListeners.push(unsubscribeEvent, unsubscribeDetach);

    await router.attach(runtime.tabId);
    runtime.enabledCdpSessions.clear();
    await router.enableBaseline(runtime.tabId);
    runtime.enabledCdpSessions.add("root");
    await router.enableAutoAttach(runtime.tabId);
    await router.send({ tabId: runtime.tabId }, "DOMStorage.enable").catch(() => undefined);
    await router.send({ tabId: runtime.tabId }, "Performance.enable").catch(() => undefined);

    runtime.cdpRouter = router;

    enqueue(
      runtime,
      async () => {
        await captureFullModeArtifacts(runtime, "session-start");
      },
      { bestEffort: true }
    );

    const screenshotIntervalMs = Math.max(
      FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS,
      normalizeSamplingInterval(
        runtime.config.sampling.screenshotIdleMs,
        DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
      )
    );

    runtime.screenshotInterval = globalThis.setInterval(() => {
      enqueue(
        runtime,
        async () => {
          await captureScreenshot(runtime, "interval");
        },
        { bestEffort: true }
      );
    }, screenshotIntervalMs);
  } catch (error) {
    console.warn("[WebBlackbox] failed to attach debugger", error);
    runtime.cdpRouter = null;
  }
}

async function processFullModeEvent(
  runtime: SessionRuntime,
  method: string,
  params: unknown,
  sessionId?: string
): Promise<void> {
  if (runtime.stopping) {
    return;
  }

  const payload = asRecord(params);

  if (method === "Target.attachedToTarget") {
    const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

    if (childSessionId) {
      await primeChildCdpSession(runtime, childSessionId);
    }

    return;
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

    if (childSessionId) {
      runtime.enabledCdpSessions.delete(childSessionId);
    }

    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const response = asRecord(payload?.response);
    const resourceType = typeof payload?.type === "string" ? payload.type : undefined;

    if (requestId) {
      runtime.requestMeta.set(requestId, {
        url: typeof response?.url === "string" ? response.url : undefined,
        mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
        status: typeof response?.status === "number" ? response.status : undefined,
        resourceType
      });
    }

    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

    if (requestId && shouldCaptureResponseBody(runtime, requestId, payload)) {
      await captureResponseBody(runtime, requestId, sessionId);
    }

    if (requestId) {
      runtime.requestMeta.delete(requestId);
    }

    return;
  }

  if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
    if (method === "Network.loadingFailed") {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

      if (requestId) {
        runtime.requestMeta.delete(requestId);
      }
    }

    if (shouldCaptureIncidentArtifacts(runtime)) {
      await captureIncidentArtifacts(runtime, method);
    }

    return;
  }

  if (method === "Page.frameNavigated" && shouldCaptureNavigationSnapshot(runtime)) {
    await captureDomSnapshot(runtime, "navigation");
  }
}

async function primeChildCdpSession(
  runtime: SessionRuntime,
  childSessionId: string
): Promise<void> {
  if (!runtime.cdpRouter || runtime.enabledCdpSessions.has(childSessionId)) {
    return;
  }

  runtime.enabledCdpSessions.add(childSessionId);

  try {
    await runtime.cdpRouter.enableBaseline(runtime.tabId, childSessionId);
    await runtime.cdpRouter.enableAutoAttach(runtime.tabId, undefined, childSessionId);
    await runtime.cdpRouter
      .send({ tabId: runtime.tabId, sessionId: childSessionId }, "DOMStorage.enable")
      .catch(() => undefined);
    await runtime.cdpRouter
      .send({ tabId: runtime.tabId, sessionId: childSessionId }, "Performance.enable")
      .catch(() => undefined);
  } catch {
    runtime.enabledCdpSessions.delete(childSessionId);
  }
}

async function captureResponseBody(
  runtime: SessionRuntime,
  requestId: string,
  sessionId?: string
): Promise<void> {
  if (!runtime.cdpRouter || runtime.stopping) {
    return;
  }

  const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
  const response = await runtime.cdpRouter
    .send<{
      body?: string;
      base64Encoded?: boolean;
    }>(target, "Network.getResponseBody", { requestId })
    .catch(() => undefined);

  if (!response?.body) {
    return;
  }

  const metadata = runtime.requestMeta.get(requestId);
  const normalizedMime = normalizeMimeType(metadata?.mimeType ?? null);
  const captureRule = resolveFullBodyCaptureRule(runtime, metadata?.url ?? "", normalizedMime);

  if (!captureRule.enabled) {
    return;
  }

  const transformed = transformResponseBodyForCapture({
    body: response.body,
    base64Encoded: response.base64Encoded === true,
    redactPatterns: runtime.config.redaction.redactBodyPatterns,
    maxBytes: captureRule.maxBytes,
    redactionToken: LITE_BODY_REDACTED_TOKEN,
    decodeBase64
  });
  const hash = await runtime.pipeline.putBlob(
    metadata?.mimeType ?? "application/octet-stream",
    transformed.sampledBytes
  );

  runtime.responseBodyCaptures += 1;

  ingestRawEvent({
    source: "system",
    rawType: "cdp.network.body",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      reqId: requestId,
      contentHash: hash,
      mimeType: metadata?.mimeType,
      size: transformed.originalBytes.byteLength,
      sampledSize: transformed.sampledBytes.byteLength,
      redacted: transformed.redacted,
      truncated: transformed.truncated
    }
  });
}

function shouldCaptureResponseBody(
  runtime: SessionRuntime,
  requestId: string,
  loadingFinishedPayload: Record<string, unknown> | null
): boolean {
  if (runtime.mode !== "full" || runtime.stopping) {
    return false;
  }

  if (runtime.responseBodyCaptures >= FULL_MODE_BODY_CAPTURE_MAX_PER_SESSION) {
    return false;
  }

  const metadata = runtime.requestMeta.get(requestId);

  if (!metadata) {
    return false;
  }

  if (metadata.resourceType && SKIPPED_FULL_MODE_BODY_RESOURCE_TYPES.has(metadata.resourceType)) {
    return false;
  }

  const normalizedMime = normalizeMimeType(metadata.mimeType ?? null);
  const captureRule = resolveFullBodyCaptureRule(runtime, metadata.url ?? "", normalizedMime);

  if (!captureRule.enabled) {
    return false;
  }

  if (normalizedMime && !isTextualMimeType(normalizedMime)) {
    return false;
  }

  if (!normalizedMime && !isLikelyTextualResourceType(metadata.resourceType)) {
    return false;
  }

  const encodedDataLength = asFiniteNumber(loadingFinishedPayload?.encodedDataLength);

  if (
    encodedDataLength !== null &&
    Number.isFinite(encodedDataLength) &&
    encodedDataLength > captureRule.maxBytes * 2
  ) {
    return false;
  }

  const now = Date.now();
  const threshold = now - 60_000;
  runtime.responseBodyCaptureTimestamps = runtime.responseBodyCaptureTimestamps.filter(
    (timestamp) => timestamp >= threshold
  );

  if (runtime.responseBodyCaptureTimestamps.length >= FULL_MODE_BODY_CAPTURE_MAX_PER_MINUTE) {
    return false;
  }

  runtime.responseBodyCaptureTimestamps.push(now);
  return true;
}

function isTextualMimeType(mimeType: string): boolean {
  return isTextualMimeTypeUtil(mimeType);
}

function isLikelyTextualResourceType(resourceType?: string): boolean {
  return isLikelyTextualResourceTypeUtil(resourceType);
}

function shouldCaptureIncidentArtifacts(runtime: SessionRuntime): boolean {
  if (runtime.stopping) {
    return false;
  }

  const now = Date.now();

  if (now - runtime.lastIncidentCaptureAt < FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS) {
    return false;
  }

  runtime.lastIncidentCaptureAt = now;
  return true;
}

async function captureIncidentArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureScreenshot(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ]);
}

function shouldCaptureNavigationSnapshot(runtime: SessionRuntime): boolean {
  if (runtime.stopping) {
    return false;
  }

  if (runtime.queueDepth >= Math.floor(BEST_EFFORT_QUEUE_MAX_PENDING / 4)) {
    return false;
  }

  const now = Date.now();

  if (now - runtime.lastNavigationSnapshotAt < FULL_MODE_NAV_SNAPSHOT_COOLDOWN_MS) {
    return false;
  }

  runtime.lastNavigationSnapshotAt = now;
  return true;
}

function handleFreezeNotice(runtime: SessionRuntime, reason: FreezeReason): void {
  if (runtime.stopping) {
    return;
  }

  const now = Date.now();
  const lastNotifiedAt = runtime.lastFreezeNotices.get(reason) ?? Number.NEGATIVE_INFINITY;

  if (now - lastNotifiedAt < FREEZE_NOTICE_COOLDOWN_MS) {
    return;
  }

  runtime.lastFreezeNotices.set(reason, now);
  broadcast({ kind: "sw.freeze", sid: runtime.sid, reason });
  void setFreezeBadge();
}

async function captureFullModeArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
  const tasks: Array<Promise<void>> = [
    captureScreenshot(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ];

  if (reason !== "session-start") {
    tasks.push(captureDomSnapshot(runtime, reason), captureStorageSnapshots(runtime, reason));
  }

  if (shouldCaptureAdvancedProfiles(reason)) {
    tasks.push(captureAdvancedProfiles(runtime, reason));
  }

  await Promise.allSettled(tasks);
}

async function captureScreenshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const screenshot = await runtime.cdpRouter
    .send<{ data?: string }>({ tabId: runtime.tabId }, "Page.captureScreenshot", {
      format: "webp",
      quality: 62,
      fromSurface: true
    })
    .catch(() => undefined);

  if (!screenshot?.data) {
    return;
  }

  const bytes = decodeBase64(screenshot.data);
  const hash = await runtime.pipeline.putBlob("image/webp", bytes);
  const viewport = runtime.lastViewport;
  const pointer =
    runtime.lastPointer && Date.now() - runtime.lastPointer.t <= POINTER_STALE_MS
      ? runtime.lastPointer
      : null;

  ingestRawEvent({
    source: "system",
    rawType: "cdp.screen.screenshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      shotId: hash,
      format: "webp",
      quality: 62,
      w: viewport?.width,
      h: viewport?.height,
      viewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            dpr: viewport.dpr
          }
        : undefined,
      pointer: pointer
        ? {
            x: pointer.x,
            y: pointer.y,
            t: pointer.t,
            mono: pointer.mono
          }
        : undefined,
      size: bytes.byteLength,
      reason
    }
  });
}

async function captureDomSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const snapshot = await runtime.cdpRouter
    .send<Record<string, unknown>>({ tabId: runtime.tabId }, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includeDOMRects: false,
      includePaintOrder: false
    })
    .catch(() => undefined);

  if (!snapshot) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents : [];
  const firstDocument = documents[0] as Record<string, unknown> | undefined;
  const nodes = firstDocument ? asRecord(firstDocument.nodes) : null;
  const nodeNameArray = Array.isArray(nodes?.nodeName) ? nodes.nodeName : [];

  ingestRawEvent({
    source: "system",
    rawType: "cdp.dom.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      snapshotId: `D-${Date.now()}`,
      contentHash: hash,
      source: "cdp",
      nodeCount: nodeNameArray.length,
      reason
    }
  });
}

async function captureStorageSnapshots(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const cookies = await runtime.cdpRouter
    .send<{ cookies?: unknown[] }>({ tabId: runtime.tabId }, "Storage.getCookies")
    .catch(() => undefined);

  if (cookies?.cookies) {
    const cookieNames = cookies.cookies
      .map((entry) => asString(asRecord(entry)?.name))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS);
    const bytes = new TextEncoder().encode(JSON.stringify(cookieNames));
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.cookie.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: cookies.cookies.length,
        sampledCount: cookieNames.length,
        truncated: cookies.cookies.length > cookieNames.length,
        redacted: true,
        reason
      }
    });
  }

  const localStorageData = await evaluateExpression(runtime, FULL_MODE_LOCAL_STORAGE_SNAPSHOT_EXPR);

  if (typeof localStorageData === "string") {
    const bytes = new TextEncoder().encode(localStorageData);
    const hash = await runtime.pipeline.putBlob("application/json", bytes);
    const parsed = parseStorageSnapshotMeta(localStorageData);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.local.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: parsed?.count,
        sampledCount: parsed?.sampledCount,
        truncated: parsed?.truncated,
        reason
      }
    });
  }

  const origin = await evaluateExpression(runtime, "location.origin");

  if (typeof origin === "string") {
    const dbNames = await runtime.cdpRouter
      .send<{ databaseNames?: string[] }>(
        { tabId: runtime.tabId },
        "IndexedDB.requestDatabaseNames",
        {
          securityOrigin: origin
        }
      )
      .catch(() => undefined);

    if (dbNames?.databaseNames) {
      const bytes = new TextEncoder().encode(JSON.stringify(dbNames.databaseNames));
      const hash = await runtime.pipeline.putBlob("application/json", bytes);

      ingestRawEvent({
        source: "system",
        rawType: "cdp.storage.idb.snapshot",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          origin,
          schemaHash: hash,
          mode: "schema-only",
          reason
        }
      });
    }
  }
}

async function captureTraceMetrics(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const metrics = await runtime.cdpRouter
    .send<Record<string, unknown>>({ tabId: runtime.tabId }, "Performance.getMetrics")
    .catch(() => undefined);

  if (!metrics) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(metrics));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.trace",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      traceHash: hash,
      durationMs: 0,
      mode: "reportEvents",
      categories: "metrics",
      reason
    }
  });
}

async function captureAdvancedProfiles(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureCpuProfile(runtime, reason),
    captureHeapSnapshot(runtime, reason)
  ]);
}

async function captureCpuProfile(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  await runtime.cdpRouter.send({ tabId: runtime.tabId }, "Profiler.enable").catch(() => undefined);
  const started = await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "Profiler.start")
    .then(() => true)
    .catch(() => false);

  if (!started) {
    return;
  }

  await wait(CPU_PROFILE_SAMPLE_MS);

  const profileResult = await runtime.cdpRouter
    .send<{ profile?: unknown }>({ tabId: runtime.tabId }, "Profiler.stop")
    .catch(() => undefined);

  if (!profileResult?.profile) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(profileResult.profile));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.cpu.profile",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      profileHash: hash,
      sampleMs: CPU_PROFILE_SAMPLE_MS,
      size: bytes.byteLength,
      reason
    }
  });

  await runtime.cdpRouter.send({ tabId: runtime.tabId }, "Profiler.disable").catch(() => undefined);
}

async function captureHeapSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  runtime.heapSnapshotCapture = {
    chunks: [],
    bytes: 0,
    truncated: false
  };

  await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.enable")
    .catch(() => undefined);

  const completed = await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: true
    })
    .then(() => true)
    .catch(() => false);

  const snapshot = runtime.heapSnapshotCapture;
  runtime.heapSnapshotCapture = null;

  if (!completed || !snapshot || snapshot.chunks.length === 0) {
    await runtime.cdpRouter
      .send({ tabId: runtime.tabId }, "HeapProfiler.disable")
      .catch(() => undefined);
    return;
  }

  const joined = snapshot.chunks.join("");
  const bytes = new TextEncoder().encode(joined);
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.heap.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      snapshotHash: hash,
      size: bytes.byteLength,
      chunkCount: snapshot.chunks.length,
      truncated: snapshot.truncated,
      reason
    }
  });

  await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.disable")
    .catch(() => undefined);
}

function shouldCaptureAdvancedProfiles(reason: string): boolean {
  return reason === "manual";
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function evaluateExpression(runtime: SessionRuntime, expression: string): Promise<unknown> {
  if (!runtime.cdpRouter) {
    return undefined;
  }

  const result = await runtime.cdpRouter
    .send<{
      result?: {
        value?: unknown;
      };
    }>({ tabId: runtime.tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    .catch(() => undefined);

  return result?.result?.value;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    return new TextEncoder().encode(value);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");

  if (commaIndex <= 5) {
    return null;
  }

  const header = dataUrl.slice(5, commaIndex);
  const encoded = dataUrl.slice(commaIndex + 1);
  const segments = header.split(";");
  const mime = segments[0] && segments[0].length > 0 ? segments[0] : "application/octet-stream";
  const isBase64 = segments.includes("base64");

  try {
    if (isBase64) {
      return {
        mime,
        bytes: decodeBase64(encoded)
      };
    }

    return {
      mime,
      bytes: new TextEncoder().encode(decodeURIComponent(encoded))
    };
  } catch {
    return null;
  }
}

function resolveLiteBodyCaptureRule(
  runtime: SessionRuntime,
  url: string,
  mimeType: string | undefined
): LiteBodyCaptureRule {
  return resolveLiteBodyCaptureRuleUtil(runtime.config, url, mimeType, {
    defaultMimeAllowlist: LITE_DEFAULT_BODY_MIME_ALLOWLIST,
    fallbackMaxBytes: NETWORK_BODY_MAX_BYTES
  });
}

function resolveFullBodyCaptureRule(
  runtime: SessionRuntime,
  url: string,
  mimeType: string | undefined
): LiteBodyCaptureRule {
  return resolveFullBodyCaptureRuleUtil(runtime.config, url, mimeType, {
    defaultMimeAllowlist: LITE_DEFAULT_BODY_MIME_ALLOWLIST,
    fallbackMaxBytes: NETWORK_BODY_MAX_BYTES
  });
}

function isMimeAllowed(allowlist: string[], mimeType: string | undefined): boolean {
  return isMimeAllowedUtil(allowlist, mimeType);
}

function normalizeMimeType(value: string | null): string | undefined {
  return normalizeMimeTypeUtil(value);
}

function redactBodyText(
  value: string,
  patterns: string[]
): {
  value: string;
  redacted: boolean;
} {
  return redactBodyTextUtil(value, patterns, LITE_BODY_REDACTED_TOKEN);
}

function normalizeFullModePayload(method: string, params: unknown): unknown {
  const payload = asRecord(params);

  if (!payload) {
    return params;
  }

  if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
    const response = asRecord(payload.response);
    const rawData = typeof response?.payloadData === "string" ? response.payloadData : "";

    return {
      ...payload,
      direction: method.endsWith("Sent") ? "sent" : "received",
      frame: {
        opcode: typeof response?.opcode === "number" ? response.opcode : undefined,
        masked: response?.mask === true,
        payloadLength: rawData.length,
        payloadPreview: rawData.slice(0, 512)
      }
    };
  }

  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate <= 0) {
    return undefined;
  }

  return Math.max(1, Math.round(candidate));
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate < 0) {
    return undefined;
  }

  return Math.max(0, Math.round(candidate));
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      continue;
    }

    output.push(entry);

    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function parseStorageSnapshotMeta(
  serialized: string
): { count?: number; sampledCount?: number; truncated?: boolean } | null {
  try {
    const parsed = JSON.parse(serialized) as {
      count?: unknown;
      entries?: unknown;
      truncated?: unknown;
    };
    const count = normalizeNonNegativeInt(parsed.count);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

    return {
      count,
      sampledCount: entries.length,
      truncated: parsed.truncated === true
    };
  } catch {
    return null;
  }
}

function encodeTextWithByteLimit(
  value: string,
  maxBytes: number
): { bytes: Uint8Array; truncated: boolean } {
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(value);

  if (fullBytes.byteLength <= maxBytes) {
    return {
      bytes: fullBytes,
      truncated: false
    };
  }

  const roughRatio = Math.max(0.05, maxBytes / fullBytes.byteLength);
  let targetChars = Math.max(1, Math.floor(value.length * roughRatio));
  let clipped = value.slice(0, targetChars);
  let clippedBytes = encoder.encode(clipped);

  while (clippedBytes.byteLength > maxBytes && targetChars > 1) {
    targetChars = Math.max(1, Math.floor(targetChars * 0.9));
    clipped = value.slice(0, targetChars);
    clippedBytes = encoder.encode(clipped);
  }

  return {
    bytes: clippedBytes,
    truncated: true
  };
}

function normalizeScreenshotViewport(
  value: unknown
): { width: number; height: number; dpr: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const width = normalizePositiveInt(row.width);
  const height = normalizePositiveInt(row.height);
  const dpr = asFiniteNumber(row.dpr);

  if (!width || !height || dpr === null || dpr <= 0) {
    return undefined;
  }

  return {
    width,
    height,
    dpr: Number(dpr.toFixed(3))
  };
}

function normalizeScreenshotPointer(
  value: unknown
): { x: number; y: number; t?: number; mono?: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const x = asFiniteNumber(row.x);
  const y = asFiniteNumber(row.y);
  const t = asFiniteNumber(row.t);
  const mono = asFiniteNumber(row.mono);

  if (x === null || y === null) {
    return undefined;
  }

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    t: t === null ? undefined : t,
    mono: mono === null ? undefined : mono
  };
}

function normalizeSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  return Math.max(250, Math.round(value));
}

function resolveExportPolicy(value: unknown): ExportPolicy {
  const row = asRecord(value);
  const includeScreenshots =
    typeof row?.includeScreenshots === "boolean"
      ? row.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;

  return {
    includeScreenshots,
    maxArchiveBytes: normalizeExportBoundedInt(
      row?.maxArchiveBytes,
      DEFAULT_EXPORT_POLICY.maxArchiveBytes,
      64 * 1024,
      5 * 1024 * 1024 * 1024
    ),
    recentWindowMs: normalizeExportBoundedInt(
      row?.recentWindowMs,
      DEFAULT_EXPORT_POLICY.recentWindowMs,
      1 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000
    )
  };
}

function normalizeExportBoundedInt(
  candidate: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const value = asFiniteNumber(candidate);

  if (value === null || value <= 0) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function toStatusSampling(runtime: SessionRuntime): RecordingSampling {
  const sampling = runtime.config.sampling;

  return {
    mousemoveHz: Math.max(1, Math.round(asFiniteNumber(sampling.mousemoveHz) ?? 20)),
    scrollHz: Math.max(1, Math.round(asFiniteNumber(sampling.scrollHz) ?? 15)),
    domFlushMs: normalizeSamplingInterval(sampling.domFlushMs, 100),
    snapshotIntervalMs: normalizeSamplingInterval(sampling.snapshotIntervalMs, 20_000),
    screenshotIdleMs: normalizeSamplingInterval(sampling.screenshotIdleMs, 8_000)
  };
}

function shouldInjectHooksForMode(mode: CaptureMode): boolean {
  return mode === "lite" || mode === "full";
}

function normalizePipelineExportDownloadResult(raw: unknown): PipelineExportDownloadResult {
  const row = asRecord(raw);

  if (!row) {
    throw new Error("Invalid offscreen export payload.");
  }

  const fileName =
    typeof row.fileName === "string" && row.fileName.length > 0
      ? row.fileName
      : "session.webblackbox";

  const sizeBytes = asFiniteNumber(row.sizeBytes);
  const downloadUrl =
    typeof row.downloadUrl === "string" && row.downloadUrl.length > 0 ? row.downloadUrl : null;

  if (sizeBytes === null || sizeBytes <= 0) {
    throw new Error("Offscreen export payload did not include valid archive size.");
  }

  if (!downloadUrl) {
    throw new Error("Offscreen export payload did not include download URL.");
  }

  return {
    fileName,
    sizeBytes: Math.round(sizeBytes),
    downloadUrl,
    downloadId: asFiniteNumber(row.downloadId) ?? undefined,
    integrity: normalizeHashesManifest(row.integrity)
  };
}

function normalizeHashesManifest(value: unknown): HashesManifest {
  const row = asRecord(value);
  const filesRow = asRecord(row?.files);
  const files: Record<string, string> = {};

  if (filesRow) {
    for (const [name, digest] of Object.entries(filesRow)) {
      if (typeof digest === "string") {
        files[name] = digest;
      }
    }
  }

  return {
    manifestSha256: typeof row?.manifestSha256 === "string" ? row.manifestSha256 : "",
    files
  };
}

async function ensureInjectedHooks(tabId: number): Promise<void> {
  await chromeApi?.scripting
    ?.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      files: ["injected.js"]
    })
    .catch(() => undefined);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chromeApi?.offscreen?.createDocument || !chromeApi.runtime?.getURL) {
    return;
  }

  const offscreenUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
  const contexts = chromeApi.runtime.getContexts
    ? await chromeApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      })
    : [];

  if (contexts.length > 0) {
    return;
  }

  await chromeApi.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "WebBlackbox uses offscreen document for persistent local recording pipeline."
  });
}

function enqueue(
  runtime: SessionRuntime,
  task: () => Promise<void>,
  options: { bestEffort?: boolean } = {}
): boolean {
  if (options.bestEffort) {
    if (runtime.stopping || runtime.queueDepth >= BEST_EFFORT_QUEUE_MAX_PENDING) {
      runtime.droppedBestEffortTasks += 1;

      if (shouldLogPerf() && runtime.droppedBestEffortTasks % 50 === 0) {
        console.info("[WebBlackbox][perf] dropped best-effort queue tasks", {
          sid: runtime.sid,
          dropped: runtime.droppedBestEffortTasks,
          queueDepth: runtime.queueDepth
        });
      }

      return false;
    }
  }

  runtime.queueDepth += 1;
  runtime.queue = runtime.queue
    .then(task)
    .catch((error) => {
      console.warn("[WebBlackbox] session queue error", error);
    })
    .finally(() => {
      runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
    });

  return true;
}

function enqueueWithResult<TResult>(
  runtime: SessionRuntime,
  task: () => Promise<TResult>
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    enqueue(runtime, async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function teardownCaptureInstrumentation(runtime: SessionRuntime): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.cdpRouter) {
    await runtime.cdpRouter.detach(runtime.tabId).catch(() => undefined);

    for (const dispose of runtime.removeCdpListeners) {
      dispose();
    }

    runtime.removeCdpListeners = [];
    runtime.cdpRouter.dispose();
    runtime.cdpRouter = null;
  }

  runtime.enabledCdpSessions.clear();
  runtime.requestMeta.clear();
  runtime.responseBodyCaptureTimestamps.length = 0;

  if (runtime.screenshotInterval !== null) {
    clearInterval(runtime.screenshotInterval);
    runtime.screenshotInterval = null;
  }
}

function scheduleStoppedRuntimeCleanup(runtime: SessionRuntime): void {
  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
  }

  runtime.cleanupTimer = setTimeout(() => {
    void disposeStoppedSession(runtime);
  }, STOPPED_SESSION_TTL_MS);
}

async function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (!sessionsBySid.has(runtime.sid)) {
    return;
  }

  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = null;
  }

  await flushBufferedPipelineEvents(runtime);
  await runtime.queue;
  await runtime.pipeline.flush().catch(() => undefined);
  await runtime.pipeline
    .close({
      purge: true
    })
    .catch(() => undefined);
  sessionsBySid.delete(runtime.sid);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await closeOffscreenIfUnused();
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function closeOffscreenIfUnused(): Promise<void> {
  if (sessionsBySid.size > 0) {
    return;
  }

  await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
}

async function downloadExportedBundle(
  exported: PipelineExportDownloadResult,
  saveAs: boolean
): Promise<void> {
  if (!chromeApi?.downloads?.download) {
    throw new Error("Downloads API is unavailable in service worker context.");
  }

  const downloadId = await chromeApi.downloads.download({
    url: exported.downloadUrl,
    filename: `webblackbox/${exported.fileName}`,
    saveAs
  });

  exported.downloadId = downloadId;
}

function toSessionListItem(runtime: SessionRuntime): SessionListItem {
  const activeRuntime = sessionsByTab.get(runtime.tabId);
  const active = activeRuntime?.sid === runtime.sid;

  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    active,
    stoppedAt: runtime.stoppedAt,
    url: runtime.url,
    title: runtime.title,
    ringBufferMinutes: runtime.config.ringBufferMinutes,
    eventCount: runtime.capturedEventCount,
    errorCount: runtime.capturedErrorCount,
    budgetAlertCount: runtime.budgetAlertCount,
    sizeBytes: runtime.capturedSizeBytes,
    tags: [...runtime.tags],
    note: runtime.note
  };
}

function toSessionMetadata(runtime: SessionRuntime): SessionMetadata {
  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    startedAt: runtime.startedAt,
    mode: runtime.mode,
    url: runtime.url,
    title: runtime.title,
    tags: [...runtime.tags]
  };
}

async function resolveTabSessionMetadata(
  tabId: number
): Promise<Pick<SessionMetadata, "url" | "title">> {
  const fallbackUrl = `tab:${tabId}`;

  if (!chromeApi?.tabs?.get) {
    return {
      url: fallbackUrl
    };
  }

  try {
    const tab = await chromeApi.tabs.get(tabId);
    const url = typeof tab?.url === "string" && tab.url.length > 0 ? tab.url : fallbackUrl;
    const title =
      typeof tab?.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : undefined;

    return {
      url,
      title
    };
  } catch {
    return {
      url: fallbackUrl
    };
  }
}

function updateSessionMetadataFromEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  if (
    event.type !== "nav.commit" &&
    event.type !== "nav.history.push" &&
    event.type !== "nav.history.replace" &&
    event.type !== "nav.hash"
  ) {
    return;
  }

  const payload = asRecord(event.data);
  const frame = asRecord(payload?.frame);
  const nextUrl = asString(payload?.url) ?? asString(frame?.url);
  const nextTitle = asString(payload?.title) ?? asString(payload?.documentTitle);
  let changed = false;

  if (nextUrl && nextUrl !== runtime.url) {
    runtime.url = nextUrl;
    changed = true;
  }

  if (nextTitle && nextTitle.trim().length > 0 && nextTitle !== runtime.title) {
    runtime.title = nextTitle.trim();
    changed = true;
  }

  if (changed) {
    pushSessionList();
  }
}

function pushSessionList(): void {
  const sessions: SessionListItem[] = [...sessionsBySid.values()]
    .map((runtime) => toSessionListItem(runtime))
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);

      if (activeDiff !== 0) {
        return activeDiff;
      }

      return right.startedAt - left.startedAt;
    });

  broadcast({
    kind: "sw.session-list",
    sessions
  });
}

function broadcast(message: ExtensionOutboundMessage): void {
  for (const port of connectedPorts) {
    try {
      port.postMessage(message);
    } catch (error) {
      connectedPorts.delete(port);

      if (offscreenPort === port) {
        offscreenPort = null;
      }

      logPortSendFailure(message.kind, error, {
        portName: port.name
      });
    }
  }
}

async function loadRecorderConfig(mode: CaptureMode): Promise<typeof DEFAULT_RECORDER_CONFIG> {
  const baseConfig = resolveModeBaseConfig(mode);

  const storedValues = await chromeApi?.storage?.local?.get(OPTIONS_STORAGE_KEY);
  const stored = asRecord(storedValues?.[OPTIONS_STORAGE_KEY]);

  if (!stored) {
    return baseConfig;
  }

  const sampling = asRecord(stored.sampling);
  const redaction = asRecord(stored.redaction);

  const mergedConfig = {
    ...baseConfig,
    ...stored,
    mode,
    sampling: {
      ...baseConfig.sampling,
      ...sampling
    },
    redaction: {
      ...baseConfig.redaction,
      ...redaction
    },
    sitePolicies: Array.isArray(stored.sitePolicies)
      ? (stored.sitePolicies as typeof baseConfig.sitePolicies)
      : baseConfig.sitePolicies
  };

  return applyModeRuntimeConfig(mode, mergedConfig);
}

async function loadPerformanceBudgetConfig(): Promise<PerformanceBudgetConfig> {
  const storedValues = await chromeApi?.storage?.local?.get(OPTIONS_STORAGE_KEY);
  const stored = asRecord(storedValues?.[OPTIONS_STORAGE_KEY]);

  if (!stored) {
    return { ...DEFAULT_PERFORMANCE_BUDGET };
  }

  return normalizePerformanceBudget(stored.performanceBudget);
}

function resolveModeBaseConfig(mode: CaptureMode): typeof DEFAULT_RECORDER_CONFIG {
  const base: typeof DEFAULT_RECORDER_CONFIG = {
    ...DEFAULT_RECORDER_CONFIG,
    mode
  };

  if (mode === "full") {
    return {
      ...base,
      freezeOnNetworkFailure: false,
      freezeOnLongTaskSpike: false,
      sampling: {
        ...base.sampling,
        mousemoveHz: 12,
        scrollHz: 10,
        domFlushMs: 180,
        snapshotIntervalMs: 30_000,
        screenshotIdleMs: 12_000,
        bodyCaptureMaxBytes: FULL_MODE_BODY_CAPTURE_MAX_BYTES
      }
    };
  }

  return {
    ...base,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...base.sampling,
      mousemoveHz: 14,
      scrollHz: 10,
      domFlushMs: 160,
      snapshotIntervalMs: 30_000,
      screenshotIdleMs: 12_000,
      bodyCaptureMaxBytes: LITE_MODE_BODY_CAPTURE_MAX_BYTES
    }
  };
}

function applyModeRuntimeConfig(
  mode: CaptureMode,
  config: typeof DEFAULT_RECORDER_CONFIG
): typeof DEFAULT_RECORDER_CONFIG {
  if (mode === "full" || mode === "lite") {
    return {
      ...config,
      freezeOnNetworkFailure: false,
      freezeOnLongTaskSpike: false
    };
  }

  return config;
}

async function updateSessionAnnotation(
  sid: string,
  tagsInput: unknown,
  noteInput: unknown
): Promise<void> {
  const tags = normalizeSessionTags(tagsInput);
  const note = normalizeSessionNote(noteInput);
  const runtime = sessionsBySid.get(sid);

  if (runtime) {
    runtime.tags = [...tags];
    runtime.note = note;
  }

  sessionAnnotations.set(sid, {
    tags: [...tags],
    note
  });

  await persistSessionAnnotations().catch(() => undefined);
  pushSessionList();
}

function getSessionAnnotation(sid: string): SessionAnnotation {
  const annotation = sessionAnnotations.get(sid);

  if (!annotation) {
    return {
      tags: []
    };
  }

  return {
    tags: [...annotation.tags],
    note: annotation.note
  };
}

async function loadSessionAnnotations(): Promise<void> {
  sessionAnnotations.clear();

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local
    .get(SESSION_ANNOTATIONS_STORAGE_KEY)
    .catch(() => undefined);
  const raw = asRecord(values?.[SESSION_ANNOTATIONS_STORAGE_KEY]);

  if (!raw) {
    return;
  }

  for (const [sid, payload] of Object.entries(raw)) {
    const row = asRecord(payload);
    const tags = normalizeSessionTags(row?.tags);
    const note = normalizeSessionNote(row?.note);

    sessionAnnotations.set(sid, {
      tags,
      note
    });
  }
}

async function persistSessionAnnotations(): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    return;
  }

  const serialized: Record<string, SessionAnnotation> = {};

  for (const [sid, annotation] of sessionAnnotations.entries()) {
    serialized[sid] = {
      tags: [...annotation.tags],
      note: annotation.note
    };
  }

  await chromeApi.storage.local.set({
    [SESSION_ANNOTATIONS_STORAGE_KEY]: serialized
  });
}

function normalizeSessionTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const raw of input) {
    if (typeof raw !== "string") {
      continue;
    }

    const normalized = raw.trim().slice(0, 40);

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);

    if (tags.length >= 12) {
      break;
    }
  }

  return tags;
}

function normalizeSessionNote(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const normalized = input.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 500);
}

async function persistRuntimeState(): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    return;
  }

  const sessions = [...sessionsByTab.values()].map((runtime) => ({
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt
  }));

  await chromeApi.storage.local.set({
    [ACTIVE_SESSION_STORAGE_KEY]: sessions
  });
}

async function restoreRuntimeState(): Promise<void> {
  await loadSessionAnnotations();

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
  const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];

  if (Array.isArray(persisted) && persisted.length > 0) {
    await chromeApi.storage.local
      .set({
        [ACTIVE_SESSION_STORAGE_KEY]: []
      })
      .catch(() => undefined);

    for (const item of persisted) {
      const row = asRecord(item);
      const tabId = typeof row?.tabId === "number" ? row.tabId : undefined;

      if (typeof tabId === "number") {
        await notifyTabStatus(tabId, false);
      }
    }
  }

  await setIdleBadge();
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

function notifyOffscreenPipelineStatus(): void {
  const port = offscreenPort;

  if (!port) {
    return;
  }

  try {
    port.postMessage({
      kind: "sw.pipeline-status",
      activeSessions: sessionsByTab.size,
      sessions: [...sessionsByTab.values()].map((runtime) => ({
        sid: runtime.sid,
        tabId: runtime.tabId,
        mode: runtime.mode,
        startedAt: runtime.startedAt,
        active: true,
        ringBufferMinutes: runtime.config.ringBufferMinutes,
        eventCount: runtime.capturedEventCount,
        errorCount: runtime.capturedErrorCount,
        budgetAlertCount: runtime.budgetAlertCount,
        sizeBytes: runtime.capturedSizeBytes,
        tags: [...runtime.tags],
        note: runtime.note
      })),
      updatedAt: Date.now()
    });
  } catch (error) {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
    }

    logPortSendFailure("sw.pipeline-status", error, {
      activeSessions: sessionsByTab.size
    });
  }
}

async function notifyTabStatus(
  tabId: number,
  active: boolean,
  sid?: string,
  mode?: CaptureMode,
  sampling?: RecordingSampling
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  await chromeApi.tabs
    .sendMessage(tabId, {
      kind: "sw.recording-status",
      active,
      sid,
      mode,
      sampling
    })
    .catch(() => undefined);
}

async function relayMarkerCommand(): Promise<void> {
  const activeTabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  const tabId = activeTabs[0]?.id;

  if (typeof tabId !== "number") {
    return;
  }

  await chromeApi?.tabs?.sendMessage(tabId, { kind: "sw.marker-command" }).catch(() => undefined);
}

async function resolveUiActionTabId(tabId?: number): Promise<number | undefined> {
  if (typeof tabId === "number") {
    return tabId;
  }

  const activeTabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  const activeTabId = activeTabs[0]?.id;

  if (typeof activeTabId === "number") {
    return activeTabId;
  }

  return sessionsByTab.keys().next().value;
}

function parseInboundMessage(message: unknown): ExtensionInboundMessage | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const kind = (message as { kind?: unknown }).kind;

  if (typeof kind !== "string") {
    return null;
  }

  return message as ExtensionInboundMessage;
}

async function setIdleBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "WB" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#1864ab" }).catch(() => undefined);
}

async function setRecordingBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "REC" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#c92a2a" }).catch(() => undefined);
}

async function setFreezeBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "ERR" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#9b2226" }).catch(() => undefined);

  if (freezeBadgeTimer !== null) {
    clearTimeout(freezeBadgeTimer);
  }

  freezeBadgeTimer = setTimeout(() => {
    freezeBadgeTimer = null;

    if (sessionsByTab.size > 0) {
      void setRecordingBadge();
      return;
    }

    void setIdleBadge();
  }, FREEZE_BADGE_HIGHLIGHT_MS);
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}

function perfNow(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.now();
}

function shouldLogPerf(): boolean {
  return (
    (globalThis as unknown as Record<string, unknown>)[PERF_LOG_FLAG] === true ||
    (globalThis as unknown as Record<string, unknown>).__WEBBLACKBOX_PERF_LOGS__ === true
  );
}

function shouldLogPortDebug(): boolean {
  return (
    shouldLogPerf() ||
    (globalThis as unknown as Record<string, unknown>)[PORT_DEBUG_LOG_FLAG] === true
  );
}

function logPortSendFailure(
  kind: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (!shouldLogPortDebug()) {
    return;
  }

  console.debug("[WebBlackbox][port] service worker postMessage failed", {
    kind,
    ...context,
    error: error instanceof Error ? error.message : String(error)
  });
}
