import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import type { PipelineResumeState, ScreenRecordingChunkReference } from "@webblackbox/pipeline";
import {
  createSessionId,
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_EXPORT_POLICY,
  DEFAULT_RECORDER_CONFIG,
  sanitizeUrlForPrivacy,
  type CapturePolicy,
  type CaptureMode,
  type ExportPolicy,
  type FreezeReason,
  type HashesManifest,
  type PrivacyScannerFinding,
  type PrivacyScannerFindingKind,
  type PrivacyScannerResult,
  type RedactionProfile,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  createDefaultRecorderPlugins,
  type RawRecorderEvent,
  WebBlackboxRecorder
} from "@webblackbox/recorder";

import { getChromeApi, type MessageSenderLike, type PortLike } from "../shared/chrome-api.js";
import {
  isAuthorizedExtensionPort,
  parseExtensionInboundMessage
} from "../shared/inbound-messages.js";
import {
  PORT_NAMES,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type FullModeVisualCapture,
  type SessionListMessage,
  type SessionListItem
} from "../shared/messages.js";
import {
  DEFAULT_PERFORMANCE_BUDGET,
  normalizePerformanceBudget,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";
import { shouldInjectPageHooksForMode } from "../shared/mode-profile.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  ENTERPRISE_POLICY_STORAGE_KEY,
  isEnterpriseOriginAllowed,
  normalizeEnterprisePolicy,
  type EnterpriseRecorderPolicy
} from "../shared/options-storage.js";
import { resolveModeRecorderConfig } from "../shared/recorder-config.js";
import {
  isLikelyTextualResourceType as isLikelyTextualResourceTypeUtil,
  isMimeAllowed as isMimeAllowedUtil,
  normalizeBodyCaptureMaxBytes as normalizeBodyCaptureMaxBytesUtil,
  isTextualMimeType as isTextualMimeTypeUtil,
  normalizeMimeType as normalizeMimeTypeUtil,
  resolveFullBodyCaptureRule as resolveFullBodyCaptureRuleUtil,
  resolveLiteBodyCaptureRule as resolveLiteBodyCaptureRuleUtil,
  transformResponseBodyForCapture
} from "./body-capture-utils.js";
import {
  bindCapturePolicyToSession,
  evaluateCaptureDocumentScope,
  isCaptureEventFrameAllowed,
  resolveContentScriptInjectionTarget,
  shouldStopForEnterpriseOriginPolicy as shouldStopForEnterpriseOriginPolicyInput
} from "./capture-scope.js";
import {
  clearCdpCaptureScopeState,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  filterCdpSnapshotDocuments,
  forgetCdpRequestScope,
  forgetCdpSessionScope,
  hasDisallowedCdpFrames,
  isCdpSessionWithinScope,
  primeCdpCaptureFrameTree,
  type CdpCaptureScopeState
} from "./cdp-capture-scope.js";
import { withCdpCommandTimeout, type CdpCommandOutcome } from "./cdp-command.js";
import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";
import { shouldUpdateSessionMetadataFromNavigation } from "./navigation-metadata.js";
import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta,
  type RequestMetaEntry
} from "./request-meta.js";
import {
  FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS,
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta,
  type LocalStorageSnapshotMode
} from "./storage-snapshot.js";
import {
  RuntimeCleanupScheduler,
  RuntimeStartCoordinator,
  buildInterruptedScreenRecordingRecoveries,
  capCleanupDeadline,
  compactScreenRecordingChunkHashes,
  createRuntimeStateSnapshot,
  evaluateActiveRuntimeRestoration,
  extractPersistedRuntimeIdentities,
  mergeRuntimeCountersWithSequenceWatermark,
  normalizeOffscreenScreenRecordingStatus,
  parseRuntimeStateSnapshot,
  reconcileScreenRecordingResumeState,
  restoreScreenRecordingChunkHashes,
  type PersistedActiveRuntime,
  type PersistedRuntime,
  type PersistedRuntimeCounters,
  type PersistedScreenRecording,
  type PersistedStoppedRuntime
} from "./runtime-state.js";

type SessionRuntime = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  url: string;
  captureUrl: string;
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
  cdpScope: CdpCaptureScopeState;
  authorizedContentFrames: Set<number>;
  requestMeta: Map<string, RequestMetaEntry>;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  screenRecording: ScreenRecordingRuntime | null;
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
  cleanupDeadline?: number;
  consentExpiryTimer: ReturnType<typeof setTimeout> | null;
};

type ScreenRecordingRuntime = {
  recordingId: string;
  source: "tab";
  startedAt: number;
  startedMono: number;
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  chunks: string[];
  chunkCount: number;
  sizeBytes: number;
  pendingWrites: Set<Promise<void>>;
  stopPromise: Promise<void> | null;
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
  privacyScanner?: PrivacyScannerResult;
};

type ExportAuditEvent = {
  schemaVersion: 1;
  timestamp: string;
  sid: string;
  mode: CaptureMode;
  outcome: "ok" | "error";
  encrypted: boolean;
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number;
  recentWindowMs: number;
  sizeBytes?: number;
  downloadId?: number;
  error?: string;
};

type SessionAnnotation = {
  tags: string[];
  note?: string;
};

type SessionPipelineClient = {
  start: (
    session: SessionMetadata,
    redactionProfile: RedactionProfile,
    capturePolicy?: CapturePolicy
  ) => Promise<void>;
  ingest: (event: WebBlackboxEvent) => Promise<void>;
  ingestBatch: (events: WebBlackboxEvent[]) => Promise<void>;
  flush: () => Promise<void>;
  getResumeState: () => Promise<PipelineResumeState>;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  exportAndDownload: (options?: {
    passphrase?: string;
    includeScreenshots?: boolean;
    includeScreenRecordings?: boolean;
    maxArchiveBytes?: number;
    recentWindowMs?: number;
  }) => Promise<PipelineExportDownloadResult>;
  close: (options?: { purge?: boolean }) => Promise<void>;
};

type OffscreenPipelineRequest = {
  kind: "sw.pipeline-request";
  requestId: string;
  op:
    | "start"
    | "ingest"
    | "ingestBatch"
    | "flush"
    | "getResumeState"
    | "putBlob"
    | "exportDownload"
    | "close"
    | "getScreenRecordingStatus"
    | "startScreenRecording"
    | "stopScreenRecording";
  sid: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  event?: WebBlackboxEvent;
  events?: WebBlackboxEvent[];
  mime?: string;
  bytes?: Uint8Array;
  passphrase?: string;
  includeScreenshots?: boolean;
  includeScreenRecordings?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
  purge?: boolean;
  recordingId?: string;
  streamId?: string;
  source?: "tab";
  reason?: string;
};

type OffscreenPipelineResponse = {
  kind: "offscreen.pipeline-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type OffscreenScreenRecordingStartResult = {
  recordingId: string;
  source: "tab";
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  audio: boolean;
};

type OffscreenScreenRecordingStopResult = {
  recordingId: string;
  mime: string;
  chunkCount: number;
  size: number;
  durationMs: number;
  width?: number;
  height?: number;
  reason?: string;
};

type OffscreenScreenRecordingChunkMessage = {
  kind: "offscreen.screen-recording-chunk";
  sid: string;
  recordingId: string;
  index: number;
  mime: string;
  bytes: unknown;
  size?: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
  durationMs?: number;
};

type OffscreenScreenRecordingEndedMessage = {
  kind: "offscreen.screen-recording-ended";
  sid: string;
  result: OffscreenScreenRecordingStopResult;
};

type OffscreenScreenRecordingErrorMessage = {
  kind: "offscreen.screen-recording-error";
  sid: string;
  recordingId?: string;
  name?: string;
  message: string;
  stage?: string;
};

type RecordingSampling = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  snapshotIntervalMs: number;
  screenshotIdleMs: number;
  bodyCaptureMaxBytes: number;
};

type LiteBodyCaptureRule = {
  enabled: boolean;
  maxBytes: number;
  mimeAllowlist: string[];
};

const chromeApi = getChromeApi();
const extensionBaseUrl = chromeApi?.runtime?.getURL("") ?? "";

const sessionsByTab = new Map<number, SessionRuntime>();
const sessionsBySid = new Map<string, SessionRuntime>();
const sessionStartCoordinator = new RuntimeStartCoordinator();
const sessionAnnotations = new Map<string, SessionAnnotation>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingStopDrainAcks = new Map<
  string,
  {
    sid: string;
    tabId: number;
    ackReceived: boolean;
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const inFlightContentMessagesByTab = new Map<number, number>();
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
let liteWebRequestCaptureCleanup: (() => void) | null = null;
let runtimeStatePersistTail: Promise<void> = Promise.resolve();
let runtimeStatePersistTimer: ReturnType<typeof setTimeout> | null = null;

const OFFSCREEN_PATH = "offscreen.html";
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const POINTER_STALE_MS = 2_500;
const NETWORK_BODY_MAX_BYTES = 256 * 1024;
const FULL_MODE_BODY_CAPTURE_MAX_BYTES = 128 * 1024;
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
const CPU_PROFILE_SAMPLE_MS = 350;
const HEAP_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const OPTIONS_STORAGE_KEY = "webblackbox.options";
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";
const SESSION_ANNOTATIONS_STORAGE_KEY = "webblackbox.runtime.sessionAnnotations";
const EXPORT_AUDIT_STORAGE_KEY = "webblackbox.audit.exports";
const EXPORT_AUDIT_MAX_EVENTS = 200;
const RUNTIME_STATE_PERSIST_DEBOUNCE_MS = 500;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);
const STOP_DRAIN_CONTENT_RAW_TYPES = new Set([
  "snapshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot",
  "screenshot"
]);
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const PERF_WARN_MS = 40;
const OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS = 12 * 60_000;
const OFFSCREEN_PORT_READY_MAX_ATTEMPTS = 200;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;
const STOP_DRAIN_ACK_TIMEOUT_MS = 3_000;
const CDP_ARTIFACT_TIMEOUT_MS = 5_000;
const CDP_HEAP_SNAPSHOT_TIMEOUT_MS = 8_000;
const SCREEN_RECORDING_OFFSCREEN_SOURCE = "tab";
const PIPELINE_RESUME_MAX_SCREEN_CHUNKS = 500_000;

console.info("[WebBlackbox] service worker booted");

const runtimeCleanupScheduler = new RuntimeCleanupScheduler({
  alarms: chromeApi?.alarms,
  onDue: async (sid) => {
    const runtime = sessionsBySid.get(sid);

    if (runtime?.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  }
});
const runtimeStateRestorePromise = restoreRuntimeState().catch(async (error) => {
  console.warn("[WebBlackbox] runtime state restoration failed closed", error);
  await failClosedRuntimeRestoration();
});

chromeApi?.alarms?.onAlarm.addListener((alarm) => {
  void runtimeCleanupScheduler.handleAlarm(alarm.name).catch((error) => {
    console.warn("[WebBlackbox] stopped-session cleanup alarm failed", error);
  });
});

chromeApi?.runtime?.onInstalled.addListener(() => {
  void setIdleBadge();
});

chromeApi?.runtime?.onConnect.addListener((port) => {
  if (!isAuthorizedExtensionPort(port, extensionBaseUrl)) {
    port.disconnect?.();
    return;
  }

  connectedPorts.add(port);

  if (port.name === PORT_NAMES.offscreen) {
    offscreenPort = port;
    notifyOffscreenPipelineStatus();
  }

  if (port.name === PORT_NAMES.content) {
    void syncContentPortStateOnConnect(port).catch((error) => {
      logInboundMessageFailure("content.connect", error, port);
    });
  }

  pushSessionList();

  const onMessage = (rawMessage: unknown) => {
    if (handleOffscreenRuntimeMessage(rawMessage, port)) {
      return;
    }

    const message = parseExtensionInboundMessage(rawMessage, {
      transport: "port",
      portName: port.name,
      sender: port.sender,
      extensionBaseUrl
    });

    if (!message) {
      return;
    }

    dispatchInboundMessage(message, port);
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
    sendInactiveContentPortState(port);
    return;
  }

  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    sendInactiveContentPortState(port);
    return;
  }

  if (!authorizeContentSender(runtime, port.sender)) {
    sendContentPortRecordingState(port, runtime, false);

    if (normalizeSenderFrameId(port.sender) === 0) {
      await stopSession(tabId);
    } else {
      runtime.authorizedContentFrames.delete(normalizeSenderFrameId(port.sender));
    }

    return;
  }

  if (shouldInjectHooksForMode(runtime.mode)) {
    await ensureInjectedHooks(tabId, normalizeSenderFrameId(port.sender));
  }

  syncContentPortRecordingState(port);
}

function syncContentPortRecordingState(port: PortLike): void {
  const tabId = port.sender?.tab?.id;

  if (typeof tabId !== "number") {
    sendInactiveContentPortState(port);
    return;
  }

  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    sendInactiveContentPortState(port);
    return;
  }

  if (!authorizeContentSender(runtime, port.sender)) {
    sendContentPortRecordingState(port, runtime, false);
    runtime.authorizedContentFrames.delete(normalizeSenderFrameId(port.sender));
    return;
  }

  sendContentPortRecordingState(port, runtime, true);
}

function sendInactiveContentPortState(port: PortLike): void {
  try {
    port.postMessage({
      kind: "sw.recording-status",
      active: false
    });
  } catch (error) {
    logPortSendFailure("sw.recording-status", error, {
      tabId: port.sender?.tab?.id,
      frameId: port.sender?.frameId
    });
  }
}

