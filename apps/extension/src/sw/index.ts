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
  normalizeWebSocketFramePayload,
  type RawRecorderEvent,
  WebBlackboxRecorder
} from "@webblackbox/recorder";

import { normalizeOptionalIngestOperationId } from "../offscreen/ingest-idempotency.js";
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
import {
  assertRuntimeStartRequirements,
  resolveInstalledRuntimeCapabilities
} from "../shared/runtime-capabilities.js";
import {
  shouldInjectIsolatedContentForMode,
  shouldInjectMainWorldHooksForMode
} from "../shared/mode-profile.js";
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
  canCaptureGlobalCdpArtifactsForRoot,
  clearCdpCaptureScopeState,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  filterCdpSnapshotDocuments,
  forgetCdpRequestScope,
  forgetCdpSessionScope,
  invalidateCdpCaptureFrameTree,
  isCdpCaptureFrameTreePrimedForRoot,
  isCdpSessionWithinScope,
  refreshCdpCaptureFrameTree,
  type CdpCaptureScopeState
} from "./cdp-capture-scope.js";
import { withCdpCommandTimeout, type CdpCommandOutcome } from "./cdp-command.js";
import {
  bootstrapCdpRoot,
  cleanupAndRethrowCdpRootBootstrapFailure,
  type CdpRootFrameTreePrime
} from "./cdp-root-bootstrap.js";
import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import { disconnectContentPort } from "./content-port-lifecycle.js";
import { injectPendingContentDocument } from "./dynamic-content-injection.js";
import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";
import { authorizeLiteWebRequest } from "./lite-web-request-authorization.js";
import {
  canUseExactLiteTopDocumentAuthorization,
  classifyActiveCommittedDocument,
  resolveCurrentTabUrlPolicyDecision,
  shouldUpdateSessionMetadataFromNavigation
} from "./navigation-metadata.js";
import { runRootNavigationInstrumentationTransaction } from "./root-navigation-instrumentation.js";
import {
  claimRuntimeNavigation,
  isRuntimeNavigationClaimCurrent as isNavigationClaimCurrent,
  snapshotRuntimeNavigation,
  type RuntimeNavigationClaim,
  type RuntimeNavigationSource
} from "./runtime-navigation-claim.js";
import {
  canOperateOnExpectedNavigationResource,
  didGuardedNavigationOperationRun,
  reconcileAmbiguousNavigationResourceStart,
  resolveCdpNavigationPrimeOutcome,
  resolveTabNavigationSignal,
  runGuardedNavigationStep,
  runRuntimeNavigationTask
} from "./runtime-navigation-operations.js";
import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";
import {
  acknowledgePipelineBatch,
  acquirePipelineBatch,
  shouldRecoverOffscreenPipeline,
  shouldRetryOffscreenPipelineRequest,
  type PipelineBatchInFlight
} from "./pipeline-batch.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta,
  type RequestMetaEntry
} from "./request-meta.js";
import { injectMainWorldHook, injectRootPageAgentsForMode } from "./script-injection.js";
import {
  FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS,
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta,
  type LocalStorageSnapshotMode
} from "./storage-snapshot.js";
import {
  acknowledgeStopDrain,
  claimStopDrainEvent,
  closeStopDrain,
  createStopDrainCapability,
  isStopDrainClaimValid,
  runStopDrainBlobOperation,
  type StopDrainCapability,
  type StopDrainClaim
} from "./stop-drain.js";
import {
  RuntimeCleanupScheduler,
  RuntimeStartCancelledError,
  RuntimeStartCoordinator,
  type RuntimeStartToken,
  blockVolatileCapture,
  buildInterruptedScreenRecordingRecoveries,
  capCleanupDeadline,
  compactScreenRecordingChunkHashes,
  commitRestoredRuntimeActivation,
  createVolatileCaptureFence,
  createRuntimeStateSnapshot,
  createStoppingRuntimeTombstone,
  deleteMapEntryIfSame,
  disposeListenersBeforeTeardown,
  evaluateActiveRuntimeRestoration,
  extractPersistedRuntimeIdentities,
  isMapEntrySame,
  isRuntimeActivationProvisional,
  isRuntimeCaptureAdmitted,
  isVolatileCaptureOpen,
  mergeRuntimeStateWithStoppingTombstones,
  mergeRuntimeCountersWithSequenceWatermark,
  normalizeOffscreenScreenRecordingStatus,
  parseRuntimeStateSnapshot,
  planRuntimeRestoration,
  persistDurableStopTombstone,
  reconcileScreenRecordingResumeState,
  recoverStoppingRuntimeFailClosed,
  restoreScreenRecordingChunkHashes,
  runActiveRuntimeRestorationTransaction,
  runDurableFailedRuntimeCleanup,
  runDurableRuntimeStopWorkflow,
  runProvisionalRuntimeStartTransaction,
  runVolatileCaptureOperation,
  type PersistedActiveRuntime,
  type PersistedRuntime,
  type PersistedRuntimeCounters,
  type PersistedScreenRecording,
  type PersistedStoppedRuntime,
  type PersistedStoppingRuntime,
  type RuntimeActivationState,
  type VolatileCaptureFence
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
  stopRequestedAt?: number;
  stoppedAt?: number;
  recorder: WebBlackboxRecorder;
  pipeline: SessionPipelineClient;
  cdpRouter: CdpRouter | null;
  enabledCdpSessions: Set<string>;
  cdpScope: CdpCaptureScopeState;
  contentDocuments: ContentDocumentAuthorization;
  authorizedContentFrames: Set<number>;
  requestMeta: Map<string, RequestMetaEntry>;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  screenRecording: ScreenRecordingRuntime | null;
  lastPointer: PointerState | null;
  lastViewport: ViewportState | null;
  lastActionScreenshotMono: number;
  lastIncidentCaptureAt: number;
  lastNavigationSnapshotAt: number;
  navigationRevision: number;
  queueDepth: number;
  droppedBestEffortTasks: number;
  pipelineEventBuffer: WebBlackboxEvent[];
  pipelineBatchInFlight: PipelineBatchInFlight<WebBlackboxEvent> | null;
  pipelineFlushTimer: ReturnType<typeof setTimeout> | null;
  pipelineFlushQueued: boolean;
  captureFence: VolatileCaptureFence;
  activationState: RuntimeActivationState;
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
  queueAccepting: boolean;
  removeCdpListeners: Array<() => void>;
  heapSnapshotCapture: HeapSnapshotCaptureState | null;
  cleanupDeadline?: number;
  consentExpiryTimer: ReturnType<typeof setTimeout> | null;
};

type SessionNavigationClaim = RuntimeNavigationClaim<SessionRuntime>;

type ScreenRecordingRuntime = {
  recordingId: string;
  cdpScopeGeneration: number | null;
  provisional: boolean;
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
  cdpScopeGeneration: number;
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
  ingest: (event: WebBlackboxEvent, operationId?: string) => Promise<void>;
  ingestBatch: (events: readonly WebBlackboxEvent[], operationId?: string) => Promise<void>;
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
  operationId?: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  event?: WebBlackboxEvent;
  events?: readonly WebBlackboxEvent[];
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
const stopSessionTasks = new Map<number, Promise<void>>();
const retainedStoppingRuntimesBySid = new Map<string, PersistedStoppingRuntime>();
const pendingRuntimeRestorationsBySid = new Map<string, PersistedRuntime>();
const sessionAnnotations = new Map<string, SessionAnnotation>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingStopDrainAcks = new Map<
  string,
  {
    sid: string;
    tabId: number;
    capability: StopDrainCapability;
    ackReceived: boolean;
    settling: boolean;
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
  "Page.frameNavigated",
  "Page.navigatedWithinDocument"
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
const RETAINED_STOPPING_RETRY_DELAY_MS = 30_000;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const PERF_WARN_MS = 40;
const OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS = 12 * 60_000;
const OFFSCREEN_PORT_READY_MAX_ATTEMPTS = 200;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;
const STOP_DRAIN_ACK_TIMEOUT_MS = 6_000;
const CDP_ARTIFACT_TIMEOUT_MS = 5_000;
const CDP_HEAP_SNAPSHOT_TIMEOUT_MS = 8_000;
const SCREEN_RECORDING_OFFSCREEN_SOURCE = "tab";
const PIPELINE_RESUME_MAX_SCREEN_CHUNKS = 500_000;

console.info("[WebBlackbox] service worker booted");

const runtimeCleanupScheduler = new RuntimeCleanupScheduler({
  alarms: chromeApi?.alarms,
  onDue: async (sid) => {
    const retainedStopping = retainedStoppingRuntimesBySid.get(sid);

    if (retainedStopping) {
      await retryRetainedStoppingRuntimeRecovery(retainedStopping);
      return;
    }

    const runtime = sessionsBySid.get(sid);

    if (runtime?.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  }
});
let runtimeStateRestored = false;
const runtimeStateRestorePromise = restoreRuntimeState()
  .catch(async (error) => {
    console.warn("[WebBlackbox] runtime state restoration failed closed", error);
    await failClosedRuntimeRestoration();
  })
  .finally(() => {
    runtimeStateRestored = true;
    notifyOffscreenPipelineStatus();
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
    if (port.name === PORT_NAMES.content) {
      disconnectContentPort(connectedPorts, port);
    } else {
      connectedPorts.delete(port);
    }

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

  if (
    !runtime ||
    !isVolatileCaptureOpen(runtime.captureFence) ||
    runtime.stopping ||
    runtime.stoppedAt
  ) {
    sendInactiveContentPortState(port);
    return;
  }

  if (!(await authorizeContentSenderForReady(runtime, port.sender))) {
    sendContentPortRecordingState(port, runtime, false);
    await deactivateDeniedContentFrame(runtime, port.sender, port);

    return;
  }

  if (!isRuntimeCaptureAdmitted(runtime.activationState)) {
    sendContentPortRecordingState(port, runtime, false);
    return;
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

  if (
    !runtime ||
    !isRuntimeCaptureAdmitted(runtime.activationState) ||
    !isVolatileCaptureOpen(runtime.captureFence) ||
    runtime.stopping ||
    runtime.stoppedAt
  ) {
    sendInactiveContentPortState(port);
    return;
  }

  if (!authorizeContentSender(runtime, port.sender)) {
    sendContentPortRecordingState(port, runtime, false);

    if (shouldStopRuntimeForDeniedContentSender(runtime, port.sender)) {
      requestStopRuntimeIfCurrent(runtime, "content-port-denied");
    } else {
      failContentSender(runtime, port.sender);
    }
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
      tabId: runtime.tabId,
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
  const runtime = sessionsByTab.get(tabId);
  const signal = resolveTabNavigationSignal(changeInfo);

  if (!runtime || !signal) {
    return;
  }

  if (usesExactLiteTopDocumentAuthorization(runtime)) {
    if (signal.candidateUrl) {
      void handleExactLiteTabUrlChanged(runtime, signal.candidateUrl).catch((error) => {
        console.warn("[WebBlackbox] failed to apply exact Lite tab URL change", {
          tabId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    if (signal.completed) {
      void restoreExactLiteTabMetadataAfterNavigation(runtime).catch((error) => {
        console.warn("[WebBlackbox] failed to restore exact Lite tab metadata", {
          tabId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return;
  }

  const claim = claimCurrentRuntimeNavigation(runtime, signal.source, signal.candidateUrl);

  if (!claim) {
    return;
  }

  suspendFullCaptureForNavigation(claim);
  enqueueNavigationClaim(claim, async () => {
    if (signal.candidateUrl && !(await handleTabUrlChanged(claim, signal.candidateUrl))) {
      return;
    }

    if (signal.completed) {
      await restoreTabInstrumentationAfterNavigation(claim);
    }
  });
});

chromeApi?.tabs?.onRemoved?.addListener((tabId) => {
  void stopSession(tabId);
});

chromeApi?.webNavigation?.onCommitted.addListener((details) => {
  void handleCommittedContentDocument(details).catch((error) => {
    console.warn("[WebBlackbox] committed document handling failed closed", {
      tabId: details.tabId,
      frameId: details.frameId,
      documentId: details.documentId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
});

async function handleInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  sender: MessageSenderLike | undefined = port?.sender
): Promise<unknown> {
  if (message.kind.startsWith("ui.") && message.kind !== "ui.start") {
    await runtimeStateRestorePromise;
  }

  if (message.kind === "ui.start") {
    const tabId = await resolveUiActionTabId(message.tabId);

    if (typeof tabId !== "number") {
      return;
    }

    await startSession(tabId, message.mode, {
      visualCapture: resolveFullModeVisualCapture(message),
      reloadPage: message.mode === "lite" && message.reloadPage === true
    });
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

    if (
      runtime &&
      isRuntimeCaptureAdmitted(runtime.activationState) &&
      authorizeContentSender(runtime, sender, message.documentUrl)
    ) {
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

    if (
      !runtime ||
      !isVolatileCaptureOpen(runtime.captureFence) ||
      runtime.stopping ||
      runtime.stoppedAt
    ) {
      return {
        kind: "sw.recording-status",
        active: false
      };
    }

    if (!(await authorizeContentSenderForReady(runtime, sender, message.documentUrl))) {
      await deactivateDeniedContentFrame(runtime, sender, port);

      return {
        kind: "sw.recording-status",
        active: false,
        tabId: runtime.tabId,
        sid: runtime.sid,
        mode: runtime.mode,
        capturePolicy: runtime.config.capturePolicy
      };
    }

    if (!isRuntimeCaptureAdmitted(runtime.activationState)) {
      return {
        kind: "sw.recording-status",
        active: false,
        tabId: runtime.tabId,
        sid: runtime.sid,
        mode: runtime.mode,
        capturePolicy: runtime.config.capturePolicy
      };
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
      tabId: runtime.tabId,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling,
      capturePolicy: runtime.config.capturePolicy
    };
  }

  if (message.kind === "content.stop-drained") {
    markStopDrainAckReceived(message, sender);
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

    if (!runtime) {
      return;
    }

    const activeCapture =
      isRuntimeCaptureAdmitted(runtime.activationState) &&
      isVolatileCaptureOpen(runtime.captureFence) &&
      !runtime.stopping &&
      !runtime.stoppedAt;
    const activeSenderAuthorized =
      activeCapture && authorizeContentSender(runtime, sender, message.documentUrl);
    const stopDrain = pendingStopDrainAcks.get(runtime.sid)?.capability;

    if (!activeSenderAuthorized && !stopDrain) {
      if (activeCapture) {
        await deactivateDeniedContentFrame(runtime, sender, port);
      }

      return;
    }

    const acceptedEvents: Array<{
      rawEvent: RawRecorderEvent;
      stopDrainClaim: StopDrainClaim | null;
    }> = [];

    for (const rawEvent of message.events) {
      const stopDrainClaim = activeSenderAuthorized
        ? null
        : claimStopDrainEvent(stopDrain!, {
            runtime,
            fence: runtime.captureFence,
            token: message.stopDrainToken ?? "",
            sid: rawEvent.sid,
            tabId,
            frameId: normalizeSenderFrameId(sender),
            documentUrl: message.documentUrl ?? "",
            rawType: rawEvent.rawType,
            reason: asRecord(rawEvent.payload)?.reason
          });

      if (activeSenderAuthorized || stopDrainClaim) {
        acceptedEvents.push({ rawEvent, stopDrainClaim });
      }
    }

    if (acceptedEvents.length === 0) {
      return;
    }

    adjustInFlightContentMessages(tabId, 1);
    let sliceStartedAt = perfNow();

    try {
      for (const { rawEvent, stopDrainClaim } of acceptedEvents) {
        ingestRawEvent(
          {
            ...rawEvent,
            tabId,
            sid: runtime.sid,
            frame
          },
          stopDrainClaim
        );

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
  options: { visualCapture?: FullModeVisualCapture; reloadPage?: boolean } = {}
): Promise<void> {
  const startKey = JSON.stringify([
    mode,
    options.visualCapture ?? null,
    options.reloadPage === true
  ]);
  await sessionStartCoordinator.run(tabId, startKey, async (token) => {
    token.assertActive();
    await runtimeStateRestorePromise;
    token.assertActive();
    await startSessionUnlocked(tabId, mode, options, token);
  });
}

async function startSessionUnlocked(
  tabId: number,
  mode: CaptureMode,
  options: { visualCapture?: FullModeVisualCapture; reloadPage?: boolean },
  startToken: RuntimeStartToken
): Promise<void> {
  const sid = createSessionId();
  const startedAt = Date.now();
  startToken.assertActive();
  const tabMetadata = await resolveTabSessionMetadata(tabId);
  startToken.assertActive();
  const sessionOrigin = resolveUrlOrigin(tabMetadata.captureUrl) ?? "";
  const enterprisePolicy = await loadEnterprisePolicy();
  startToken.assertActive();

  const loadedRecorderConfig = applyFullModeVisualCapture(
    await loadRecorderConfig(mode),
    mode,
    options.visualCapture
  );
  startToken.assertActive();
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

  const screenRecordingRequested =
    mode === "full" && recorderConfig.capturePolicy?.categories.screenRecordings === "allow";
  assertRuntimeStartRequirements(resolveInstalledRuntimeCapabilities(chromeApi), {
    mode,
    screenRecording: screenRecordingRequested
  });

  const performanceBudget = await loadPerformanceBudgetConfig();
  startToken.assertActive();
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
  const provisionalActive = createInitialPersistedActiveRuntime({
    sid,
    tabId,
    mode,
    metadata,
    config: recorderConfig,
    startedAt
  });
  const existing = sessionsByTab.get(tabId);
  const runtime = await runProvisionalRuntimeStartTransaction({
    token: startToken,
    checkpointStopping: () => checkpointProvisionalRuntimeStart(provisionalActive),
    startPipeline: async () => {
      startToken.assertActive();
      await ensureOffscreenDocument();
      startToken.assertActive();
      await pipeline.start(metadata, recorderConfig.redaction, recorderConfig.capturePolicy);
    },
    stopExisting: async () => {
      startToken.assertActive();

      if (existing && isMapEntrySame(sessionsByTab, tabId, existing)) {
        await requestSessionStop(tabId);
      } else if (sessionsByTab.has(tabId)) {
        throw new Error("The tab recording changed while a replacement start was pending.");
      }
    },
    prepareRuntime: () =>
      createSessionRuntime({
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
        performanceBudget,
        activationState: "starting"
      }),
    registerRuntime: (candidate) => {
      if (sessionsByTab.has(tabId) || sessionsBySid.has(sid)) {
        throw new Error("The provisional runtime identity is already registered.");
      }

      sessionsByTab.set(tabId, candidate);
      sessionsBySid.set(sid, candidate);
      scheduleConsentExpiry(candidate);

      if (mode === "lite") {
        installLiteWebRequestCapture();
      }

      notifyOffscreenPipelineStatus();
    },
    completeRuntime: async (candidate) => {
      ingestRawEvent({
        source: "system",
        rawType: "config",
        sid,
        tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: recorderConfig
      });
      await flushBufferedPipelineEvents(candidate);
      startToken.assertActive();
      await candidate.pipeline.flush();

      if (shouldInjectIsolatedContentForMode(mode)) {
        startToken.assertActive();
        await ensureRootPageAgentsInjected(candidate, {
          assertCurrent: () => startToken.assertActive()
        });
      }

      if (mode === "full" && recorderConfig.capturePolicy?.categories.cdp !== "off") {
        startToken.assertActive();
        await attachCdp(candidate);
      }

      if (screenRecordingRequested) {
        if (!shouldStartScreenRecording(candidate, true)) {
          throw new Error("Screen recording prerequisites are not ready before activation.");
        }

        startToken.assertActive();
        await startScreenRecording(candidate, true);

        if (!candidate.screenRecording) {
          throw new Error("Screen recording did not start before runtime activation.");
        }

        startToken.assertActive();
        await flushBufferedPipelineEvents(candidate);
        startToken.assertActive();
        await candidate.pipeline.flush();
      }

      if (mode === "lite" && options.reloadPage === true) {
        startToken.assertActive();
        await reloadRecordingTab(tabId);
      }
    },
    commitRuntime: (candidate, tombstone) =>
      commitProvisionalRuntimeStart(candidate, tombstone, startToken),
    cleanupPipeline: (tombstone) =>
      cleanupFailedProvisionalPipelineStart(provisionalActive, tombstone, pipeline),
    cleanupRuntime: (candidate, tombstone) =>
      cleanupFailedProvisionalRuntimeStart(provisionalActive, tombstone, candidate)
  });

  if (!startToken.isActive()) {
    if (isMapEntrySame(sessionsByTab, tabId, runtime)) {
      await requestSessionStop(tabId);
    }
    throw new RuntimeStartCancelledError();
  }

  scheduleFullModeSessionStartArtifacts(runtime);
  publishCommittedRuntimeStart(runtime);
}

function createInitialPersistedActiveRuntime(input: {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  metadata: SessionMetadata;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
}): PersistedActiveRuntime {
  return {
    state: "active",
    sid: input.sid,
    tabId: input.tabId,
    mode: input.mode,
    url: sanitizeUrlForPrivacy(input.metadata.url),
    ...(input.metadata.title ? { title: input.metadata.title.slice(0, 1_024) } : {}),
    tags: normalizeSessionTags(input.metadata.tags),
    config: input.config,
    startedAt: input.startedAt,
    counters: {
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
    }
  };
}

async function checkpointProvisionalRuntimeStart(
  active: PersistedActiveRuntime
): Promise<PersistedStoppingRuntime> {
  const stopRequestedAt = Date.now();
  const cleanupDeadline = stopRequestedAt + resolveRuntimeLocalTtlMs(active.config.capturePolicy);
  const tombstone = createStoppingRuntimeTombstone(active, stopRequestedAt, cleanupDeadline);
  retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch(() => undefined);
    throw error;
  }

  await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch((error) => {
    console.warn("[WebBlackbox] failed to schedule provisional start cleanup", {
      sid: tombstone.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return tombstone;
}

async function commitProvisionalRuntimeStart(
  runtime: SessionRuntime,
  tombstone: PersistedStoppingRuntime,
  startToken: RuntimeStartToken
): Promise<void> {
  startToken.assertActive();

  if (
    runtime.activationState !== "starting" ||
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
    !isMapEntrySame(sessionsBySid, runtime.sid, runtime) ||
    !deleteMapEntryIfSame(retainedStoppingRuntimesBySid, tombstone.sid, tombstone)
  ) {
    throw new Error("The provisional runtime lost its activation identity.");
  }

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    if (!retainedStoppingRuntimesBySid.has(tombstone.sid)) {
      retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    }
    await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch(() => undefined);
    throw error;
  }

  if (
    !startToken.isActive() ||
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
    !isMapEntrySame(sessionsBySid, runtime.sid, runtime)
  ) {
    retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    throw new RuntimeStartCancelledError();
  }

  // The required storage write above is the only active-state commit point.
  // Nothing below this assignment is allowed to reject the successful start.
  runtime.activationState = "active";

  if (runtime.screenRecording) {
    runtime.screenRecording.provisional = false;
  }
  void Promise.resolve()
    .then(() => runtimeCleanupScheduler.cancel(tombstone.sid))
    .catch(() => undefined);
}

function publishCommittedRuntimeStart(runtime: SessionRuntime): void {
  void setRecordingBadge().catch(() => undefined);
  void notifyAuthorizedContentFrames(runtime, true).catch(() => undefined);

  try {
    broadcast({
      kind: "sw.recording-status",
      active: true,
      tabId: runtime.tabId,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling: toStatusSampling(runtime),
      capturePolicy: runtime.config.capturePolicy
    });
    pushSessionList();
    notifyOffscreenPipelineStatus();
  } catch (error) {
    console.warn("[WebBlackbox] failed to publish committed runtime status", error);
  }
}

function cleanupFailedProvisionalPipelineStart(
  active: PersistedActiveRuntime,
  tombstone: PersistedStoppingRuntime,
  pipeline: SessionPipelineClient
): Promise<void> {
  return cleanupFailedPipelineRestoration(active, pipeline, tombstone);
}

function cleanupFailedProvisionalRuntimeStart(
  active: PersistedActiveRuntime,
  tombstone: PersistedStoppingRuntime,
  runtime: SessionRuntime
): Promise<void> {
  return cleanupFailedActiveRuntimeRestoration(active, runtime, tombstone);
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
  activationState?: RuntimeActivationState;
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
  const contentDocuments = new ContentDocumentAuthorization(input.tabId);

  if (!input.stoppedAt) {
    contentDocuments.reset({ url: input.captureUrl });
  }

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
    stopRequestedAt: undefined,
    stoppedAt: input.stoppedAt,
    recorder,
    pipeline: input.pipeline,
    cdpRouter: null,
    enabledCdpSessions: new Set<string>(),
    cdpScope: createCdpCaptureScopeState(input.config.capturePolicy, input.tabId, input.captureUrl),
    contentDocuments,
    authorizedContentFrames: new Set<number>(),
    requestMeta: new Map(),
    screenshotInterval: null,
    screenRecording: input.screenRecording
      ? {
          recordingId: input.screenRecording.recordingId,
          cdpScopeGeneration: null,
          provisional: isRuntimeActivationProvisional(input.activationState ?? "active"),
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
    navigationRevision: 0,
    queueDepth: 0,
    droppedBestEffortTasks: counters.droppedBestEffortTasks,
    pipelineEventBuffer: [],
    pipelineBatchInFlight: null,
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    captureFence: createVolatileCaptureFence(input.stoppedAt !== undefined),
    activationState: input.activationState ?? "active",
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
    queueAccepting: true,
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

async function restoreExactLiteTabMetadataAfterNavigation(runtime: SessionRuntime): Promise<void> {
  if (!isRuntimeCurrentCaptureOpen(runtime) || !usesExactLiteTopDocumentAuthorization(runtime)) {
    return;
  }

  const tabMetadata = await resolveTabSessionMetadata(runtime.tabId);

  if (!isRuntimeCurrentCaptureOpen(runtime)) {
    return;
  }

  const decision = await resolveCurrentTabUrlPolicyDecision({
    candidateUrl: tabMetadata.captureUrl,
    evaluateAllowed: () => isRuntimeTopDocumentAllowed(runtime, tabMetadata.captureUrl),
    resolveCurrentUrl: () => resolveCurrentTabCaptureUrl(runtime.tabId)
  });

  if (!isRuntimeCurrentCaptureOpen(runtime) || decision === "stale") {
    return;
  }

  if (decision === "denied") {
    await stopRuntimeIfCurrent(runtime);
    return;
  }

  runtime.captureUrl = tabMetadata.captureUrl;
  runtime.cdpScope.captureUrl = tabMetadata.captureUrl;
  runtime.url = tabMetadata.url;
  pushSessionList();
  scheduleRuntimeStatePersist();
}

async function restoreTabInstrumentationAfterNavigation(
  claim: SessionNavigationClaim
): Promise<void> {
  const runtime = claim.runtime;

  if (
    !isSessionNavigationClaimCurrent(claim) ||
    !shouldInjectIsolatedContentForMode(runtime.mode) ||
    usesExactLiteTopDocumentAuthorization(runtime)
  ) {
    return;
  }

  const tabMetadata = await resolveTabSessionMetadata(runtime.tabId);

  if (
    !isSessionNavigationClaimCurrent(claim) ||
    (claim.candidateUrl !== undefined && claim.candidateUrl !== tabMetadata.captureUrl)
  ) {
    return;
  }

  const policy = await runGuardedNavigationStep(
    () => isSessionNavigationClaimCurrent(claim),
    () => isRuntimeTopDocumentAllowed(runtime, tabMetadata.captureUrl)
  );

  if (policy.status !== "current") {
    return;
  }

  if (!policy.value) {
    await stopRuntimeIfNavigationClaimCurrent(claim);
    return;
  }

  runtime.captureUrl = tabMetadata.captureUrl;
  runtime.cdpScope.captureUrl = tabMetadata.captureUrl;
  runtime.url = tabMetadata.url;
  resetAuthorizedContentFrames(runtime);

  const instrumentation = await runRootNavigationInstrumentationTransaction({
    isCurrent: () => isSessionNavigationClaimCurrent(claim),
    inject: (assertCurrent) => ensureRootPageAgentsInjected(runtime, { assertCurrent }),
    stopCurrent: () => stopRuntimeIfNavigationClaimCurrent(claim),
    continueAfterInjection: async (assertCurrent) => {
      assertCurrent();

      if (runtime.mode === "full" && runtime.cdpRouter) {
        await restoreCdpGlobalCaptureAfterNavigation(claim, true);
        assertCurrent();
      }

      await notifyAuthorizedContentFrames(runtime, true);
      assertCurrent();
    }
  });

  if (instrumentation.kind === "failed-closed") {
    console.warn("[WebBlackbox] root navigation injection failed closed", {
      tabId: runtime.tabId,
      sid: runtime.sid,
      error:
        instrumentation.error instanceof Error
          ? instrumentation.error.message
          : String(instrumentation.error)
    });
  }
}

async function handleCommittedContentDocument(details: {
  tabId: number;
  frameId: number;
  documentId?: string;
  documentLifecycle?: string;
  frameType?: string;
  parentDocumentId?: string;
  parentFrameId?: number;
  url: string;
}): Promise<void> {
  const runtime = sessionsByTab.get(details.tabId);
  const committedKind = classifyActiveCommittedDocument(details);
  const topLiteDocument =
    committedKind === "top" &&
    runtime !== undefined &&
    usesExactLiteTopDocumentAuthorization(runtime);
  const includedChildDocument =
    committedKind === "child" &&
    runtime?.config.capturePolicy?.scope.includeSubframes === true &&
    details.parentFrameId !== undefined &&
    runtime.contentDocuments.matchesKnownDocument({
      frameId: details.parentFrameId,
      documentId: details.parentDocumentId
    });

  if (
    !runtime ||
    (!topLiteDocument && !includedChildDocument) ||
    !isVolatileCaptureOpen(runtime.captureFence) ||
    runtime.stopping ||
    runtime.stoppedAt
  ) {
    return;
  }

  const preparation = await runtime.contentDocuments
    .prepareCommittedNavigation(details, async ({ url, frameId }) => {
      if (frameId === 0) {
        return isRuntimeTopDocumentAllowed(runtime, url);
      }

      return evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
        url,
        tabId: runtime.tabId,
        frameId
      });
    })
    .finally(() => {
      syncAuthorizedContentFrames(runtime);
    });

  if (!isRuntimeCurrentCaptureOpen(runtime)) {
    return;
  }

  if (!preparation.prepared) {
    if (
      topLiteDocument &&
      (preparation.reason === "invalid-navigation" ||
        preparation.reason === "scope-denied" ||
        preparation.reason === "scope-error")
    ) {
      await stopRuntimeIfCurrent(runtime);
    }
    return;
  }

  if (
    !runtime.contentDocuments.isCurrentNavigation(
      preparation.document.frameId,
      preparation.document.documentId
    )
  ) {
    return;
  }

  if (topLiteDocument) {
    runtime.captureUrl = preparation.document.url;
    runtime.cdpScope.captureUrl = preparation.document.url;
    runtime.url = sanitizeUrlForPrivacy(preparation.document.url);
    pushSessionList();
    scheduleRuntimeStatePersist();
  }

  const result = await injectPendingContentDocument({
    chromeApi,
    authorization: runtime.contentDocuments,
    document: preparation.document,
    isRuntimeActive: () =>
      isVolatileCaptureOpen(runtime.captureFence) &&
      !runtime.stopping &&
      !runtime.stoppedAt &&
      sessionsByTab.get(runtime.tabId) === runtime,
    mode: runtime.mode
  });

  if (result.status === "injected") {
    try {
      await requestExactContentRecordingStatus(runtime, preparation.document);
    } catch (error) {
      const failedCurrentNavigation = runtime.contentDocuments.failNavigation(
        preparation.document.frameId,
        preparation.document.documentId
      );
      syncAuthorizedContentFrames(runtime);
      console.warn("[WebBlackbox] prepared document status request failed closed", {
        tabId: runtime.tabId,
        frameId: preparation.document.frameId,
        documentId: preparation.document.documentId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (topLiteDocument && failedCurrentNavigation) {
        await stopRuntimeIfCurrent(runtime);
      }
      return;
    }

    runtime.contentDocuments.completePendingInjection(
      preparation.document.frameId,
      preparation.document.documentId
    );
  } else if (result.status === "stale") {
    runtime.contentDocuments.failNavigation(
      preparation.document.frameId,
      preparation.document.documentId
    );
  }
  syncAuthorizedContentFrames(runtime);

  if (result.status === "failed") {
    console.warn("[WebBlackbox] dynamic document injection failed closed", {
      tabId: runtime.tabId,
      frameId: preparation.document.frameId,
      documentId: preparation.document.documentId,
      error: result.error instanceof Error ? result.error.message : String(result.error)
    });

    if (topLiteDocument && result.failedCurrentNavigation) {
      await stopRuntimeIfCurrent(runtime);
    }
  }
}

async function requestExactContentRecordingStatus(
  runtime: SessionRuntime,
  document: { frameId: number; documentId: string }
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    throw new Error("Chrome tabs messaging is unavailable for exact status request.");
  }

  const acknowledgement = await chromeApi.tabs.sendMessage(
    runtime.tabId,
    {
      kind: "sw.request-recording-status"
    },
    {
      frameId: document.frameId,
      documentId: document.documentId
    }
  );

  if (
    typeof acknowledgement !== "object" ||
    acknowledgement === null ||
    Array.isArray(acknowledgement) ||
    (acknowledgement as { kind?: unknown }).kind !== "content.recording-status-requested"
  ) {
    throw new Error("Exact content document did not acknowledge the status request.");
  }
}

async function stopRuntimeIfCurrent(runtime: SessionRuntime): Promise<void> {
  if (sessionsByTab.get(runtime.tabId) !== runtime) {
    return;
  }

  await stopSession(runtime.tabId);
}

function isRuntimeCurrentCaptureOpen(runtime: SessionRuntime): boolean {
  return (
    sessionsByTab.get(runtime.tabId) === runtime &&
    isVolatileCaptureOpen(runtime.captureFence) &&
    !runtime.stopping &&
    !runtime.stoppedAt
  );
}

function isRuntimeNavigationOpen(runtime: SessionRuntime): boolean {
  return (
    isRuntimeCurrentCaptureOpen(runtime) &&
    sessionsBySid.get(runtime.sid) === runtime &&
    isRuntimeCaptureAdmitted(runtime.activationState)
  );
}

function claimCurrentRuntimeNavigation(
  runtime: SessionRuntime,
  source: RuntimeNavigationSource,
  candidateUrl?: string
): SessionNavigationClaim | null {
  if (!isRuntimeNavigationOpen(runtime)) {
    return null;
  }

  return claimRuntimeNavigation(runtime, source, candidateUrl);
}

function snapshotCurrentRuntimeNavigation(
  runtime: SessionRuntime,
  source: RuntimeNavigationSource,
  candidateUrl?: string
): SessionNavigationClaim | null {
  if (!isRuntimeNavigationOpen(runtime)) {
    return null;
  }

  return snapshotRuntimeNavigation(runtime, source, candidateUrl);
}

function isSessionNavigationClaimCurrent(claim: SessionNavigationClaim): boolean {
  return isNavigationClaimCurrent(
    claim,
    sessionsByTab.get(claim.runtime.tabId),
    isRuntimeNavigationOpen
  );
}

async function stopRuntimeIfNavigationClaimCurrent(claim: SessionNavigationClaim): Promise<void> {
  if (!isSessionNavigationClaimCurrent(claim)) {
    return;
  }

  await stopRuntimeIfCurrent(claim.runtime);
}

function requestStopRuntimeIfNavigationClaimCurrent(
  claim: SessionNavigationClaim,
  reason: string
): void {
  void stopRuntimeIfNavigationClaimCurrent(claim).catch((error) => {
    console.warn("[WebBlackbox] failed to stop current navigation", {
      tabId: claim.runtime.tabId,
      sid: claim.runtime.sid,
      revision: claim.revision,
      reason,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function enqueueNavigationClaim(claim: SessionNavigationClaim, task: () => Promise<void>): boolean {
  const accepted = enqueue(claim.runtime, async () => {
    const result = await runRuntimeNavigationTask(
      () => isSessionNavigationClaimCurrent(claim),
      task,
      () => stopRuntimeIfNavigationClaimCurrent(claim)
    );

    if (result.kind === "failed-closed") {
      console.warn("[WebBlackbox] current navigation task failed closed", {
        tabId: claim.runtime.tabId,
        sid: claim.runtime.sid,
        revision: claim.revision,
        source: claim.source,
        error: result.error instanceof Error ? result.error.message : String(result.error)
      });
    }
  });

  if (!accepted) {
    requestStopRuntimeIfNavigationClaimCurrent(claim, "navigation-queue-closed");
  }

  return accepted;
}

function suspendFullCaptureForNavigation(
  claim: SessionNavigationClaim,
  options: { cdpScopeAlreadyInvalidated?: boolean } = {}
): void {
  const runtime = claim.runtime;

  if (!isSessionNavigationClaimCurrent(claim) || runtime.mode !== "full" || !runtime.cdpRouter) {
    return;
  }

  if (options.cdpScopeAlreadyInvalidated !== true) {
    invalidateCdpCaptureFrameTree(runtime.cdpScope);
  }

  const recording = runtime.screenRecording;
  void stopScreenRecording(runtime, "navigation-scope", recording, () =>
    isSessionNavigationClaimCurrent(claim)
  ).catch(() => {
    requestStopRuntimeIfNavigationClaimCurrent(claim, "navigation-screen-stop");
  });
}

function requestStopRuntimeIfCurrent(runtime: SessionRuntime, reason: string): void {
  void stopRuntimeIfCurrent(runtime).catch((error) => {
    console.warn("[WebBlackbox] failed to stop current runtime", {
      tabId: runtime.tabId,
      sid: runtime.sid,
      reason,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function stopSession(tabId: number): Promise<void> {
  sessionStartCoordinator.cancel(tabId);
  const runtime = sessionsByTab.get(tabId);

  if (runtime) {
    blockVolatileCapture(runtime.captureFence);
    runtime.contentDocuments.cancelPendingNavigations();
    notifyOffscreenPipelineStatus();

    if (runtime.activationState === "starting") {
      return Promise.resolve();
    }
  }

  return requestSessionStop(tabId);
}

function requestSessionStop(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (runtime) {
    blockVolatileCapture(runtime.captureFence);
    runtime.contentDocuments.cancelPendingNavigations();
    notifyOffscreenPipelineStatus();
  }

  const existing = stopSessionTasks.get(tabId);

  if (existing) {
    return existing;
  }

  const task = stopSessionOnce(tabId).finally(() => {
    if (stopSessionTasks.get(tabId) === task) {
      stopSessionTasks.delete(tabId);
    }
  });
  stopSessionTasks.set(tabId, task);
  return task;
}

async function stopSessionOnce(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  const stopRequestedAt = runtime.stopRequestedAt ?? Date.now();
  const cleanupDeadline =
    runtime.cleanupDeadline ??
    stopRequestedAt + resolveRuntimeLocalTtlMs(runtime.config.capturePolicy);
  let stopDrainAck: Promise<void> = Promise.resolve();

  try {
    await runDurableRuntimeStopWorkflow({
      captureFence: runtime.captureFence,
      persistStopping: runtime.stopping
        ? () => undefined
        : () => persistRuntimeStoppingTombstone(runtime, stopRequestedAt, cleanupDeadline),
      teardownSteps: [
        () => stopScreenRecording(runtime, "session-stop"),
        () =>
          runBestEffortStopStep(runtime, "pipeline-buffer", () =>
            flushBufferedPipelineEvents(runtime)
          ),
        () => teardownCaptureInstrumentation(runtime),
        async () => {
          const drain = createStopDrainAck(runtime);
          stopDrainAck = drain.wait;
          await runBestEffortStopStep(runtime, "content-notification", () =>
            notifyAuthorizedContentFrames(runtime, false, drain.notice)
          );
        },
        async () => {
          await stopDrainAck;
          await runBestEffortStopStep(runtime, "final-pipeline-buffer", () =>
            flushBufferedPipelineEvents(runtime)
          );
          await runBestEffortStopStep(runtime, "final-pipeline-flush", () =>
            runtime.pipeline.flush()
          );
        },
        async () => {
          sessionsByTab.delete(runtime.tabId);
          resetAuthorizedContentFrames(runtime);
          uninstallLiteWebRequestCaptureIfUnused();
          runtime.stoppedAt = stopRequestedAt;
          runtime.stopRequestedAt = undefined;
          runtime.cleanupDeadline = cleanupDeadline;
          await scheduleStoppedRuntimeCleanup(runtime).catch((error) => {
            console.warn("[WebBlackbox] alarm setup failed; restart recovery remains armed", {
              sid: runtime.sid,
              error: error instanceof Error ? error.message : String(error)
            });
          });

          await runBestEffortStopStep(runtime, "badge", async () => {
            if (sessionsByTab.size === 0) {
              await setIdleBadge();
            } else {
              await setRecordingBadge();
            }
          });

          broadcast({
            kind: "sw.recording-status",
            active: false,
            tabId: runtime.tabId,
            sid: runtime.sid,
            mode: runtime.mode,
            capturePolicy: runtime.config.capturePolicy
          });
          pushSessionList();
        }
      ],
      persistStopped: () => persistRuntimeState({ required: true })
    });
    runtime.stopping = false;
  } catch (error) {
    if (runtime.stopping) {
      notifyOffscreenPipelineStatus();
      await runBestEffortStopStep(runtime, "failed-stop-notification", () =>
        notifyAuthorizedContentFrames(runtime, false)
      );
    }

    if (runtime.stoppedAt) {
      scheduleRuntimeStatePersist();
    }

    throw error;
  }
  notifyOffscreenPipelineStatus();
}

async function runBestEffortStopStep(
  runtime: SessionRuntime,
  stage: string,
  step: () => void | Promise<void>
): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.warn("[WebBlackbox] stop step failed closed", {
      sid: runtime.sid,
      stage,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

function ingestRawEvent(
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null = null
): void {
  const runtime =
    sessionsByTab.get(rawEvent.tabId) ??
    (typeof rawEvent.sid === "string" ? sessionsBySid.get(rawEvent.sid) : undefined);
  const stopDrainAuthorized = Boolean(
    runtime &&
    stopDrainClaim &&
    isStopDrainClaimValid(stopDrainClaim, runtime, runtime.captureFence)
  );
  const provisionalSystemEvent = Boolean(
    runtime &&
    runtime.activationState === "starting" &&
    rawEvent.source === "system" &&
    (rawEvent.rawType === "config" || rawEvent.rawType.startsWith("screen.recording.")) &&
    rawEvent.sid === runtime.sid
  );

  if (
    !runtime ||
    ((!isVolatileCaptureOpen(runtime.captureFence) ||
      !isRuntimeCaptureAdmitted(runtime.activationState)) &&
      !provisionalSystemEvent &&
      !stopDrainAuthorized &&
      !isCaptureClosureEvent(rawEvent))
  ) {
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

  if (runtime.stopping && rawEvent.source !== "system" && !stopDrainAuthorized) {
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
      if (!isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim)) {
        return;
      }

      const materialized = await materializeLiteContentEvent(runtime, nextRawEvent, stopDrainClaim);

      if (!materialized || !isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim)) {
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

function isCaptureClosureEvent(rawEvent: RawRecorderEvent): boolean {
  // These records close already-captured video state and contain no new page payload.
  return (
    rawEvent.source === "system" &&
    (rawEvent.rawType === "screen.recording.end" || rawEvent.rawType === "screen.recording.error")
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
    return true;
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
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null = null
): Promise<RawRecorderEvent | null> {
  if (!isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim)) {
    return null;
  }

  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(runtime, rawEvent, stopDrainClaim);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(runtime, rawEvent, stopDrainClaim);
  }

  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    return materializeLiteStorageSnapshot(runtime, rawEvent, stopDrainClaim);
  }

  if (rawEvent.rawType === "networkBody") {
    return materializeLiteNetworkBody(runtime, rawEvent);
  }

  return rawEvent;
}

async function materializeLiteScreenshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null
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

  const shotId = await putRuntimeCaptureBlob(runtime, decoded.mime, decoded.bytes, stopDrainClaim);

  if (!shotId) {
    return null;
  }
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
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const html = asString(payload?.html);

  if (!payload || !html) {
    return null;
  }

  const encoded = encodeTextWithByteLimit(html, LITE_DOM_SNAPSHOT_MAX_BYTES);
  const contentHash = await putRuntimeCaptureBlob(
    runtime,
    "text/html",
    encoded.bytes,
    stopDrainClaim
  );

  if (!contentHash) {
    return null;
  }
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
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reason = asString(payload.reason) ?? undefined;

  if (rawEvent.rawType === "localStorageSnapshot") {
    const entries = asRecord(payload.entries);
    const encoded = entries
      ? encodeTextWithByteLimit(JSON.stringify(entries), LITE_STORAGE_SNAPSHOT_MAX_BYTES)
      : null;
    const hash =
      encoded && encoded.bytes.byteLength > 0
        ? await putRuntimeCaptureBlob(runtime, "application/json", encoded.bytes, stopDrainClaim)
        : undefined;

    if (encoded && encoded.bytes.byteLength > 0 && !hash) {
      return null;
    }
    const count = normalizeNonNegativeInt(payload.count) ?? Object.keys(entries ?? {}).length;

    return {
      ...rawEvent,
      payload: {
        hash,
        count,
        mode: entries ? "sample" : "schema-only",
        redacted: true,
        reason,
        truncated: payload.truncated === true || encoded?.truncated === true
      }
    };
  }

  if (rawEvent.rawType === "indexedDbSnapshot") {
    const names = asStringArray(payload.databaseNames, 400);
    const serialized = JSON.stringify(names);
    const encoded = encodeTextWithByteLimit(serialized, LITE_STORAGE_SNAPSHOT_MAX_BYTES);
    const hash =
      encoded.bytes.byteLength > 0
        ? await putRuntimeCaptureBlob(runtime, "application/json", encoded.bytes)
        : undefined;

    if (encoded.bytes.byteLength > 0 && !hash) {
      return null;
    }
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
        ? await putRuntimeCaptureBlob(runtime, "application/json", encoded.bytes)
        : undefined;

    if (encoded.bytes.byteLength > 0 && !hash) {
      return null;
    }
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
  const contentHash = await putRuntimeCaptureBlob(runtime, mimeType, transformed.sampledBytes);

  if (!contentHash) {
    return null;
  }

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

async function putRuntimeCaptureBlob(
  runtime: SessionRuntime,
  mime: string,
  bytes: Uint8Array,
  stopDrainClaim: StopDrainClaim | null = null
): Promise<string | null> {
  if (stopDrainClaim) {
    return runStopDrainBlobOperation(stopDrainClaim, runtime, runtime.captureFence, () =>
      runtime.pipeline.putBlob(mime, bytes)
    );
  }

  if (!isRuntimeCaptureScopeActive(runtime)) {
    return null;
  }

  const hash = await runVolatileCaptureOperation(runtime.captureFence, () =>
    runtime.pipeline.putBlob(mime, bytes)
  );
  return isRuntimeCaptureScopeActive(runtime) ? hash : null;
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

      if (
        runtime.pipelineEventBuffer.length > 0 &&
        isVolatileCaptureOpen(runtime.captureFence) &&
        !runtime.stopping
      ) {
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

  while (runtime.pipelineBatchInFlight || runtime.pipelineEventBuffer.length > 0) {
    runtime.pipelineBatchInFlight = acquirePipelineBatch(
      runtime.pipelineBatchInFlight,
      runtime.pipelineEventBuffer,
      PIPELINE_BATCH_DRAIN_CHUNK_EVENTS,
      createPipelineIngestOperationId,
      requireIngestOperationId
    );
    const batch = runtime.pipelineBatchInFlight;

    if (!batch) {
      break;
    }

    await runtime.pipeline.ingestBatch(batch.events, batch.operationId);
    acknowledgePipelineBatch(runtime.pipelineEventBuffer, batch);
    runtime.pipelineBatchInFlight = null;
    flushed += batch.events.length;

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

function createPipelineIngestOperationId(): string {
  return `I-${crypto.randomUUID()}`;
}

function requireIngestOperationId(value: unknown): string {
  const operationId = normalizeOptionalIngestOperationId(value);

  if (!operationId) {
    throw new Error("Missing ingest idempotency operation id.");
  }

  return operationId;
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
    ingest: async (event, operationId) => {
      const normalizedOperationId = normalizeOptionalIngestOperationId(operationId);
      await requestOffscreenPipeline<void>({
        op: "ingest",
        sid,
        event,
        ...(normalizedOperationId === undefined ? {} : { operationId: normalizedOperationId })
      });
    },
    ingestBatch: async (events, operationId) => {
      const normalizedOperationId = normalizeOptionalIngestOperationId(operationId);
      await requestOffscreenPipeline<void>({
        op: "ingestBatch",
        sid,
        events,
        ...(normalizedOperationId === undefined ? {} : { operationId: normalizedOperationId })
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
  return shouldRetryOffscreenPipelineRequest(request.op, error);
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
    if (!shouldRecoverOffscreenPipeline(toOffscreenPipelineRecoveryState(runtime), "automatic")) {
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

    if (
      !runtime ||
      !runtime.queueAccepting ||
      !shouldRecoverOffscreenPipeline(toOffscreenPipelineRecoveryState(runtime), "request")
    ) {
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

function toOffscreenPipelineRecoveryState(runtime: SessionRuntime) {
  return {
    captureOpen:
      isRuntimeCaptureAdmitted(runtime.activationState) &&
      isVolatileCaptureOpen(runtime.captureFence),
    stopping: runtime.stopping,
    stopped: runtime.stoppedAt !== undefined
  };
}

async function attachCdp(runtime: SessionRuntime): Promise<void> {
  let router: CdpRouter | null = null;

  try {
    const candidateRouter = createCdpRouter(createChromeDebuggerTransport());
    router = candidateRouter;

    const unsubscribeEvent = candidateRouter.onEvent((event) => {
      if (!isMapEntrySame(sessionsByTab, runtime.tabId, runtime)) {
        return;
      }

      const normalizedPayload = normalizeFullModePayload(
        event.method,
        event.params ?? {},
        runtime.config.capturePolicy?.categories.network
      );
      const scopeEvaluation = evaluateCdpCaptureScopeEvent(
        runtime.cdpScope,
        event.method,
        event.params ?? {},
        event.sessionId
      );

      // Bootstrap events may prime the provisional CDP scope, but they must
      // not enter navigation ownership, capture, or follow-up queues until the
      // restoration transaction commits active.
      if (isRuntimeActivationProvisional(runtime.activationState)) {
        return;
      }

      const scopeAllowed = scopeEvaluation.allowed;
      const captureAllowed =
        scopeAllowed &&
        isRuntimeCaptureAdmitted(runtime.activationState) &&
        isVolatileCaptureOpen(runtime.captureFence);
      const cdpFrameTreeMutated = scopeEvaluation.globalFrameTreeMutation === true;
      let frameTreeNavigationClaim: SessionNavigationClaim | null = null;

      if (scopeEvaluation.topNavigation) {
        const { url, decision } = scopeEvaluation.topNavigation;
        const source: RuntimeNavigationSource =
          event.method === "Page.navigatedWithinDocument"
            ? "cdp-within-document"
            : "cdp-frame-navigated";
        const claim = claimCurrentRuntimeNavigation(runtime, source, url);
        frameTreeNavigationClaim = claim;

        if (!claim) {
          // Root bootstrap has its own atomic transaction and is intentionally
          // not folded into active-runtime navigation ownership.
        } else if (!decision.allowed) {
          requestStopRuntimeIfNavigationClaimCurrent(claim, "cdp-navigation-denied");
        } else {
          suspendFullCaptureForNavigation(claim, { cdpScopeAlreadyInvalidated: true });
          enqueueNavigationClaim(claim, async () => {
            if (!(await handleTabUrlChanged(claim, url))) {
              return;
            }

            await restoreCdpGlobalCaptureAfterNavigation(claim, true);
          });
        }
      } else if (cdpFrameTreeMutated) {
        const mutationGeneration = runtime.cdpScope.generation;
        const claim = snapshotCurrentRuntimeNavigation(
          runtime,
          "cdp-child-mutation",
          runtime.captureUrl
        );
        frameTreeNavigationClaim = claim;
        const activeRecording = runtime.screenRecording;
        const recordingGeneration = activeRecording?.cdpScopeGeneration;

        if (
          claim &&
          recordingGeneration !== undefined &&
          (recordingGeneration === null ||
            !isRuntimeGlobalCdpCaptureClaimValid(
              runtime,
              recordingGeneration,
              activeRecording?.provisional === true
            ))
        ) {
          void stopScreenRecording(runtime, "navigation-scope", activeRecording, () =>
            isSessionNavigationClaimCurrent(claim)
          ).catch(() => undefined);
        }

        if (claim) {
          enqueueNavigationClaim(claim, async () => {
            if (runtime.cdpScope.generation !== mutationGeneration) {
              return;
            }

            await restoreCdpGlobalCaptureAfterNavigation(claim, true);
          });
        }
      }

      if (captureAllowed && event.method === "HeapProfiler.addHeapSnapshotChunk") {
        const payload = asRecord(normalizedPayload);
        const chunk = typeof payload?.chunk === "string" ? payload.chunk : undefined;

        if (
          chunk &&
          runtime.heapSnapshotCapture &&
          isRuntimeGlobalCdpCaptureClaimValid(
            runtime,
            runtime.heapSnapshotCapture.cdpScopeGeneration
          )
        ) {
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

      if (captureAllowed) {
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
        (!captureAllowed &&
          event.method !== "Target.attachedToTarget" &&
          event.method !== "Target.detachedFromTarget")
      ) {
        return;
      }

      enqueue(
        runtime,
        async () => {
          if (
            frameTreeNavigationClaim &&
            !isSessionNavigationClaimCurrent(frameTreeNavigationClaim)
          ) {
            return;
          }

          await processFullModeEvent(runtime, event.method, event.params ?? {}, event.sessionId);
        },
        { bestEffort: true }
      );
    });

    const unsubscribeDetach = candidateRouter.onDetach((event) => {
      if (event.tabId === runtime.tabId && isMapEntrySame(sessionsByTab, runtime.tabId, runtime)) {
        requestStopRuntimeIfCurrent(runtime, "cdp-detach");
      }
    });

    runtime.removeCdpListeners.push(unsubscribeEvent, unsubscribeDetach);

    const bootstrapResult = await bootstrapCdpRoot({
      cdpLevel: runtime.config.capturePolicy?.categories.cdp ?? "off",
      commands: {
        attach: async () => {
          await candidateRouter.attach(runtime.tabId);

          if (!isMapEntrySame(sessionsByTab, runtime.tabId, runtime)) {
            throw new Error("The runtime changed while its root debugger was attaching.");
          }

          runtime.cdpRouter = candidateRouter;
          runtime.enabledCdpSessions.clear();
        },
        clearExecutionContextScopes: () => {
          runtime.cdpScope.executionContextScopes.clear();
        },
        enableAutoAttach: () => candidateRouter.enableAutoAttach(runtime.tabId),
        primeFrameTree: () => primeCdpFrameTreeScopes(runtime, candidateRouter),
        send: (method) => candidateRouter.send({ tabId: runtime.tabId }, method)
      },
      includeSubframes: runtime.config.capturePolicy?.scope.includeSubframes === true
    });

    runtime.enabledCdpSessions.add("root");

    if (runtime.screenRecording) {
      if (bootstrapResult.globalCaptureReady) {
        runtime.screenRecording.cdpScopeGeneration = runtime.cdpScope.generation;
      } else {
        await stopScreenRecording(runtime, "capture-scope");
      }
    }

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
    console.warn("[WebBlackbox] failed to bootstrap root debugger", error);
    await cleanupAndRethrowCdpRootBootstrapFailure(error, () =>
      cleanupCdpInstrumentation(runtime, router)
    );
  }
}

function scheduleFullModeSessionStartArtifacts(runtime: SessionRuntime): void {
  if (
    runtime.mode !== "full" ||
    !runtime.cdpRouter ||
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime)
  ) {
    return;
  }

  enqueue(
    runtime,
    async () => {
      await captureFullModeArtifacts(runtime, "session-start");
    },
    { bestEffort: true }
  );
}

async function primeCdpFrameTreeScopes(
  runtime: SessionRuntime,
  router: CdpRouter | null = runtime.cdpRouter
): Promise<CdpRootFrameTreePrime> {
  if (!router) {
    invalidateCdpCaptureFrameTree(runtime.cdpScope);
    return {
      globalCaptureReady: false,
      rootValid: false
    };
  }

  await refreshCdpCaptureFrameTree(runtime.cdpScope, async () => {
    const response = await router.send<{ frameTree?: unknown }>(
      { tabId: runtime.tabId },
      "Page.getFrameTree"
    );
    return response?.frameTree;
  });

  const generation = runtime.cdpScope.generation;
  const rootValid = isCdpCaptureFrameTreePrimedForRoot(
    runtime.cdpScope,
    runtime.captureUrl,
    generation
  );

  if (!rootValid) {
    invalidateCdpCaptureFrameTree(runtime.cdpScope);
  }

  return {
    globalCaptureReady:
      rootValid &&
      canCaptureGlobalCdpArtifactsForRoot(runtime.cdpScope, runtime.captureUrl, generation),
    rootValid
  };
}

async function restoreCdpGlobalCaptureAfterNavigation(
  claim: SessionNavigationClaim,
  forceRefresh = false
): Promise<void> {
  const runtime = claim.runtime;
  const expectedUrl = claim.candidateUrl ?? runtime.captureUrl;

  if (
    !isSessionNavigationClaimCurrent(claim) ||
    runtime.mode !== "full" ||
    !runtime.cdpRouter ||
    !isRuntimeCaptureScopeActive(runtime) ||
    runtime.captureUrl !== expectedUrl
  ) {
    return;
  }

  const initialRecording = runtime.screenRecording;
  const currentGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (
    initialRecording &&
    (forceRefresh ||
      currentGeneration === null ||
      initialRecording.cdpScopeGeneration !== currentGeneration)
  ) {
    try {
      await stopScreenRecording(runtime, "navigation-scope", initialRecording, () =>
        isSessionNavigationClaimCurrent(claim)
      );
    } catch {
      await stopRuntimeIfNavigationClaimCurrent(claim);
      return;
    }

    if (!isSessionNavigationClaimCurrent(claim)) {
      return;
    }
  }

  if (forceRefresh || claimRuntimeGlobalCdpCapture(runtime) === null) {
    const prime = await runGuardedNavigationStep(
      () => isSessionNavigationClaimCurrent(claim),
      () => primeCdpFrameTreeScopes(runtime)
    );

    if (prime.status !== "current" || runtime.captureUrl !== expectedUrl) {
      return;
    }

    const frameTreePrime = prime.value;
    const primeOutcome = resolveCdpNavigationPrimeOutcome(frameTreePrime);

    if (primeOutcome === "root-invalid") {
      const invalidRootRecording = runtime.screenRecording;

      await stopScreenRecording(runtime, "capture-scope", invalidRootRecording, () =>
        isSessionNavigationClaimCurrent(claim)
      ).catch(() => undefined);
      await stopRuntimeIfNavigationClaimCurrent(claim);
      return;
    }

    if (primeOutcome === "global-blocked") {
      const childBlockedRecording = runtime.screenRecording;

      try {
        await stopScreenRecording(runtime, "capture-scope", childBlockedRecording, () =>
          isSessionNavigationClaimCurrent(claim)
        );
      } catch {
        await stopRuntimeIfNavigationClaimCurrent(claim);
      }

      return;
    }
  }

  const finalGeneration = claimRuntimeGlobalCdpCapture(runtime);
  const activeRecording = runtime.screenRecording;

  if (
    activeRecording &&
    (finalGeneration === null || activeRecording.cdpScopeGeneration !== finalGeneration)
  ) {
    try {
      await stopScreenRecording(runtime, "navigation-scope", activeRecording, () =>
        isSessionNavigationClaimCurrent(claim)
      );
    } catch {
      await stopRuntimeIfNavigationClaimCurrent(claim);
      return;
    }

    if (!isSessionNavigationClaimCurrent(claim)) {
      return;
    }
  }

  const screenRecordingRequested =
    runtime.config.capturePolicy?.categories.screenRecordings === "allow";

  if (!runtime.screenRecording && screenRecordingRequested) {
    try {
      await startScreenRecording(runtime, false, claim);
    } catch (error) {
      console.warn("[WebBlackbox] failed to restart screen recording after navigation", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });

      await stopRuntimeIfNavigationClaimCurrent(claim);
      return;
    }

    if (!isSessionNavigationClaimCurrent(claim)) {
      return;
    }

    if (!runtime.screenRecording) {
      // A child-target mutation can invalidate global capture while the
      // requested start is in flight without superseding the top navigation.
      // Its queued snapshot owns the next prime and decides whether the valid
      // root is merely global-blocked or actually invalid.
      if (claimRuntimeGlobalCdpCapture(runtime) === null) {
        return;
      }

      await stopRuntimeIfNavigationClaimCurrent(claim);
    }
  }
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
  return (
    isVolatileCaptureOpen(runtime.captureFence) &&
    !runtime.stopping &&
    !runtime.stoppedAt &&
    isRuntimeDocumentWithinScope(runtime)
  );
}

function claimRuntimeGlobalCdpCapture(
  runtime: SessionRuntime,
  allowStarting = false
): number | null {
  const provisionalIdentityCurrent =
    allowStarting &&
    isRuntimeActivationProvisional(runtime.activationState) &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime);

  if (
    (!isRuntimeCaptureAdmitted(runtime.activationState) && !provisionalIdentityCurrent) ||
    !isRuntimeCaptureScopeActive(runtime) ||
    !canCaptureGlobalCdpArtifactsForRoot(runtime.cdpScope, runtime.captureUrl)
  ) {
    return null;
  }

  return runtime.cdpScope.generation;
}

function isRuntimeGlobalCdpCaptureClaimValid(
  runtime: SessionRuntime,
  generation: number,
  allowStarting = false
): boolean {
  const provisionalIdentityCurrent =
    allowStarting &&
    isRuntimeActivationProvisional(runtime.activationState) &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime);

  return (
    (isRuntimeCaptureAdmitted(runtime.activationState) || provisionalIdentityCurrent) &&
    isRuntimeCaptureScopeActive(runtime) &&
    canCaptureGlobalCdpArtifactsForRoot(runtime.cdpScope, runtime.captureUrl, generation)
  );
}

function isRuntimeEventMaterializationAllowed(
  runtime: SessionRuntime,
  stopDrainClaim: StopDrainClaim | null
): boolean {
  return stopDrainClaim
    ? isStopDrainClaimValid(stopDrainClaim, runtime, runtime.captureFence) &&
        isRuntimeDocumentWithinScope(runtime)
    : isRuntimeCaptureScopeActive(runtime);
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
  if (!isRuntimeCaptureScopeActive(runtime)) {
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
    !sessionId &&
    ((method === "Page.frameNavigated" &&
      typeof frame?.parentId !== "string" &&
      typeof frame?.parentFrameId !== "string") ||
      (method === "Page.navigatedWithinDocument" &&
        typeof payload?.frameId === "string" &&
        payload.frameId === runtime.cdpScope.rootFrameId));

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

  const hash = await putRuntimeCaptureBlob(
    runtime,
    metadata?.mimeType ?? "application/octet-stream",
    transformed.sampledBytes
  );

  if (!hash) {
    return;
  }

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
  if (runtime.mode !== "full" || !isRuntimeCaptureScopeActive(runtime)) {
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
  if (claimRuntimeGlobalCdpCapture(runtime) === null) {
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
  if (claimRuntimeGlobalCdpCapture(runtime) === null) {
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
  if (!isRuntimeCaptureScopeActive(runtime)) {
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
  if (claimRuntimeGlobalCdpCapture(runtime) === null) {
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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (!screenshot?.data || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  const bytes = decodeBase64(screenshot.data);
  const hash = await putRuntimeCaptureBlob(runtime, "image/webp", bytes);

  if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

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

function shouldStartScreenRecording(runtime: SessionRuntime, allowStarting = false): boolean {
  return (
    runtime.mode === "full" &&
    claimRuntimeGlobalCdpCapture(runtime, allowStarting) !== null &&
    runtime.config.capturePolicy?.categories.screenRecordings === "allow"
  );
}

async function startScreenRecording(
  runtime: SessionRuntime,
  provisional = false,
  navigationClaim?: SessionNavigationClaim
): Promise<void> {
  const isCurrentNavigation = () =>
    navigationClaim === undefined || isSessionNavigationClaimCurrent(navigationClaim);
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime, provisional);

  if (!isCurrentNavigation() || runtime.screenRecording || cdpScopeGeneration === null) {
    return;
  }

  if (!chromeApi?.tabCapture?.getMediaStreamId) {
    throw new Error("Chrome tabCapture API is unavailable for screen recording.");
  }

  const recordingId = createScreenRecordingId(runtime.sid);
  const startedAt = Date.now();
  const startedMono = monotonicTime();
  const stream = await runGuardedNavigationStep(isCurrentNavigation, () =>
    chromeApi.tabCapture!.getMediaStreamId!({
      targetTabId: runtime.tabId
    })
  );

  if (
    stream.status !== "current" ||
    runtime.screenRecording !== null ||
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration, provisional)
  ) {
    return;
  }

  const streamId = stream.value;

  if (!streamId) {
    throw new Error("Chrome did not grant a tab capture stream.");
  }

  const recording: ScreenRecordingRuntime = {
    recordingId,
    cdpScopeGeneration,
    provisional,
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
    const offscreenStart = await runGuardedNavigationStep(isCurrentNavigation, () =>
      requestOffscreenPipeline<OffscreenScreenRecordingStartResult>({
        op: "startScreenRecording",
        sid: runtime.sid,
        recordingId,
        streamId,
        source: SCREEN_RECORDING_OFFSCREEN_SOURCE
      })
    );

    if (
      offscreenStart.status !== "current" ||
      runtime.screenRecording !== recording ||
      !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration, provisional)
    ) {
      if (didGuardedNavigationOperationRun(offscreenStart)) {
        await stopScreenRecording(runtime, "capture-fence", recording);
      } else if (runtime.screenRecording === recording) {
        runtime.screenRecording = null;
      }
      return;
    }

    const result = offscreenStart.value;

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
    if (runtime.screenRecording === recording) {
      ingestScreenRecordingError(runtime, recording, error, "start");
      const reconciliation = await reconcileAmbiguousNavigationResourceStart({
        current: () => runtime.screenRecording,
        expected: recording,
        stop: (expected) => stopScreenRecording(runtime, "start-failed", expected)
      });

      if (reconciliation.kind === "retained") {
        // Keep the exact local identity so the surrounding start/restore
        // transaction can retry cleanup after an ambiguous offscreen result.
        console.warn("[WebBlackbox] failed to reconcile ambiguous screen start", {
          sid: runtime.sid,
          recordingId: recording.recordingId,
          error:
            reconciliation.error instanceof Error
              ? reconciliation.error.message
              : String(reconciliation.error)
        });
      }
    }
    throw error;
  }
}

async function stopScreenRecording(
  runtime: SessionRuntime,
  reason: string,
  expectedRecording: ScreenRecordingRuntime | null = runtime.screenRecording,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const recording = expectedRecording;

  if (!canOperateOnExpectedNavigationResource(isCurrent, runtime.screenRecording, recording)) {
    return;
  }

  if (recording.stopPromise) {
    await recording.stopPromise;
    return;
  }

  const stopPromise = (async () => {
    const result = await requestOffscreenPipeline<OffscreenScreenRecordingStopResult>({
      op: "stopScreenRecording",
      sid: runtime.sid,
      recordingId: recording.recordingId,
      reason
    });
    await finalizeScreenRecording(runtime, result);
  })();
  recording.stopPromise = stopPromise;

  try {
    await stopPromise;
  } catch (error) {
    if (recording.stopPromise === stopPromise) {
      recording.stopPromise = null;
    }

    throw error;
  }
}

async function handleOffscreenScreenRecordingChunk(
  message: OffscreenScreenRecordingChunkMessage
): Promise<void> {
  const runtime = sessionsBySid.get(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime || !recording || recording.recordingId !== message.recordingId) {
    return;
  }

  if (
    recording.cdpScopeGeneration === null ||
    !isRuntimeGlobalCdpCaptureClaimValid(
      runtime,
      recording.cdpScopeGeneration,
      recording.provisional
    )
  ) {
    await stopScreenRecording(runtime, "capture-scope").catch(() => undefined);
    return;
  }

  const bytes = asUint8Array(message.bytes);

  if (!bytes || bytes.byteLength === 0) {
    return;
  }

  const index = resolveScreenRecordingChunkIndex(message.index, recording.chunkCount);
  const task = (async () => {
    const cdpScopeGeneration = recording.cdpScopeGeneration;

    if (
      cdpScopeGeneration === null ||
      !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration, recording.provisional)
    ) {
      return;
    }

    const mime = typeof message.mime === "string" && message.mime ? message.mime : recording.mime;
    const hash = await putRuntimeCaptureBlob(runtime, mime, bytes);

    if (
      !hash ||
      runtime.screenRecording !== recording ||
      !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration, recording.provisional)
    ) {
      return;
    }

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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (!snapshot || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  const scopedDocuments = filterCdpSnapshotDocuments(runtime.cdpScope, snapshot.documents);
  const scopedSnapshot = {
    ...snapshot,
    documents: scopedDocuments
  };
  const bytes = new TextEncoder().encode(JSON.stringify(scopedSnapshot));
  const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

  if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (!isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  if (cookies?.cookies) {
    const cookieNames = cookies.cookies
      .map((entry) => asString(asRecord(entry)?.name))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS);
    const bytes = new TextEncoder().encode(JSON.stringify(cookieNames));
    const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

    if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
      return;
    }

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

  if (!isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  if (typeof localStorageData === "string") {
    const bytes = new TextEncoder().encode(localStorageData);
    const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

    if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
      return;
    }

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

  if (!isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  if (typeof origin === "string") {
    const dbNames = await sendCdpCommand<{ databaseNames?: string[] }>(
      runtime,
      { tabId: runtime.tabId },
      "IndexedDB.requestDatabaseNames",
      {
        securityOrigin: origin
      }
    );

    if (!isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
      return;
    }

    if (dbNames?.databaseNames) {
      const bytes = new TextEncoder().encode(JSON.stringify(dbNames.databaseNames));
      const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

      if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
        return;
      }

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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (!metrics || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(metrics));
  const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

  if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    return;
  }

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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
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
      !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
    ) {
      return;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(profileResult.profile));
    const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

    if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
      return;
    }

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
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!runtime.cdpRouter || cdpScopeGeneration === null) {
    return;
  }

  if (
    runtime.config.capturePolicy?.mode !== "lab" ||
    runtime.config.capturePolicy.categories.heapProfiles !== "lab-only"
  ) {
    return;
  }

  runtime.heapSnapshotCapture = {
    cdpScopeGeneration,
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
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
  ) {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
    return;
  }

  const joined = snapshot.chunks.join("");
  const bytes = new TextEncoder().encode(joined);
  const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

  if (!hash || !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)) {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
    return;
  }

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
  if (!runtime.cdpRouter || !isRuntimeCaptureScopeActive(runtime)) {
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

function normalizeFullModePayload(
  method: string,
  params: unknown,
  networkPolicy: CapturePolicy["categories"]["network"] | undefined
): unknown {
  const payload = asRecord(params);

  if (!payload) {
    return params;
  }

  if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
    return normalizeWebSocketFramePayload(method, payload, networkPolicy);
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
  documentUrl?: string,
  ready = false
): boolean {
  if (!isVolatileCaptureOpen(runtime.captureFence)) {
    return false;
  }

  const tabId = sender?.tab?.id;
  const frameId = normalizeSenderFrameId(sender);

  if (typeof tabId !== "number" || tabId !== runtime.tabId || frameId < 0) {
    return false;
  }

  const documentId = sender?.documentId;

  if (typeof documentId !== "string" || documentId.length === 0) {
    return false;
  }

  const senderUrl =
    typeof documentUrl === "string" && documentUrl.length > 0
      ? documentUrl
      : typeof sender?.url === "string" && sender.url.length > 0
        ? sender.url
        : null;
  const decision = evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url: senderUrl,
    tabId,
    frameId
  });

  if (!decision.allowed) {
    return false;
  }

  if (!senderUrl) {
    return false;
  }

  const authorizationInput = {
    tabId,
    frameId,
    documentId,
    url: senderUrl
  };
  const authorized =
    frameId === 0
      ? runtime.contentDocuments.authorizeTopSender(authorizationInput, {
          allowNavigationFallback: !usesExactLiteTopDocumentAuthorization(runtime),
          currentCaptureUrl: runtime.captureUrl,
          ready
        })
      : ready
        ? runtime.contentDocuments.authorize(authorizationInput)
        : runtime.contentDocuments.authorizeEvent(authorizationInput);

  if (!authorized) {
    return false;
  }

  if (frameId === 0 && senderUrl !== runtime.captureUrl) {
    runtime.captureUrl = senderUrl;
    runtime.cdpScope.captureUrl = senderUrl;
    runtime.url = sanitizeUrlForPrivacy(senderUrl);
  }

  syncAuthorizedContentFrames(runtime);
  return true;
}

function matchesAuthorizedContentSender(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  documentUrl?: string
): boolean {
  const tabId = sender?.tab?.id;
  const frameId = normalizeSenderFrameId(sender);
  const documentId = sender?.documentId;
  const url =
    typeof documentUrl === "string" && documentUrl.length > 0
      ? documentUrl
      : typeof sender?.url === "string" && sender.url.length > 0
        ? sender.url
        : null;

  return (
    typeof tabId === "number" &&
    tabId === runtime.tabId &&
    frameId >= 0 &&
    typeof documentId === "string" &&
    documentId.length > 0 &&
    url !== null &&
    runtime.contentDocuments.matchesSender({ tabId, frameId, documentId, url })
  );
}

function shouldStopRuntimeForDeniedContentSender(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined
): boolean {
  return runtime.contentDocuments.shouldStopRuntimeForDeniedSender({
    frameId: normalizeSenderFrameId(sender),
    documentId: sender?.documentId
  });
}

async function authorizeContentSenderForReady(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  documentUrl?: string
): Promise<boolean> {
  if (!authorizeContentSender(runtime, sender, documentUrl, true)) {
    const frameId = normalizeSenderFrameId(sender);
    const senderUrl =
      typeof documentUrl === "string" && documentUrl.length > 0
        ? documentUrl
        : typeof sender?.url === "string" && sender.url.length > 0
          ? sender.url
          : null;
    const preparing =
      typeof sender?.tab?.id === "number" &&
      frameId >= 0 &&
      typeof sender.documentId === "string" &&
      senderUrl
        ? runtime.contentDocuments.waitForPreparingAuthorization({
            tabId: sender.tab.id,
            frameId,
            documentId: sender.documentId,
            url: senderUrl
          })
        : null;

    if (
      !(
        preparing &&
        (await preparing) &&
        isRuntimeCurrentCaptureOpen(runtime) &&
        authorizeContentSender(runtime, sender, documentUrl, true)
      )
    ) {
      return false;
    }
  }

  if (!shouldInjectMainWorldHooksForMode(runtime.mode)) {
    return true;
  }

  const frameId = normalizeSenderFrameId(sender);

  if (frameId === 0) {
    if (usesExactLiteTopDocumentAuthorization(runtime)) {
      return true;
    }

    try {
      await injectMainWorldHook(chromeApi, {
        tabId: runtime.tabId,
        frameId: 0
      });
    } catch (error) {
      if (
        isRuntimeCurrentCaptureOpen(runtime) &&
        matchesAuthorizedContentSender(runtime, sender, documentUrl)
      ) {
        failContentSender(runtime, sender);
        await stopRuntimeIfCurrent(runtime);
      }

      console.warn("[WebBlackbox] top main-world hook injection failed closed", {
        tabId: runtime.tabId,
        documentId: sender?.documentId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }

    return (
      isRuntimeCurrentCaptureOpen(runtime) &&
      matchesAuthorizedContentSender(runtime, sender, documentUrl)
    );
  }

  const documentId = sender?.documentId;

  if (frameId < 0 || typeof documentId !== "string" || documentId.length === 0) {
    failContentSender(runtime, sender);
    return false;
  }

  try {
    await injectMainWorldHook(chromeApi, {
      tabId: runtime.tabId,
      frameId,
      documentId
    });
    return true;
  } catch (error) {
    failContentSender(runtime, sender);
    console.warn("[WebBlackbox] child main-world hook injection failed closed", {
      tabId: runtime.tabId,
      frameId,
      documentId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function failContentSender(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined
): boolean {
  const frameId = normalizeSenderFrameId(sender);
  const documentId = sender?.documentId;

  if (frameId < 0 || typeof documentId !== "string" || documentId.length === 0) {
    return false;
  }

  const navigationFailed = runtime.contentDocuments.failNavigation(frameId, documentId);
  const activeRevoked = runtime.contentDocuments.revoke(frameId, documentId);
  syncAuthorizedContentFrames(runtime);
  return navigationFailed || activeRevoked;
}

function syncAuthorizedContentFrames(runtime: SessionRuntime): void {
  runtime.authorizedContentFrames.clear();

  for (const frameId of runtime.contentDocuments.activeFrameIds()) {
    runtime.authorizedContentFrames.add(frameId);
  }
}

async function deactivateDeniedContentFrame(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  port?: PortLike
): Promise<void> {
  if (shouldStopRuntimeForDeniedContentSender(runtime, sender)) {
    await stopRuntimeIfCurrent(runtime);
    return;
  }

  const frameId = normalizeSenderFrameId(sender);

  if (frameId < 0) {
    return;
  }

  const deactivated = failContentSender(runtime, sender);

  if (port?.name === PORT_NAMES.content) {
    sendContentPortRecordingState(port, runtime, false);
  } else if (deactivated) {
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
}

function resetAuthorizedContentFrames(
  runtime: SessionRuntime,
  topDocumentUrl = runtime.captureUrl
): void {
  runtime.contentDocuments.reset({ url: topDocumentUrl });
  syncAuthorizedContentFrames(runtime);
}

function usesExactLiteTopDocumentAuthorization(runtime: SessionRuntime): boolean {
  try {
    return canUseExactLiteTopDocumentAuthorization({
      mode: runtime.mode,
      permissions: chromeApi?.runtime?.getManifest?.().permissions,
      hasWebNavigationApi: typeof chromeApi?.webNavigation?.onCommitted?.addListener === "function",
      hasScriptingApi: typeof chromeApi?.scripting?.executeScript === "function"
    });
  } catch {
    return false;
  }
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

async function ensureRootPageAgentsInjected(
  runtime: SessionRuntime,
  guards: {
    assertCurrent?: () => void;
    beforeEach?: (step: "isolated-content" | "main-world-hook") => Promise<void> | void;
  } = {}
): Promise<void> {
  await injectRootPageAgentsForMode(chromeApi, {
    mode: runtime.mode,
    contentTarget: resolveContentScriptInjectionTarget(runtime.config.capturePolicy, runtime.tabId),
    mainWorldTarget: { tabId: runtime.tabId, frameId: 0 },
    ...guards
  });
}

function installLiteWebRequestCapture(): void {
  if (
    resolveInstalledRuntimeCapabilities(chromeApi).browserNetwork !== "webRequest" ||
    !chromeApi?.webRequest ||
    liteWebRequestCaptureCleanup
  ) {
    return;
  }

  const filter = { urls: ["<all_urls>"] };
  const onBeforeRequest = (details: {
    requestId: string;
    tabId: number;
    documentId?: string;
    frameId?: number;
    parentDocumentId?: string;
    parentFrameId?: number;
    method?: string;
    type?: string;
    url: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveActiveLiteRuntime(details.tabId);

    if (!runtime) {
      return;
    }

    const requestMetaKey = buildRequestMetaKey(details.requestId);
    const existingMetadata = getRequestMeta(runtime.requestMeta, requestMetaKey);

    const authorization = authorizeLiteWebRequest({
      authorization: runtime.contentDocuments,
      details,
      phase: "before",
      navigationAuthorization: existingMetadata?.liteNavigationAuthorization,
      evaluateScope: (documentUrl, frameId) =>
        evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
          url: documentUrl,
          tabId: runtime.tabId,
          frameId
        }).allowed
    });

    if (authorization.kind === "subframe-navigation" || authorization.kind === "top-navigation") {
      syncAuthorizedContentFrames(runtime);
    }

    if (!authorization.allowed) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);

      if (authorization.kind === "top-navigation" && authorization.navigationCurrent === true) {
        requestStopRuntimeIfCurrent(runtime, "navigation-before-denied");
      }
      return;
    }

    const startedAt = normalizeLiteNetworkTimestamp(details.timeStamp);
    upsertRequestMeta(runtime.requestMeta, requestMetaKey, {
      url: details.url,
      method: details.method,
      startedAt,
      resourceType: details.type,
      liteNavigationAuthorization:
        authorization.kind === "subframe-navigation" || authorization.kind === "top-navigation"
          ? authorization.navigationAuthorization
          : undefined
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
          timeStamp: startedAt,
          mono: monotonicTime()
        }
      )
    );
  };

  const onCompleted = (details: {
    requestId: string;
    tabId: number;
    documentId?: string;
    frameId?: number;
    method?: string;
    type?: string;
    url: string;
    statusCode?: number;
    statusLine?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveActiveLiteRuntime(details.tabId);

    if (!runtime) {
      return;
    }

    const requestMetaKey = buildRequestMetaKey(details.requestId);
    const metadata = getRequestMeta(runtime.requestMeta, requestMetaKey);
    const authorization = authorizeLiteWebRequest({
      authorization: runtime.contentDocuments,
      details: {
        ...details,
        type: details.type ?? metadata?.resourceType
      },
      phase: "completion",
      navigationAuthorization: metadata?.liteNavigationAuthorization,
      evaluateScope: (documentUrl, frameId) =>
        evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
          url: documentUrl,
          tabId: runtime.tabId,
          frameId
        }).allowed
    });
    finalizeLiteNavigation(runtime, metadata?.liteNavigationAuthorization);

    if (!authorization.allowed) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);

      if (authorization.kind === "top-navigation" && authorization.navigationCurrent === true) {
        requestStopRuntimeIfCurrent(runtime, "navigation-completion-denied");
      }
      return;
    }

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
          mono: monotonicTime(),
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, requestMetaKey);
  };

  const onErrorOccurred = (details: {
    requestId: string;
    tabId: number;
    documentId?: string;
    frameId?: number;
    method?: string;
    type?: string;
    url: string;
    error?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveActiveLiteRuntime(details.tabId);

    if (!runtime) {
      return;
    }

    const requestMetaKey = buildRequestMetaKey(details.requestId);
    const metadata = getRequestMeta(runtime.requestMeta, requestMetaKey);
    const authorization = authorizeLiteWebRequest({
      authorization: runtime.contentDocuments,
      details: {
        ...details,
        type: details.type ?? metadata?.resourceType
      },
      phase: "completion",
      navigationAuthorization: metadata?.liteNavigationAuthorization,
      evaluateScope: (documentUrl, frameId) =>
        evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
          url: documentUrl,
          tabId: runtime.tabId,
          frameId
        }).allowed
    });
    finalizeLiteNavigation(runtime, metadata?.liteNavigationAuthorization);

    if (!authorization.allowed) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);

      if (authorization.kind === "top-navigation" && authorization.navigationCurrent === true) {
        requestStopRuntimeIfCurrent(runtime, "navigation-error");
      }
      return;
    }

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
          mono: monotonicTime(),
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined,
          error: details.error
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, requestMetaKey);

    if (authorization.kind === "top-navigation" && authorization.navigationCurrent === true) {
      requestStopRuntimeIfCurrent(runtime, "navigation-error");
    }
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

function finalizeLiteNavigation(
  runtime: SessionRuntime,
  authorization: RequestMetaEntry["liteNavigationAuthorization"]
): void {
  if (authorization) {
    runtime.contentDocuments.finalizeNavigation(authorization);
  }
}

function uninstallLiteWebRequestCaptureIfUnused(): void {
  if (!liteWebRequestCaptureCleanup || hasActiveLiteRuntime()) {
    return;
  }

  liteWebRequestCaptureCleanup();
}

function hasActiveLiteRuntime(): boolean {
  for (const runtime of sessionsByTab.values()) {
    if (
      runtime.mode === "lite" &&
      isRuntimeCaptureAdmitted(runtime.activationState) &&
      isVolatileCaptureOpen(runtime.captureFence) &&
      !runtime.stopping &&
      !runtime.stoppedAt
    ) {
      return true;
    }
  }

  return false;
}

function resolveActiveLiteRuntime(tabId: number): SessionRuntime | undefined {
  if (!Number.isFinite(tabId) || tabId < 0) {
    return undefined;
  }

  const runtime = sessionsByTab.get(tabId);

  if (
    !runtime ||
    runtime.mode !== "lite" ||
    !isRuntimeCaptureAdmitted(runtime.activationState) ||
    !isVolatileCaptureOpen(runtime.captureFence) ||
    runtime.stopping ||
    runtime.stoppedAt
  ) {
    return undefined;
  }

  return runtime;
}

function normalizeLiteNetworkTimestamp(candidate: unknown): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? candidate
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
  if (!runtime.queueAccepting) {
    return false;
  }

  if (options.bestEffort) {
    if (
      !isRuntimeCaptureAdmitted(runtime.activationState) ||
      !isVolatileCaptureOpen(runtime.captureFence) ||
      runtime.stopping ||
      runtime.queueDepth >= BEST_EFFORT_QUEUE_MAX_PENDING
    ) {
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
    const accepted = enqueue(runtime, async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (!accepted) {
      reject(new Error("Session queue is closed."));
    }
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

  await disposeListenersBeforeTeardown(
    runtime.removeCdpListeners.splice(0, runtime.removeCdpListeners.length),
    () => router?.detach(runtime.tabId).catch(() => undefined)
  );

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
  const active =
    activeRuntime?.sid === runtime.sid &&
    isRuntimeCaptureAdmitted(runtime.activationState) &&
    isVolatileCaptureOpen(runtime.captureFence) &&
    !runtime.stopping &&
    !runtime.stoppedAt;

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

  if (nextUrl && !usesExactLiteTopDocumentAuthorization(runtime)) {
    const claim = claimCurrentRuntimeNavigation(runtime, "content-navigation", nextUrl);

    if (!claim) {
      return;
    }

    suspendFullCaptureForNavigation(claim);
    enqueueNavigationClaim(claim, () => updateSessionMetadataFromEventAsync(runtime, event, claim));
    return;
  }

  void updateSessionMetadataFromEventAsync(runtime, event).catch((error) => {
    console.warn("[WebBlackbox] failed to update session navigation metadata", error);
  });
}

async function updateSessionMetadataFromEventAsync(
  runtime: SessionRuntime,
  event: WebBlackboxEvent,
  navigationClaim?: SessionNavigationClaim
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
  const globalCdpNavigationChanged = Boolean(
    nextUrl && runtime.mode === "full" && runtime.cdpRouter
  );
  let changed = false;

  if (nextUrl) {
    const exactLiteTopDocument = usesExactLiteTopDocumentAuthorization(runtime);
    const exactDocument = exactLiteTopDocument ? runtime.contentDocuments.get(0) : null;

    if (exactLiteTopDocument && (!exactDocument || exactDocument.url !== nextUrl)) {
      return;
    }

    const policy = navigationClaim
      ? await runGuardedNavigationStep(
          () => isSessionNavigationClaimCurrent(navigationClaim),
          () => isRuntimeTopDocumentAllowed(runtime, nextUrl)
        )
      : ({
          status: "current",
          value: await isRuntimeTopDocumentAllowed(runtime, nextUrl)
        } as const);

    if (
      policy.status !== "current" ||
      (!navigationClaim && !isRuntimeCurrentCaptureOpen(runtime))
    ) {
      return;
    }

    if (
      exactDocument &&
      !runtime.contentDocuments.matchesSender({
        tabId: runtime.tabId,
        frameId: 0,
        documentId: exactDocument.documentId,
        url: exactDocument.url
      })
    ) {
      return;
    }

    if (!policy.value) {
      if (exactLiteTopDocument) {
        await stopRuntimeIfCurrent(runtime);
      } else if (navigationClaim) {
        await stopRuntimeIfNavigationClaimCurrent(navigationClaim);
      }
      return;
    }

    const sanitizedNextUrl = sanitizeUrlForPrivacy(nextUrl);

    if (sanitizedNextUrl !== runtime.url || nextUrl !== runtime.captureUrl) {
      runtime.url = sanitizedNextUrl;
      runtime.captureUrl = nextUrl;
      runtime.cdpScope.captureUrl = nextUrl;
      if (!exactLiteTopDocument) {
        resetAuthorizedContentFrames(runtime);
      }
      changed = true;
    }
  }

  if (nextTitle && nextTitle.trim().length > 0 && nextTitle !== runtime.title) {
    if (
      navigationClaim
        ? !isSessionNavigationClaimCurrent(navigationClaim)
        : !isRuntimeCurrentCaptureOpen(runtime)
    ) {
      return;
    }

    runtime.title = nextTitle.trim();
    changed = true;
  }

  if (changed) {
    pushSessionList();
    scheduleRuntimeStatePersist();
  }

  if (globalCdpNavigationChanged && nextUrl && navigationClaim) {
    await restoreCdpGlobalCaptureAfterNavigation(navigationClaim, true);
  }
}

function pushSessionList(): void {
  broadcast(buildSessionListMessage());
}

function buildSessionListMessage(): SessionListMessage {
  const sessions: SessionListItem[] = [...sessionsBySid.values()]
    .filter((runtime) => isRuntimeCaptureAdmitted(runtime.activationState))
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

async function handleExactLiteTabUrlChanged(
  runtime: SessionRuntime,
  rawUrl: string
): Promise<void> {
  if (!isRuntimeCurrentCaptureOpen(runtime) || !usesExactLiteTopDocumentAuthorization(runtime)) {
    return;
  }

  const decision = await resolveCurrentTabUrlPolicyDecision({
    candidateUrl: rawUrl,
    evaluateAllowed: () => isRuntimeTopDocumentAllowed(runtime, rawUrl),
    resolveCurrentUrl: () => resolveCurrentTabCaptureUrl(runtime.tabId)
  });

  if (!isRuntimeCurrentCaptureOpen(runtime) || decision === "stale") {
    return;
  }

  if (decision === "denied") {
    await stopRuntimeIfCurrent(runtime);
    return;
  }

  const nextUrl = sanitizeUrlForPrivacy(rawUrl);

  if (nextUrl !== runtime.url || rawUrl !== runtime.captureUrl) {
    runtime.url = nextUrl;
    runtime.captureUrl = rawUrl;
    runtime.cdpScope.captureUrl = rawUrl;
    pushSessionList();
    scheduleRuntimeStatePersist();
  }
}

async function handleTabUrlChanged(
  claim: SessionNavigationClaim,
  rawUrl: string
): Promise<boolean> {
  const runtime = claim.runtime;

  if (!isSessionNavigationClaimCurrent(claim) || usesExactLiteTopDocumentAuthorization(runtime)) {
    return false;
  }

  const policy = await runGuardedNavigationStep(
    () => isSessionNavigationClaimCurrent(claim),
    () => isRuntimeTopDocumentAllowed(runtime, rawUrl)
  );

  if (policy.status !== "current") {
    return false;
  }

  if (!policy.value) {
    await stopRuntimeIfNavigationClaimCurrent(claim);
    return false;
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

  return isSessionNavigationClaimCurrent(claim);
}

async function resolveCurrentTabCaptureUrl(tabId: number): Promise<string | null> {
  if (!chromeApi?.tabs?.get) {
    return null;
  }

  try {
    const tab = await chromeApi.tabs.get(tabId);
    return typeof tab?.url === "string" && tab.url.length > 0 ? tab.url : null;
  } catch {
    return null;
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

async function persistRuntimeState(options: { required?: boolean } = {}): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    if (options.required) {
      throw new Error("Chrome storage is unavailable for the runtime checkpoint.");
    }

    return;
  }

  await enqueueRuntimeStatePersist(async () => {
    const snapshot = createCurrentRuntimeStateSnapshot();
    await chromeApi.storage!.local.set({
      [ACTIVE_SESSION_STORAGE_KEY]: snapshot
    });
  });
}

async function persistRuntimeStoppingTombstone(
  runtime: SessionRuntime,
  stopRequestedAt: number,
  cleanupDeadline: number
): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    throw new Error("Chrome storage is unavailable for the stop checkpoint.");
  }

  await enqueueRuntimeStatePersist(async () => {
    await persistDurableStopTombstone({
      persist: async () => {
        const snapshot = createCurrentRuntimeStateSnapshot({
          runtime,
          stopRequestedAt,
          cleanupDeadline
        });
        await chromeApi.storage!.local.set({
          [ACTIVE_SESSION_STORAGE_KEY]: snapshot
        });
      },
      activate: () => {
        runtime.stopping = true;
        runtime.stopRequestedAt = stopRequestedAt;
        runtime.cleanupDeadline = cleanupDeadline;
      }
    });
  });
}

function createCurrentRuntimeStateSnapshot(stoppingCheckpoint?: {
  runtime: SessionRuntime;
  stopRequestedAt: number;
  cleanupDeadline: number;
}) {
  const liveSessions = [...sessionsBySid.values()].map((runtime) => {
    const persisted = toPersistedRuntime(runtime);

    if (stoppingCheckpoint?.runtime !== runtime) {
      return persisted;
    }

    if (persisted.state !== "active") {
      throw new Error("Only an active runtime can enter the stopping checkpoint.");
    }

    return createStoppingRuntimeTombstone(
      persisted,
      stoppingCheckpoint.stopRequestedAt,
      stoppingCheckpoint.cleanupDeadline
    );
  });
  return createRuntimeStateSnapshot(
    mergeRuntimeStateWithStoppingTombstones(
      [...pendingRuntimeRestorationsBySid.values(), ...liveSessions],
      [...retainedStoppingRuntimesBySid.values()]
    )
  );
}

function enqueueRuntimeStatePersist(operationFactory: () => Promise<void>): Promise<void> {
  const operation = runtimeStatePersistTail.catch(() => undefined).then(operationFactory);
  runtimeStatePersistTail = operation;
  return operation;
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

  if (runtime.stopping) {
    if (runtime.stopRequestedAt === undefined || runtime.cleanupDeadline === undefined) {
      throw new Error("Stopping session is missing its durable stop checkpoint metadata.");
    }

    return {
      ...base,
      state: "stopping",
      stopRequestedAt: runtime.stopRequestedAt,
      cleanupDeadline: runtime.cleanupDeadline
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
  pendingRuntimeRestorationsBySid.clear();

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
    const restorationOrder = [
      ...snapshot.sessions.filter((runtime) => runtime.state === "stopping"),
      ...snapshot.sessions.filter((runtime) => runtime.state !== "stopping")
    ];

    for (const runtime of snapshot.sessions) {
      pendingRuntimeRestorationsBySid.set(runtime.sid, runtime);
    }

    for (const persistedRuntime of restorationOrder) {
      const config = applyEnterprisePolicyToRecorderConfig(
        persistedRuntime.config,
        enterprisePolicy
      );

      try {
        const restorationPlan = planRuntimeRestoration(persistedRuntime);

        if (restorationPlan.kind === "retain-stopped") {
          const runtime = await restoreStoppedRuntime(
            restorationPlan.runtime,
            config,
            performanceBudget
          );
          stoppedRuntimes.push(runtime);
          continue;
        }

        if (restorationPlan.kind === "purge-stopping") {
          const retainedTombstone: PersistedStoppingRuntime = {
            ...restorationPlan.runtime,
            config
          };
          retainedStoppingRuntimesBySid.set(retainedTombstone.sid, retainedTombstone);
          await notifyTabStatus(restorationPlan.runtime.tabId, false);
          await purgePersistedRuntimeData(retainedTombstone, {
            stopScreenRecording: true,
            rethrow: true
          });
          retainedStoppingRuntimesBySid.delete(retainedTombstone.sid);
          continue;
        }

        const restoration = await restoreActiveRuntime(
          restorationPlan.runtime,
          config,
          performanceBudget
        );

        if (restoration.kind === "rejected") {
          await notifyTabStatus(restorationPlan.runtime.tabId, false);
          await purgePersistedRuntimeData({ ...restorationPlan.runtime, config });
        }
      } catch (error) {
        console.warn("[WebBlackbox] failed closed while restoring session", {
          sid: persistedRuntime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
        await notifyTabStatus(persistedRuntime.tabId, false);

        if (persistedRuntime.state === "stopping") {
          await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
          console.warn("[WebBlackbox] retained stopping tombstone for recovery retry", {
            sid: persistedRuntime.sid
          });
          await scheduleRetainedStoppingRuntimeRecovery(
            retainedStoppingRuntimesBySid.get(persistedRuntime.sid)!
          ).catch((scheduleError) => {
            console.warn("[WebBlackbox] stopping recovery retry schedule failed", {
              sid: persistedRuntime.sid,
              error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError)
            });
          });
          continue;
        }
        await purgePersistedRuntimeData({ ...persistedRuntime, config });
      } finally {
        pendingRuntimeRestorationsBySid.delete(persistedRuntime.sid);
      }
    }

    await clearStaleRuntimeCleanupAlarms(
      new Set([
        ...stoppedRuntimes.map((runtime) => runtime.sid),
        ...retainedStoppingRuntimesBySid.keys()
      ])
    );

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
  retainedStoppingRuntimesBySid.clear();
  pendingRuntimeRestorationsBySid.clear();
  sessionAnnotations.clear();
  uninstallLiteWebRequestCaptureIfUnused();

  for (const runtime of runtimes) {
    await runtimeCleanupScheduler.cancel(runtime.sid).catch(() => undefined);

    if (!runtime.stoppedAt) {
      await notifyAuthorizedContentFrames(runtime, false).catch(() => undefined);
      await teardownCaptureInstrumentation(runtime).catch(() => undefined);
    }

    resetAuthorizedContentFrames(runtime);

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
): Promise<
  | Readonly<{ kind: "restored"; runtime: SessionRuntime }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "failed-cleaned" }>
> {
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
  try {
    assertRuntimeStartRequirements(resolveInstalledRuntimeCapabilities(chromeApi), {
      mode: persisted.mode,
      screenRecording:
        persisted.mode === "full" && config.capturePolicy?.categories.screenRecordings === "allow"
    });
  } catch (error) {
    console.warn("[WebBlackbox] active session capability checkpoint rejected", {
      sid: persisted.sid,
      error: error instanceof Error ? error.message : String(error)
    });
    return { kind: "rejected" };
  }
  const decision = evaluateActiveRuntimeRestoration(candidate, tab, Date.now());

  if (!decision.allowed) {
    console.warn("[WebBlackbox] active session checkpoint rejected", {
      sid: persisted.sid,
      reason: decision.reason
    });
    return { kind: "rejected" };
  }

  const pipeline = createOffscreenPipelineClient(persisted.sid);
  const transaction = await runActiveRuntimeRestorationTransaction({
    startPipeline: async () => {
      await ensureOffscreenDocument();
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
    },
    prepareRuntime: async () => {
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
        screenRecordingChunks,
        activationState: "starting"
      });

      return {
        runtime,
        resumeState,
        screenRecordingStatus,
        screenRecordingAllowedByCurrentPolicy,
        recorderSurvived,
        policyStoppedRecordingId
      };
    },
    registerRuntime: ({ runtime }) => {
      sessionsByTab.set(runtime.tabId, runtime);
      sessionsBySid.set(runtime.sid, runtime);
      scheduleConsentExpiry(runtime);
    },
    completeRuntime: async ({
      runtime,
      resumeState,
      screenRecordingStatus,
      screenRecordingAllowedByCurrentPolicy,
      recorderSurvived,
      policyStoppedRecordingId
    }) => {
      let recoveredRecordingId = policyStoppedRecordingId;

      if (
        screenRecordingStatus.active &&
        screenRecordingAllowedByCurrentPolicy &&
        !recorderSurvived
      ) {
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

      if (shouldInjectIsolatedContentForMode(runtime.mode)) {
        await ensureRootPageAgentsInjected(runtime, {
          assertCurrent: () => {
            if (!isRuntimeCurrentCaptureOpen(runtime)) {
              throw new Error("The restoring runtime changed during root script injection.");
            }
          }
        });
      }

      if (runtime.mode === "full" && runtime.config.capturePolicy?.categories.cdp !== "off") {
        await attachCdp(runtime);
      }

      if (runtime.screenRecording && claimRuntimeGlobalCdpCapture(runtime, true) === null) {
        await stopScreenRecording(runtime, "capture-scope");
      }

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

      if (!runtime.screenRecording && shouldStartScreenRecording(runtime, true)) {
        await startScreenRecording(runtime, true);

        if (!runtime.screenRecording && shouldStartScreenRecording(runtime, true)) {
          throw new Error("Screen recording did not restart before runtime restoration committed.");
        }

        await flushBufferedPipelineEvents(runtime);
        await runtime.pipeline.flush();
      }

      // This is the last fallible restoration stage. It also drains a
      // survived recording that was stopped because the restored frame tree
      // is globally blocked, even when there were no interrupted rows.
      await flushBufferedPipelineEvents(runtime);
      await runtime.pipeline.flush();
    },
    activateRuntime: ({ runtime }) => {
      commitRestoredRuntimeActivation(runtime, {
        currentByTab: isMapEntrySame(sessionsByTab, runtime.tabId, runtime),
        currentBySid: isMapEntrySame(sessionsBySid, runtime.sid, runtime)
      });
    },
    cleanupPipeline: () => cleanupFailedPipelineRestoration(candidate, pipeline),
    cleanupRuntime: ({ runtime }) => cleanupFailedActiveRuntimeRestoration(candidate, runtime)
  });

  if (transaction.kind === "restored") {
    await notifyAuthorizedContentFrames(transaction.runtime.runtime, true).catch(() => undefined);
    scheduleFullModeSessionStartArtifacts(transaction.runtime.runtime);
    return { kind: "restored", runtime: transaction.runtime.runtime };
  }

  console.warn("[WebBlackbox] partial active runtime restoration cleaned", {
    sid: persisted.sid,
    phase: transaction.phase,
    error:
      transaction.error instanceof Error ? transaction.error.message : String(transaction.error),
    cleanupError:
      transaction.cleanupError instanceof Error
        ? transaction.cleanupError.message
        : transaction.cleanupError === undefined
          ? undefined
          : String(transaction.cleanupError)
  });

  if (sessionAnnotations.delete(persisted.sid)) {
    await persistSessionAnnotations().catch(() => undefined);
  }

  return { kind: "failed-cleaned" };
}

async function cleanupFailedPipelineRestoration(
  persisted: PersistedActiveRuntime,
  pipeline: SessionPipelineClient,
  existingTombstone?: PersistedStoppingRuntime
): Promise<void> {
  let tombstone: PersistedStoppingRuntime | null = null;

  await runDurableFailedRuntimeCleanup({
    persistStopping: async () => {
      tombstone = await checkpointFailedActiveRuntimeCleanup(
        persisted,
        undefined,
        existingTombstone
      );
    },
    cleanup: async () => {
      await pipeline.close({ purge: true });
      await closeOffscreenIfUnused().catch(() => undefined);
    },
    clearStopping: () => clearFailedActiveRuntimeCleanup(requireTombstone(tombstone))
  });
}

async function cleanupFailedActiveRuntimeRestoration(
  persisted: PersistedActiveRuntime,
  runtime: SessionRuntime,
  existingTombstone?: PersistedStoppingRuntime
): Promise<void> {
  let tombstone: PersistedStoppingRuntime | null = null;

  await runDurableFailedRuntimeCleanup({
    persistStopping: async () => {
      tombstone = await checkpointFailedActiveRuntimeCleanup(persisted, runtime, existingTombstone);
    },
    cleanup: () => purgeFailedActiveRuntimeRestoration(runtime),
    clearStopping: () => clearFailedActiveRuntimeCleanup(requireTombstone(tombstone))
  });
}

async function checkpointFailedActiveRuntimeCleanup(
  persisted: PersistedActiveRuntime,
  runtime?: SessionRuntime,
  existingTombstone?: PersistedStoppingRuntime
): Promise<PersistedStoppingRuntime> {
  const stopRequestedAt = existingTombstone?.stopRequestedAt ?? Date.now();
  const cleanupDeadline =
    existingTombstone?.cleanupDeadline ??
    stopRequestedAt + resolveRuntimeLocalTtlMs(persisted.config.capturePolicy);
  const tombstone =
    existingTombstone ??
    createStoppingRuntimeTombstone(persisted, stopRequestedAt, cleanupDeadline);

  if (!existingTombstone) {
    pendingRuntimeRestorationsBySid.delete(persisted.sid);
  }

  if (runtime) {
    blockVolatileCapture(runtime.captureFence);
    runtime.stopping = true;
    runtime.stopRequestedAt = stopRequestedAt;
    runtime.cleanupDeadline = cleanupDeadline;
    runtime.queueAccepting = false;
    runtime.contentDocuments.cancelPendingNavigations();

    if (runtime.consentExpiryTimer !== null) {
      clearTimeout(runtime.consentExpiryTimer);
      runtime.consentExpiryTimer = null;
    }

    if (runtime.pipelineFlushTimer !== null) {
      clearTimeout(runtime.pipelineFlushTimer);
      runtime.pipelineFlushTimer = null;
    }

    cancelRuntimeStopDrain(runtime);

    deleteMapEntryIfSame(sessionsByTab, runtime.tabId, runtime);
    deleteMapEntryIfSame(sessionsBySid, runtime.sid, runtime);
    uninstallLiteWebRequestCaptureIfUnused();
    pushSessionList();
    notifyOffscreenPipelineStatus();
    void (sessionsByTab.size === 0 ? setIdleBadge() : setRecordingBadge()).catch(() => undefined);
  }

  retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch(() => undefined);
    throw error;
  }

  await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch((error) => {
    console.warn("[WebBlackbox] failed to schedule restoration cleanup retry", {
      sid: tombstone.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return tombstone;
}

async function clearFailedActiveRuntimeCleanup(tombstone: PersistedStoppingRuntime): Promise<void> {
  if (!deleteMapEntryIfSame(retainedStoppingRuntimesBySid, tombstone.sid, tombstone)) {
    return;
  }

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    if (!retainedStoppingRuntimesBySid.has(tombstone.sid)) {
      retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    }
    await scheduleRetainedStoppingRuntimeRecovery(tombstone).catch(() => undefined);
    throw error;
  }

  await runtimeCleanupScheduler.cancel(tombstone.sid).catch(() => undefined);
}

function requireTombstone(tombstone: PersistedStoppingRuntime | null): PersistedStoppingRuntime {
  if (!tombstone) {
    throw new Error("Restoration cleanup is missing its durable stopping tombstone.");
  }

  return tombstone;
}

async function purgeFailedActiveRuntimeRestoration(runtime: SessionRuntime): Promise<void> {
  blockVolatileCapture(runtime.captureFence);
  runtime.stopping = true;
  runtime.queueAccepting = false;
  runtime.contentDocuments.cancelPendingNavigations();

  if (runtime.consentExpiryTimer !== null) {
    clearTimeout(runtime.consentExpiryTimer);
    runtime.consentExpiryTimer = null;
  }

  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  cancelRuntimeStopDrain(runtime);
  const queueToDrain = runtime.queue;
  const recoveryToDrain = offscreenSessionRecovery.get(runtime.sid);

  deleteMapEntryIfSame(sessionsByTab, runtime.tabId, runtime);
  deleteMapEntryIfSame(sessionsBySid, runtime.sid, runtime);
  uninstallLiteWebRequestCaptureIfUnused();
  pushSessionList();
  notifyOffscreenPipelineStatus();

  await notifyAuthorizedContentFrames(runtime, false).catch(() => undefined);
  await Promise.allSettled([queueToDrain, ...(recoveryToDrain ? [recoveryToDrain] : [])]);
  runtime.queue = Promise.resolve();
  runtime.queueDepth = 0;

  await stopScreenRecording(runtime, "restore-failed").catch((error) => {
    console.warn("[WebBlackbox] failed to stop recorder during restoration cleanup", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  await teardownCaptureInstrumentation(runtime).catch((error) => {
    console.warn("[WebBlackbox] instrumentation cleanup failed after restoration", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  runtime.contentDocuments.reset();
  runtime.authorizedContentFrames.clear();
  runtime.requestMeta.clear();
  runtime.pipelineEventBuffer.length = 0;
  runtime.pipelineBatchInFlight = null;
  runtime.pipelineFlushQueued = false;
  runtime.responseBodyCaptureTimestamps.length = 0;
  runtime.heapSnapshotCapture = null;

  if (sessionsByTab.size === 0) {
    await setIdleBadge().catch(() => undefined);
  } else {
    await setRecordingBadge().catch(() => undefined);
  }

  await runtime.pipeline.close({ purge: true });
  await closeOffscreenIfUnused().catch(() => undefined);
}

function cancelRuntimeStopDrain(runtime: SessionRuntime): void {
  const pending = pendingStopDrainAcks.get(runtime.sid);

  if (!pending || pending.capability.runtime !== runtime) {
    return;
  }

  pendingStopDrainAcks.delete(runtime.sid);
  clearTimeout(pending.timeout);
  closeStopDrain(pending.capability);
  pending.resolve();
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

async function purgePersistedRuntimeData(
  runtime: {
    sid: string;
    tabId: number;
    startedAt: number;
    mode: CaptureMode;
    url: string;
    title?: string;
    tags: readonly string[];
    config: typeof DEFAULT_RECORDER_CONFIG;
  },
  options: {
    stopScreenRecording?: boolean;
    rethrow?: boolean;
  } = {}
): Promise<void> {
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

    if (options.stopScreenRecording) {
      await recoverStoppingRuntimeFailClosed({
        getScreenRecordingStatus: async () =>
          normalizeOffscreenScreenRecordingStatus(
            await requestOffscreenPipeline<unknown>({
              op: "getScreenRecordingStatus",
              sid: runtime.sid
            })
          ),
        stopScreenRecording: async (status) => {
          await requestOffscreenPipeline<OffscreenScreenRecordingStopResult>({
            op: "stopScreenRecording",
            sid: runtime.sid,
            recordingId: status.recordingId,
            reason: "stop-tombstone-recovery"
          });
        },
        purge: () => pipeline.close({ purge: true })
      });
    } else {
      await pipeline.close({ purge: true });
    }
  } catch (error) {
    console.warn("[WebBlackbox] persisted session purge failed", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });

    if (options.rethrow) {
      throw error;
    }
  }
}

async function scheduleRetainedStoppingRuntimeRecovery(
  runtime: PersistedStoppingRuntime
): Promise<void> {
  const retryAt = Math.min(runtime.cleanupDeadline, Date.now() + RETAINED_STOPPING_RETRY_DELAY_MS);
  await runtimeCleanupScheduler.schedule(runtime.sid, retryAt);
}

async function retryRetainedStoppingRuntimeRecovery(
  runtime: PersistedStoppingRuntime
): Promise<void> {
  await purgePersistedRuntimeData(runtime, {
    stopScreenRecording: true,
    rethrow: true
  });
  retainedStoppingRuntimesBySid.delete(runtime.sid);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    retainedStoppingRuntimesBySid.set(runtime.sid, runtime);
    throw error;
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

  const activeRuntimes = [...sessionsByTab.values()].filter(
    (runtime) =>
      isRuntimeCaptureAdmitted(runtime.activationState) &&
      isVolatileCaptureOpen(runtime.captureFence) &&
      !runtime.stopping &&
      !runtime.stoppedAt
  );

  try {
    port.postMessage({
      kind: "sw.pipeline-status",
      runtimeStateRestored,
      activeSessions: activeRuntimes.length,
      sessions: activeRuntimes.map((runtime) => ({
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
      activeSessions: activeRuntimes.length
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
  frameId?: number,
  stopDrain?: { token: string; deadline: number; documentUrl: string },
  documentId?: string
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  const target =
    frameId === undefined && documentId === undefined
      ? undefined
      : {
          ...(frameId === undefined ? {} : { frameId }),
          ...(documentId === undefined ? {} : { documentId })
        };

  await chromeApi.tabs
    .sendMessage(
      tabId,
      {
        kind: "sw.recording-status",
        active,
        tabId,
        sid,
        mode,
        sampling,
        capturePolicy,
        stopDrain
      },
      target
    )
    .catch(() => undefined);
}

async function notifyAuthorizedContentFrames(
  runtime: SessionRuntime,
  active: boolean,
  stopDrain?: { token: string; deadline: number; documentUrl: string }
): Promise<void> {
  const documents = runtime.contentDocuments.activeDocuments();

  await Promise.all(
    documents.map((document) =>
      notifyTabStatus(
        runtime.tabId,
        active,
        runtime.sid,
        runtime.mode,
        toStatusSampling(runtime),
        runtime.config.capturePolicy,
        document.frameId,
        document.frameId === 0 ? stopDrain : undefined,
        document.documentId
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

function createStopDrainAck(runtime: SessionRuntime): {
  wait: Promise<void>;
  notice?: { token: string; deadline: number; documentUrl: string };
} {
  const existing = pendingStopDrainAcks.get(runtime.sid);

  if (existing) {
    clearTimeout(existing.timeout);
    pendingStopDrainAcks.delete(runtime.sid);
    closeStopDrain(existing.capability);
    existing.resolve();
  }

  if (
    runtime.mode !== "lite" ||
    !runtime.authorizedContentFrames.has(0) ||
    !isRuntimeDocumentWithinScope(runtime)
  ) {
    return { wait: Promise.resolve() };
  }

  const deadline = Date.now() + STOP_DRAIN_ACK_TIMEOUT_MS;
  let capability: StopDrainCapability;

  try {
    capability = createStopDrainCapability({
      runtime,
      fence: runtime.captureFence,
      sid: runtime.sid,
      tabId: runtime.tabId,
      documentUrl: runtime.captureUrl,
      deadline
    });
  } catch (error) {
    console.warn("[WebBlackbox] stop-drain capability creation failed closed", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
    return { wait: Promise.resolve() };
  }

  const wait = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      const pending = pendingStopDrainAcks.get(runtime.sid);

      if (!pending || pending.capability !== capability) {
        return;
      }

      pending.capability.accepting = false;
      pending.ackReceived = true;
      resolveStopDrainAckIfReady(pending);
    }, STOP_DRAIN_ACK_TIMEOUT_MS);

    pendingStopDrainAcks.set(runtime.sid, {
      sid: runtime.sid,
      tabId: runtime.tabId,
      capability,
      ackReceived: false,
      settling: false,
      resolve,
      timeout
    });
  });

  return {
    wait,
    notice: {
      token: capability.token,
      deadline: capability.deadline,
      documentUrl: capability.documentUrl
    }
  };
}

function markStopDrainAckReceived(
  message: Extract<ExtensionInboundMessage, { kind: "content.stop-drained" }>,
  sender: MessageSenderLike | undefined
): void {
  const pending = pendingStopDrainAcks.get(message.sid);

  if (!pending) {
    return;
  }

  const runtime = sessionsBySid.get(message.sid);

  if (
    !runtime ||
    !acknowledgeStopDrain(pending.capability, {
      runtime,
      fence: runtime.captureFence,
      token: message.token,
      sid: message.sid,
      tabId: sender?.tab?.id ?? -1,
      frameId: normalizeSenderFrameId(sender),
      documentUrl: message.documentUrl
    })
  ) {
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
  capability: StopDrainCapability;
  ackReceived: boolean;
  settling: boolean;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}): void {
  if (!pending.ackReceived || pending.settling) {
    return;
  }

  if ((inFlightContentMessagesByTab.get(pending.tabId) ?? 0) > 0) {
    return;
  }

  const runtime = sessionsBySid.get(pending.sid);
  pending.settling = true;

  const finalize = () => {
    if (pendingStopDrainAcks.get(pending.sid) === pending) {
      pendingStopDrainAcks.delete(pending.sid);
    }

    clearTimeout(pending.timeout);
    closeStopDrain(pending.capability);
    pending.resolve();
  };

  if (!runtime) {
    finalize();
    return;
  }

  void runtime.queue.then(finalize, finalize);
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