function sendContentPortRecordingState(
  port: PortLike,
  runtime: SessionRuntime,
  active: boolean
): void {
  const sampling = toStatusSampling(runtime);

  try {
    port.postMessage({
      kind: "sw.recording-status",
      active,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling,
      capturePolicy: runtime.config.capturePolicy
    });
  } catch (error) {
    logPortSendFailure("sw.recording-status", error, {
      tabId: runtime.tabId,
      sid: runtime.sid,
      mode: runtime.mode
    });
  }
}

chromeApi?.runtime?.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = parseExtensionInboundMessage(rawMessage, {
    transport: "runtime",
    sender,
    extensionBaseUrl
  });

  if (!message) {
    return;
  }

  void handleInboundMessage(message, undefined, sender)
    .then((result) => {
      sendResponse(result ?? { ok: true });
    })
    .catch((error) => {
      logInboundMessageFailure(message.kind, error, undefined, {
        tabId: sender.tab?.id,
        frameId: sender.frameId
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

function dispatchInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  sender: MessageSenderLike | undefined = port?.sender
): void {
  void handleInboundMessage(message, port, sender).catch((error) => {
    logInboundMessageFailure(message.kind, error, port, {
      tabId: sender?.tab?.id,
      frameId: sender?.frameId
    });
  });
}

chromeApi?.commands?.onCommand.addListener((command) => {
  if (command !== "mark-bug") {
    return;
  }

  void relayMarkerCommand();
});

chromeApi?.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== "string" || changeInfo.url.length === 0) {
    if (changeInfo.status === "complete") {
      void restoreTabInstrumentationAfterNavigation(tabId);
    }
    return;
  }

  void handleTabUrlChanged(tabId, changeInfo.url);

  if (changeInfo.status === "complete") {
    void restoreTabInstrumentationAfterNavigation(tabId);
  }
});

chromeApi?.tabs?.onRemoved?.addListener((tabId) => {
  void stopSession(tabId);
});

async function handleInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  sender: MessageSenderLike | undefined = port?.sender
): Promise<unknown> {
  if (message.kind.startsWith("ui.")) {
    await runtimeStateRestorePromise;
  }

  if (message.kind === "ui.start") {
    const tabId = await resolveUiActionTabId(message.tabId);

    if (typeof tabId !== "number") {
      return;
    }

    await startSession(tabId, message.mode, {
      visualCapture: resolveFullModeVisualCapture(message)
    });
    if (message.mode === "lite" && message.reloadPage) {
      try {
        await reloadRecordingTab(tabId);
      } catch (error) {
        await stopSession(tabId);
        throw error;
      }
    }
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
    return exportSession(
      message.sid,
      message.passphrase,
      message.saveAs,
      resolveExportPolicy(message.policy)
    );
  }

  if (message.kind === "ui.delete") {
    await deleteSessionBySid(message.sid);
    return;
  }

  if (message.kind === "ui.annotate") {
    await updateSessionAnnotation(message.sid, message.tags, message.note);
    return;
  }

  if (message.kind === "ui.request-session-list") {
    const sessionList = buildSessionListMessage();

    if (port) {
      sendPortMessage(port, sessionList);
      return;
    }

    return sessionList;
  }

  if (message.kind === "content.marker") {
    const tabId = sender?.tab?.id;
    const frame = normalizeContentFrameId(sender?.frameId);
    const runtime = typeof tabId === "number" ? sessionsByTab.get(tabId) : undefined;

    if (runtime && authorizeContentSender(runtime, sender, message.documentUrl)) {
      ingestRawEvent({
        source: "content",
        rawType: "marker",
        tabId: runtime.tabId,
        sid: runtime.sid,
        t: Date.now(),
        mono: monotonicTime(),
        frame,
        payload: {
          message: message.message
        }
      });
    } else if (runtime) {
      await deactivateDeniedContentFrame(runtime, sender, port);
    }

    return;
  }

  if (message.kind === "content.ready") {
    const tabId = sender?.tab?.id;

    if (typeof tabId !== "number") {
      return {
        kind: "sw.recording-status",
        active: false
      };
    }

    const runtime = sessionsByTab.get(tabId);

    if (!runtime || runtime.stoppedAt) {
      return {
        kind: "sw.recording-status",
        active: false
      };
    }

    if (!authorizeContentSender(runtime, sender, message.documentUrl)) {
      if (normalizeSenderFrameId(sender) === 0) {
        await stopSession(tabId);
      } else {
        await deactivateDeniedContentFrame(runtime, sender, port);
      }

      return {
        kind: "sw.recording-status",
        active: false,
        sid: runtime.sid,
        mode: runtime.mode,
        capturePolicy: runtime.config.capturePolicy
      };
    }

    if (shouldInjectHooksForMode(runtime.mode)) {
      await ensureInjectedHooks(tabId, normalizeSenderFrameId(sender));
    }

    const sampling = toStatusSampling(runtime);

    if (port?.name === PORT_NAMES.content) {
      syncContentPortRecordingState(port);
      return {
        ok: true
      };
    }

    return {
      kind: "sw.recording-status",
      active: true,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling,
      capturePolicy: runtime.config.capturePolicy
    };
  }

  if (message.kind === "content.stop-drained") {
    if (normalizeSenderFrameId(sender) === 0) {
      markStopDrainAckReceived(message.sid);
    }
    return;
  }

  if (message.kind === "content.events") {
    const tabId = sender?.tab?.id;
    const frame = normalizeContentFrameId(sender?.frameId);

    if (
      typeof tabId !== "number" ||
      !Array.isArray(message.events) ||
      message.events.length === 0
    ) {
      return;
    }

    const runtime = sessionsByTab.get(tabId);

    if (!runtime || !authorizeContentSender(runtime, sender, message.documentUrl)) {
      if (runtime && normalizeSenderFrameId(sender) === 0) {
        await stopSession(tabId);
      } else if (runtime) {
        await deactivateDeniedContentFrame(runtime, sender, port);
      }

      return;
    }

    adjustInFlightContentMessages(tabId, 1);
    let sliceStartedAt = perfNow();

    try {
      for (const rawEvent of message.events) {
        ingestRawEvent({
          ...rawEvent,
          tabId,
          sid: runtime.sid,
          frame
        });

        if (perfNow() - sliceStartedAt >= CONTENT_EVENT_SLICE_BUDGET_MS) {
          await wait(0);
          sliceStartedAt = perfNow();
        }
      }
    } finally {
      adjustInFlightContentMessages(tabId, -1);
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

async function startSession(
  tabId: number,
  mode: CaptureMode,
  options: { visualCapture?: FullModeVisualCapture } = {}
): Promise<void> {
  await runtimeStateRestorePromise;
  await sessionStartCoordinator.run(tabId, () => startSessionUnlocked(tabId, mode, options));
}

async function startSessionUnlocked(
  tabId: number,
  mode: CaptureMode,
  options: { visualCapture?: FullModeVisualCapture }
): Promise<void> {
  const existing = sessionsByTab.get(tabId);

  if (existing) {
    await stopSession(tabId);
  }

  const sid = createSessionId();
  const startedAt = Date.now();
  const tabMetadata = await resolveTabSessionMetadata(tabId);
  const sessionOrigin = resolveUrlOrigin(tabMetadata.captureUrl) ?? "";
  const enterprisePolicy = await loadEnterprisePolicy();

  const loadedRecorderConfig = applyFullModeVisualCapture(
    await loadRecorderConfig(mode),
    mode,
    options.visualCapture
  );
  const recorderConfig = applyEnterprisePolicyToRecorderConfig(
    withSessionCapturePolicy(loadedRecorderConfig, {
      tabId,
      origin: sessionOrigin,
      startedAt
    }),
    enterprisePolicy
  );
  const startScope = evaluateCaptureDocumentScope(recorderConfig.capturePolicy, {
    url: tabMetadata.captureUrl,
    tabId,
    frameId: 0,
    now: startedAt
  });

  if (!startScope.allowed) {
    throw new Error(`Recording is outside the permitted capture scope (${startScope.reason}).`);
  }

  await ensureOffscreenDocument();

  const performanceBudget = await loadPerformanceBudgetConfig();
  const annotation = getSessionAnnotation(sid);
  const metadata: SessionMetadata = {
    sid,
    tabId,
    startedAt,
    mode,
    url: sanitizeUrlForPrivacy(tabMetadata.url),
    title: tabMetadata.title,
    tags: [...annotation.tags]
  };

  const pipeline = createOffscreenPipelineClient(sid);
  await pipeline.start(metadata, recorderConfig.redaction, recorderConfig.capturePolicy);
  const runtime = createSessionRuntime({
    sid,
    tabId,
    mode,
    url: metadata.url,
    captureUrl: tabMetadata.captureUrl,
    title: metadata.title,
    tags: annotation.tags,
    note: annotation.note,
    config: recorderConfig,
    startedAt,
    pipeline,
    performanceBudget
  });

  sessionsByTab.set(tabId, runtime);
  sessionsBySid.set(sid, runtime);
  scheduleConsentExpiry(runtime);

  if (mode === "lite") {
    installLiteWebRequestCapture();
  }

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
    await ensureContentScriptInjected(runtime);
    await ensureInjectedHooks(tabId, 0);
  }

  if (mode === "full" && recorderConfig.capturePolicy?.categories.cdp !== "off") {
    await attachCdp(runtime);
  }

  // Make the owning session durable before an offscreen MediaRecorder can outlive this worker.
  await persistRuntimeState();

  if (shouldStartScreenRecording(runtime)) {
    try {
      await startScreenRecording(runtime);
    } catch (error) {
      await stopSession(tabId);
      throw error;
    }
  }

  const sampling = toStatusSampling(runtime);

  await setRecordingBadge();
  await notifyAuthorizedContentFrames(runtime, true);
  broadcast({
    kind: "sw.recording-status",
    active: true,
    sid,
    mode,
    sampling,
    capturePolicy: recorderConfig.capturePolicy
  });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

function createSessionRuntime(input: {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  url: string;
  captureUrl: string;
  title?: string;
  tags: readonly string[];
  note?: string;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
  stoppedAt?: number;
  cleanupDeadline?: number;
  pipeline: SessionPipelineClient;
  performanceBudget: PerformanceBudgetConfig;
  counters?: PersistedRuntimeCounters;
  screenRecording?: PersistedScreenRecording;
  screenRecordingChunks?: readonly ScreenRecordingChunkReference[];
}): SessionRuntime {
  const counters = input.counters ?? {
    recorderEventSequence: 0,
    recorderActionSequence: 0,
    eventCount: 0,
    errorCount: 0,
    sizeBytes: 0,
    budgetAlertCount: 0,
    droppedBestEffortTasks: 0,
    responseBodyCaptures: 0,
    networkTotal: 0,
    networkFailed: 0
  };
  const recorderPlugins = createDefaultRecorderPlugins();
  const runtimeRef: { current?: SessionRuntime } = {};
  const recorder = new WebBlackboxRecorder(
    {
      ...input.config,
      mode: input.mode
    },
    {
      onEvent: (event) => {
        const runtime = runtimeRef.current;

        if (!runtime) {
          return;
        }

        updateSessionMetadataFromEvent(runtime, event);
        trackSessionCounters(runtime, event);
        evaluatePerformanceBudget(runtime, event);
        enqueuePipelineEvent(runtime, event);
      },
      onFreeze: (reason) => {
        if (runtimeRef.current) {
          handleFreezeNotice(runtimeRef.current, reason);
        }
      }
    },
    undefined,
    recorderPlugins
  );
  recorder.restoreSequenceState({
    event: counters.recorderEventSequence,
    action: counters.recorderActionSequence
  });
  const restoredScreenRecordingChunks = input.screenRecording
    ? restoreScreenRecordingChunkHashes(
        input.screenRecording.chunkCount,
        input.screenRecordingChunks ?? []
      )
    : null;

  const runtime: SessionRuntime = {
    sid: input.sid,
    tabId: input.tabId,
    mode: input.mode,
    url: input.url,
    captureUrl: input.captureUrl,
    title: input.title,
    tags: [...input.tags],
    note: input.note,
    config: input.config,
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    recorder,
    pipeline: input.pipeline,
    cdpRouter: null,
    enabledCdpSessions: new Set<string>(),
    cdpScope: createCdpCaptureScopeState(input.config.capturePolicy, input.tabId, input.captureUrl),
    authorizedContentFrames: new Set<number>(input.stoppedAt ? [] : [0]),
    requestMeta: new Map(),
    screenshotInterval: null,
    screenRecording: input.screenRecording
      ? {
          recordingId: input.screenRecording.recordingId,
          source: SCREEN_RECORDING_OFFSCREEN_SOURCE,
          startedAt: input.screenRecording.startedAt,
          startedMono: input.screenRecording.startedMono,
          mime: input.screenRecording.mime,
          width: input.screenRecording.width,
          height: input.screenRecording.height,
          frameRate: input.screenRecording.frameRate,
          chunks: restoredScreenRecordingChunks ?? [],
          chunkCount: restoredScreenRecordingChunks?.length ?? input.screenRecording.chunkCount,
          sizeBytes: input.screenRecording.sizeBytes,
          pendingWrites: new Set(),
          stopPromise: null
        }
      : null,
    lastPointer: null,
    lastViewport: null,
    lastActionScreenshotMono: Number.NEGATIVE_INFINITY,
    lastIncidentCaptureAt: Number.NEGATIVE_INFINITY,
    lastNavigationSnapshotAt: Number.NEGATIVE_INFINITY,
    queueDepth: 0,
    droppedBestEffortTasks: counters.droppedBestEffortTasks,
    pipelineEventBuffer: [],
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    stopping: false,
    responseBodyCaptures: counters.responseBodyCaptures,
    responseBodyCaptureTimestamps: [],
    capturedEventCount: counters.eventCount,
    capturedErrorCount: counters.errorCount,
    capturedSizeBytes: counters.sizeBytes,
    budgetAlertCount: counters.budgetAlertCount,
    performanceBudget: input.performanceBudget,
    networkBudgetSample: {
      total: counters.networkTotal,
      failed: counters.networkFailed
    },
    lastFreezeNotices: new Map<string, number>(),
    lastBudgetBreachAt: new Map<string, number>(),
    queue: Promise.resolve(),
    removeCdpListeners: [],
    heapSnapshotCapture: null,
    cleanupDeadline: input.cleanupDeadline,
    consentExpiryTimer: null
  };
  runtimeRef.current = runtime;

  return runtime;
}

async function reloadRecordingTab(tabId: number): Promise<void> {
  if (!chromeApi?.tabs?.reload) {
    throw new Error("Current Chrome API cannot reload the active tab.");
  }

  await chromeApi.tabs.reload(tabId);
}

async function restoreTabInstrumentationAfterNavigation(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (
    !runtime ||
    runtime.stopping ||
    runtime.stoppedAt ||
    !shouldInjectHooksForMode(runtime.mode)
  ) {
    return;
  }

  const tabMetadata = await resolveTabSessionMetadata(tabId);

  if (!(await isRuntimeTopDocumentAllowed(runtime, tabMetadata.captureUrl))) {
    await stopSession(tabId);
    return;
  }

  runtime.captureUrl = tabMetadata.captureUrl;
  runtime.cdpScope.captureUrl = tabMetadata.captureUrl;
  runtime.url = tabMetadata.url;
  resetAuthorizedContentFrames(runtime);

  await ensureContentScriptInjected(runtime);
  await ensureInjectedHooks(tabId, 0);
  await notifyAuthorizedContentFrames(runtime, true);
}

async function stopSession(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stopping) {
    return;
  }

  runtime.stopping = true;
  const stopDrainAck = createStopDrainAck(runtime);
  await stopScreenRecording(runtime, "session-stop").catch((error) => {
    console.warn("[WebBlackbox] failed to stop screen recording", error);
  });
  await flushBufferedPipelineEvents(runtime);
  await teardownCaptureInstrumentation(runtime);
  await notifyAuthorizedContentFrames(runtime, false);
  sessionsByTab.delete(runtime.tabId);
  uninstallLiteWebRequestCaptureIfUnused();
  runtime.stoppedAt = Date.now();
  runtime.cleanupDeadline =
    runtime.stoppedAt + resolveRuntimeLocalTtlMs(runtime.config.capturePolicy);
  await scheduleStoppedRuntimeCleanup(runtime).catch((error) => {
    console.warn("[WebBlackbox] alarm setup failed; timer and restart recovery remain armed", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  broadcast({
    kind: "sw.recording-status",
    active: false,
    sid: runtime.sid,
    mode: runtime.mode,
    capturePolicy: runtime.config.capturePolicy
  });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
  await stopDrainAck;
  await flushBufferedPipelineEvents(runtime);
}

async function exportSession(
  sid: string,
  passphrase: string | undefined,
  saveAs = true,
  policy: ExportPolicy = DEFAULT_EXPORT_POLICY
): Promise<
  | { ok: true; fileName: string; privacyWarning?: ExportPrivacyWarning }
  | { ok: false; error: string }
> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    const error = "Session not found for export.";
    console.warn("[WebBlackbox] export ignored; unknown session", sid);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error
    });
    return {
      ok: false,
      error
    };
  }

  const effectivePolicy = resolveSessionExportPolicy(runtime, policy);

  try {
    if (!runtime.stoppedAt) {
      await stopSession(runtime.tabId);
    }

    await flushBufferedPipelineEvents(runtime);
    const encrypted = hasExportPassphrase(passphrase);

    const exported = await enqueueWithResult(runtime, async () => {
      return runtime.pipeline.exportAndDownload({
        passphrase: encrypted ? passphrase : undefined,
        includeScreenshots: effectivePolicy.includeScreenshots,
        includeScreenRecordings: effectivePolicy.includeScreenRecordings,
        maxArchiveBytes: effectivePolicy.maxArchiveBytes,
        recentWindowMs: effectivePolicy.recentWindowMs
      });
    });

    await downloadExportedBundle(exported, saveAs);
    const privacyWarning = buildExportPrivacyWarning(exported.privacyScanner);
    await appendExportAuditEvent({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      sid,
      mode: runtime.mode,
      outcome: "ok",
      encrypted,
      includeScreenshots: effectivePolicy.includeScreenshots,
      includeScreenRecordings: effectivePolicy.includeScreenRecordings,
      maxArchiveBytes: effectivePolicy.maxArchiveBytes,
      recentWindowMs: effectivePolicy.recentWindowMs,
      sizeBytes: exported.sizeBytes,
      downloadId: exported.downloadId
    });
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: true,
      fileName: exported.fileName,
      privacyWarning
    });

    if (runtime.stoppedAt) {
      await disposeStoppedSession(runtime);
    }

    return {
      ok: true,
      fileName: exported.fileName,
      privacyWarning
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendExportAuditEvent({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      sid,
      mode: runtime.mode,
      outcome: "error",
      encrypted: hasExportPassphrase(passphrase),
      includeScreenshots: effectivePolicy.includeScreenshots,
      includeScreenRecordings: effectivePolicy.includeScreenRecordings,
      maxArchiveBytes: effectivePolicy.maxArchiveBytes,
      recentWindowMs: effectivePolicy.recentWindowMs,
      error: redactOperationalMessage(message)
    });
    console.warn("[WebBlackbox] export failed", error);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: message
    });
    return {
      ok: false,
      error: message
    };
  }
}

function resolveSessionExportPolicy(runtime: SessionRuntime, policy: ExportPolicy): ExportPolicy {
  if (runtime.mode !== "full") {
    return policy;
  }

  const categories = runtime.config.capturePolicy?.categories;

  if (!categories) {
    return policy;
  }

  return {
    ...policy,
    includeScreenshots: categories.screenshots === "allow",
    includeScreenRecordings: categories.screenRecordings === "allow"
  };
}

function hasExportPassphrase(passphrase: string | undefined): passphrase is string {
  return typeof passphrase === "string" && passphrase.length > 0;
}

function ingestRawEvent(rawEvent: RawRecorderEvent): void {
  const runtime =
    sessionsByTab.get(rawEvent.tabId) ??
    (typeof rawEvent.sid === "string" ? sessionsBySid.get(rawEvent.sid) : undefined);

  if (!runtime) {
    return;
  }

  const runtimeScope = evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url: runtime.captureUrl,
    tabId: runtime.tabId,
    frameId: 0
  });

  if (!runtimeScope.allowed) {
    if (!runtime.stopping && !runtime.stoppedAt) {
      void stopSession(runtime.tabId);
    }

    return;
  }

  if (!isCaptureEventFrameAllowed(runtime.config.capturePolicy, rawEvent)) {
    return;
  }

  if (
    runtime.stopping &&
    rawEvent.source !== "system" &&
    !shouldAllowStopDrainContentEvent(runtime, rawEvent)
  ) {
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

function shouldAllowStopDrainContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  return (
    rawEvent.source === "content" &&
    rawEvent.sid === runtime.sid &&
    STOP_DRAIN_CONTENT_RAW_TYPES.has(rawEvent.rawType)
  );
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
  if (!isRuntimeDocumentWithinScope(runtime)) {
    return null;
  }

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
  if (runtime.config.capturePolicy?.categories.screenshots !== "allow") {
    return null;
  }

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

  if (!reqId || !body || !mimeType || (encoding !== "utf8" && encoding !== "base64")) {
    return null;
  }

  const captureRule = resolveLiteBodyCaptureRule(runtime, url, mimeType);

  if (!captureRule.enabled || !isMimeAllowed(captureRule.mimeAllowlist, mimeType)) {
    return null;
  }

  const transformed = transformResponseBodyForCapture({
    body,
    base64Encoded: encoding === "base64",
    mimeType,
    redactPatterns: runtime.config.redaction.redactBodyPatterns,
    maxBytes: captureRule.maxBytes,
    redactionToken: LITE_BODY_REDACTED_TOKEN,
    decodeBase64
  });

  if (!transformed) {
    return null;
  }

  const size = normalizeNonNegativeInt(payload.size) ?? transformed.originalBytes.byteLength;
  const truncatedByInput = payload.truncated === true;
  const contentHash = await runtime.pipeline.putBlob(mimeType, transformed.sampledBytes);

  return {
    ...rawEvent,
    payload: {
      reqId,
      requestId: reqId,
      contentHash,
      mimeType,
      size,
      sampledSize: transformed.sampledBytes.byteLength,
      truncated: truncatedByInput || transformed.truncated,
      redacted: payload.redacted === true || transformed.redacted
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

  if (runtime.config.capturePolicy?.categories.screenshots !== "allow") {
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
    scheduleRuntimeStatePersist();
    return;
  }

  if (runtime.capturedEventCount % 50 === 0) {
    pushSessionList();
    scheduleRuntimeStatePersist();
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
    const { duration, failed } = extractPerformanceBudgetNetworkSample(event.data);

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
    scheduleRuntimeStatePersist();
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
    start: async (session, redactionProfile, capturePolicy) => {
      await requestOffscreenPipeline<void>({
        op: "start",
        sid,
        session,
        redactionProfile,
        capturePolicy
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
    getResumeState: async () => {
      const result = await requestOffscreenPipeline<unknown>({
        op: "getResumeState",
        sid
      });
      return normalizePipelineResumeState(result);
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
        includeScreenRecordings: options.includeScreenRecordings,
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

  if (kind === "offscreen.keepalive") {
    return true;
  }

  if (kind === "offscreen.screen-recording-chunk") {
    void handleOffscreenScreenRecordingChunk(
      rawMessage as OffscreenScreenRecordingChunkMessage
    ).catch((error) => {
      console.warn("[WebBlackbox] failed to persist screen recording chunk", error);
    });
    return true;
  }

  if (kind === "offscreen.screen-recording-ended") {
    void handleOffscreenScreenRecordingEnded(
      rawMessage as OffscreenScreenRecordingEndedMessage
    ).catch((error) => {
      console.warn("[WebBlackbox] failed to finalize screen recording", error);
    });
    return true;
  }

  if (kind === "offscreen.screen-recording-error") {
    handleOffscreenScreenRecordingError(rawMessage as OffscreenScreenRecordingErrorMessage);
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
      redactionProfile: runtime.config.redaction,
      capturePolicy: runtime.config.capturePolicy
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
  let router: CdpRouter | null = null;

  try {
    router = createCdpRouter(createChromeDebuggerTransport());

    const unsubscribeEvent = router.onEvent((event) => {
      const normalizedPayload = normalizeFullModePayload(event.method, event.params ?? {});
      const scopeEvaluation = evaluateCdpCaptureScopeEvent(
        runtime.cdpScope,
        event.method,
        event.params ?? {},
        event.sessionId
      );
      const scopeAllowed = scopeEvaluation.allowed;

      if (scopeEvaluation.topNavigation) {
        const { url, decision } = scopeEvaluation.topNavigation;

        if (!decision.allowed) {
          void stopSession(runtime.tabId);
        } else {
          runtime.captureUrl = url;
          runtime.url = sanitizeUrlForPrivacy(url);
          resetAuthorizedContentFrames(runtime);
          void handleTabUrlChanged(runtime.tabId, url);
        }
      }

      if (scopeAllowed && event.method === "HeapProfiler.addHeapSnapshotChunk") {
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

      if (scopeAllowed) {
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
      }

      if (
        !FULL_MODE_FOLLOWUP_METHODS.has(event.method) ||
        (!scopeAllowed &&
          event.method !== "Target.attachedToTarget" &&
          event.method !== "Target.detachedFromTarget")
      ) {
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
    runtime.cdpRouter = router;
    runtime.enabledCdpSessions.clear();
    await router.enableBaseline(runtime.tabId);
    runtime.enabledCdpSessions.add("root");
    await primeCdpFrameTreeScopes(runtime);
    runtime.cdpScope.executionContextScopes.clear();
    await router.send({ tabId: runtime.tabId }, "Runtime.disable").catch(() => undefined);
    await router.send({ tabId: runtime.tabId }, "Runtime.enable").catch(() => undefined);
    if (runtime.config.capturePolicy?.scope.includeSubframes === true) {
      await router.enableAutoAttach(runtime.tabId);
    }
    await router.send({ tabId: runtime.tabId }, "DOMStorage.enable").catch(() => undefined);
    await router.send({ tabId: runtime.tabId }, "Performance.enable").catch(() => undefined);

    enqueue(
      runtime,
      async () => {
        await captureFullModeArtifacts(runtime, "session-start");
      },
      { bestEffort: true }
    );

    const normalizedScreenshotIntervalMs = normalizeOptionalSamplingInterval(
      runtime.config.sampling.screenshotIdleMs,
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    );

    if (normalizedScreenshotIntervalMs > 0) {
      const screenshotIntervalMs = Math.max(
        FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS,
        normalizedScreenshotIntervalMs
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
    }
  } catch (error) {
    await cleanupCdpInstrumentation(runtime, router);
    console.warn("[WebBlackbox] failed to attach debugger", error);
  }
}

async function primeCdpFrameTreeScopes(runtime: SessionRuntime): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const response = await runtime.cdpRouter
    .send<{ frameTree?: unknown }>({ tabId: runtime.tabId }, "Page.getFrameTree")
    .catch(() => undefined);

  primeCdpCaptureFrameTree(runtime.cdpScope, response?.frameTree);
}

function evaluateRuntimeFrameDocument(
  runtime: SessionRuntime,
  url: string | null | undefined,
  topLevel: boolean
): boolean {
  return evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url,
    tabId: runtime.tabId,
    frameId: topLevel ? 0 : 1
  }).allowed;
}

function isRuntimeCaptureScopeActive(runtime: SessionRuntime): boolean {
  return !runtime.stopping && !runtime.stoppedAt && isRuntimeDocumentWithinScope(runtime);
}

function isRuntimeDocumentWithinScope(runtime: SessionRuntime): boolean {
  return evaluateRuntimeFrameDocument(runtime, runtime.captureUrl, true);
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

    if (childSessionId && isCdpSessionWithinScope(runtime.cdpScope, childSessionId)) {
      await primeChildCdpSession(runtime, childSessionId);
    }

    return;
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

    if (childSessionId) {
      runtime.enabledCdpSessions.delete(childSessionId);
      forgetCdpSessionScope(runtime.cdpScope, childSessionId);
    }

    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const response = asRecord(payload?.response);
    const resourceType = typeof payload?.type === "string" ? payload.type : undefined;

    if (requestId) {
      upsertRequestMeta(runtime.requestMeta, buildRequestMetaKey(requestId, sessionId), {
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

    if (requestId && shouldCaptureResponseBody(runtime, requestId, payload, sessionId)) {
      await captureResponseBody(runtime, requestId, sessionId);
    }

    if (requestId) {
      deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(requestId, sessionId));
      forgetCdpRequestScope(runtime.cdpScope, requestId, sessionId);
    }

    return;
  }

  if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
    if (method === "Network.loadingFailed") {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

      if (requestId) {
        deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(requestId, sessionId));
        forgetCdpRequestScope(runtime.cdpScope, requestId, sessionId);
      }
    }

    if (shouldCaptureIncidentArtifacts(runtime)) {
      await captureIncidentArtifacts(runtime, method);
    }

    return;
  }

  const frame = asRecord(payload?.frame);
  const isTopFrameNavigation =
    method === "Page.frameNavigated" &&
    !sessionId &&
    typeof frame?.parentId !== "string" &&
    typeof frame?.parentFrameId !== "string";

  if (isTopFrameNavigation && shouldCaptureNavigationSnapshot(runtime)) {
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
  if (!runtime.cdpRouter || !isRuntimeCaptureScopeActive(runtime)) {
    return;
  }

  const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
  const response = await sendCdpCommand<{
    body?: string;
    base64Encoded?: boolean;
  }>(runtime, target, "Network.getResponseBody", { requestId });

  if (!response?.body) {
    return;
  }

  if (!isRuntimeCaptureScopeActive(runtime)) {
    return;
  }

  const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(requestId, sessionId));
  const normalizedMime = normalizeMimeType(metadata?.mimeType ?? null);
  const captureRule = resolveFullBodyCaptureRule(runtime, metadata?.url ?? "", normalizedMime);

  if (!captureRule.enabled) {
    return;
  }

  const transformed = transformResponseBodyForCapture({
    body: response.body,
    base64Encoded: response.base64Encoded === true,
    mimeType: normalizedMime,
    redactPatterns: runtime.config.redaction.redactBodyPatterns,
    maxBytes: captureRule.maxBytes,
    redactionToken: LITE_BODY_REDACTED_TOKEN,
    decodeBase64
  });

  if (!transformed) {
    return;
  }

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
  loadingFinishedPayload: Record<string, unknown> | null,
  sessionId?: string
): boolean {
  if (runtime.mode !== "full" || runtime.stopping) {
    return false;
  }

  if (runtime.config.capturePolicy?.categories.network !== "body-allowlist") {
    return false;
  }

  if (runtime.responseBodyCaptures >= FULL_MODE_BODY_CAPTURE_MAX_PER_SESSION) {
    return false;
  }

  const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(requestId, sessionId));

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

  if (
    runtime.config.capturePolicy?.categories.screenshots === "off" &&
    runtime.config.capturePolicy?.categories.cdp !== "full"
  ) {
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

  if (runtime.config.capturePolicy?.categories.dom !== "allow") {
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
  if (!isRuntimeCaptureScopeActive(runtime) || hasDisallowedCdpFrames(runtime.cdpScope)) {
    await stopScreenRecording(runtime, "capture-scope").catch(() => undefined);
    return;
  }

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
  if (
    !runtime.cdpRouter ||
    !isRuntimeCaptureScopeActive(runtime) ||
    hasDisallowedCdpFrames(runtime.cdpScope)
  ) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.screenshots !== "allow") {
    return;
  }

  const screenshot = await sendCdpCommand<{ data?: string }>(
    runtime,
    { tabId: runtime.tabId },
    "Page.captureScreenshot",
    {
      format: "webp",
      quality: 62,
      fromSurface: true
    }
  );

  if (!screenshot?.data) {
    return;
  }

  if (!isRuntimeCaptureScopeActive(runtime) || hasDisallowedCdpFrames(runtime.cdpScope)) {
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

function shouldStartScreenRecording(runtime: SessionRuntime): boolean {
  return (
    runtime.mode === "full" &&
    isRuntimeCaptureScopeActive(runtime) &&
    !hasDisallowedCdpFrames(runtime.cdpScope) &&
    runtime.config.capturePolicy?.categories.screenRecordings === "allow"
  );
}

async function startScreenRecording(runtime: SessionRuntime): Promise<void> {
  if (!chromeApi?.tabCapture?.getMediaStreamId) {
    throw new Error("Chrome tabCapture API is unavailable for screen recording.");
  }

  if (runtime.screenRecording) {
    return;
  }

  const recordingId = createScreenRecordingId(runtime.sid);
  const startedAt = Date.now();
  const startedMono = monotonicTime();
  const streamId = await chromeApi.tabCapture.getMediaStreamId({
    targetTabId: runtime.tabId
  });

  if (!streamId) {
    throw new Error("Chrome did not grant a tab capture stream.");
  }

  if (!isRuntimeCaptureScopeActive(runtime) || hasDisallowedCdpFrames(runtime.cdpScope)) {
    return;
  }

  const recording: ScreenRecordingRuntime = {
    recordingId,
    source: SCREEN_RECORDING_OFFSCREEN_SOURCE,
    startedAt,
    startedMono,
    mime: "video/webm",
    chunks: [],
    chunkCount: 0,
    sizeBytes: 0,
    pendingWrites: new Set(),
    stopPromise: null
  };
  runtime.screenRecording = recording;

  try {
    const result = await requestOffscreenPipeline<OffscreenScreenRecordingStartResult>({
      op: "startScreenRecording",
      sid: runtime.sid,
      recordingId,
      streamId,
      source: SCREEN_RECORDING_OFFSCREEN_SOURCE
    });

    recording.mime = result.mime;
    recording.width = result.width;
    recording.height = result.height;
    recording.frameRate = result.frameRate;

    ingestRawEvent({
      source: "system",
      rawType: "screen.recording.start",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: startedAt,
      mono: startedMono,
      payload: {
        recordingId,
        source: result.source,
        mime: result.mime,
        width: result.width,
        height: result.height,
        frameRate: result.frameRate,
        audio: result.audio
      }
    });
  } catch (error) {
    ingestScreenRecordingError(runtime, recording, error, "start");
    runtime.screenRecording = null;
    throw error;
  }
}

async function stopScreenRecording(runtime: SessionRuntime, reason: string): Promise<void> {
  const recording = runtime.screenRecording;

  if (!recording) {
    return;
  }

  if (recording.stopPromise) {
    await recording.stopPromise;
    return;
  }

  recording.stopPromise = (async () => {
    const result = await requestOffscreenPipeline<OffscreenScreenRecordingStopResult>({
      op: "stopScreenRecording",
      sid: runtime.sid,
      recordingId: recording.recordingId,
      reason
    });
    await finalizeScreenRecording(runtime, result);
  })();

  await recording.stopPromise;
}

async function handleOffscreenScreenRecordingChunk(
  message: OffscreenScreenRecordingChunkMessage
): Promise<void> {
  const runtime = sessionsBySid.get(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime || !recording || recording.recordingId !== message.recordingId) {
    return;
  }

  if (!isRuntimeCaptureScopeActive(runtime) || hasDisallowedCdpFrames(runtime.cdpScope)) {
    await stopScreenRecording(runtime, "capture-scope").catch(() => undefined);
    return;
  }

  const bytes = asUint8Array(message.bytes);

  if (!bytes || bytes.byteLength === 0) {
    return;
  }

  const index = resolveScreenRecordingChunkIndex(message.index, recording.chunkCount);
  const task = (async () => {
    const mime = typeof message.mime === "string" && message.mime ? message.mime : recording.mime;
    const hash = await runtime.pipeline.putBlob(mime, bytes);
    const size = bytes.byteLength;
    recording.chunks[index] = hash;
    recording.chunkCount = Math.max(recording.chunkCount, index + 1);
    recording.sizeBytes += size;

    ingestRawEvent({
      source: "system",
      rawType: "screen.recording.chunk",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        recordingId: recording.recordingId,
        chunkId: hash,
        index,
        mime,
        size,
        startOffsetMs: normalizeRecordingOffset(message.startOffsetMs),
        endOffsetMs: normalizeRecordingOffset(message.endOffsetMs),
        durationMs: normalizeRecordingOffset(message.durationMs)
      }
    });
  })();

  recording.pendingWrites.add(task);
  task.then(
    () => {
      recording.pendingWrites.delete(task);
    },
    (error) => {
      recording.pendingWrites.delete(task);
      ingestScreenRecordingError(runtime, recording, error, "chunk");
    }
  );

  await task;
}

async function handleOffscreenScreenRecordingEnded(
  message: OffscreenScreenRecordingEndedMessage
): Promise<void> {
  const runtime = sessionsBySid.get(message.sid);

  if (!runtime?.screenRecording) {
    return;
  }

  await finalizeScreenRecording(runtime, message.result);
}

function handleOffscreenScreenRecordingError(message: OffscreenScreenRecordingErrorMessage): void {
  const runtime = sessionsBySid.get(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime) {
    return;
  }

  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.error",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: message.recordingId ?? recording?.recordingId,
      name: message.name,
      message: message.message,
      stage: message.stage
    }
  });
}

async function finalizeScreenRecording(
  runtime: SessionRuntime,
  result: OffscreenScreenRecordingStopResult
): Promise<void> {
  const recording = runtime.screenRecording;

  if (!recording || recording.recordingId !== result.recordingId) {
    return;
  }

  await waitForScreenRecordingChunkWrites(recording);
  const chunks = compactScreenRecordingChunkHashes(recording.chunks);

  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.end",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: recording.recordingId,
      mime: result.mime || recording.mime,
      chunks,
      chunkCount: chunks.length,
      size: recording.sizeBytes,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      width: result.width ?? recording.width,
      height: result.height ?? recording.height,
      reason: result.reason
    }
  });

  runtime.screenRecording = null;
}

function ingestScreenRecordingError(
  runtime: SessionRuntime,
  recording: ScreenRecordingRuntime | null,
  error: unknown,
  stage: string
): void {
  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.error",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: recording?.recordingId,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stage
    }
  });
}

async function waitForScreenRecordingChunkWrites(recording: ScreenRecordingRuntime): Promise<void> {
  while (recording.pendingWrites.size > 0) {
    await Promise.allSettled([...recording.pendingWrites]);
  }
}

function resolveScreenRecordingChunkIndex(value: unknown, fallback: number): number {
  const numberValue = asFiniteNumber(value);
  return numberValue === null ? Math.max(0, fallback) : Math.max(0, Math.round(numberValue));
}

function normalizeRecordingOffset(value: unknown): number | undefined {
  const numberValue = asFiniteNumber(value);
  return numberValue === null ? undefined : Math.max(0, Math.round(numberValue));
}

function createScreenRecordingId(sid: string): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `VR-${sid}-${Date.now()}-${random}`;
}

async function captureDomSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!isRuntimeCaptureScopeActive(runtime) || hasDisallowedCdpFrames(runtime.cdpScope)) {
    return;
  }

  if (!runtime.cdpRouter) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.dom !== "allow") {
    return;
  }

  const snapshot = await sendCdpCommand<Record<string, unknown>>(
    runtime,
    { tabId: runtime.tabId },
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: [],
      includeDOMRects: false,
      includePaintOrder: false
    }
  );

  if (!snapshot) {
    return;
  }

  if (!isRuntimeCaptureScopeActive(runtime)) {
    return;
  }

  const scopedDocuments = filterCdpSnapshotDocuments(runtime.cdpScope, snapshot.documents);
  const scopedSnapshot = {
    ...snapshot,
    documents: scopedDocuments
  };
  const bytes = new TextEncoder().encode(JSON.stringify(scopedSnapshot));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);
  const firstDocument = scopedDocuments[0] as Record<string, unknown> | undefined;
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
  if (!isRuntimeCaptureScopeActive(runtime)) {
    return;
  }

  if (!runtime.cdpRouter) {
    return;
  }

  const policy = runtime.config.capturePolicy;

  const cookies =
    policy?.categories.cookies === "names-only"
      ? await sendCdpCommand<{ cookies?: unknown[] }>(
          runtime,
          { tabId: runtime.tabId },
          "Network.getCookies",
          {
            urls: [runtime.captureUrl]
          }
        )
      : null;

  if (cookies?.cookies && isRuntimeCaptureScopeActive(runtime)) {
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

  const localStorageMode = resolveLocalStorageSnapshotMode(policy);
  const localStorageData = localStorageMode
    ? await evaluateExpression(runtime, buildLocalStorageSnapshotExpression(localStorageMode))
    : null;

  if (typeof localStorageData === "string" && isRuntimeCaptureScopeActive(runtime)) {
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
        mode: localStorageMode,
        redacted: localStorageMode !== "allow",
        reason
      }
    });
  }

  const origin =
    policy?.categories.indexedDb === "names-only"
      ? await evaluateExpression(runtime, "location.origin")
      : null;

  if (typeof origin === "string" && isRuntimeCaptureScopeActive(runtime)) {
    const dbNames = await sendCdpCommand<{ databaseNames?: string[] }>(
      runtime,
      { tabId: runtime.tabId },
      "IndexedDB.requestDatabaseNames",
      {
        securityOrigin: origin
      }
    );

    if (dbNames?.databaseNames && isRuntimeCaptureScopeActive(runtime)) {
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

function resolveLocalStorageSnapshotMode(
  policy: CapturePolicy | undefined
): LocalStorageSnapshotMode | null {
  if (policy?.categories.storage === "allow" || policy?.categories.storage === "lengths-only") {
    return policy.categories.storage;
  }

  return null;
}

async function captureTraceMetrics(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!isRuntimeCaptureScopeActive(runtime)) {
    return;
  }

  if (!runtime.cdpRouter) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.cdp !== "full") {
    return;
  }

  const metrics = await sendCdpCommand<Record<string, unknown>>(
    runtime,
    { tabId: runtime.tabId },
    "Performance.getMetrics"
  );

  if (!metrics) {
    return;
  }

  if (!isRuntimeCaptureScopeActive(runtime)) {
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
  if (
    !runtime.cdpRouter ||
    !isRuntimeCaptureScopeActive(runtime) ||
    hasDisallowedCdpFrames(runtime.cdpScope)
  ) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.cdp !== "full") {
    return;
  }

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.enable");

  try {
    const started = await sendCdpCommandOutcome(
      runtime,
      { tabId: runtime.tabId },
      "Profiler.start"
    );

    if (!started.ok) {
      return;
    }

    await wait(CPU_PROFILE_SAMPLE_MS);

    const profileResult = await sendCdpCommand<{ profile?: unknown }>(
      runtime,
      { tabId: runtime.tabId },
      "Profiler.stop"
    );

    if (
      !profileResult?.profile ||
      !isRuntimeCaptureScopeActive(runtime) ||
      hasDisallowedCdpFrames(runtime.cdpScope)
    ) {
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
  } finally {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.disable");
  }
}

async function captureHeapSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (
    !runtime.cdpRouter ||
    !isRuntimeCaptureScopeActive(runtime) ||
    hasDisallowedCdpFrames(runtime.cdpScope)
  ) {
    return;
  }

  if (
    runtime.config.capturePolicy?.mode !== "lab" ||
    runtime.config.capturePolicy.categories.heapProfiles !== "lab-only"
  ) {
    return;
  }

  runtime.heapSnapshotCapture = {
    chunks: [],
    bytes: 0,
    truncated: false
  };

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.enable");

  const completed = await sendCdpCommandOutcome(
    runtime,
    { tabId: runtime.tabId },
    "HeapProfiler.takeHeapSnapshot",
    {
      reportProgress: false,
      captureNumericValue: true
    },
    CDP_HEAP_SNAPSHOT_TIMEOUT_MS
  );

  const snapshot = runtime.heapSnapshotCapture;
  runtime.heapSnapshotCapture = null;

  if (
    !completed.ok ||
    !snapshot ||
    snapshot.chunks.length === 0 ||
    !isRuntimeCaptureScopeActive(runtime) ||
    hasDisallowedCdpFrames(runtime.cdpScope)
  ) {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
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

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
}

function shouldCaptureAdvancedProfiles(reason: string): boolean {
  return reason === "manual";
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function sendCdpCommand<TResult = unknown>(
  runtime: SessionRuntime,
  target: { tabId: number; sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<TResult | undefined> {
  const outcome = await sendCdpCommandOutcome<TResult>(runtime, target, method, params, timeoutMs);
  return outcome.ok ? outcome.value : undefined;
}

async function sendCdpCommandOutcome<TResult = unknown>(
  runtime: SessionRuntime,
  target: { tabId: number; sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<CdpCommandOutcome<TResult>> {
  if (!runtime.cdpRouter || runtime.stopping) {
    return { ok: false };
  }

  return withCdpCommandTimeout(runtime.cdpRouter.send<TResult>(target, method, params), timeoutMs);
}

async function evaluateExpression(runtime: SessionRuntime, expression: string): Promise<unknown> {
  if (!runtime.cdpRouter) {
    return undefined;
  }

  const result = await sendCdpCommand<{
    result?: {
      value?: unknown;
    };
  }>(runtime, { tabId: runtime.tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

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

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value, (entry) =>
      typeof entry === "number" && Number.isFinite(entry) ? entry & 0xff : 0
    );
  }

  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const numericKeys = Object.keys(record)
    .filter((key) => /^\d+$/.test(key))
    .map((key) => Number(key))
    .sort((left, right) => left - right);

  if (numericKeys.length === 0) {
    return null;
  }

  const maxIndex = numericKeys[numericKeys.length - 1];

  if (typeof maxIndex !== "number" || !Number.isFinite(maxIndex)) {
    return null;
  }

  const bytes = new Uint8Array(maxIndex + 1);

  for (const index of numericKeys) {
    const byte = record[String(index)];

    if (typeof byte !== "number" || !Number.isFinite(byte)) {
      return null;
    }

    bytes[index] = byte & 0xff;
  }

  return bytes;
}

function normalizeContentFrameId(value: unknown): string | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null) {
    return undefined;
  }

  const frameId = Math.max(0, Math.floor(candidate));

  if (frameId <= 0) {
    return undefined;
  }

  return `content-frame-${frameId}`;
}

function normalizeSenderFrameId(sender: MessageSenderLike | undefined): number {
  const candidate = asFiniteNumber(sender?.frameId);

  if (candidate === null) {
    return sender?.frameId === undefined ? 0 : -1;
  }

  return candidate >= 0 ? Math.floor(candidate) : -1;
}

function authorizeContentSender(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  documentUrl?: string
): boolean {
  const tabId = sender?.tab?.id;
  const frameId = normalizeSenderFrameId(sender);

  if (typeof tabId !== "number" || tabId !== runtime.tabId || frameId < 0) {
    return false;
  }

  const senderUrl =
    typeof documentUrl === "string" && documentUrl.length > 0
      ? documentUrl
      : typeof sender?.url === "string" && sender.url.length > 0
        ? sender.url
        : frameId === 0
          ? runtime.captureUrl
          : null;
  const decision = evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url: senderUrl,
    tabId,
    frameId
  });

  if (!decision.allowed) {
    return false;
  }

  if (frameId === 0 && senderUrl && senderUrl !== runtime.captureUrl) {
    runtime.captureUrl = senderUrl;
    runtime.cdpScope.captureUrl = senderUrl;
    runtime.url = sanitizeUrlForPrivacy(senderUrl);
    resetAuthorizedContentFrames(runtime);
  }

  runtime.authorizedContentFrames.add(frameId);
  return true;
}

async function deactivateDeniedContentFrame(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  port?: PortLike
): Promise<void> {
  const frameId = normalizeSenderFrameId(sender);

  if (frameId < 0) {
    return;
  }

  if (port?.name === PORT_NAMES.content) {
    sendContentPortRecordingState(port, runtime, false);
  } else {
    await notifyTabStatus(
      runtime.tabId,
      false,
      runtime.sid,
      runtime.mode,
      toStatusSampling(runtime),
      runtime.config.capturePolicy,
      frameId
    );
  }

  runtime.authorizedContentFrames.delete(frameId);
}

function resetAuthorizedContentFrames(runtime: SessionRuntime): void {
  runtime.authorizedContentFrames.clear();
  runtime.authorizedContentFrames.add(0);
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

function normalizeOptionalSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(250, Math.round(value));
}

function resolveExportPolicy(value: unknown): ExportPolicy {
  const row = asRecord(value);
  const includeScreenshots =
    typeof row?.includeScreenshots === "boolean"
      ? row.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof row?.includeScreenRecordings === "boolean"
      ? row.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;

  return {
    includeScreenshots,
    includeScreenRecordings,
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
    screenshotIdleMs: normalizeOptionalSamplingInterval(
      sampling.screenshotIdleMs,
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    ),
    bodyCaptureMaxBytes:
      runtime.config.capturePolicy?.categories.network === "body-allowlist"
        ? normalizeBodyCaptureMaxBytesUtil(sampling.bodyCaptureMaxBytes, 0)
        : 0
  };
}

function shouldInjectHooksForMode(mode: CaptureMode): boolean {
  return shouldInjectPageHooksForMode(mode);
}

function normalizePipelineResumeState(raw: unknown): PipelineResumeState {
  const row = asRecord(raw);
  const sequence = asRecord(row?.sequenceWatermark);
  const event = sequence?.event;
  const action = sequence?.action;

  if (
    !row ||
    Object.keys(row).length !== 2 ||
    !sequence ||
    Object.keys(sequence).length !== 2 ||
    !Number.isSafeInteger(event) ||
    (event as number) < 0 ||
    !Number.isSafeInteger(action) ||
    (action as number) < 0 ||
    !Array.isArray(row.screenRecordings) ||
    row.screenRecordings.length > 32
  ) {
    throw new Error("Invalid offscreen pipeline resume state.");
  }

  const screenRecordings: PipelineResumeState["screenRecordings"] = [];
  const recordingIds = new Set<string>();
  let totalChunks = 0;

  for (const candidate of row.screenRecordings) {
    const recording = asRecord(candidate);

    if (
      !recording ||
      Object.keys(recording).length !== 2 ||
      typeof recording.recordingId !== "string" ||
      recording.recordingId.length === 0 ||
      recording.recordingId.length > 256 ||
      recordingIds.has(recording.recordingId) ||
      !Array.isArray(recording.chunks)
    ) {
      throw new Error("Invalid offscreen screen-recording resume state.");
    }

    recordingIds.add(recording.recordingId);
    totalChunks += recording.chunks.length;

    if (totalChunks > PIPELINE_RESUME_MAX_SCREEN_CHUNKS) {
      throw new Error("Offscreen screen-recording resume state is too large.");
    }

    const chunks: ScreenRecordingChunkReference[] = [];
    const indexes = new Set<number>();

    for (const chunkCandidate of recording.chunks) {
      const chunk = asRecord(chunkCandidate);
      const index = chunk?.index;
      const hash = chunk?.hash;
      const size = chunk?.size;
      const chunkKeys = chunk ? Object.keys(chunk) : [];

      if (
        !chunk ||
        (chunkKeys.length !== 2 && chunkKeys.length !== 3) ||
        (chunkKeys.length === 3 && (!chunkKeys.includes("size") || size === undefined)) ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= PIPELINE_RESUME_MAX_SCREEN_CHUNKS ||
        indexes.has(index as number) ||
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(hash) ||
        (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 0))
      ) {
        throw new Error("Invalid offscreen screen-recording chunk reference.");
      }

      indexes.add(index as number);
      chunks.push({
        index: index as number,
        hash,
        ...(size === undefined ? {} : { size: size as number })
      });
    }

    screenRecordings.push({
      recordingId: recording.recordingId,
      chunks: chunks.sort((left, right) => left.index - right.index)
    });
  }

  return {
    sequenceWatermark: {
      event: event as number,
      action: action as number
    },
    screenRecordings
  };
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
    integrity: normalizeHashesManifest(row.integrity),
    privacyScanner: normalizePrivacyScannerResult(row.privacyScanner)
  };
}

function normalizePrivacyScannerResult(raw: unknown): PrivacyScannerResult | undefined {
  const row = asRecord(raw);

  if (!row) {
    return undefined;
  }

  const status = row.status === "blocked" ? "blocked" : row.status === "passed" ? "passed" : null;
  const scannedAt = typeof row.scannedAt === "string" ? row.scannedAt : new Date().toISOString();
  const preEncryption = row.preEncryption === true;
  const findings = Array.isArray(row.findings)
    ? row.findings.map(normalizePrivacyScannerFinding).filter((finding) => finding !== null)
    : [];

  if (!status) {
    return undefined;
  }

  return {
    scannedAt,
    preEncryption,
    status,
    findings
  };
}

function normalizePrivacyScannerFinding(raw: unknown): PrivacyScannerFinding | null {
  const row = asRecord(raw);

  if (!row) {
    return null;
  }

  const kind = normalizePrivacyScannerFindingKind(row.kind);
  const path = typeof row.path === "string" && row.path.length > 0 ? row.path : null;
  const matchCount = asFiniteNumber(row.matchCount);
  const sampleSha256 =
    typeof row.sampleSha256 === "string" && /^[a-f0-9]{64}$/u.test(row.sampleSha256)
      ? row.sampleSha256
      : "0".repeat(64);

  if (!kind || !path || matchCount === null || matchCount <= 0) {
    return null;
  }

  return {
    kind,
    severity: "high",
    path,
    matchCount: Math.round(matchCount),
    sampleSha256
  };
}

function normalizePrivacyScannerFindingKind(raw: unknown): PrivacyScannerFindingKind | null {
  if (typeof raw !== "string") {
    return null;
  }

  switch (raw) {
    case "jwt":
    case "bearer-token":
    case "api-key":
    case "oauth-code":
    case "session-cookie":
    case "email":
    case "phone":
    case "credit-card":
    case "ssn":
    case "private-key":
    case "long-secret":
      return raw;
    default:
      return null;
  }
}

function buildExportPrivacyWarning(
  scanner: PrivacyScannerResult | undefined
): ExportPrivacyWarning | undefined {
  if (scanner?.status !== "blocked" || scanner.findings.length === 0) {
    return undefined;
  }

  const findings = scanner.findings.slice(0, 8).map((finding) => ({
    kind: finding.kind,
    path: finding.path,
    matchCount: finding.matchCount
  }));
  const summary = findings
    .slice(0, 5)
    .map((finding) => `${finding.kind} in ${finding.path}`)
    .join(", ");

  return {
    findingCount: scanner.findings.length,
    summary,
    findings
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

async function ensureInjectedHooks(tabId: number, frameId: number): Promise<void> {
  await chromeApi?.scripting
    ?.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      files: ["injected.js"]
    })
    .catch(() => undefined);
}

async function ensureContentScriptInjected(runtime: SessionRuntime): Promise<void> {
  await chromeApi?.scripting
    ?.executeScript({
      target: {
        ...resolveContentScriptInjectionTarget(runtime.config.capturePolicy, runtime.tabId)
      },
      world: "ISOLATED",
      files: ["content.js"]
    })
    .catch(() => undefined);
}

function installLiteWebRequestCapture(): void {
  if (!chromeApi?.webRequest || liteWebRequestCaptureCleanup) {
    return;
  }

  const filter = { urls: ["<all_urls>"] };
  const onBeforeRequest = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId, details.frameId);

    if (!runtime) {
      return;
    }

    const startedAt = normalizeLiteNetworkTimestamp(details.timeStamp);
    upsertRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId), {
      url: details.url,
      method: details.method,
      startedAt
    });

    ingestRawEvent(
      buildLiteNetworkRequestRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method,
          url: details.url,
          timeStamp: startedAt
        }
      )
    );
  };

  const onCompleted = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    statusCode?: number;
    statusLine?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId, details.frameId);

    if (!runtime) {
      return;
    }

    const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    ingestRawEvent(
      buildLiteNetworkResponseRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method ?? metadata?.method,
          url: details.url ?? metadata?.url ?? "unknown://request",
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          timeStamp: endedAt,
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
  };

  const onErrorOccurred = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    error?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId, details.frameId);

    if (!runtime) {
      return;
    }

    const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    ingestRawEvent(
      buildLiteNetworkFailureRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method ?? metadata?.method,
          url: details.url ?? metadata?.url ?? "unknown://request",
          timeStamp: endedAt,
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined,
          error: details.error
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
  };

  chromeApi.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  chromeApi.webRequest.onCompleted.addListener(onCompleted, filter);
  chromeApi.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);

  liteWebRequestCaptureCleanup = () => {
    chromeApi.webRequest?.onBeforeRequest.removeListener(onBeforeRequest);
    chromeApi.webRequest?.onCompleted.removeListener(onCompleted);
    chromeApi.webRequest?.onErrorOccurred.removeListener(onErrorOccurred);
    liteWebRequestCaptureCleanup = null;
  };
}

function uninstallLiteWebRequestCaptureIfUnused(): void {
  if (!liteWebRequestCaptureCleanup || hasActiveLiteRuntime()) {
    return;
  }

  liteWebRequestCaptureCleanup();
}

function hasActiveLiteRuntime(): boolean {
  for (const runtime of sessionsByTab.values()) {
    if (runtime.mode === "lite" && !runtime.stopping && !runtime.stoppedAt) {
      return true;
    }
  }

  return false;
}

function resolveLiteRuntimeForWebRequest(
  tabId: number,
  frameIdCandidate?: number
): SessionRuntime | undefined {
  if (!Number.isFinite(tabId) || tabId < 0) {
    return undefined;
  }

  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.mode !== "lite" || runtime.stopping) {
    return undefined;
  }

  const frameId =
    typeof frameIdCandidate === "number" && Number.isFinite(frameIdCandidate)
      ? Math.max(0, Math.floor(frameIdCandidate))
      : 0;

  if (frameId > 0 && !runtime.authorizedContentFrames.has(frameId)) {
    return undefined;
  }

  if (
    !evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
      url: runtime.captureUrl,
      tabId,
      frameId: 0
    }).allowed
  ) {
    return undefined;
  }

  return runtime;
}

function normalizeLiteNetworkTimestamp(candidate: unknown): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.round(candidate)
    : Date.now();
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
    reasons: ["DOM_PARSER", "USER_MEDIA"],
    justification:
      "WebBlackbox uses offscreen document for persistent local recording pipeline and optional tab video capture."
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
  if (runtime.consentExpiryTimer !== null) {
    clearTimeout(runtime.consentExpiryTimer);
    runtime.consentExpiryTimer = null;
  }

  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  await cleanupCdpInstrumentation(runtime, runtime.cdpRouter);
}

function scheduleConsentExpiry(runtime: SessionRuntime): void {
  if (runtime.consentExpiryTimer !== null) {
    clearTimeout(runtime.consentExpiryTimer);
    runtime.consentExpiryTimer = null;
  }

  const expiresAt = runtime.config.capturePolicy?.consent.expiresAt;

  if (!expiresAt) {
    return;
  }

  const delay = Date.parse(expiresAt) - Date.now();

  if (!Number.isFinite(delay) || delay <= 0) {
    void stopSession(runtime.tabId);
    return;
  }

  runtime.consentExpiryTimer = setTimeout(
    () => {
      runtime.consentExpiryTimer = null;

      if (Date.now() >= Date.parse(expiresAt)) {
        void stopSession(runtime.tabId);
        return;
      }

      scheduleConsentExpiry(runtime);
    },
    Math.min(delay, 2_147_000_000)
  );
}

async function cleanupCdpInstrumentation(
  runtime: SessionRuntime,
  router: CdpRouter | null
): Promise<void> {
  if (runtime.screenshotInterval !== null) {
    clearInterval(runtime.screenshotInterval);
    runtime.screenshotInterval = null;
  }

  if (router) {
    await router.detach(runtime.tabId).catch(() => undefined);
  }

  for (const dispose of runtime.removeCdpListeners.splice(0, runtime.removeCdpListeners.length)) {
    dispose();
  }

  router?.dispose();

  if (runtime.cdpRouter === router) {
    runtime.cdpRouter = null;
  }

  runtime.enabledCdpSessions.clear();
  clearCdpCaptureScopeState(runtime.cdpScope);
  runtime.requestMeta.clear();
  runtime.responseBodyCaptureTimestamps.length = 0;
  runtime.heapSnapshotCapture = null;
}

async function scheduleStoppedRuntimeCleanup(runtime: SessionRuntime): Promise<void> {
  if (!runtime.stoppedAt || !runtime.cleanupDeadline) {
    throw new Error("Stopped session is missing its absolute cleanup deadline.");
  }

  await runtimeCleanupScheduler.schedule(runtime.sid, runtime.cleanupDeadline);
}

async function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (!sessionsBySid.has(runtime.sid)) {
    return;
  }

  await flushBufferedPipelineEvents(runtime).catch((error) => {
    console.warn("[WebBlackbox] stopped-session buffer flush failed during purge", error);
  });
  await runtime.queue.catch((error) => {
    console.warn("[WebBlackbox] stopped-session queue drain failed during purge", error);
  });
  await runtime.pipeline.flush().catch(() => undefined);
  await runtime.pipeline.close({
    purge: true
  });
  sessionsBySid.delete(runtime.sid);
  await runtimeCleanupScheduler.cancel(runtime.sid).catch(() => undefined);
  if (sessionAnnotations.delete(runtime.sid)) {
    await persistSessionAnnotations().catch(() => undefined);
  }

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await closeOffscreenIfUnused().catch(() => undefined);
  pushSessionList();
  await persistRuntimeState().catch((error) => {
    console.warn("[WebBlackbox] failed to persist stopped-session purge", error);
  });
  notifyOffscreenPipelineStatus();
}

function resolveRuntimeLocalTtlMs(policy: CapturePolicy | null | undefined): number {
  const ttl = policy?.retention.localTtlMs;

  if (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0) {
    return ttl;
  }

  return (
    DEFAULT_RECORDER_CONFIG.capturePolicy?.retention.localTtlMs ??
    DEFAULT_CAPTURE_POLICY.retention.localTtlMs
  );
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
    url: sanitizeUrlForPrivacy(runtime.url),
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
    endedAt: runtime.stoppedAt,
    mode: runtime.mode,
    url: sanitizeUrlForPrivacy(runtime.url),
    title: runtime.title,
    tags: [...runtime.tags]
  };
}

async function resolveTabSessionMetadata(
  tabId: number
): Promise<Pick<SessionMetadata, "url" | "title"> & { captureUrl: string }> {
  const fallbackUrl = `tab:${tabId}`;

  if (!chromeApi?.tabs?.get) {
    return {
      url: fallbackUrl,
      captureUrl: fallbackUrl
    };
  }

  try {
    const tab = await chromeApi.tabs.get(tabId);
    const captureUrl = typeof tab?.url === "string" && tab.url.length > 0 ? tab.url : fallbackUrl;
    const url = sanitizeUrlForPrivacy(captureUrl);
    const title =
      typeof tab?.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : undefined;

    return {
      url,
      captureUrl,
      title
    };
  } catch {
    return {
      url: fallbackUrl,
      captureUrl: fallbackUrl
    };
  }
}

function updateSessionMetadataFromEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  void updateSessionMetadataFromEventAsync(runtime, event).catch((error) => {
    console.warn("[WebBlackbox] failed to update session navigation metadata", error);
  });
}

async function updateSessionMetadataFromEventAsync(
  runtime: SessionRuntime,
  event: WebBlackboxEvent
): Promise<void> {
  if (
    event.type !== "nav.commit" &&
    event.type !== "nav.history.push" &&
    event.type !== "nav.history.replace" &&
    event.type !== "nav.hash"
  ) {
    return;
  }

  const payload = asRecord(event.data);

  if (!shouldUpdateSessionMetadataFromNavigation(event, payload)) {
    return;
  }

  const frame = asRecord(payload?.frame);
  const nextUrl = asString(payload?.url) ?? asString(frame?.url);
  const nextTitle = asString(payload?.title) ?? asString(payload?.documentTitle);
  let changed = false;

  if (nextUrl) {
    if (!(await isRuntimeTopDocumentAllowed(runtime, nextUrl))) {
      await stopSession(runtime.tabId);
      return;
    }

    const sanitizedNextUrl = sanitizeUrlForPrivacy(nextUrl);

    if (sanitizedNextUrl !== runtime.url || nextUrl !== runtime.captureUrl) {
      runtime.url = sanitizedNextUrl;
      runtime.captureUrl = nextUrl;
      runtime.cdpScope.captureUrl = nextUrl;
      resetAuthorizedContentFrames(runtime);
      changed = true;
    }
  }

  if (nextTitle && nextTitle.trim().length > 0 && nextTitle !== runtime.title) {
    runtime.title = nextTitle.trim();
    changed = true;
  }

  if (changed) {
    pushSessionList();
    scheduleRuntimeStatePersist();
  }
}

function pushSessionList(): void {
  broadcast(buildSessionListMessage());
}

function buildSessionListMessage(): SessionListMessage {
  const sessions: SessionListItem[] = [...sessionsBySid.values()]
    .map((runtime) => toSessionListItem(runtime))
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);

      if (activeDiff !== 0) {
        return activeDiff;
      }

      return right.startedAt - left.startedAt;
    });

  return {
    kind: "sw.session-list",
    sessions
  };
}

async function handleTabUrlChanged(tabId: number, rawUrl: string): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  if (!(await isRuntimeTopDocumentAllowed(runtime, rawUrl))) {
    await stopSession(tabId);
    return;
  }

  const nextUrl = sanitizeUrlForPrivacy(rawUrl);

  if (nextUrl !== runtime.url || rawUrl !== runtime.captureUrl) {
    runtime.url = nextUrl;
    runtime.captureUrl = rawUrl;
    runtime.cdpScope.captureUrl = rawUrl;
    resetAuthorizedContentFrames(runtime);
    pushSessionList();
    scheduleRuntimeStatePersist();
  }
}

async function isRuntimeTopDocumentAllowed(
  runtime: SessionRuntime,
  rawUrl: string
): Promise<boolean> {
  const decision = evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url: rawUrl,
    tabId: runtime.tabId,
    frameId: 0
  });

  if (!decision.allowed) {
    return false;
  }

  return !(await shouldStopForEnterpriseOriginPolicy(decision.origin));
}

async function shouldStopForEnterpriseOriginPolicy(nextOrigin: string | null): Promise<boolean> {
  const enterprisePolicy = await loadEnterprisePolicy();

  return shouldStopForEnterpriseOriginPolicyInput({
    nextOrigin,
    isEnterpriseOriginAllowed: (origin) => isEnterpriseOriginAllowed(origin, enterprisePolicy)
  });
}

function resolveUrlOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

function broadcast(message: ExtensionOutboundMessage): void {
  for (const port of connectedPorts) {
    if (port.name === PORT_NAMES.content && message.kind === "sw.recording-status") {
      continue;
    }

    sendPortMessage(port, message);
  }
}

function sendPortMessage(port: PortLike, message: ExtensionOutboundMessage): void {
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

async function loadRecorderConfig(mode: CaptureMode): Promise<typeof DEFAULT_RECORDER_CONFIG> {
  const baseConfig = resolveModeBaseConfig(mode);

  const storedValues = await chromeApi?.storage?.local?.get(OPTIONS_STORAGE_KEY);

  return resolveModeRecorderConfig(mode, baseConfig, storedValues?.[OPTIONS_STORAGE_KEY]);
}

function resolveFullModeVisualCapture(
  message: ExtensionInboundMessage
): FullModeVisualCapture | undefined {
  if (message.kind !== "ui.start" || message.mode !== "full") {
    return undefined;
  }

  if (isFullModeVisualCapture(message.visualCapture)) {
    return message.visualCapture;
  }

  return message.recordScreen === true ? "both" : undefined;
}

function isFullModeVisualCapture(value: unknown): value is FullModeVisualCapture {
  return value === "screenshots" || value === "recording" || value === "both" || value === "none";
}

function applyFullModeVisualCapture(
  config: typeof DEFAULT_RECORDER_CONFIG,
  mode: CaptureMode,
  visualCapture: FullModeVisualCapture | undefined
): typeof DEFAULT_RECORDER_CONFIG {
  if (mode !== "full" || !visualCapture) {
    return config;
  }

  const basePolicy =
    config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const screenshots = visualCapture === "screenshots" || visualCapture === "both" ? "allow" : "off";
  const screenRecordings =
    visualCapture === "recording" || visualCapture === "both" ? "allow" : "off";

  return {
    ...config,
    capturePolicy: {
      ...basePolicy,
      categories: {
        ...basePolicy.categories,
        screenshots,
        screenRecordings
      }
    }
  };
}

async function loadEnterprisePolicy(): Promise<EnterpriseRecorderPolicy> {
  try {
    const values = await chromeApi?.storage?.managed?.get(ENTERPRISE_POLICY_STORAGE_KEY);
    const scoped = asRecord(values?.[ENTERPRISE_POLICY_STORAGE_KEY]);

    return normalizeEnterprisePolicy(scoped ?? values ?? {});
  } catch {
    return normalizeEnterprisePolicy({});
  }
}

function withSessionCapturePolicy(
  config: typeof DEFAULT_RECORDER_CONFIG,
  context: {
    tabId: number;
    origin: string;
    startedAt: number;
  }
): typeof DEFAULT_RECORDER_CONFIG {
  const basePolicy =
    config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const sessionPolicy = bindCapturePolicyToSession(basePolicy, {
    tabId: context.tabId,
    origin: context.origin
  });
  const capturePolicy: CapturePolicy = {
    ...sessionPolicy,
    consent: {
      ...sessionPolicy.consent,
      grantedAt: new Date(context.startedAt).toISOString()
    },
    redaction: config.redaction
  };

  return {
    ...config,
    capturePolicy
  };
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
      screenshotIdleMs: base.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: 0
    }
  };
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
  await persistRuntimeState().catch(() => undefined);
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

  const snapshot = createRuntimeStateSnapshot([...sessionsBySid.values()].map(toPersistedRuntime));
  const operation = runtimeStatePersistTail
    .catch(() => undefined)
    .then(async () => {
      await chromeApi.storage!.local.set({
        [ACTIVE_SESSION_STORAGE_KEY]: snapshot
      });
    });
  runtimeStatePersistTail = operation;
  await operation;
}

function scheduleRuntimeStatePersist(): void {
  if (runtimeStatePersistTimer !== null) {
    return;
  }

  runtimeStatePersistTimer = setTimeout(() => {
    runtimeStatePersistTimer = null;
    void persistRuntimeState().catch((error) => {
      console.warn("[WebBlackbox] failed to persist runtime checkpoint", error);
    });
  }, RUNTIME_STATE_PERSIST_DEBOUNCE_MS);
}

function toPersistedRuntime(runtime: SessionRuntime): PersistedRuntime {
  const recorderSequence = runtime.recorder.getSequenceState();
  const counters: PersistedRuntimeCounters = {
    recorderEventSequence: recorderSequence.event,
    recorderActionSequence: recorderSequence.action,
    eventCount: runtime.capturedEventCount,
    errorCount: runtime.capturedErrorCount,
    sizeBytes: runtime.capturedSizeBytes,
    budgetAlertCount: runtime.budgetAlertCount,
    droppedBestEffortTasks: runtime.droppedBestEffortTasks,
    responseBodyCaptures: runtime.responseBodyCaptures,
    networkTotal: runtime.networkBudgetSample.total,
    networkFailed: runtime.networkBudgetSample.failed
  };
  const screenRecording: PersistedScreenRecording | undefined = runtime.screenRecording
    ? {
        recordingId: runtime.screenRecording.recordingId,
        startedAt: runtime.screenRecording.startedAt,
        startedMono: runtime.screenRecording.startedMono,
        mime: runtime.screenRecording.mime,
        ...(runtime.screenRecording.width ? { width: runtime.screenRecording.width } : {}),
        ...(runtime.screenRecording.height ? { height: runtime.screenRecording.height } : {}),
        ...(runtime.screenRecording.frameRate
          ? { frameRate: runtime.screenRecording.frameRate }
          : {}),
        chunkCount: runtime.screenRecording.chunkCount,
        sizeBytes: runtime.screenRecording.sizeBytes
      }
    : undefined;
  const base = {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    url: sanitizeUrlForPrivacy(runtime.url),
    ...(runtime.title ? { title: runtime.title.slice(0, 1_024) } : {}),
    tags: normalizeSessionTags(runtime.tags),
    ...(runtime.note ? { note: normalizeSessionNote(runtime.note) } : {}),
    config: runtime.config,
    startedAt: runtime.startedAt,
    counters,
    ...(screenRecording ? { screenRecording } : {})
  };

  if (runtime.stoppedAt) {
    const cleanupDeadline =
      runtime.cleanupDeadline ??
      runtime.stoppedAt + resolveRuntimeLocalTtlMs(runtime.config.capturePolicy);
    return {
      ...base,
      state: "stopped",
      stoppedAt: runtime.stoppedAt,
      cleanupDeadline
    };
  }

  return {
    ...base,
    state: "active"
  };
}

async function appendExportAuditEvent(event: ExportAuditEvent): Promise<void> {
  if (!chromeApi?.storage?.local?.get || !chromeApi.storage.local.set) {
    return;
  }

  const values = await chromeApi.storage.local.get(EXPORT_AUDIT_STORAGE_KEY);
  const current = Array.isArray(values[EXPORT_AUDIT_STORAGE_KEY])
    ? (values[EXPORT_AUDIT_STORAGE_KEY] as unknown[])
    : [];
  const events = [...current.slice(-EXPORT_AUDIT_MAX_EVENTS + 1), event];

  await chromeApi.storage.local.set({
    [EXPORT_AUDIT_STORAGE_KEY]: events
  });
}

function redactOperationalMessage(message: string): string {
  return message
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/\b(?:https?|file):\/\/[^\s)]+/gi, "[redacted-url]")
    .slice(0, 240);
}

async function restoreRuntimeState(): Promise<void> {
  await loadSessionAnnotations();

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
  const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];
  const snapshot = parseRuntimeStateSnapshot(persisted);

  if (persisted !== undefined && !snapshot) {
    const identities = extractPersistedRuntimeIdentities(persisted);
    sessionAnnotations.clear();
    await persistSessionAnnotations().catch(() => undefined);
    await chromeApi.storage.local
      .set({
        [ACTIVE_SESSION_STORAGE_KEY]: createRuntimeStateSnapshot([])
      })
      .catch(() => undefined);
    await clearStaleRuntimeCleanupAlarms(new Set());

    for (const identity of identities) {
      await notifyTabStatus(identity.tabId, false);
      await purgePersistedRuntimeData({
        ...identity,
        mode: "lite",
        url: "https://invalid.invalid/",
        title: undefined,
        tags: [],
        config: withSessionCapturePolicy(resolveModeBaseConfig("lite"), {
          tabId: identity.tabId,
          origin: "https://invalid.invalid",
          startedAt: identity.startedAt
        })
      });
    }
  } else if (snapshot) {
    const enterprisePolicy = await loadEnterprisePolicy();
    const performanceBudget = await loadPerformanceBudgetConfig();
    const stoppedRuntimes: SessionRuntime[] = [];

    for (const persistedRuntime of snapshot.sessions) {
      const config = applyEnterprisePolicyToRecorderConfig(
        persistedRuntime.config,
        enterprisePolicy
      );

      try {
        if (persistedRuntime.state === "stopped") {
          const runtime = await restoreStoppedRuntime(persistedRuntime, config, performanceBudget);
          stoppedRuntimes.push(runtime);
          continue;
        }

        const restored = await restoreActiveRuntime(persistedRuntime, config, performanceBudget);

        if (!restored) {
          await notifyTabStatus(persistedRuntime.tabId, false);
          await purgePersistedRuntimeData({ ...persistedRuntime, config });
        }
      } catch (error) {
        console.warn("[WebBlackbox] failed closed while restoring session", {
          sid: persistedRuntime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
        await notifyTabStatus(persistedRuntime.tabId, false);
        await purgePersistedRuntimeData({ ...persistedRuntime, config });
      }
    }

    await clearStaleRuntimeCleanupAlarms(new Set(stoppedRuntimes.map((runtime) => runtime.sid)));

    for (const runtime of stoppedRuntimes) {
      if (sessionsBySid.get(runtime.sid) === runtime) {
        await scheduleStoppedRuntimeCleanup(runtime).catch((error) => {
          console.warn("[WebBlackbox] stopped-session cleanup scheduled for retry", {
            sid: runtime.sid,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }

    await persistRuntimeState();
  }

  if (sessionsByTab.size > 0) {
    await setRecordingBadge();
  } else {
    await setIdleBadge();
  }
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

async function failClosedRuntimeRestoration(): Promise<void> {
  const runtimes = [...sessionsBySid.values()];
  sessionsByTab.clear();
  sessionsBySid.clear();
  sessionAnnotations.clear();
  uninstallLiteWebRequestCaptureIfUnused();

  for (const runtime of runtimes) {
    await runtimeCleanupScheduler.cancel(runtime.sid).catch(() => undefined);

    if (!runtime.stoppedAt) {
      await notifyAuthorizedContentFrames(runtime, false).catch(() => undefined);
      await teardownCaptureInstrumentation(runtime).catch(() => undefined);
    }

    await runtime.pipeline.close({ purge: true }).catch(() => undefined);
  }

  await chromeApi?.storage?.local
    ?.set({
      [ACTIVE_SESSION_STORAGE_KEY]: createRuntimeStateSnapshot([])
    })
    .catch(() => undefined);
  await persistSessionAnnotations().catch(() => undefined);

  for (const port of connectedPorts) {
    if (port.name === PORT_NAMES.content) {
      sendInactiveContentPortState(port);
    }
  }

  await setIdleBadge();
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

async function restoreActiveRuntime(
  persisted: PersistedActiveRuntime,
  config: typeof DEFAULT_RECORDER_CONFIG,
  performanceBudget: PerformanceBudgetConfig
): Promise<SessionRuntime | null> {
  let tab: {
    id?: number;
    active?: boolean;
    url?: string;
    title?: string;
    lastAccessed?: number;
  } | null = null;

  try {
    tab = chromeApi?.tabs?.get ? await chromeApi.tabs.get(persisted.tabId) : null;
  } catch {
    tab = null;
  }

  const candidate: PersistedActiveRuntime = {
    ...persisted,
    config
  };
  const decision = evaluateActiveRuntimeRestoration(candidate, tab, Date.now());

  if (!decision.allowed) {
    console.warn("[WebBlackbox] active session checkpoint rejected", {
      sid: persisted.sid,
      reason: decision.reason
    });
    return null;
  }

  await ensureOffscreenDocument();
  const pipeline = createOffscreenPipelineClient(persisted.sid);
  await pipeline.start(
    {
      sid: persisted.sid,
      tabId: persisted.tabId,
      startedAt: persisted.startedAt,
      mode: persisted.mode,
      url: decision.sanitizedUrl,
      title: persisted.title,
      tags: [...persisted.tags]
    },
    config.redaction,
    config.capturePolicy
  );
  const resumeState = await pipeline.getResumeState();
  const restoredCounters = mergeRuntimeCountersWithSequenceWatermark(
    persisted.counters,
    resumeState.sequenceWatermark
  );
  const screenRecordingResume = persisted.screenRecording
    ? resumeState.screenRecordings.find(
        (recording) => recording.recordingId === persisted.screenRecording?.recordingId
      )
    : undefined;
  const screenRecordingStatus = normalizeOffscreenScreenRecordingStatus(
    await requestOffscreenPipeline<unknown>({
      op: "getScreenRecordingStatus",
      sid: persisted.sid
    })
  );

  const reconciledScreenRecording = reconcileScreenRecordingResumeState(
    persisted.screenRecording,
    screenRecordingResume
  );
  const screenRecordingAllowedByCurrentPolicy =
    persisted.mode === "full" && config.capturePolicy?.categories.screenRecordings === "allow";
  const recorderSurvived = Boolean(
    screenRecordingAllowedByCurrentPolicy &&
    persisted.screenRecording &&
    screenRecordingStatus.active &&
    screenRecordingStatus.recordingId === persisted.screenRecording.recordingId &&
    reconciledScreenRecording.screenRecording
  );
  let policyStoppedRecordingId: string | undefined;

  if (screenRecordingStatus.active && !screenRecordingAllowedByCurrentPolicy) {
    await requestOffscreenPipeline<OffscreenScreenRecordingStopResult>({
      op: "stopScreenRecording",
      sid: persisted.sid,
      recordingId: screenRecordingStatus.recordingId,
      reason: "policy-disabled-after-restart"
    });
    policyStoppedRecordingId = screenRecordingStatus.recordingId;
  }

  const statusResume = screenRecordingStatus.active
    ? resumeState.screenRecordings.find(
        (recording) => recording.recordingId === screenRecordingStatus.recordingId
      )
    : undefined;
  const provisionalPersistedScreenRecording =
    screenRecordingStatus.active && screenRecordingAllowedByCurrentPolicy && !recorderSurvived
      ? screenRecordingStatus.recordingId === persisted.screenRecording?.recordingId
        ? persisted.screenRecording
        : {
            recordingId: screenRecordingStatus.recordingId,
            startedAt: Date.now(),
            startedMono: monotonicTime(),
            mime: screenRecordingStatus.mime,
            width: screenRecordingStatus.width,
            height: screenRecordingStatus.height,
            frameRate: screenRecordingStatus.frameRate,
            chunkCount: 0,
            sizeBytes: 0
          }
      : undefined;
  const provisionalScreenRecording = reconcileScreenRecordingResumeState(
    provisionalPersistedScreenRecording,
    statusResume
  );
  const screenRecording = recorderSurvived
    ? reconciledScreenRecording.screenRecording
    : provisionalPersistedScreenRecording
      ? (provisionalScreenRecording.screenRecording ?? {
          ...provisionalPersistedScreenRecording,
          chunkCount: 0,
          sizeBytes: 0
        })
      : undefined;
  const screenRecordingChunks = recorderSurvived
    ? reconciledScreenRecording.chunks
    : provisionalPersistedScreenRecording
      ? (provisionalScreenRecording.chunks ?? [])
      : undefined;

  const runtime = createSessionRuntime({
    sid: persisted.sid,
    tabId: persisted.tabId,
    mode: persisted.mode,
    url: decision.sanitizedUrl,
    captureUrl: decision.captureUrl,
    title:
      typeof tab?.title === "string" && tab.title.trim().length > 0
        ? tab.title.trim().slice(0, 1_024)
        : persisted.title,
    tags: persisted.tags,
    note: persisted.note,
    config,
    startedAt: persisted.startedAt,
    pipeline,
    performanceBudget,
    counters: restoredCounters,
    screenRecording,
    screenRecordingChunks
  });
  sessionsByTab.set(runtime.tabId, runtime);
  sessionsBySid.set(runtime.sid, runtime);
  scheduleConsentExpiry(runtime);

  let recoveredRecordingId = policyStoppedRecordingId;

  if (screenRecordingStatus.active && screenRecordingAllowedByCurrentPolicy && !recorderSurvived) {
    const stopped = await requestOffscreenPipeline<OffscreenScreenRecordingStopResult>({
      op: "stopScreenRecording",
      sid: persisted.sid,
      recordingId: screenRecordingStatus.recordingId,
      reason: "resume-state-not-durable"
    });
    await finalizeScreenRecording(runtime, stopped);
    await flushBufferedPipelineEvents(runtime);
    await runtime.pipeline.flush();
    recoveredRecordingId = screenRecordingStatus.recordingId;
  }

  const interruptedScreenRecordings = buildInterruptedScreenRecordingRecoveries({
    persisted: persisted.screenRecording,
    resumeState,
    status: screenRecordingStatus,
    claimedRecordingId:
      recoveredRecordingId ??
      (recorderSurvived ? persisted.screenRecording?.recordingId : undefined)
  });

  if (runtime.mode === "lite") {
    installLiteWebRequestCapture();
  }

  if (shouldInjectHooksForMode(runtime.mode)) {
    await ensureContentScriptInjected(runtime);
    await ensureInjectedHooks(runtime.tabId, 0);
  }

  if (runtime.mode === "full" && runtime.config.capturePolicy?.categories.cdp !== "off") {
    await attachCdp(runtime);
  }

  await notifyAuthorizedContentFrames(runtime, true);

  if (interruptedScreenRecordings.length > 0) {
    for (const interrupted of interruptedScreenRecordings) {
      const hashes = [...interrupted.chunks]
        .sort((left, right) => left.index - right.index)
        .map((chunk) => chunk.hash);
      const endedAt = Date.now();

      ingestRawEvent({
        source: "system",
        rawType: "screen.recording.end",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: endedAt,
        mono: monotonicTime(),
        payload: {
          recordingId: interrupted.recordingId,
          mime: interrupted.mime,
          chunks: hashes,
          chunkCount: hashes.length,
          size: interrupted.sizeBytes,
          durationMs: interrupted.startedAt
            ? Math.max(0, Math.round(endedAt - interrupted.startedAt))
            : 0,
          width: interrupted.width,
          height: interrupted.height,
          reason: "offscreen-restart"
        }
      });
      ingestRawEvent({
        source: "system",
        rawType: "screen.recording.error",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: endedAt,
        mono: monotonicTime(),
        payload: {
          recordingId: interrupted.recordingId,
          name: "OffscreenRecordingInterrupted",
          message: "Screen recording was interrupted while the extension runtime restarted.",
          stage: "restart"
        }
      });
    }

    await flushBufferedPipelineEvents(runtime);
    await runtime.pipeline.flush();
  }

  if (!runtime.screenRecording && shouldStartScreenRecording(runtime)) {
    await startScreenRecording(runtime).catch((error) => {
      console.warn("[WebBlackbox] failed to restart screen recording", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await flushBufferedPipelineEvents(runtime);
    await runtime.pipeline.flush();
  }

  return runtime;
}

async function restoreStoppedRuntime(
  persisted: PersistedStoppedRuntime,
  config: typeof DEFAULT_RECORDER_CONFIG,
  performanceBudget: PerformanceBudgetConfig
): Promise<SessionRuntime> {
  const cleanupDeadline = capCleanupDeadline(
    persisted.stoppedAt,
    persisted.cleanupDeadline,
    resolveRuntimeLocalTtlMs(config.capturePolicy)
  );
  await ensureOffscreenDocument();
  const pipeline = createOffscreenPipelineClient(persisted.sid);
  await pipeline.start(
    {
      sid: persisted.sid,
      tabId: persisted.tabId,
      startedAt: persisted.startedAt,
      endedAt: persisted.stoppedAt,
      mode: persisted.mode,
      url: persisted.url,
      title: persisted.title,
      tags: [...persisted.tags]
    },
    config.redaction,
    config.capturePolicy
  );
  const runtime = createSessionRuntime({
    sid: persisted.sid,
    tabId: persisted.tabId,
    mode: persisted.mode,
    url: persisted.url,
    captureUrl: persisted.url,
    title: persisted.title,
    tags: persisted.tags,
    note: persisted.note,
    config,
    startedAt: persisted.startedAt,
    stoppedAt: persisted.stoppedAt,
    cleanupDeadline,
    pipeline,
    performanceBudget,
    counters: persisted.counters
  });
  sessionsBySid.set(runtime.sid, runtime);
  return runtime;
}

async function purgePersistedRuntimeData(runtime: {
  sid: string;
  tabId: number;
  startedAt: number;
  mode: CaptureMode;
  url: string;
  title?: string;
  tags: readonly string[];
  config: typeof DEFAULT_RECORDER_CONFIG;
}): Promise<void> {
  if (sessionAnnotations.delete(runtime.sid)) {
    await persistSessionAnnotations().catch(() => undefined);
  }

  try {
    await ensureOffscreenDocument();
    const pipeline = createOffscreenPipelineClient(runtime.sid);
    await pipeline.start(
      {
        sid: runtime.sid,
        tabId: runtime.tabId,
        startedAt: runtime.startedAt,
        mode: runtime.mode,
        url: sanitizeUrlForPrivacy(runtime.url),
        title: runtime.title,
        tags: [...runtime.tags]
      },
      runtime.config.redaction,
      runtime.config.capturePolicy
    );
    await pipeline.close({ purge: true });
  } catch (error) {
    console.warn("[WebBlackbox] persisted session purge failed", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function clearStaleRuntimeCleanupAlarms(validSids: ReadonlySet<string>): Promise<void> {
  const alarms = await chromeApi?.alarms?.getAll?.().catch(() => []);

  for (const alarm of alarms ?? []) {
    const prefix = "webblackbox.runtime.cleanup:";

    if (!alarm.name.startsWith(prefix)) {
      continue;
    }

    const sid = alarm.name.slice(prefix.length);

    if (!validSids.has(sid)) {
      await chromeApi?.alarms?.clear(alarm.name);
    }
  }
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
  sampling?: RecordingSampling,
  capturePolicy?: CapturePolicy,
  frameId?: number
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  await chromeApi.tabs
    .sendMessage(
      tabId,
      {
        kind: "sw.recording-status",
        active,
        sid,
        mode,
        sampling,
        capturePolicy
      },
      frameId === undefined ? undefined : { frameId }
    )
    .catch(() => undefined);
}

async function notifyAuthorizedContentFrames(
  runtime: SessionRuntime,
  active: boolean
): Promise<void> {
  const frameIds = [...runtime.authorizedContentFrames];

  await Promise.all(
    frameIds.map((frameId) =>
      notifyTabStatus(
        runtime.tabId,
        active,
        runtime.sid,
        runtime.mode,
        toStatusSampling(runtime),
        runtime.config.capturePolicy,
        frameId
      )
    )
  );
}

function adjustInFlightContentMessages(tabId: number, delta: 1 | -1): void {
  const next = (inFlightContentMessagesByTab.get(tabId) ?? 0) + delta;

  if (next <= 0) {
    inFlightContentMessagesByTab.delete(tabId);
    resolveStopDrainAcksForTab(tabId);
    return;
  }

  inFlightContentMessagesByTab.set(tabId, next);
}

function createStopDrainAck(runtime: SessionRuntime): Promise<void> {
  const existing = pendingStopDrainAcks.get(runtime.sid);

  if (existing) {
    clearTimeout(existing.timeout);
    pendingStopDrainAcks.delete(runtime.sid);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingStopDrainAcks.delete(runtime.sid);
      resolve();
    }, STOP_DRAIN_ACK_TIMEOUT_MS);

    pendingStopDrainAcks.set(runtime.sid, {
      sid: runtime.sid,
      tabId: runtime.tabId,
      ackReceived: false,
      resolve,
      timeout
    });
  });
}

function markStopDrainAckReceived(sid: string): void {
  const pending = pendingStopDrainAcks.get(sid);

  if (!pending) {
    return;
  }

  pending.ackReceived = true;
  resolveStopDrainAckIfReady(pending);
}

function resolveStopDrainAcksForTab(tabId: number): void {
  for (const pending of pendingStopDrainAcks.values()) {
    if (pending.tabId === tabId) {
      resolveStopDrainAckIfReady(pending);
    }
  }
}

function resolveStopDrainAckIfReady(pending: {
  sid: string;
  tabId: number;
  ackReceived: boolean;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}): void {
  if (!pending.ackReceived) {
    return;
  }

  if ((inFlightContentMessagesByTab.get(pending.tabId) ?? 0) > 0) {
    return;
  }

  pendingStopDrainAcks.delete(pending.sid);
  clearTimeout(pending.timeout);

  const runtime = sessionsBySid.get(pending.sid);

  if (!runtime) {
    pending.resolve();
    return;
  }

  void runtime.queue.finally(() => {
    pending.resolve();
  });
}

async function relayMarkerCommand(): Promise<void> {
  const activeTabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  const tabId = activeTabs[0]?.id;

  if (typeof tabId !== "number") {
    return;
  }

  await chromeApi?.tabs
    ?.sendMessage(tabId, { kind: "sw.marker-command" }, { frameId: 0 })
    .catch(() => undefined);
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

async function setIdleBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "" }).catch(() => undefined);
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

function logInboundMessageFailure(
  kind: string,
  error: unknown,
  port?: PortLike,
  context: Record<string, unknown> = {}
): void {
  console.warn("[WebBlackbox] inbound message failed", {
    kind,
    port: port?.name,
    tabId: context.tabId ?? port?.sender?.tab?.id,
    frameId: context.frameId ?? port?.sender?.frameId,
    error: error instanceof Error ? error.message : String(error)
  });
}
