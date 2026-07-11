import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import type {
  PipelineDeliveryEventProvenance,
  PipelineDeliveryNoOutputChange,
  PipelineDeliveryReceipt,
  PipelineDeliveryReceiptQuery,
  PipelineDeliverySidecar,
  PipelineResumeState,
  ScreenRecordingChunkReference
} from "@webblackbox/pipeline";
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
import type {
  ContentActivationId,
  ContentEventBatchId
} from "../shared/content-activation-protocol.js";
import {
  isAuthorizedExtensionPort,
  parseExtensionInboundMessage
} from "../shared/inbound-messages.js";
import {
  CONTENT_EVENT_BATCH_MAX,
  PORT_NAMES,
  type ContentSameDocumentTransition,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type FullModeVisualCapture,
  type OffscreenScreenRecordingChunkMessage,
  type ScreenRecordingChunkAckMessage,
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
import { shouldInjectIsolatedContentForMode } from "../shared/mode-profile.js";
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
  getCdpChildSessionClaim,
  invalidateCdpCaptureFrameTree,
  isCdpCaptureFrameTreePrimedForRoot,
  isCdpChildSessionClaimCurrent,
  refreshCdpCaptureFrameTree,
  type CdpCaptureScopeState,
  type CdpChildSessionClaim
} from "./cdp-capture-scope.js";
import { bootstrapCdpChildSession } from "./cdp-child-bootstrap.js";
import { withCdpCommandTimeout, type CdpCommandOutcome } from "./cdp-command.js";
import {
  buildCdpFollowupRequestMetaKey,
  evaluateCdpTargetControlScopeEvent,
  isCdpFollowupClaimCurrent
} from "./cdp-event-followup.js";
import {
  bootstrapCdpRoot,
  cleanupAndRethrowCdpRootBootstrapFailure,
  type CdpRootFrameTreePrime
} from "./cdp-root-bootstrap.js";
import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import {
  ContentActivationRegistry,
  type ContentActivationSnapshot,
  type ContentActivationState
} from "./content-activation-registry.js";
import {
  canFinalizeMainWorldRevocation,
  runBoundedMainWorldDeactivation
} from "./content-main-world-revocation.js";
import {
  ContentEventBatchLedger,
  classifyContentEventBatchReceipt,
  fingerprintContentEventBatch,
  isContentEventBatchAdmissionLive,
  processContentEventBatchAttempt,
  readContentEventBatchReceiptAfterBarrier,
  type ContentEventBatchAdmissionIdentity,
  type ContentEventBatchRecord
} from "./content-event-batch-ledger.js";
import { disconnectContentPort } from "./content-port-lifecycle.js";
import { commitDurableRemoval } from "./durable-removal.js";
import { injectPendingContentDocument } from "./dynamic-content-injection.js";
import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";
import {
  authorizeLiteWebRequest,
  isLiteWebRequestDocumentUrlUnambiguous,
  type LiteWebRequestAuthorizationDecision
} from "./lite-web-request-authorization.js";
import {
  advanceCdpRestoreEpoch,
  cancelExactWebNavigationCommitObservation,
  canUseExactLiteTopDocumentAuthorization,
  classifyActiveCommittedDocument,
  createExactTopNavigationObservationState,
  isCdpRestoreEpochCurrent,
  observeExactCdpTopNavigation,
  observeExactWebNavigationCommit,
  resolveCurrentTabUrlPolicyDecision,
  resolveCdpRestorePredecessor,
  resolveCdpTopNavigationOwnership,
  resolveExactInitialContentParent,
  shouldContentSenderClaimCaptureUrl,
  shouldUpdateSessionMetadataFromNavigation,
  type ExactTopNavigationObservationState
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
  launchDetachedNavigationTask,
  reconcileAmbiguousNavigationResourceStart,
  resolveCdpNavigationPrimeOutcome,
  resolveTabNavigationSignal,
  runGuardedNavigationStep,
  runRuntimeNavigationTask
} from "./runtime-navigation-operations.js";
import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";
import {
  sameMainWorldControllerCapability,
  type MainWorldControllerHint
} from "../shared/main-world-controller.js";
import {
  acknowledgePipelineBatch,
  acquirePipelineBatch,
  shouldRecoverOffscreenPipeline,
  shouldRetryOffscreenPipelineRequest,
  type PipelineBatchInFlight
} from "./pipeline-batch.js";
import {
  ScreenRecordingChunkWriteLedger,
  ScreenRecordingFinalizationGate,
  retryScreenRecordingFinalization,
  runDurableScreenRecordingFinalization
} from "./screen-recording-chunk-write.js";
import { OffscreenDocumentLifecycle } from "./offscreen-document-lifecycle.js";
import { SameDocumentTransitionLedger } from "./same-document-transition-ledger.js";
import {
  commitSessionAnnotationMutation,
  mergePersistedSessionAnnotation,
  SessionAnnotationMutationCoordinator
} from "./session-annotation-state.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta,
  type RequestMetaEntry
} from "./request-meta.js";
import {
  advanceControllerFromControl,
  bootstrapMainWorldDirectController,
  controlMainWorldDirectController,
  injectRootPageAgentsForMode
} from "./script-injection.js";
import {
  FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS,
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta,
  type LocalStorageSnapshotMode
} from "./storage-snapshot.js";
import {
  acknowledgeStopDrain,
  canAdmitStopDrainBatch,
  claimStopDrainEvent,
  closeStopDrain,
  commitStopDrainBatchClaims,
  commitStopDrainClaim,
  createStopDrainCapability,
  dropUnclaimableStopDrainOrdinaryEvent,
  getCommittedStopDrainArtifactTypes,
  isStopDrainClaimValid,
  releaseStopDrainClaim,
  resolveStopDrainTimeoutEvidence,
  runStopDrainBlobOperation,
  type StopDrainCapability,
  type StopDrainClaim
} from "./stop-drain.js";
import {
  RuntimeCleanupScheduler,
  DurableRuntimeRecoveryCheckpoint,
  MAX_PERSISTED_RUNTIME_SESSIONS,
  RuntimeStartCancelledError,
  RuntimeStartCoordinator,
  type RuntimeStartToken,
  beginVolatileCaptureQuiescence,
  blockVolatileCapture,
  buildInterruptedScreenRecordingRecoveries,
  capCleanupDeadline,
  compactScreenRecordingChunkHashes,
  commitRestoredRuntimeActivation,
  createVolatileCaptureFence,
  createRuntimeStateSnapshot,
  createStoppedRuntimeTombstone,
  createStoppingRuntimeTombstone,
  deleteMapEntryIfSame,
  disposeListenersBeforeTeardown,
  establishDurableRuntimeRestorationReadiness,
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
  preserveRuntimeRowsAfterGlobalRestoreFailure,
  persistDurableStopTombstone,
  reconcileScreenRecordingResumeState,
  recoverStoppingRuntimeFailClosed,
  recoverStoppingRuntimeForRetention,
  restoreScreenRecordingChunkHashes,
  runActiveRuntimeRestorationTransaction,
  runDurableFailedRuntimeRetention,
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
import {
  RuntimeTaskCoordinator,
  cancelOwnedRuntimeStart,
  resolveRuntimeEventOwner
} from "./runtime-identity.js";

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
  cdpScope: CdpCaptureScopeState;
  contentDocuments: ContentDocumentAuthorization;
  contentActivationParents: Map<string, { frameId: number; documentId: string }>;
  contentMainWorldProofs: Map<string, MainWorldControllerHint>;
  contentNavigationRevisions: Map<string, number>;
  sameDocumentTransitions: SameDocumentTransitionLedger;
  pendingContentPolicyRevisions: Map<string, number>;
  pendingLiteNetworkPolicyRevisions: Map<string, number>;
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
  pipelineEventBuffer: BufferedPipelineEvent[];
  pipelineBatchInFlight: PipelineBatchInFlight<BufferedPipelineEvent> | null;
  activePipelineDelivery: PipelineDeliveryEventProvenance | null;
  pipelineFlushTimer: ReturnType<typeof setTimeout> | null;
  pipelineFlushQueued: boolean;
  captureFence: VolatileCaptureFence;
  cdpPayloadAdmissionBlocked: boolean;
  cdpRestoreCheckpoint: {
    navigationRevision: number;
    captureUrl: string;
    childMutationRevision: number;
    restoreEpoch: number;
    generation: number;
  } | null;
  cdpRestoreEpoch: number;
  cdpRestoreTail: Promise<void>;
  cdpRestoreTailEpoch: number;
  exactTopNavigationObservations: ExactTopNavigationObservationState;
  exactWebNavigationTransactions: Map<number, ExactWebNavigationCommitTransaction>;
  activationState: RuntimeActivationState;
  startToken: RuntimeStartToken | null;
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

type ExactWebNavigationCommitTransaction = {
  token: number;
  restoreEpoch: number;
  claim: SessionNavigationClaim;
  phase: "running" | "restoring" | "completed";
  cdpObserved: boolean;
  detachedRestorePending: boolean;
};

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
  chunkWrites: ScreenRecordingChunkWriteLedger;
  stopPromise: Promise<void> | null;
  finalization: ScreenRecordingFinalizationGate;
  finalizing: boolean;
  durabilityEvidenceQueued: boolean;
  terminalEvidenceQueued: boolean;
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

type BufferedPipelineEvent = Readonly<{
  event: WebBlackboxEvent;
  delivery?: PipelineDeliveryEventProvenance;
}>;

type SessionPipelineClient = {
  start: (
    session: SessionMetadata,
    redactionProfile: RedactionProfile,
    capturePolicy?: CapturePolicy
  ) => Promise<void>;
  ingest: (event: WebBlackboxEvent, operationId?: string) => Promise<void>;
  ingestBatch: (
    events: readonly WebBlackboxEvent[],
    operationId?: string,
    options?: { screenRecordingFinalization?: boolean }
  ) => Promise<void>;
  ingestBatchWithDelivery: (
    events: readonly WebBlackboxEvent[],
    deliveryByEventId: PipelineDeliverySidecar,
    operationId?: string,
    options?: { screenRecordingFinalization?: boolean }
  ) => Promise<void>;
  getDeliveryReceipt: (
    query: PipelineDeliveryReceiptQuery
  ) => Promise<PipelineDeliveryReceipt | undefined>;
  commitDeliveryProgress: (changes: readonly PipelineDeliveryNoOutputChange[]) => Promise<void>;
  flush: () => Promise<void>;
  getResumeState: () => Promise<PipelineResumeState>;
  putBlob: (
    mime: string,
    bytes: Uint8Array,
    options?: { screenRecordingFinalization?: boolean }
  ) => Promise<string>;
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
    | "ingestBatchDurably"
    | "ingestBatchWithDelivery"
    | "flush"
    | "getResumeState"
    | "getDeliveryReceipt"
    | "commitDeliveryProgress"
    | "putBlob"
    | "exportDownload"
    | "close"
    | "getScreenRecordingStatus"
    | "quiesceScreenRecording"
    | "startScreenRecording"
    | "stopScreenRecording";
  sid: string;
  operationId?: string;
  session?: SessionMetadata;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  event?: WebBlackboxEvent;
  events?: readonly WebBlackboxEvent[];
  deliverySidecar?: Array<{
    eventId: string;
    provenance: PipelineDeliveryEventProvenance;
  }>;
  deliveryProgress?: readonly PipelineDeliveryNoOutputChange[];
  deliveryQuery?: PipelineDeliveryReceiptQuery;
  mime?: string;
  bytes?: Uint8Array;
  screenRecordingFinalization?: boolean;
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
  durableChunkCount?: number;
  durableSize?: number;
  degraded?: boolean;
  degradationReason?: string;
  durationMs: number;
  width?: number;
  height?: number;
  reason?: string;
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

type SessionContentActivation = ContentActivationSnapshot<
  SessionRuntime,
  VolatileCaptureFence,
  CaptureMode
>;

type StopDrainNotice = Extract<ExtensionOutboundMessage, { kind: "sw.content-drain" }>;

type PendingStopDrainAck = {
  sid: string;
  runtime: SessionRuntime;
  capabilities: Map<ContentActivationId, StopDrainCapability>;
  acknowledged: Set<ContentActivationId>;
  settling: boolean;
  timeoutFinalizing: boolean;
  timeoutNoticeQueued: boolean;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
  retryTimer: ReturnType<typeof setInterval>;
};

type ContentEventBatchAdmission = ContentEventBatchAdmissionIdentity<
  SessionRuntime,
  VolatileCaptureFence,
  CaptureMode
> & {
  readonly kind: "content-event-batch";
  readonly activationId: ContentActivationId;
  readonly batchId: ContentEventBatchId;
  valid: boolean;
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
const offscreenDocumentLifecycle = new OffscreenDocumentLifecycle();
const sessionStartCoordinator = new RuntimeStartCoordinator();
const runtimeStopTasks = new RuntimeTaskCoordinator<SessionRuntime>();
const runtimeDisposeTasks = new RuntimeTaskCoordinator<SessionRuntime>();
const contentActivations = new ContentActivationRegistry<
  SessionRuntime,
  VolatileCaptureFence,
  PortLike,
  CaptureMode
>();
const retainedStoppingRuntimesBySid = new Map<string, PersistedStoppingRuntime>();
const pendingRuntimeRestorationsBySid = new Map<string, PersistedRuntime>();
const runtimeRestorationSourceRowsBySid = new Map<string, PersistedRuntime>();
let runtimeRestorationCheckpointRewriteAllowed = false;
const sessionAnnotations = new Map<string, SessionAnnotation>();
const sessionAnnotationMutations = new SessionAnnotationMutationCoordinator();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingStopDrainAcks = new Map<string, PendingStopDrainAck>();
const preparedStopDrainPlans = new WeakMap<
  SessionRuntime,
  {
    wait: Promise<void>;
    notification: Promise<void>;
  }
>();
const inFlightContentMessagesByActivation = new Map<ContentActivationId, number>();
const contentEventBatchLedger = new ContentEventBatchLedger<PortLike>();
const contentEventBatchAdmissionsByActivation = new Map<
  ContentActivationId,
  Set<ContentEventBatchAdmission>
>();
const pendingContentRevocations = new Map<ContentActivationId, Promise<void>>();
const contentRevocationControllers = new Map<
  ContentActivationId,
  { key: string; controller: MainWorldControllerHint }
>();
const contentRevocationRetryTimers = new Map<ContentActivationId, ReturnType<typeof setTimeout>>();
const pendingContentArmWaiters = new Set<{
  runtime: SessionRuntime;
  fence: VolatileCaptureFence;
  frameId: number;
  documentId?: string;
  excludedDocumentId?: string;
  awaitingCommittedDocument?: boolean;
  resolve: (activation: SessionContentActivation) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
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
const RUNTIME_RESTORATION_RETRY_MS = 1_000;
const RETAINED_STOPPING_RETRY_DELAY_MS = 30_000;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const PERF_WARN_MS = 40;
const OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS = 12 * 60_000;
const OFFSCREEN_PORT_READY_MAX_ATTEMPTS = 200;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;
const STOP_DRAIN_ACK_TIMEOUT_MS = 15_000;
const STOP_DRAIN_NOTIFICATION_TIMEOUT_MS = 2_000;
const STOP_DRAIN_NOTIFICATION_RETRY_MS = 500;
const STOP_DRAIN_QUEUE_SETTLE_TIMEOUT_MS = 1_500;
const MAIN_WORLD_REVOCATION_TIMEOUT_MS = 2_000;
const MAIN_WORLD_REVOCATION_RETRY_MS = 500;
const SCREEN_RECORDING_FINALIZATION_MAX_ATTEMPTS = 5;
const SCREEN_RECORDING_FINALIZATION_RETRY_INITIAL_MS = 250;
const CONTENT_ARM_TIMEOUT_MS = 5_000;
const CDP_ARTIFACT_TIMEOUT_MS = 5_000;
const CDP_HEAP_SNAPSHOT_TIMEOUT_MS = 8_000;
const CDP_CHILD_SETTLE_TIMEOUT_MS = 15_000;
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

    const retainedStopped = pendingRuntimeRestorationsBySid.get(sid);

    if (retainedStopped?.state === "stopped") {
      await retryRetainedStoppedRuntimeRecovery(retainedStopped);
      return;
    }

    const runtime = sessionsBySid.get(sid);

    if (runtime?.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  }
});
let runtimeStateRestored = false;
const runtimeStateRestorePromise = establishDurableRuntimeRestorationReadiness({
  restore: restoreRuntimeState,
  failClosed: failClosedRuntimeRestoration,
  waitForRetry: () => wait(RUNTIME_RESTORATION_RETRY_MS),
  shouldRetryRestore: () =>
    !runtimeRestorationCheckpointRewriteAllowed &&
    runtimeRestorationSourceRowsBySid.size === 0 &&
    pendingRuntimeRestorationsBySid.size === 0 &&
    retainedStoppingRuntimesBySid.size === 0 &&
    sessionsBySid.size === 0,
  markReady: () => {
    runtimeStateRestored = true;
    notifyOffscreenPipelineStatus();
  },
  onRestoreFailure: (error) => {
    console.warn("[WebBlackbox] runtime state restoration failed closed", error);
  },
  onFailClosedRetry: (error) => {
    console.warn("[WebBlackbox] durable fail-closed checkpoint retry scheduled", error);
  }
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
      contentActivations.unbindPort(port);
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
      const hintClaim = claimCurrentRuntimeNavigation(runtime, signal.source, signal.candidateUrl);

      if (!hintClaim) {
        return;
      }

      void handleExactLiteTabUrlChanged(hintClaim, signal.candidateUrl).catch((error) => {
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

  if (runtime.mode === "full" && hasExactWebNavigationTracking()) {
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
  const owner = sessionsByTab.get(details.tabId);
  const task = handleCommittedContentDocument(details);
  // The handler claims top-level ownership synchronously before its first
  // policy await. Snapshot afterward so the catch path is fenced from later
  // same-URL commits and replacement runtimes.
  const navigationClaim = owner
    ? snapshotCurrentRuntimeNavigation(owner, "web-navigation-commit", details.url)
    : null;
  const exactTransaction =
    owner && navigationClaim
      ? [...owner.exactWebNavigationTransactions.values()].find(
          (candidate) => candidate.claim.revision === navigationClaim.revision
        )
      : undefined;
  const documentRevisionKey =
    owner && typeof details.documentId === "string" && details.documentId.length > 0
      ? contentActivationParentKey(details.frameId, details.documentId)
      : null;
  const failureClaim = navigationClaim
    ? {
        navigation: navigationClaim,
        documentRevisionKey,
        documentRevision: documentRevisionKey
          ? (owner?.contentNavigationRevisions.get(documentRevisionKey) ?? 0)
          : 0,
        cdpRestoreEpoch: owner?.cdpRestoreEpoch ?? 0,
        ...(exactTransaction ? { exactTransaction } : {})
      }
    : null;

  void task.catch((error) => {
    console.warn("[WebBlackbox] committed document handling failed closed", {
      tabId: details.tabId,
      frameId: details.frameId,
      documentId: details.documentId,
      error: error instanceof Error ? error.message : String(error)
    });
    if (failureClaim) {
      void failCommittedContentDocument(details, failureClaim);
    }
  });
});

chromeApi?.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  const runtime = sessionsByTab.get(details.tabId);
  if (details.frameId === 0 && runtime?.mode === "full" && runtime.cdpRouter) {
    return;
  }

  dispatchSameDocumentNavigation(details, "history-state");
});

chromeApi?.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
  const runtime = sessionsByTab.get(details.tabId);
  if (details.frameId === 0 && runtime?.mode === "full" && runtime.cdpRouter) {
    return;
  }

  dispatchSameDocumentNavigation(details, "fragment");
});

function dispatchSameDocumentNavigation(
  details: { tabId: number; frameId: number; documentId?: string; url: string },
  source: "history-state" | "fragment"
): void {
  const owner = sessionsByTab.get(details.tabId);
  const task = handleSameDocumentNavigation(details);
  const revisionKey =
    typeof details.documentId === "string" && details.documentId.length > 0
      ? contentActivationParentKey(details.frameId, details.documentId)
      : null;
  // Async functions run synchronously until their first await, so this
  // snapshots the exact revision installed by handleSameDocumentNavigation.
  const contentRevision = revisionKey
    ? owner?.contentNavigationRevisions.get(revisionKey)
    : undefined;
  const navigationRevision = owner?.navigationRevision;
  const cdpRestoreEpoch = owner?.cdpRestoreEpoch;

  void task.catch((error) => {
    console.warn(`[WebBlackbox] ${source} activation refresh failed closed`, {
      tabId: details.tabId,
      frameId: details.frameId,
      documentId: details.documentId,
      error: error instanceof Error ? error.message : String(error)
    });

    if (
      owner &&
      revisionKey &&
      contentRevision !== undefined &&
      navigationRevision !== undefined &&
      cdpRestoreEpoch !== undefined
    ) {
      void failSameDocumentNavigationIfCurrent(details, {
        runtime: owner,
        revisionKey,
        contentRevision,
        navigationRevision,
        cdpRestoreEpoch
      });
    }
  });
}

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
    const activation = resolveBoundContentActivation(
      message.activationId,
      message.documentUrl,
      port,
      sender,
      ["active"]
    );

    if (!activation) {
      return;
    }

    ingestRawEvent({
      source: "content",
      rawType: "marker",
      tabId: activation.tabId,
      sid: activation.sid,
      t: Date.now(),
      mono: monotonicTime(),
      frame: normalizeContentFrameId(activation.frameId),
      payload: {
        message: message.message
      }
    });

    return;
  }

  if (message.kind === "content.ready") {
    return prepareContentActivation(message, sender);
  }

  if (message.kind === "content.main-world-control") {
    return controlContentMainWorld(message, sender);
  }

  if (message.kind === "content.armed") {
    return armContentActivation(message, sender);
  }

  if (message.kind === "content.bind") {
    bindContentActivationPort(message, port, sender);
    return;
  }

  if (message.kind === "content.stop-drained") {
    await markStopDrainAckReceived(message, port, sender);
    return;
  }

  if (message.kind === "content.events") {
    const activeActivation = resolveBoundContentActivation(
      message.activationId,
      message.documentUrl,
      port,
      sender,
      ["active"]
    );
    const drainingActivation = activeActivation
      ? null
      : resolveBoundContentActivation(message.activationId, message.documentUrl, port, sender, [
          "draining"
        ]);
    const activation = activeActivation ?? drainingActivation;

    if (!activation || message.events.length === 0) {
      return;
    }

    const runtime = activation.runtime;
    if (activeActivation && runtime.stopRequestedAt !== undefined) {
      return;
    }

    const stopDrain = drainingActivation
      ? getStopDrainCapability(runtime.sid, activation.activationId)
      : undefined;

    if (
      drainingActivation &&
      (!stopDrain ||
        !canAdmitStopDrainBatch(stopDrain, {
          runtime,
          fence: runtime.captureFence,
          activationId: activation.activationId,
          token: message.stopDrainToken,
          sid: activation.sid,
          tabId: activation.tabId,
          frameId: activation.frameId,
          documentId: activation.documentId,
          documentUrl: message.documentUrl
        }))
    ) {
      if (stopDrain) {
        sendStopDrainNotice(port!, stopDrain);
      }
      return;
    }

    const isDeliveryOwnerCurrent = (): boolean => {
      const current = resolveBoundContentActivation(
        message.activationId,
        message.documentUrl,
        port,
        sender,
        activeActivation ? ["active"] : ["draining"]
      );
      if (
        !current ||
        current.runtime !== runtime ||
        current.fence !== activation.fence ||
        current.sid !== activation.sid ||
        current.tabId !== activation.tabId ||
        current.frameId !== activation.frameId ||
        current.documentId !== activation.documentId ||
        current.url !== activation.url ||
        current.mode !== activation.mode
      ) {
        return false;
      }
      if (activeActivation) {
        return runtime.stopRequestedAt === undefined;
      }
      return Boolean(
        stopDrain &&
        canAdmitStopDrainBatch(stopDrain, {
          runtime,
          fence: runtime.captureFence,
          activationId: activation.activationId,
          token: message.stopDrainToken,
          sid: activation.sid,
          tabId: activation.tabId,
          frameId: activation.frameId,
          documentId: activation.documentId,
          documentUrl: message.documentUrl
        })
      );
    };
    const fingerprint = await fingerprintContentEventBatch(message.events);
    if (!isDeliveryOwnerCurrent()) {
      return;
    }
    // Serialize behind any delivery output admitted by a predecessor activation. Its receipt
    // must become durable before a replacement activation decides which raw indexes to replay.
    const deliveryBatch = {
      tabId: activation.tabId,
      frameId: activation.frameId,
      documentId: activation.documentId,
      batchId: message.batchId,
      fingerprint,
      eventCount: message.events.length
    } as const;
    const deliveryQuery: PipelineDeliveryReceiptQuery = {
      tabId: deliveryBatch.tabId,
      frameId: deliveryBatch.frameId,
      documentId: deliveryBatch.documentId,
      batchId: deliveryBatch.batchId
    };
    const receiptRead = await readContentEventBatchReceiptAfterBarrier({
      flushPendingDelivery: () => flushContentEventBatchDurably(runtime),
      isOwnerCurrent: isDeliveryOwnerCurrent,
      readReceipt: () => runtime.pipeline.getDeliveryReceipt(deliveryQuery)
    });
    if (receiptRead.kind === "stale") {
      return;
    }
    const durableReceipt = receiptRead.receipt;
    const durableReceiptDecision = classifyContentEventBatchReceipt(durableReceipt, deliveryBatch);
    if (durableReceiptDecision.kind === "mismatch") {
      await revokeContentActivationSnapshots([activation], "content-delivery-mismatch");
      return;
    }
    if (durableReceiptDecision.kind === "complete") {
      if (
        stopDrain &&
        !commitStopDrainBatchClaims(stopDrain, message.batchId, runtime, runtime.captureFence)
      ) {
        logInboundMessageFailure(
          "content.events",
          new Error("Stop-drain claims remain incomplete for a durable content batch."),
          port,
          { activationId: activation.activationId, batchId: message.batchId }
        );
        return;
      }
      sendContentEventBatchAck(port!, activation.activationId, message.batchId);
      return;
    }

    const batchLookup = getOrCreateContentEventBatchRecord(
      activation.activationId,
      message.batchId,
      fingerprint,
      port!
    );
    const batchRecord = batchLookup.record;

    if (batchRecord.fingerprint !== fingerprint) {
      return;
    }

    if (batchRecord.status === "completed") {
      await revokeContentActivationSnapshots([activation], "content-delivery-inconsistent");
      return;
    }

    if (!batchLookup.process) {
      return;
    }

    for (const eventIndex of durableReceiptDecision.committedEventIndexes) {
      batchRecord.completedEventIndexes.add(eventIndex);
    }

    const batchAdmission: ContentEventBatchAdmission | null = activeActivation
      ? {
          kind: "content-event-batch",
          runtime,
          fence: runtime.captureFence,
          activationId: activation.activationId,
          batchId: message.batchId,
          sid: activation.sid,
          tabId: activation.tabId,
          documentUrl: message.documentUrl,
          frameId: activation.frameId,
          documentId: activation.documentId,
          mode: activation.mode,
          valid: true
        }
      : null;
    if (batchAdmission) {
      let admissions = contentEventBatchAdmissionsByActivation.get(activation.activationId);
      if (!admissions) {
        admissions = new Set();
        contentEventBatchAdmissionsByActivation.set(activation.activationId, admissions);
      }
      admissions.add(batchAdmission);
    }
    adjustInFlightContentMessages(activation.activationId, 1);
    let sliceStartedAt = perfNow();
    let completed = false;
    const commitNoOutput = async (eventIndex: number): Promise<void> => {
      if (!isDeliveryOwnerCurrent()) {
        throw new Error("Content delivery owner changed before no-output commit.");
      }
      await runtime.pipeline.commitDeliveryProgress([
        { ...deliveryBatch, eventIndex, outcome: "no-output" }
      ]);
      if (!isDeliveryOwnerCurrent()) {
        throw new Error("Content delivery owner changed after no-output commit.");
      }
    };

    try {
      const attempt = await processContentEventBatchAttempt({
        record: batchRecord,
        eventCount: message.events.length,
        processEvent: async (eventIndex) => {
          const rawEvent = message.events[eventIndex]!;
          if (rawEvent.sid !== activation.sid || rawEvent.tabId !== activation.tabId) {
            if (drainingActivation) {
              throw new Error("Stop-drain event identity does not match its activation.");
            }
            await commitNoOutput(eventIndex);
            return;
          }

          const stopDrainEventBinding = stopDrain
            ? {
                runtime,
                fence: runtime.captureFence,
                activationId: activation.activationId,
                token: message.stopDrainToken,
                sid: rawEvent.sid,
                tabId: activation.tabId,
                frameId: activation.frameId,
                documentId: activation.documentId,
                documentUrl: message.documentUrl,
                batchId: message.batchId,
                eventIndex,
                rawType: rawEvent.rawType,
                reason: asRecord(rawEvent.payload)?.reason,
                capturedAt: rawEvent.t
              }
            : null;
          const stopDrainClaim = activeActivation
            ? null
            : stopDrain && stopDrainEventBinding
              ? claimStopDrainEvent(stopDrain, stopDrainEventBinding)
              : null;

          if (drainingActivation && !stopDrainClaim) {
            if (
              stopDrain &&
              stopDrainEventBinding &&
              dropUnclaimableStopDrainOrdinaryEvent(stopDrain, stopDrainEventBinding)
            ) {
              await commitNoOutput(eventIndex);
              return;
            }
            throw new Error("Stop-drain event could not reserve its exact capability claim.");
          }

          if (activeActivation || stopDrainClaim) {
            try {
              const producedOutput = await ingestRawEvent(
                {
                  ...rawEvent,
                  frame: normalizeContentFrameId(activation.frameId)
                },
                stopDrainClaim,
                batchAdmission,
                { ...deliveryBatch, eventIndex }
              );
              if (!producedOutput) {
                if (
                  (batchAdmission && !isContentEventBatchAdmissionValid(batchAdmission, runtime)) ||
                  (stopDrainClaim &&
                    !isStopDrainClaimValid(stopDrainClaim, runtime, runtime.captureFence))
                ) {
                  throw new Error("Content event admission changed before materialization.");
                }
                await commitNoOutput(eventIndex);
              }
            } catch (error) {
              if (stopDrainClaim) {
                releaseStopDrainClaim(stopDrainClaim);
              }
              throw error;
            }
          }

          if (perfNow() - sliceStartedAt >= CONTENT_EVENT_SLICE_BUDGET_MS) {
            await wait(0);
            sliceStartedAt = perfNow();
          }
        },
        flush: () => flushContentEventBatchDurably(runtime)
      });

      if (attempt.completed) {
        const committedReceipt = await runtime.pipeline.getDeliveryReceipt(deliveryQuery);
        const committedReceiptDecision = classifyContentEventBatchReceipt(
          committedReceipt,
          deliveryBatch
        );
        if (!isDeliveryOwnerCurrent() || committedReceiptDecision.kind !== "complete") {
          throw new Error("Content event batch lacks a complete durable delivery receipt.");
        }
        if (
          stopDrain &&
          !commitStopDrainBatchClaims(stopDrain, message.batchId, runtime, runtime.captureFence)
        ) {
          throw new Error("Stop-drain batch claims could not be committed after durable flush.");
        }
      }
      completed = attempt.completed;
      for (const failure of attempt.failures) {
        logInboundMessageFailure("content.events", failure.error, port, {
          activationId: activation.activationId,
          batchId: message.batchId,
          ...(failure.eventIndex === undefined ? {} : { eventIndex: failure.eventIndex })
        });
      }
    } catch (error) {
      logInboundMessageFailure("content.events", error, port, {
        activationId: activation.activationId,
        batchId: message.batchId
      });
    } finally {
      if (batchAdmission) {
        batchAdmission.valid = false;
        const admissions = contentEventBatchAdmissionsByActivation.get(activation.activationId);
        admissions?.delete(batchAdmission);
        if (admissions?.size === 0) {
          contentEventBatchAdmissionsByActivation.delete(activation.activationId);
        }
      }
      if (completed) {
        completeContentEventBatch(activation.activationId, message.batchId, batchRecord);
      } else {
        retryContentEventBatch(activation.activationId, message.batchId, batchRecord);
      }
      adjustInFlightContentMessages(activation.activationId, -1);
    }

    return;
  }
}

async function prepareContentActivation(
  message: Extract<ExtensionInboundMessage, { kind: "content.ready" }>,
  sender: MessageSenderLike | undefined
): Promise<unknown> {
  const tabId = sender?.tab?.id;
  const runtime = typeof tabId === "number" ? sessionsByTab.get(tabId) : undefined;

  if (!runtime || !isRuntimeCurrentCaptureOpen(runtime)) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const frameId = normalizeSenderFrameId(sender);
  const documentId = sender?.documentId;

  if (frameId < 0 || typeof documentId !== "string" || documentId.length === 0) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  if (
    sender?.url !== message.documentUrl &&
    !(
      hasExactWebNavigationTracking() &&
      runtime.contentDocuments.matchesSameDocumentSender(
        {
          tabId: runtime.tabId,
          frameId,
          documentId,
          url: message.documentUrl
        },
        sender?.url
      )
    )
  ) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const policyRevisionKey = contentActivationParentKey(frameId, documentId);
  if (runtime.pendingContentPolicyRevisions.has(policyRevisionKey)) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  if (runtime.mode === "full" && message.mainWorldController !== null) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const parent = runtime.contentActivationParents.get(policyRevisionKey);
  if (frameId > 0 && (!parent || !isContentParentReady(runtime, parent))) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const currentActivation = message.currentActivationId
    ? contentActivations.lookupByActivationId(message.currentActivationId)
    : null;

  if (currentActivation && !matchesContentActivationStableSender(currentActivation, sender)) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const activeDocument = runtime.contentDocuments.get(frameId);
  const awaitingExactSameDocumentPolicy =
    hasExactWebNavigationTracking() &&
    activeDocument?.documentId === documentId &&
    activeDocument.url !== message.documentUrl;

  if (!(await authorizeContentSenderForReady(runtime, sender, message.documentUrl))) {
    if (awaitingExactSameDocumentPolicy) {
      return { kind: "sw.content-inactive", readyId: message.readyId };
    }
    await deactivateDeniedContentFrame(runtime, sender);
    rejectContentArmWaiters(runtime, sender, "Content document authorization was denied.");
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  if (!isRuntimeCurrentCaptureOpen(runtime)) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  if (runtime.pendingContentPolicyRevisions.has(policyRevisionKey)) {
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  if (runtime.mode === "lite") {
    const controller = await resolveMainWorldControllerForReady(
      runtime,
      { tabId: runtime.tabId, frameId, documentId },
      message.mainWorldController
    );
    if (!controller || !isRuntimeCurrentCaptureOpen(runtime)) {
      return { kind: "sw.content-inactive", readyId: message.readyId };
    }
    if (!rememberMainWorldController(runtime, policyRevisionKey, controller)) {
      return { kind: "sw.content-inactive", readyId: message.readyId };
    }
  }

  if (frameId > 0 && (!parent || !isContentParentReady(runtime, parent))) {
    runtime.contentDocuments.blockDocument(frameId, documentId);
    syncAuthorizedContentFrames(runtime);
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  const existingForDocument = contentActivations
    .listRuntime(runtime, runtime.captureFence)
    .find((candidate) => candidate.frameId === frameId && candidate.documentId === documentId);
  if (existingForDocument && existingForDocument.readyId !== message.readyId) {
    await revokeContentFrameActivations(runtime, frameId, "activation-replaced", documentId);
  }

  const activation = contentActivations.prepare({
    runtime,
    fence: runtime.captureFence,
    sid: runtime.sid,
    tabId: runtime.tabId,
    frameId,
    documentId,
    url: message.documentUrl,
    mode: runtime.mode,
    readyId: message.readyId,
    ...(parent ? { parent } : {})
  });

  if (!activation) {
    rejectContentArmWaiters(runtime, sender, "Content activation preparation failed closed.");
    return { kind: "sw.content-inactive", readyId: message.readyId };
  }

  return {
    kind: "sw.content-prepare",
    readyId: activation.readyId,
    activationId: activation.activationId,
    sid: activation.sid,
    tabId: activation.tabId,
    mode: activation.mode,
    sampling: toStatusSampling(runtime),
    capturePolicy: runtime.config.capturePolicy,
    mainWorldController:
      runtime.mode === "lite"
        ? (runtime.contentMainWorldProofs.get(policyRevisionKey) ?? null)
        : null
  };
}

async function resolveMainWorldControllerForReady(
  runtime: SessionRuntime,
  target: { tabId: number; frameId: number; documentId: string },
  isolatedHint: MainWorldControllerHint | null
): Promise<MainWorldControllerHint | null> {
  if (!isolatedHint) {
    return null;
  }
  const key = contentActivationParentKey(target.frameId, target.documentId);
  const installed = runtime.contentMainWorldProofs.get(key);
  if (installed && !sameMainWorldControllerCapability(installed, isolatedHint)) {
    return null;
  }
  if (
    installed &&
    installed.revision === isolatedHint.revision &&
    installed.phase === isolatedHint.phase &&
    installed.activationId === isolatedHint.activationId
  ) {
    return installed;
  }

  try {
    const bootstrap = await bootstrapMainWorldDirectController(chromeApi, target, isolatedHint);
    if (bootstrap.kind !== "installed" && bootstrap.kind !== "existing") {
      return null;
    }
    const probed = await controlMainWorldDirectController(chromeApi, target, isolatedHint, {
      kind: "probe"
    });
    const recovered = advanceControllerFromControl(isolatedHint, probed);
    return recovered && sameMainWorldControllerCapability(recovered, isolatedHint)
      ? recovered
      : null;
  } catch {
    return null;
  }
}

function rememberMainWorldController(
  runtime: SessionRuntime,
  key: string,
  candidate: MainWorldControllerHint
): boolean {
  const current = runtime.contentMainWorldProofs.get(key);
  if (!current) {
    runtime.contentMainWorldProofs.set(key, candidate);
    return true;
  }
  if (!sameMainWorldControllerCapability(current, candidate)) {
    return false;
  }
  if (candidate.revision < current.revision) {
    return true;
  }
  if (
    candidate.revision === current.revision &&
    (candidate.phase !== current.phase || candidate.activationId !== current.activationId)
  ) {
    return false;
  }
  runtime.contentMainWorldProofs.set(key, candidate);
  return true;
}

async function controlContentMainWorld(
  message: Extract<ExtensionInboundMessage, { kind: "content.main-world-control" }>,
  sender: MessageSenderLike | undefined
): Promise<unknown> {
  const activation = contentActivations.lookupByActivationId(message.activationId, [
    "prepared",
    "active",
    "draining"
  ]);
  const stopIntentOwnsActiveDrain =
    activation?.state === "active" &&
    message.operation === "drain" &&
    activation.runtime.stopRequestedAt !== undefined &&
    isMapEntrySame(sessionsByTab, activation.tabId, activation.runtime) &&
    isMapEntrySame(sessionsBySid, activation.sid, activation.runtime);
  if (
    !activation ||
    !matchesContentActivationSender(activation, sender, message.documentUrl) ||
    (message.operation === "activate" && activation.state !== "prepared") ||
    (message.operation === "drain" &&
      activation.state !== "active" &&
      activation.state !== "draining") ||
    (activation.state === "draining"
      ? getStopDrainCapability(activation.sid, activation.activationId) === undefined
      : !stopIntentOwnsActiveDrain && !isRuntimeCurrentCaptureOpen(activation.runtime))
  ) {
    return null;
  }

  const key = contentActivationParentKey(activation.frameId, activation.documentId);
  const controller = activation.runtime.contentMainWorldProofs.get(key);
  if (!controller) {
    return null;
  }
  const target = {
    tabId: activation.tabId,
    frameId: activation.frameId,
    documentId: activation.documentId
  };
  const outcome = await runMainWorldControlWithRecovery(target, controller, (revision) =>
    message.operation === "activate"
      ? {
          kind: "activate" as const,
          revision,
          config: {
            active: true,
            activationId: activation.activationId,
            bodyCaptureMaxBytes: resolveMainWorldBodyCaptureBudget(activation.runtime),
            capturePolicy: activation.runtime.config.capturePolicy ?? DEFAULT_CAPTURE_POLICY
          }
        }
      : {
          kind: message.operation,
          revision,
          activationId: activation.activationId
        }
  );
  if (!outcome) {
    return null;
  }
  const expectedKind =
    message.operation === "activate"
      ? "activated"
      : message.operation === "deactivate"
        ? "deactivated"
        : "drained";
  if (outcome.result.kind !== expectedKind) {
    return null;
  }
  if (!rememberMainWorldController(activation.runtime, key, outcome.controller)) {
    return null;
  }
  return {
    kind: "sw.main-world-control-result",
    activationId: activation.activationId,
    operation: message.operation,
    controller: outcome.controller,
    result: outcome.result
  };
}

async function runMainWorldControlWithRecovery(
  target: { tabId: number; frameId: number; documentId: string },
  initialController: MainWorldControllerHint,
  createCommand: (revision: number) =>
    | {
        kind: "activate";
        revision: number;
        config: {
          active: true;
          activationId: ContentActivationId;
          bodyCaptureMaxBytes: number;
          capturePolicy: CapturePolicy;
        };
      }
    | {
        kind: "deactivate" | "drain";
        revision: number;
        activationId: ContentActivationId;
      }
): Promise<{
  controller: MainWorldControllerHint;
  result: Exclude<
    Awaited<ReturnType<typeof controlMainWorldDirectController>>,
    { kind: "rejected" | "unavailable" | "probed" }
  >;
} | null> {
  let controller = initialController;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (controller.revision >= Number.MAX_SAFE_INTEGER) {
      return null;
    }
    try {
      const result = await controlMainWorldDirectController(
        chromeApi,
        target,
        controller,
        createCommand(controller.revision + 1)
      );
      const advanced = advanceControllerFromControl(controller, result);
      if (
        advanced &&
        result.kind !== "rejected" &&
        result.kind !== "unavailable" &&
        result.kind !== "probed"
      ) {
        return { controller: advanced, result };
      }
      if (result.kind !== "rejected" || result.reason !== "stale") {
        return null;
      }
    } catch {
      // The command may have committed before executeScript lost its result.
    }

    try {
      const probe = await controlMainWorldDirectController(chromeApi, target, controller, {
        kind: "probe"
      });
      const recovered = advanceControllerFromControl(controller, probe);
      if (!recovered) {
        return null;
      }
      controller = recovered;
      const intended = createCommand(
        recovered.revision < Number.MAX_SAFE_INTEGER ? recovered.revision + 1 : recovered.revision
      );
      if (
        intended.kind === "deactivate" &&
        recovered.phase === "inactive" &&
        recovered.activationId === null
      ) {
        return {
          controller: recovered,
          result: {
            kind: "deactivated",
            activationId: intended.activationId,
            revision: recovered.revision
          }
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function resolveMainWorldBodyCaptureBudget(runtime: SessionRuntime): number {
  const value = toStatusSampling(runtime)?.bodyCaptureMaxBytes;
  return runtime.mode === "lite" &&
    (runtime.config.capturePolicy ?? DEFAULT_CAPTURE_POLICY).categories.network ===
      "body-allowlist" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? Math.max(4 * 1024, Math.min(8 * 1024 * 1024, Math.round(value)))
    : 0;
}

function isContentParentReady(
  runtime: SessionRuntime,
  parent: { frameId: number; documentId: string }
): boolean {
  return contentActivations
    .listRuntime(runtime, runtime.captureFence)
    .some(
      (candidate) =>
        candidate.frameId === parent.frameId &&
        candidate.documentId === parent.documentId &&
        (isRuntimeCaptureAdmitted(runtime.activationState)
          ? candidate.state === "active"
          : candidate.state === "prepared" && candidate.armed)
    );
}

function armContentActivation(
  message: Extract<ExtensionInboundMessage, { kind: "content.armed" }>,
  sender: MessageSenderLike | undefined
): unknown {
  const prepared = contentActivations.lookupByReadyId(message.readyId, ["prepared", "active"]);

  if (
    !prepared ||
    prepared.activationId !== message.activationId ||
    !isRuntimeCurrentCaptureOpen(prepared.runtime) ||
    !matchesContentActivationSender(prepared, sender, message.documentUrl)
  ) {
    return { kind: "sw.content-revoked", activationId: message.activationId, reason: "stale" };
  }

  if (prepared.state === "active") {
    return { kind: "sw.content-activated", activationId: prepared.activationId };
  }

  const armed = contentActivations.arm(prepared);

  if (!armed) {
    return { kind: "sw.content-revoked", activationId: message.activationId, reason: "invalid" };
  }

  resolveContentArmWaiters(armed);

  if (!isRuntimeCaptureAdmitted(armed.runtime.activationState)) {
    return { ok: true };
  }

  const active = contentActivations.activate(armed);
  return active
    ? { kind: "sw.content-activated", activationId: active.activationId }
    : { kind: "sw.content-revoked", activationId: message.activationId, reason: "activation" };
}

function bindContentActivationPort(
  message: Extract<ExtensionInboundMessage, { kind: "content.bind" }>,
  port: PortLike | undefined,
  sender: MessageSenderLike | undefined
): void {
  const activation = contentActivations.lookupByActivationId(message.activationId, [
    "active",
    "draining"
  ]);
  const activationOwnerCurrent = activation
    ? activation.state === "active"
      ? isRuntimeActiveContentOwner(activation.runtime)
      : getStopDrainCapability(activation.sid, activation.activationId) !== undefined
    : false;

  if (
    !port ||
    port.name !== PORT_NAMES.content ||
    !activation ||
    !activationOwnerCurrent ||
    !matchesContentActivationStableSender(activation, sender) ||
    !contentActivations.bindPort(port, activation)
  ) {
    port?.disconnect?.();
    return;
  }

  try {
    if (message.documentUrl !== activation.url) {
      port.postMessage({
        kind: "sw.content-url",
        activationId: activation.activationId,
        documentUrl: activation.url,
        revision:
          activation.runtime.contentNavigationRevisions.get(
            contentActivationParentKey(activation.frameId, activation.documentId)
          ) ?? 0
      });
    }
    port.postMessage({ kind: "sw.content-bound", activationId: activation.activationId });
    if (activation.state === "draining") {
      const capability = getStopDrainCapability(activation.sid, activation.activationId);
      if (capability) {
        sendStopDrainNotice(port, capability);
      }
    }
  } catch (error) {
    contentActivations.unbindPort(port, activation);
    logPortSendFailure("sw.content-bound", error, {
      sid: activation.sid,
      tabId: activation.tabId,
      frameId: activation.frameId
    });
  }
}

function resolveBoundContentActivation(
  activationId: ContentActivationId,
  documentUrl: string,
  port: PortLike | undefined,
  sender: MessageSenderLike | undefined,
  allowedStates: readonly ContentActivationState[]
): SessionContentActivation | null {
  if (!port || port.name !== PORT_NAMES.content) {
    return null;
  }

  const activation = contentActivations.lookupByActivationId(activationId, allowedStates);

  if (!activation || !matchesContentActivationStableSender(activation, sender)) {
    return null;
  }

  if (
    !matchesContentActivationStableSender(activation, sender) ||
    activation.url !== documentUrl ||
    (activation.state === "active"
      ? !isRuntimeActiveContentOwner(activation.runtime)
      : getStopDrainCapability(activation.sid, activation.activationId) === undefined)
  ) {
    return null;
  }

  return contentActivations.validatePort(port, activation, allowedStates);
}

function matchesContentActivationStableSender(
  activation: SessionContentActivation,
  sender: MessageSenderLike | undefined
): boolean {
  return (
    sender?.tab?.id === activation.tabId &&
    normalizeSenderFrameId(sender) === activation.frameId &&
    sender?.documentId === activation.documentId &&
    activation.runtime.captureFence === activation.fence &&
    activation.runtime.sid === activation.sid &&
    activation.runtime.mode === activation.mode
  );
}

function matchesContentActivationSender(
  activation: SessionContentActivation,
  sender: MessageSenderLike | undefined,
  documentUrl: string
): boolean {
  return (
    matchesContentActivationStableSender(activation, sender) &&
    activation.url === documentUrl &&
    (sender?.url === documentUrl ||
      (hasExactWebNavigationTracking() &&
        activation.runtime.contentDocuments.matchesSameDocumentSender(
          {
            tabId: activation.tabId,
            frameId: activation.frameId,
            documentId: activation.documentId,
            url: documentUrl
          },
          sender?.url
        )))
  );
}

function isRuntimeActiveContentOwner(runtime: SessionRuntime): boolean {
  return (
    isRuntimeCurrentCaptureOpen(runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime) &&
    isRuntimeCaptureAdmitted(runtime.activationState)
  );
}

function requireArmedRootContentActivation(runtime: SessionRuntime): SessionContentActivation {
  const activeDocument = runtime.contentDocuments.get(0);
  const roots = contentActivations
    .listRuntime(runtime, runtime.captureFence, ["prepared"])
    .filter(
      (activation) =>
        activation.frameId === 0 &&
        activation.armed &&
        activeDocument?.documentId === activation.documentId &&
        activeDocument.url === activation.url
    );

  if (roots.length !== 1) {
    throw new Error("The runtime has no unique armed root content activation.");
  }

  return roots[0]!;
}

function activateArmedRuntimeContent(
  runtime: SessionRuntime,
  requiredRootActivationId?: ContentActivationId
): SessionContentActivation[] {
  const prepared = contentActivations
    .listRuntime(runtime, runtime.captureFence, ["prepared"])
    .filter((activation) => activation.armed);
  const preparedByDocument = new Map(
    prepared.map((activation) => [
      contentActivationParentKey(activation.frameId, activation.documentId),
      activation
    ])
  );
  const resolveDepth = (activation: SessionContentActivation): number => {
    let depth = 0;
    let parent = activation.parent;
    const visited = new Set<string>();

    while (parent) {
      const key = contentActivationParentKey(parent.frameId, parent.documentId);
      if (visited.has(key)) {
        return Number.MAX_SAFE_INTEGER;
      }
      visited.add(key);
      depth += 1;
      parent = preparedByDocument.get(key)?.parent;
    }

    return depth;
  };
  prepared.sort((left, right) => resolveDepth(left) - resolveDepth(right));
  const activated: SessionContentActivation[] = [];

  for (const activation of prepared) {
    const active = contentActivations.activate(activation);

    if (active) {
      activated.push(active);
    }
  }

  if (
    requiredRootActivationId &&
    !activated.some(
      (activation) =>
        activation.frameId === 0 && activation.activationId === requiredRootActivationId
    )
  ) {
    throw new Error("The armed root content activation changed at runtime commit.");
  }

  for (const activation of activated) {
    void sendContentActivationMessage(activation, {
      kind: "sw.content-activated",
      activationId: activation.activationId
    });
  }

  return activated;
}

function contentActivationParentKey(frameId: number, documentId: string): string {
  return JSON.stringify([frameId, documentId]);
}

function revokeContentFrameActivations(
  runtime: SessionRuntime,
  frameId: number,
  reason: string,
  documentId?: string
): Promise<void> {
  const live = contentActivations.listRuntime(runtime, runtime.captureFence);
  const revoked =
    frameId === 0 && documentId === undefined
      ? live
      : collectContentActivationSubtree(
          live,
          live.filter(
            (activation) =>
              activation.frameId === frameId &&
              (documentId === undefined || activation.documentId === documentId)
          )
        );

  return revokeContentActivationSnapshots(revoked, reason);
}

function revokeRuntimeContent(runtime: SessionRuntime, reason: string): void {
  cancelContentArmWaiters(runtime, `Content activation revoked: ${reason}.`);
  void revokeContentActivationSnapshots(
    contentActivations.listRuntime(runtime, runtime.captureFence),
    reason
  );
}

async function revokeContentActivationSnapshots(
  snapshots: readonly SessionContentActivation[],
  reason: string
): Promise<void> {
  const unique = new Map<ContentActivationId, SessionContentActivation>();
  for (const root of snapshots) {
    const live = contentActivations.listRuntime(root.runtime, root.fence);
    for (const activation of collectContentActivationSubtree(live, [root])) {
      unique.set(activation.activationId, activation);
    }
  }
  const byDocument = new Map(
    [...unique.values()].map((activation) => [
      contentActivationParentKey(activation.frameId, activation.documentId),
      activation
    ])
  );
  const depth = (activation: SessionContentActivation): number => {
    let parent = activation.parent;
    let value = 0;
    const visited = new Set<string>();
    while (parent) {
      const key = contentActivationParentKey(parent.frameId, parent.documentId);
      if (visited.has(key)) {
        return Number.MAX_SAFE_INTEGER;
      }
      visited.add(key);
      value += 1;
      parent = byDocument.get(key)?.parent;
    }
    return value;
  };
  const ordered = [...unique.values()].sort((left, right) => depth(right) - depth(left));
  // Start every revocation synchronously before the first await. Callers such as runtime reset
  // clear the shared proof map immediately after this function yields; eager start guarantees
  // that each exact frame has already retained its controller authorization by then.
  const tasks = ordered.map((activation) => revokeContentActivationOnce(activation, reason));
  for (const task of tasks) {
    await task;
  }
}

function revokeContentActivationOnce(
  activation: SessionContentActivation,
  reason: string
): Promise<void> {
  const existing = pendingContentRevocations.get(activation.activationId);
  if (existing) {
    return existing;
  }

  const revoking = contentActivations.beginRevocation(activation);
  if (!revoking) {
    return Promise.resolve();
  }
  invalidateContentEventBatchAdmissions(revoking.activationId);
  const controllerKey = contentActivationParentKey(revoking.frameId, revoking.documentId);
  const controller = revoking.runtime.contentMainWorldProofs.get(controllerKey);
  if (
    controller?.phase === "active" &&
    controller.activationId === revoking.activationId &&
    !contentRevocationControllers.has(revoking.activationId)
  ) {
    contentRevocationControllers.set(revoking.activationId, {
      key: controllerKey,
      controller
    });
  }

  const task = (async () => {
    const outcome = await deactivateRevokingMainWorldController(revoking);
    const documentReachable =
      outcome.kind === "deactivated" ? false : await isExactContentDocumentReachable(revoking);
    if (!canFinalizeMainWorldRevocation(outcome, documentReachable)) {
      console.warn("[WebBlackbox] MAIN-world revocation did not confirm deactivation", {
        sid: revoking.sid,
        tabId: revoking.tabId,
        frameId: revoking.frameId,
        activationId: revoking.activationId,
        reason,
        outcome: outcome.kind,
        ...(outcome.kind === "failed"
          ? {
              error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }
          : {})
      });
      scheduleContentRevocationRetry(revoking, reason);
      return;
    }

    if (!contentActivations.finalizeRevocation(revoking)) {
      if (contentActivations.lookupByActivationId(revoking.activationId, ["revoking"])) {
        scheduleContentRevocationRetry(revoking, reason);
      }
      return;
    }
    contentRevocationControllers.delete(revoking.activationId);
    const retryTimer = contentRevocationRetryTimers.get(revoking.activationId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      contentRevocationRetryTimers.delete(revoking.activationId);
    }
    await sendContentActivationMessage(revoking, {
      kind: "sw.content-revoked",
      activationId: revoking.activationId,
      reason
    });
  })().finally(() => {
    if (pendingContentRevocations.get(revoking.activationId) === task) {
      pendingContentRevocations.delete(revoking.activationId);
    }
  });
  pendingContentRevocations.set(revoking.activationId, task);
  return task;
}

async function deactivateRevokingMainWorldController(
  activation: SessionContentActivation
): Promise<Awaited<ReturnType<typeof runBoundedMainWorldDeactivation>>> {
  const authorization = contentRevocationControllers.get(activation.activationId);
  const controller = authorization?.controller;
  if (
    activation.mode !== "lite" ||
    !authorization ||
    !controller ||
    controller.phase !== "active" ||
    controller.activationId !== activation.activationId
  ) {
    return { kind: "deactivated" };
  }

  const target = {
    tabId: activation.tabId,
    frameId: activation.frameId,
    documentId: activation.documentId
  };
  return runBoundedMainWorldDeactivation({
    timeoutMs: MAIN_WORLD_REVOCATION_TIMEOUT_MS,
    deactivate: async () => {
      const outcome = await runMainWorldControlWithRecovery(target, controller, (revision) => ({
        kind: "deactivate",
        revision,
        activationId: activation.activationId
      }));
      if (!outcome || outcome.result.kind !== "deactivated") {
        throw new Error("Exact MAIN-world controller did not confirm revocation deactivation.");
      }

      const stillRevoking = contentActivations.lookupByActivationId(activation.activationId, [
        "revoking"
      ]);
      if (
        stillRevoking &&
        !rememberMainWorldController(activation.runtime, authorization.key, outcome.controller)
      ) {
        throw new Error("MAIN-world revocation controller conflicted with its exact proof.");
      }
      authorization.controller = outcome.controller;
    }
  });
}

async function isExactContentDocumentReachable(
  activation: SessionContentActivation
): Promise<boolean> {
  const sendMessage = chromeApi?.tabs?.sendMessage;
  if (!sendMessage) {
    return true;
  }

  try {
    await sendMessage.call(
      chromeApi.tabs,
      activation.tabId,
      { kind: "sw.content-document-probe" },
      { frameId: activation.frameId, documentId: activation.documentId }
    );
    return true;
  } catch {
    return false;
  }
}

function scheduleContentRevocationRetry(
  activation: SessionContentActivation,
  reason: string
): void {
  if (contentRevocationRetryTimers.has(activation.activationId)) {
    return;
  }

  const timer = setTimeout(() => {
    contentRevocationRetryTimers.delete(activation.activationId);
    const revoking = contentActivations.lookupByActivationId(activation.activationId, ["revoking"]);
    if (revoking) {
      void revokeContentActivationOnce(revoking, reason);
    }
  }, MAIN_WORLD_REVOCATION_RETRY_MS);
  contentRevocationRetryTimers.set(activation.activationId, timer);
}

function collectContentActivationSubtree(
  live: readonly SessionContentActivation[],
  roots: readonly SessionContentActivation[]
): SessionContentActivation[] {
  const selected = new Set<SessionContentActivation>(roots);
  const pending = roots.map((root) => ({ frameId: root.frameId, documentId: root.documentId }));

  while (pending.length > 0) {
    const parent = pending.shift();

    if (!parent) {
      break;
    }

    for (const activation of live) {
      if (
        !selected.has(activation) &&
        activation.parent?.frameId === parent.frameId &&
        activation.parent.documentId === parent.documentId
      ) {
        selected.add(activation);
        pending.push({ frameId: activation.frameId, documentId: activation.documentId });
      }
    }
  }

  return [...selected];
}

async function sendContentActivationMessage(
  activation: SessionContentActivation,
  message: ExtensionOutboundMessage,
  options: { required?: boolean } = {}
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    if (options.required) {
      throw new Error("Chrome tabs messaging is unavailable for exact content delivery.");
    }
    return;
  }

  try {
    await chromeApi.tabs.sendMessage(activation.tabId, message, {
      frameId: activation.frameId,
      documentId: activation.documentId
    });
  } catch (error) {
    if (options.required) {
      throw error;
    }
  }
}

function waitForContentArm(
  runtime: SessionRuntime,
  input: {
    frameId: number;
    documentId?: string;
    excludedDocumentId?: string;
    awaitCommittedDocument?: boolean;
  }
): {
  promise: Promise<SessionContentActivation>;
  cancel: (reason?: Error) => void;
} {
  let waiter:
    | (typeof pendingContentArmWaiters extends Set<infer Value> ? Value : never)
    | undefined;
  let settled = false;
  const promise = new Promise<SessionContentActivation>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!waiter || settled) {
        return;
      }

      settled = true;
      pendingContentArmWaiters.delete(waiter);
      reject(new Error("Timed out waiting for exact content activation acknowledgement."));
    }, CONTENT_ARM_TIMEOUT_MS);

    waiter = {
      runtime,
      fence: runtime.captureFence,
      frameId: input.frameId,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.excludedDocumentId ? { excludedDocumentId: input.excludedDocumentId } : {}),
      ...(input.awaitCommittedDocument ? { awaitingCommittedDocument: true } : {}),
      resolve: (activation) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        pendingContentArmWaiters.delete(waiter!);
        resolve(activation);
      },
      reject: (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        pendingContentArmWaiters.delete(waiter!);
        reject(error);
      },
      timeout
    };
    pendingContentArmWaiters.add(waiter);
  });

  return {
    promise,
    cancel: (reason = new Error("Content activation wait was cancelled.")) => waiter?.reject(reason)
  };
}

function resolveContentArmWaiters(activation: SessionContentActivation): void {
  for (const waiter of [...pendingContentArmWaiters]) {
    if (
      waiter.runtime === activation.runtime &&
      waiter.fence === activation.fence &&
      waiter.frameId === activation.frameId &&
      waiter.awaitingCommittedDocument !== true &&
      (waiter.documentId === undefined || waiter.documentId === activation.documentId) &&
      (waiter.excludedDocumentId === undefined ||
        waiter.excludedDocumentId !== activation.documentId)
    ) {
      waiter.resolve(activation);
    }
  }
}

function bindCommittedDocumentToContentArmWaiters(
  runtime: SessionRuntime,
  frameId: number,
  documentId: string
): void {
  for (const waiter of pendingContentArmWaiters) {
    if (
      waiter.runtime === runtime &&
      waiter.fence === runtime.captureFence &&
      waiter.frameId === frameId &&
      waiter.awaitingCommittedDocument === true
    ) {
      waiter.documentId = documentId;
      waiter.awaitingCommittedDocument = false;
    }
  }
}

function rejectContentArmWaiters(
  runtime: SessionRuntime,
  sender: MessageSenderLike | undefined,
  reason: string
): void {
  const frameId = normalizeSenderFrameId(sender);
  const documentId = sender?.documentId;

  for (const waiter of [...pendingContentArmWaiters]) {
    if (
      waiter.runtime === runtime &&
      waiter.fence === runtime.captureFence &&
      waiter.frameId === frameId &&
      waiter.awaitingCommittedDocument !== true &&
      (waiter.documentId === undefined || waiter.documentId === documentId)
    ) {
      waiter.reject(new Error(reason));
    }
  }
}

function cancelContentArmWaiters(runtime: SessionRuntime, reason: string): void {
  for (const waiter of [...pendingContentArmWaiters]) {
    if (waiter.runtime === runtime) {
      waiter.reject(new Error(reason));
    }
  }
}

async function requestFreshContentActivation(
  runtime: SessionRuntime,
  input: {
    frameId: number;
    documentId?: string;
    excludedDocumentId?: string;
    assertCurrent?: () => void;
    sendRequest?: boolean;
    sameDocumentTransition?: ContentSameDocumentTransition;
  }
): Promise<SessionContentActivation> {
  input.assertCurrent?.();
  const waiter = waitForContentArm(runtime, input);

  try {
    if (input.sendRequest !== false) {
      if (!chromeApi?.tabs?.sendMessage) {
        throw new Error("Chrome tabs messaging is unavailable for content activation.");
      }

      const target = {
        frameId: input.frameId,
        ...(input.documentId ? { documentId: input.documentId } : {})
      };
      const acknowledgement = await chromeApi.tabs.sendMessage(
        runtime.tabId,
        {
          kind: "sw.request-content-ready",
          ...(input.sameDocumentTransition
            ? { sameDocumentTransition: input.sameDocumentTransition }
            : {})
        },
        target
      );

      if (
        typeof acknowledgement !== "object" ||
        acknowledgement === null ||
        Array.isArray(acknowledgement) ||
        (acknowledgement as { kind?: unknown }).kind !== "content.ready-requested"
      ) {
        throw new Error("Exact content document did not acknowledge activation request.");
      }
    }

    const activation = await waiter.promise;
    input.assertCurrent?.();
    return activation;
  } catch (error) {
    waiter.cancel(error instanceof Error ? error : new Error(String(error)));
    await waiter.promise.catch(() => undefined);
    throw error;
  }
}

async function deleteSessionBySid(sid: string): Promise<void> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    await deleteSessionAnnotationDurably(sid);
    return;
  }

  if (!runtime.stoppedAt) {
    await stopRuntimeIfCurrent(runtime);

    if (!runtime.stoppedAt) {
      return;
    }
  }

  await disposeStoppedSession(runtime);
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

  if (mode === "lite" && options.reloadPage === true && !hasExactWebNavigationTracking()) {
    throw new Error("Reload-before-recording requires exact webNavigation document tracking.");
  }

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
  assertRuntimeCheckpointCapacityFor(sid);

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
        activationState: "starting",
        startToken
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

      if (
        shouldInjectIsolatedContentForMode(mode) &&
        !(mode === "lite" && options.reloadPage === true)
      ) {
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
        await reloadRecordingTabAndWaitForContentActivation(candidate, startToken);
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

function assertRuntimeCheckpointCapacityFor(sid: string): void {
  const identities = new Set([
    ...sessionsBySid.keys(),
    ...retainedStoppingRuntimesBySid.keys(),
    ...pendingRuntimeRestorationsBySid.keys(),
    ...runtimeRestorationSourceRowsBySid.keys()
  ]);
  if (identities.has(sid)) {
    throw new Error("The new session identity already exists in the runtime checkpoint.");
  }
  if (identities.size >= MAX_PERSISTED_RUNTIME_SESSIONS) {
    throw new Error(
      `Retained session capacity is full (${MAX_PERSISTED_RUNTIME_SESSIONS}); delete an older stopped session before starting another recording.`
    );
  }
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
  const armedRoot = requireArmedRootContentActivation(runtime);

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

  let armedRootStillCurrent = false;

  try {
    armedRootStillCurrent =
      requireArmedRootContentActivation(runtime).activationId === armedRoot.activationId;
  } catch {
    armedRootStillCurrent = false;
  }

  if (
    !startToken.isActive() ||
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
    !isMapEntrySame(sessionsBySid, runtime.sid, runtime) ||
    !armedRootStillCurrent
  ) {
    retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    throw new RuntimeStartCancelledError();
  }

  try {
    activateArmedRuntimeContent(runtime, armedRoot.activationId);
  } catch (error) {
    retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    throw error;
  }

  // The required storage write and the synchronous activation transition above
  // are the only active-state commit point. Nothing below may reject it.
  runtime.activationState = "active";
  runtime.startToken = null;

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
  startToken?: RuntimeStartToken;
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
        enqueuePipelineEvent(runtime, event, runtime.activePipelineDelivery ?? undefined);
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
    cdpScope: createCdpCaptureScopeState(input.config.capturePolicy, input.tabId, input.captureUrl),
    contentDocuments,
    contentActivationParents: new Map(),
    contentMainWorldProofs: new Map(),
    contentNavigationRevisions: new Map(),
    sameDocumentTransitions: new SameDocumentTransitionLedger(),
    pendingContentPolicyRevisions: new Map(),
    pendingLiteNetworkPolicyRevisions: new Map(),
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
          chunkWrites: new ScreenRecordingChunkWriteLedger(),
          stopPromise: null,
          finalization: new ScreenRecordingFinalizationGate(),
          finalizing: false,
          durabilityEvidenceQueued: false,
          terminalEvidenceQueued: false
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
    activePipelineDelivery: null,
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    captureFence: createVolatileCaptureFence(input.stoppedAt !== undefined),
    cdpPayloadAdmissionBlocked: false,
    cdpRestoreCheckpoint: null,
    cdpRestoreEpoch: 0,
    cdpRestoreTail: Promise.resolve(),
    cdpRestoreTailEpoch: 0,
    exactTopNavigationObservations: createExactTopNavigationObservationState(),
    exactWebNavigationTransactions: new Map(),
    activationState: input.activationState ?? "active",
    startToken: input.startToken ?? null,
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

async function reloadRecordingTabAndWaitForContentActivation(
  runtime: SessionRuntime,
  startToken: RuntimeStartToken
): Promise<SessionContentActivation> {
  const waiter = waitForContentArm(runtime, {
    frameId: 0,
    awaitCommittedDocument: true
  });

  try {
    startToken.assertActive();
    await reloadRecordingTab(runtime.tabId);
    startToken.assertActive();
    const activation = await waiter.promise;
    startToken.assertActive();
    return activation;
  } catch (error) {
    waiter.cancel(error instanceof Error ? error : new Error(String(error)));
    await waiter.promise.catch(() => undefined);
    throw error;
  }
}

async function restoreExactLiteTabMetadataAfterNavigation(runtime: SessionRuntime): Promise<void> {
  if (!isRuntimeCurrentCaptureOpen(runtime) || !usesExactLiteTopDocumentAuthorization(runtime)) {
    return;
  }

  const tabMetadata = await resolveTabSessionMetadata(runtime.tabId);
  const exactRoot = runtime.contentDocuments.get(0);

  if (
    !isRuntimeCurrentCaptureOpen(runtime) ||
    exactRoot?.url !== tabMetadata.captureUrl ||
    runtime.captureUrl !== exactRoot.url
  ) {
    return;
  }

  runtime.url = tabMetadata.url;
  runtime.title = tabMetadata.title;
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
        launchCdpNavigationRestore(claim);
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

async function handleSameDocumentNavigation(
  details: {
    tabId: number;
    frameId: number;
    documentId?: string;
    url: string;
  },
  isNavigationCurrent: () => boolean = () => true
): Promise<void> {
  const runtime = sessionsByTab.get(details.tabId);
  const documentId = details.documentId;
  const currentDocument =
    runtime && typeof documentId === "string" && documentId.length > 0
      ? runtime.contentDocuments.getKnownDocument(details.frameId, documentId)
      : null;
  const activeDocument = runtime?.contentDocuments.get(details.frameId);

  if (
    !runtime ||
    !isRuntimeCurrentCaptureOpen(runtime) ||
    !isNavigationCurrent() ||
    typeof documentId !== "string" ||
    documentId.length === 0 ||
    currentDocument?.documentId !== documentId
  ) {
    return;
  }

  if (
    details.frameId === 0 &&
    usesExactLiteTopDocumentAuthorization(runtime) &&
    !claimCurrentRuntimeNavigation(runtime, "content-navigation", details.url)
  ) {
    return;
  }

  const revisionKey = contentActivationParentKey(details.frameId, documentId);
  const revision = (runtime.contentNavigationRevisions.get(revisionKey) ?? 0) + 1;
  runtime.contentNavigationRevisions.set(revisionKey, revision);
  runtime.pendingContentPolicyRevisions.set(revisionKey, revision);
  runtime.pendingLiteNetworkPolicyRevisions.set(revisionKey, revision);
  const documentsToReactivate =
    activeDocument?.documentId === documentId
      ? collectAuthorizedContentDocumentSubtree(runtime, activeDocument)
      : [];
  const previousRootActivation = contentActivations.currentForDocument(
    {
      runtime,
      fence: runtime.captureFence,
      sid: runtime.sid,
      tabId: runtime.tabId,
      frameId: details.frameId,
      documentId,
      url: currentDocument.url,
      mode: runtime.mode
    },
    ["active"]
  );
  const sameDocumentTransition = runtime.sameDocumentTransitions.begin({
    frameId: details.frameId,
    documentId,
    currentDocumentUrl: currentDocument.url,
    nextDocumentUrl: details.url,
    revision,
    ...(previousRootActivation ? { activeActivationId: previousRootActivation.activationId } : {})
  });

  // Close old identities before the first async policy operation. A delayed or
  // lost renderer control message cannot keep them useful because registry
  // admission is revoked synchronously in the service worker.
  await revokeContentFrameActivations(
    runtime,
    details.frameId,
    "same-document-policy-pending",
    documentId
  );

  const policyDecision =
    details.frameId === 0
      ? await resolveCurrentTabUrlPolicyDecision({
          candidateUrl: details.url,
          evaluateAllowed: () => isRuntimeTopDocumentAllowed(runtime, details.url),
          resolveCurrentUrl: () => resolveCurrentTabCaptureUrl(runtime.tabId)
        })
      : evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
            url: details.url,
            tabId: runtime.tabId,
            frameId: details.frameId
          }).allowed
        ? "allowed"
        : "denied";

  if (
    !isNavigationCurrent() ||
    !isRuntimeCurrentCaptureOpen(runtime) ||
    runtime.contentNavigationRevisions.get(revisionKey) !== revision ||
    runtime.pendingContentPolicyRevisions.get(revisionKey) !== revision ||
    runtime.contentDocuments.getKnownDocument(details.frameId, documentId)?.documentId !==
      documentId
  ) {
    runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
    return;
  }

  if (policyDecision === "stale") {
    runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
    runtime.pendingContentPolicyRevisions.delete(revisionKey);
    runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
    return;
  }

  if (policyDecision === "denied") {
    runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
    runtime.pendingContentPolicyRevisions.delete(revisionKey);
    runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
    if (details.frameId === 0) {
      await stopRuntimeIfCurrent(runtime);
    } else {
      blockKnownContentSubtree(runtime, currentDocument, "same-document-scope-denied");
    }
    return;
  }

  const authorized = runtime.contentDocuments.refreshKnownDocumentUrl({
    tabId: runtime.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    url: details.url
  });

  if (!authorized) {
    runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
    runtime.pendingContentPolicyRevisions.delete(revisionKey);
    runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
    await failSameDocumentReactivation(runtime, currentDocument);
    return;
  }

  if (details.frameId === 0) {
    runtime.captureUrl = details.url;
    runtime.cdpScope.captureUrl = details.url;
    runtime.url = sanitizeUrlForPrivacy(details.url);
    pushSessionList();
    scheduleRuntimeStatePersist();
  }

  if (activeDocument?.documentId !== documentId) {
    runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
    runtime.pendingContentPolicyRevisions.delete(revisionKey);
    runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
    return;
  }

  runtime.pendingContentPolicyRevisions.delete(revisionKey);

  try {
    const reactivated = await reactivateSameDocumentSubtree(
      runtime,
      documentsToReactivate,
      revisionKey,
      revision,
      sameDocumentTransition,
      isNavigationCurrent
    );

    if (
      !reactivated &&
      isNavigationCurrent() &&
      runtime.contentNavigationRevisions.get(revisionKey) === revision
    ) {
      runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
      runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
      await failSameDocumentReactivation(runtime, currentDocument);
    } else if (reactivated) {
      runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
      runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
    }
  } catch (error) {
    if (isNavigationCurrent() && runtime.contentNavigationRevisions.get(revisionKey) === revision) {
      runtime.sameDocumentTransitions.complete(details.frameId, documentId, revision);
      runtime.pendingLiteNetworkPolicyRevisions.delete(revisionKey);
      await failSameDocumentReactivation(runtime, currentDocument);
      throw error;
    }
  }
}

function collectAuthorizedContentDocumentSubtree(
  runtime: SessionRuntime,
  root: { frameId: number; documentId: string; url: string }
): Array<{ frameId: number; documentId: string; url: string }> {
  const documents = runtime.contentDocuments.activeDocuments();
  const selected = new Map<string, { frameId: number; documentId: string; url: string }>([
    [contentActivationParentKey(root.frameId, root.documentId), root]
  ]);
  const pending = [{ frameId: root.frameId, documentId: root.documentId }];

  while (pending.length > 0) {
    const parent = pending.shift();

    if (!parent) {
      break;
    }

    for (const document of documents) {
      const key = contentActivationParentKey(document.frameId, document.documentId);
      const relationship = runtime.contentActivationParents.get(key);

      if (
        !selected.has(key) &&
        relationship?.frameId === parent.frameId &&
        relationship.documentId === parent.documentId
      ) {
        selected.set(key, document);
        pending.push(document);
      }
    }
  }

  return [...selected.values()];
}

function blockKnownContentSubtree(
  runtime: SessionRuntime,
  root: { frameId: number; documentId: string },
  reason: string
): void {
  const removed = runtime.contentDocuments.blockKnownDocumentSubtree(root, (document) =>
    runtime.contentActivationParents.get(
      contentActivationParentKey(document.frameId, document.documentId)
    )
  );

  for (const document of removed) {
    clearContentDocumentCompanionState(runtime, document, reason);
  }

  syncAuthorizedContentFrames(runtime);
}

function clearContentDocumentCompanionState(
  runtime: SessionRuntime,
  document: { frameId: number; documentId: string },
  reason: string
): void {
  void revokeContentFrameActivations(runtime, document.frameId, reason, document.documentId);
  const key = contentActivationParentKey(document.frameId, document.documentId);
  runtime.contentMainWorldProofs.delete(key);
  runtime.contentActivationParents.delete(key);
  clearContentNavigationRevisions(runtime, document.frameId);
}

async function reactivateSameDocumentSubtree(
  runtime: SessionRuntime,
  documents: readonly { frameId: number; documentId: string; url: string }[],
  revisionKey: string,
  revision: number,
  sameDocumentTransition?: ContentSameDocumentTransition,
  isNavigationCurrent: () => boolean = () => true
): Promise<boolean> {
  const pending = [...documents];
  const isCurrent = () =>
    isNavigationCurrent() &&
    isRuntimeCurrentCaptureOpen(runtime) &&
    runtime.contentNavigationRevisions.get(revisionKey) === revision;

  while (pending.length > 0) {
    if (!isCurrent()) {
      return false;
    }

    const live = contentActivations.listRuntime(runtime, runtime.captureFence);
    const ready = pending.filter((document) => {
      if (document.frameId === 0) {
        return true;
      }

      const parent = runtime.contentActivationParents.get(
        contentActivationParentKey(document.frameId, document.documentId)
      );
      return (
        parent !== undefined &&
        live.some(
          (activation) =>
            activation.frameId === parent.frameId &&
            activation.documentId === parent.documentId &&
            activation.state === "active"
        )
      );
    });

    if (ready.length === 0) {
      return false;
    }

    for (const document of ready) {
      pending.splice(pending.indexOf(document), 1);
    }

    await Promise.all(
      ready.map((document) =>
        requestFreshContentActivation(runtime, {
          frameId: document.frameId,
          documentId: document.documentId,
          ...(sameDocumentTransition &&
          document.frameId === sameDocumentTransition.frameId &&
          document.documentId === sameDocumentTransition.documentId
            ? { sameDocumentTransition }
            : {}),
          assertCurrent: () => {
            if (
              !isCurrent() ||
              runtime.contentDocuments.get(document.frameId)?.documentId !== document.documentId
            ) {
              throw new Error("Same-document activation rotation became stale.");
            }
          }
        })
      )
    );
  }

  return isCurrent();
}

async function failSameDocumentReactivation(
  runtime: SessionRuntime,
  root: { frameId: number; documentId: string }
): Promise<void> {
  if (root.frameId === 0) {
    await stopRuntimeIfCurrent(runtime);
    return;
  }

  blockKnownContentSubtree(runtime, root, "same-document-reactivation-failed");
}

async function failSameDocumentNavigationIfCurrent(
  details: { tabId: number; frameId: number; documentId?: string; url: string },
  claim: {
    runtime: SessionRuntime;
    revisionKey: string;
    contentRevision: number;
    navigationRevision: number;
    cdpRestoreEpoch: number;
  }
): Promise<void> {
  const runtime = claim.runtime;
  const documentId = details.documentId;

  if (
    sessionsByTab.get(details.tabId) !== runtime ||
    !isRuntimeCurrentCaptureOpen(runtime) ||
    runtime.navigationRevision !== claim.navigationRevision ||
    !isCdpRestoreEpochCurrent(runtime, claim.cdpRestoreEpoch) ||
    runtime.contentNavigationRevisions.get(claim.revisionKey) !== claim.contentRevision ||
    typeof documentId !== "string" ||
    runtime.contentDocuments.getKnownDocument(details.frameId, documentId)?.documentId !==
      documentId
  ) {
    return;
  }

  if (details.frameId === 0) {
    const currentUrl = await resolveCurrentTabCaptureUrl(details.tabId);

    if (
      currentUrl === details.url &&
      sessionsByTab.get(details.tabId) === runtime &&
      runtime.navigationRevision === claim.navigationRevision &&
      isCdpRestoreEpochCurrent(runtime, claim.cdpRestoreEpoch) &&
      runtime.contentNavigationRevisions.get(claim.revisionKey) === claim.contentRevision
    ) {
      await stopRuntimeIfCurrent(runtime);
    }
    return;
  }

  const known = runtime.contentDocuments.getKnownDocument(details.frameId, documentId);
  if (known) {
    blockKnownContentSubtree(runtime, known, "same-document-policy-failed");
  }
}

function clearContentNavigationRevisions(runtime: SessionRuntime, frameId: number): void {
  if (frameId === 0) {
    runtime.contentNavigationRevisions.clear();
    runtime.pendingContentPolicyRevisions.clear();
    runtime.pendingLiteNetworkPolicyRevisions.clear();
    runtime.sameDocumentTransitions.clear();
    return;
  }

  runtime.sameDocumentTransitions.clearFrame(frameId);

  for (const revisions of [
    runtime.contentNavigationRevisions,
    runtime.pendingContentPolicyRevisions,
    runtime.pendingLiteNetworkPolicyRevisions
  ]) {
    for (const key of revisions.keys()) {
      try {
        const parsed = JSON.parse(key) as unknown;
        if (Array.isArray(parsed) && parsed[0] === frameId) {
          revisions.delete(key);
        }
      } catch {
        revisions.delete(key);
      }
    }
  }
}

async function waitForLiveParentContentActivation(
  runtime: SessionRuntime,
  parent: { frameId: number; documentId: string }
): Promise<boolean> {
  const deadline = Date.now() + CONTENT_ARM_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    if (!isRuntimeCurrentCaptureOpen(runtime)) {
      return false;
    }

    if (isContentParentReady(runtime, parent)) {
      return true;
    }

    await wait(25);
  }

  return false;
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
  let exactTransaction: ExactWebNavigationCommitTransaction | null = null;
  let transactionFailed = false;

  try {
    const committedKind = classifyActiveCommittedDocument(details);
    const topContentDocument =
      committedKind === "top" &&
      runtime !== undefined &&
      (runtime.mode === "full"
        ? hasExactWebNavigationTracking()
        : usesExactLiteTopDocumentAuthorization(runtime));
    const parentDocument =
      committedKind === "child" &&
      runtime &&
      details.parentFrameId !== undefined &&
      typeof details.parentDocumentId === "string" &&
      details.parentDocumentId.length > 0
        ? runtime.contentDocuments.getKnownDocument(details.parentFrameId, details.parentDocumentId)
        : null;
    const includedChildDocument = Boolean(
      committedKind === "child" &&
      runtime?.config.capturePolicy?.scope.includeSubframes === true &&
      details.parentFrameId !== undefined &&
      parentDocument !== null &&
      parentDocument.documentId === details.parentDocumentId
    );

    if (
      !runtime ||
      (!topContentDocument && !includedChildDocument) ||
      !isVolatileCaptureOpen(runtime.captureFence) ||
      runtime.stopping ||
      runtime.stoppedAt
    ) {
      return;
    }

    const exactObservation =
      topContentDocument && runtime.mode === "full"
        ? observeExactWebNavigationCommit(runtime.exactTopNavigationObservations, details.url, () =>
            advanceCdpRestoreEpoch(runtime)
          )
        : null;
    if (exactObservation) {
      evictExactWebNavigationTransactions(runtime, exactObservation.evictedWebTokens);
    }

    const topCommitClaim = topContentDocument
      ? claimCurrentRuntimeNavigation(runtime, "web-navigation-commit", details.url)
      : null;

    if (exactObservation && topCommitClaim) {
      exactTransaction = {
        token: exactObservation.token,
        restoreEpoch: exactObservation.restoreEpoch,
        claim: topCommitClaim,
        phase: "running",
        cdpObserved: exactObservation.cdpObserved,
        detachedRestorePending: false
      };
      runtime.exactWebNavigationTransactions.set(exactTransaction.token, exactTransaction);
    } else if (exactObservation && !exactObservation.cdpObserved) {
      cancelExactWebNavigationCommitObservation(
        runtime.exactTopNavigationObservations,
        exactObservation.token
      );
    }

    if (topCommitClaim && runtime.mode === "full") {
      suspendFullCaptureForNavigation(topCommitClaim);
    }

    clearContentNavigationRevisions(runtime, details.frameId);

    if (
      topContentDocument &&
      runtime.mode === "lite" &&
      typeof details.documentId === "string" &&
      details.documentId.length > 0
    ) {
      bindCommittedDocumentToContentArmWaiters(runtime, 0, details.documentId);
    }

    const previousDocument = runtime.contentDocuments.get(details.frameId);
    if (previousDocument) {
      blockKnownContentSubtree(runtime, previousDocument, "navigation");
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

    if (
      !isRuntimeCurrentCaptureOpen(runtime) ||
      (exactTransaction && !isExactWebNavigationTransactionCurrent(runtime, exactTransaction))
    ) {
      return;
    }

    if (!preparation.prepared) {
      if (
        topContentDocument &&
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

    if (
      preparation.document.frameId > 0 &&
      details.parentFrameId !== undefined &&
      typeof details.parentDocumentId === "string" &&
      details.parentDocumentId.length > 0
    ) {
      runtime.contentActivationParents.set(
        contentActivationParentKey(preparation.document.frameId, preparation.document.documentId),
        {
          frameId: details.parentFrameId,
          documentId: details.parentDocumentId
        }
      );
    }

    const currentPreparedDocument = runtime.contentDocuments.getKnownDocument(
      preparation.document.frameId,
      preparation.document.documentId
    );

    if (!currentPreparedDocument) {
      return;
    }

    if (
      topContentDocument &&
      (!exactTransaction || isExactWebNavigationTransactionCurrent(runtime, exactTransaction))
    ) {
      runtime.captureUrl = currentPreparedDocument.url;
      runtime.cdpScope.captureUrl = currentPreparedDocument.url;
      runtime.url = sanitizeUrlForPrivacy(currentPreparedDocument.url);
      pushSessionList();
      scheduleRuntimeStatePersist();
    }

    if (currentPreparedDocument.frameId > 0) {
      const parent = runtime.contentActivationParents.get(
        contentActivationParentKey(
          currentPreparedDocument.frameId,
          currentPreparedDocument.documentId
        )
      );

      const parentActivation = parent
        ? runtime.contentDocuments.waitForKnownDocumentActivation(parent)
        : null;

      if (
        !parent ||
        !parentActivation ||
        !(await parentActivation) ||
        !(await waitForLiveParentContentActivation(runtime, parent)) ||
        (exactTransaction && !isExactWebNavigationTransactionCurrent(runtime, exactTransaction))
      ) {
        blockKnownContentSubtree(runtime, currentPreparedDocument, "committed-parent-missing");
        return;
      }
    }

    const result = await injectPendingContentDocument({
      chromeApi,
      authorization: runtime.contentDocuments,
      document: currentPreparedDocument,
      isRuntimeActive: () =>
        isVolatileCaptureOpen(runtime.captureFence) &&
        !runtime.stopping &&
        !runtime.stoppedAt &&
        sessionsByTab.get(runtime.tabId) === runtime &&
        (!exactTransaction || isExactWebNavigationTransactionCurrent(runtime, exactTransaction)),
      mode: runtime.mode
    });

    if (result.status === "injected") {
      if (runtime.mode === "lite") {
        if (!result.mainWorldController) {
          throw new Error("Lite document injection omitted its MAIN-world controller.");
        }
        if (
          !rememberMainWorldController(
            runtime,
            contentActivationParentKey(
              preparation.document.frameId,
              preparation.document.documentId
            ),
            result.mainWorldController
          )
        ) {
          throw new Error("Lite document controller conflicted with its isolated singleton.");
        }
      }
      runtime.contentDocuments.completePendingInjection(
        preparation.document.frameId,
        preparation.document.documentId
      );
      syncAuthorizedContentFrames(runtime);

      try {
        await requestFreshContentActivation(runtime, {
          frameId: preparation.document.frameId,
          documentId: preparation.document.documentId,
          assertCurrent: () => {
            if (
              !isRuntimeCurrentCaptureOpen(runtime) ||
              (exactTransaction &&
                !isExactWebNavigationTransactionCurrent(runtime, exactTransaction)) ||
              !runtime.contentDocuments.isCurrentNavigation(
                preparation.document.frameId,
                preparation.document.documentId
              )
            ) {
              throw new Error("The prepared content document changed during activation.");
            }
          }
        });
      } catch (error) {
        const failedCurrentNavigation = runtime.contentDocuments.isCurrentNavigation(
          preparation.document.frameId,
          preparation.document.documentId
        );
        blockKnownContentSubtree(runtime, preparation.document, "prepared-activation-failed");
        syncAuthorizedContentFrames(runtime);
        console.warn("[WebBlackbox] prepared document status request failed closed", {
          tabId: runtime.tabId,
          frameId: preparation.document.frameId,
          documentId: preparation.document.documentId,
          error: error instanceof Error ? error.message : String(error)
        });

        if (
          topContentDocument &&
          failedCurrentNavigation &&
          (!exactTransaction || isExactWebNavigationTransactionCurrent(runtime, exactTransaction))
        ) {
          await stopRuntimeIfCurrent(runtime);
        }
        return;
      }
    } else if (result.status === "stale") {
      runtime.contentDocuments.failNavigation(
        preparation.document.frameId,
        preparation.document.documentId
      );
      clearContentDocumentCompanionState(runtime, preparation.document, "injection-stale");
    }
    syncAuthorizedContentFrames(runtime);

    if (result.status === "failed") {
      clearContentDocumentCompanionState(runtime, preparation.document, "injection-failed");
      console.warn("[WebBlackbox] dynamic document injection failed closed", {
        tabId: runtime.tabId,
        frameId: preparation.document.frameId,
        documentId: preparation.document.documentId,
        error: result.error instanceof Error ? result.error.message : String(result.error)
      });

      if (
        topContentDocument &&
        result.failedCurrentNavigation &&
        (!exactTransaction || isExactWebNavigationTransactionCurrent(runtime, exactTransaction))
      ) {
        await stopRuntimeIfCurrent(runtime);
      }
    }

    if (
      result.status === "injected" &&
      topCommitClaim &&
      isSessionNavigationClaimCurrent(topCommitClaim) &&
      (!exactTransaction || isExactWebNavigationTransactionCurrent(runtime, exactTransaction)) &&
      runtime.cdpRouter
    ) {
      if (exactTransaction) {
        exactTransaction.phase = "restoring";
      }
      await restoreCdpGlobalCaptureAfterNavigation(topCommitClaim, true, {
        ...(exactTransaction ? { expectedRestoreEpoch: exactTransaction.restoreEpoch } : {})
      });
    }
  } catch (error) {
    transactionFailed = true;
    throw error;
  } finally {
    if (runtime && exactTransaction) {
      finishExactWebNavigationTransaction(runtime, exactTransaction, transactionFailed);
    }
  }
}

async function failCommittedContentDocument(
  details: {
    tabId: number;
    frameId: number;
    documentId?: string;
    url: string;
  },
  claim: {
    navigation: SessionNavigationClaim;
    documentRevisionKey: string | null;
    documentRevision: number;
    cdpRestoreEpoch: number;
    exactTransaction?: ExactWebNavigationCommitTransaction;
  }
): Promise<void> {
  const runtime = claim.navigation.runtime;
  const expectedRestoreEpoch = claim.exactTransaction?.restoreEpoch ?? claim.cdpRestoreEpoch;

  if (
    !isSessionNavigationClaimCurrent(claim.navigation) ||
    !isCdpRestoreEpochCurrent(runtime, expectedRestoreEpoch) ||
    (claim.documentRevisionKey !== null &&
      (runtime.contentNavigationRevisions.get(claim.documentRevisionKey) ?? 0) !==
        claim.documentRevision)
  ) {
    return;
  }

  if (details.frameId === 0) {
    const currentUrl = await resolveCurrentTabCaptureUrl(details.tabId);
    if (
      currentUrl === details.url &&
      isSessionNavigationClaimCurrent(claim.navigation) &&
      isCdpRestoreEpochCurrent(runtime, expectedRestoreEpoch)
    ) {
      await stopRuntimeIfNavigationClaimCurrent(claim.navigation);
    }
    return;
  }

  if (typeof details.documentId !== "string" || details.documentId.length === 0) {
    return;
  }

  const known = runtime.contentDocuments.getKnownDocument(details.frameId, details.documentId);
  if (known) {
    blockKnownContentSubtree(runtime, known, "committed-navigation-failed");
  }
}

async function stopRuntimeIfCurrent(runtime: SessionRuntime): Promise<void> {
  await requestRuntimeStop(runtime);
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

function isExactWebNavigationTransactionCurrent(
  runtime: SessionRuntime,
  transaction: ExactWebNavigationCommitTransaction
): boolean {
  return (
    runtime.exactWebNavigationTransactions.get(transaction.token) === transaction &&
    isSessionNavigationClaimCurrent(transaction.claim) &&
    isCdpRestoreEpochCurrent(runtime, transaction.restoreEpoch)
  );
}

function finishExactWebNavigationTransaction(
  runtime: SessionRuntime,
  transaction: ExactWebNavigationCommitTransaction,
  failed: boolean
): void {
  if (runtime.exactWebNavigationTransactions.get(transaction.token) !== transaction) {
    return;
  }

  if (failed) {
    cancelExactWebNavigationCommitObservation(
      runtime.exactTopNavigationObservations,
      transaction.token
    );
    runtime.exactWebNavigationTransactions.delete(transaction.token);
    return;
  }

  transaction.phase = "completed";
  if (transaction.cdpObserved && !transaction.detachedRestorePending) {
    runtime.exactWebNavigationTransactions.delete(transaction.token);
  }
}

function evictExactWebNavigationTransactions(
  runtime: SessionRuntime,
  tokens: readonly number[]
): void {
  for (const token of tokens) {
    runtime.exactWebNavigationTransactions.delete(token);
  }
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

  runtime.cdpPayloadAdmissionBlocked = true;

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

function isCdpChildRuntimeCurrent(runtime: SessionRuntime, router: CdpRouter): boolean {
  return (
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime) &&
    runtime.cdpRouter === router &&
    isVolatileCaptureOpen(runtime.captureFence) &&
    !runtime.stopping &&
    !runtime.stoppedAt
  );
}

function enqueueCdpChildSessionControl(
  runtime: SessionRuntime,
  router: CdpRouter,
  childClaim: CdpChildSessionClaim
): void {
  const accepted = enqueue(runtime, async () => {
    const isRuntimeCurrent = () => isCdpChildRuntimeCurrent(runtime, router);
    const outcome = await bootstrapCdpChildSession({
      state: runtime.cdpScope,
      claim: childClaim,
      commands: {
        send: (method) =>
          requireCdpCommand(
            router.send({ tabId: runtime.tabId, sessionId: childClaim.sessionId }, method),
            `child ${method}`
          ),
        enableAutoAttach: () =>
          requireCdpCommand(
            router.enableAutoAttach(runtime.tabId, undefined, childClaim.sessionId),
            "child Target.setAutoAttach"
          )
      },
      isRuntimeCurrent
    });

    if (
      outcome === "stale" ||
      !isRuntimeCurrent() ||
      !isCdpChildSessionClaimCurrent(runtime.cdpScope, childClaim)
    ) {
      return;
    }

    const child = runtime.cdpScope.childSessions.get(childClaim.sessionId);

    if (!child?.rootReprimeRequired || !isRuntimeCaptureAdmitted(runtime.activationState)) {
      return;
    }

    const navigationClaim = snapshotCurrentRuntimeNavigation(
      runtime,
      "cdp-child-mutation",
      runtime.captureUrl
    );

    if (!navigationClaim) {
      return;
    }

    const expectedChildMutationRevision = runtime.cdpScope.childMutationRevision;
    const expectedRestoreEpoch = runtime.cdpRestoreEpoch;

    launchCdpNavigationRestore(
      navigationClaim,
      {
        expectedChildMutationRevision,
        expectedRestoreEpoch
      },
      undefined,
      () =>
        isSessionNavigationClaimCurrent(navigationClaim) &&
        isCdpChildSessionClaimCurrent(runtime.cdpScope, childClaim) &&
        runtime.cdpScope.childMutationRevision === expectedChildMutationRevision &&
        isCdpRestoreEpochCurrent(runtime, expectedRestoreEpoch)
    );
  });

  if (!accepted && isRuntimeCaptureAdmitted(runtime.activationState)) {
    requestStopRuntimeIfCurrent(runtime, "cdp-child-control-queue-closed");
  }
}

async function drainCurrentRuntimeQueue(
  runtime: SessionRuntime,
  deadline: number
): Promise<boolean> {
  if (!isRuntimeCurrentCaptureOpen(runtime)) {
    return false;
  }

  const currentTail = runtime.queue;
  const remainingMs = deadline - Date.now();

  if (remainingMs <= 0) {
    throw new Error("Child CDP controls exceeded their settle deadline.");
  }

  const outcome = await withCdpCommandTimeout(currentTail, remainingMs);

  if (!outcome.ok) {
    throw new Error("Child CDP controls did not drain before their settle deadline.");
  }

  return runtime.queue === currentTail;
}

async function primeCdpRootAfterChildControls(
  runtime: SessionRuntime,
  router: CdpRouter
): Promise<CdpRootFrameTreePrime> {
  const deadline = Date.now() + CDP_CHILD_SETTLE_TIMEOUT_MS;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await drainCurrentRuntimeQueue(runtime, deadline))) {
      continue;
    }

    if (!isCdpChildRuntimeCurrent(runtime, router)) {
      throw new Error("The runtime changed while child CDP sessions were becoming ready.");
    }

    const expectedChildMutationRevision = runtime.cdpScope.childMutationRevision;
    const settledQueue = runtime.queue;
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new Error("Child CDP controls exceeded their settle deadline.");
    }

    const result = await primeCdpFrameTreeScopes(
      runtime,
      router,
      Math.min(CDP_ARTIFACT_TIMEOUT_MS, remainingMs)
    );

    if (
      expectedChildMutationRevision === runtime.cdpScope.childMutationRevision &&
      settledQueue === runtime.queue
    ) {
      return result;
    }
  }

  throw new Error("Child CDP sessions did not settle during root frame-tree priming.");
}

async function requireCdpCommand<TResult>(
  task: Promise<TResult>,
  label: string,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<TResult> {
  const outcome = await withCdpCommandTimeout(task, timeoutMs);

  if (!outcome.ok) {
    throw new Error(`${label} failed or timed out.`);
  }

  return outcome.value;
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

  return runtime ? requestRuntimeStop(runtime) : Promise.resolve();
}

function requestSessionStop(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  return runtime ? requestRuntimeStop(runtime) : Promise.resolve();
}

function requestRuntimeStop(runtime: SessionRuntime): Promise<void> {
  if (
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
    !isMapEntrySame(sessionsBySid, runtime.sid, runtime)
  ) {
    return Promise.resolve();
  }

  runtime.stopRequestedAt ??= Date.now();
  beginVolatileCaptureQuiescence(runtime.captureFence, () => {
    runtime.contentDocuments.cancelPendingNavigations();
    cancelContentArmWaiters(runtime, "Runtime stop cancelled pending content activation.");
    quiesceRuntimeContentProducers(runtime);
    if (runtime.activationState !== "starting") {
      void quiesceScreenRecordingForStop(runtime).catch((error) => {
        console.warn("[WebBlackbox] failed to quiesce screen recording at stop intent", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });

  if (runtime.activationState === "starting") {
    revokeRuntimeContent(runtime, "runtime-start-cancelled");
    cancelOwnedRuntimeStart(runtime.startToken);
    return Promise.resolve();
  }

  return runtimeStopTasks.run(runtime, () => stopSessionOnce(runtime));
}

async function stopSessionOnce(runtime: SessionRuntime): Promise<void> {
  if (
    runtime.stoppedAt ||
    !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
    !isMapEntrySame(sessionsBySid, runtime.sid, runtime)
  ) {
    return;
  }

  const stopRequestedAt = runtime.stopRequestedAt ?? Date.now();
  const cleanupDeadline =
    runtime.cleanupDeadline ??
    stopRequestedAt + resolveRuntimeLocalTtlMs(runtime.config.capturePolicy);
  let stopDrainPlan:
    | {
        wait: Promise<void>;
        notification: Promise<void>;
      }
    | undefined = preparedStopDrainPlans.get(runtime);

  try {
    await runDurableRuntimeStopWorkflow({
      captureFence: runtime.captureFence,
      persistStopping: runtime.stopping
        ? () => undefined
        : () => persistRuntimeStoppingTombstone(runtime, stopRequestedAt, cleanupDeadline),
      teardownSteps: [
        async () => {
          await runBestEffortStopStep(runtime, "screen-recording-quiesce", () =>
            quiesceScreenRecordingForStop(runtime)
          );
          stopDrainPlan ??= prepareRuntimeStopDrain(runtime);
          await runBestEffortStopStep(
            runtime,
            "content-notification",
            () => stopDrainPlan!.notification
          );
        },
        () => stopScreenRecording(runtime, "session-stop"),
        () =>
          runBestEffortStopStep(runtime, "pipeline-buffer", () =>
            flushBufferedPipelineEvents(runtime)
          ),
        () => teardownCaptureInstrumentation(runtime),
        async () => {
          await stopDrainPlan?.wait;
          await flushBufferedPipelineEvents(runtime);
          await runtime.pipeline.flush();
        }
      ],
      persistStopped: () =>
        persistRuntimeStoppedCheckpoint(runtime, stopRequestedAt, cleanupDeadline)
    });
    await finalizeRuntimeStopped(runtime, stopRequestedAt, cleanupDeadline);
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

async function finalizeRuntimeStopped(
  runtime: SessionRuntime,
  stoppedAt: number,
  cleanupDeadline: number
): Promise<void> {
  deleteMapEntryIfSame(sessionsByTab, runtime.tabId, runtime);
  resetAuthorizedContentFrames(runtime);
  uninstallLiteWebRequestCaptureIfUnused();
  runtime.stoppedAt = stoppedAt;
  runtime.stopRequestedAt = undefined;
  runtime.cleanupDeadline = cleanupDeadline;
  preparedStopDrainPlans.delete(runtime);
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
      await stopRuntimeIfCurrent(runtime);

      if (!runtime.stoppedAt) {
        throw new Error("Session identity changed before export could stop it.");
      }
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
  stopDrainClaim: StopDrainClaim | null = null,
  batchAdmission: ContentEventBatchAdmission | null = null,
  delivery: PipelineDeliveryEventProvenance | null = null
): Promise<boolean> {
  const runtime = resolveRuntimeEventOwner(sessionsBySid, sessionsByTab, rawEvent);
  const stopDrainAuthorized = Boolean(
    runtime &&
    stopDrainClaim &&
    isStopDrainClaimValid(stopDrainClaim, runtime, runtime.captureFence)
  );
  const batchAuthorized = Boolean(
    runtime && batchAdmission && isContentEventBatchAdmissionValid(batchAdmission, runtime)
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
      !batchAuthorized &&
      !isCaptureClosureEvent(rawEvent))
  ) {
    return Promise.resolve(false);
  }

  const admittedDocumentUrl =
    batchAdmission?.documentUrl ?? stopDrainClaim?.capability.documentUrl ?? runtime.captureUrl;
  const admittedFrameId = batchAdmission?.frameId ?? stopDrainClaim?.capability.frameId ?? 0;
  const runtimeScope = evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
    url: admittedDocumentUrl,
    tabId: runtime.tabId,
    frameId: admittedFrameId
  });

  if (!runtimeScope.allowed) {
    if (!runtime.stopping && !runtime.stoppedAt) {
      requestStopRuntimeIfCurrent(runtime, "capture-scope-denied");
    }

    return Promise.resolve(false);
  }

  if (!isCaptureEventFrameAllowed(runtime.config.capturePolicy, rawEvent)) {
    return Promise.resolve(false);
  }

  if (
    runtime.stopping &&
    rawEvent.source !== "system" &&
    !stopDrainAuthorized &&
    !batchAuthorized
  ) {
    return Promise.resolve(false);
  }

  if (shouldSkipFullModeContentRawEvent(runtime, rawEvent)) {
    return Promise.resolve(false);
  }

  const nextRawEvent: RawRecorderEvent = {
    ...rawEvent,
    sid: runtime.sid
  };

  updateRuntimeInteractionState(runtime, nextRawEvent);

  if (shouldMaterializeLiteContentEvent(runtime, nextRawEvent)) {
    return enqueueWithResult(runtime, async () => {
      if (!isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim, batchAdmission)) {
        return false;
      }

      const materialized = await materializeLiteContentEvent(
        runtime,
        nextRawEvent,
        stopDrainClaim,
        batchAdmission
      );

      if (
        !materialized ||
        !isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim, batchAdmission)
      ) {
        return false;
      }

      return ingestRecorderEvent(runtime, materialized, delivery);
    });
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

  return Promise.resolve(ingestRecorderEvent(runtime, nextRawEvent, delivery));
}

function ingestRecorderEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent,
  delivery: PipelineDeliveryEventProvenance | null
): boolean {
  const previous = runtime.activePipelineDelivery;
  runtime.activePipelineDelivery = delivery;
  try {
    return runtime.recorder.ingest(rawEvent).event !== undefined;
  } finally {
    runtime.activePipelineDelivery = previous;
  }
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
  stopDrainClaim: StopDrainClaim | null = null,
  batchAdmission: ContentEventBatchAdmission | null = null
): Promise<RawRecorderEvent | null> {
  if (!isRuntimeEventMaterializationAllowed(runtime, stopDrainClaim, batchAdmission)) {
    return null;
  }

  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(runtime, rawEvent, stopDrainClaim, batchAdmission);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(runtime, rawEvent, stopDrainClaim, batchAdmission);
  }

  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    return materializeLiteStorageSnapshot(runtime, rawEvent, stopDrainClaim, batchAdmission);
  }

  if (rawEvent.rawType === "networkBody") {
    return materializeLiteNetworkBody(runtime, rawEvent, stopDrainClaim, batchAdmission);
  }

  return rawEvent;
}

async function materializeLiteScreenshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null,
  batchAdmission: ContentEventBatchAdmission | null
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

  const shotId = await putRuntimeCaptureBlob(
    runtime,
    decoded.mime,
    decoded.bytes,
    stopDrainClaim,
    batchAdmission
  );

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
  stopDrainClaim: StopDrainClaim | null,
  batchAdmission: ContentEventBatchAdmission | null
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
    stopDrainClaim,
    batchAdmission
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
  stopDrainClaim: StopDrainClaim | null,
  batchAdmission: ContentEventBatchAdmission | null
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
        ? await putRuntimeCaptureBlob(
            runtime,
            "application/json",
            encoded.bytes,
            stopDrainClaim,
            batchAdmission
          )
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
        ? await putRuntimeCaptureBlob(
            runtime,
            "application/json",
            encoded.bytes,
            stopDrainClaim,
            batchAdmission
          )
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
        ? await putRuntimeCaptureBlob(
            runtime,
            "application/json",
            encoded.bytes,
            stopDrainClaim,
            batchAdmission
          )
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
  rawEvent: RawRecorderEvent,
  stopDrainClaim: StopDrainClaim | null,
  batchAdmission: ContentEventBatchAdmission | null
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
  const contentHash = await putRuntimeCaptureBlob(
    runtime,
    mimeType,
    transformed.sampledBytes,
    stopDrainClaim,
    batchAdmission
  );

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
  stopDrainClaim: StopDrainClaim | null = null,
  batchAdmission: ContentEventBatchAdmission | null = null
): Promise<string | null> {
  if (stopDrainClaim) {
    return runStopDrainBlobOperation(stopDrainClaim, runtime, runtime.captureFence, () =>
      runtime.pipeline.putBlob(mime, bytes)
    );
  }

  if (batchAdmission) {
    if (!isContentEventBatchAdmissionValid(batchAdmission, runtime)) {
      return null;
    }

    const hash = await runtime.pipeline.putBlob(mime, bytes);
    return isContentEventBatchAdmissionValid(batchAdmission, runtime) ? hash : null;
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

function enqueuePipelineEvent(
  runtime: SessionRuntime,
  event: WebBlackboxEvent,
  delivery?: PipelineDeliveryEventProvenance
): void {
  runtime.pipelineEventBuffer.push({ event, ...(delivery ? { delivery } : {}) });

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

async function flushBufferedPipelineEvents(
  runtime: SessionRuntime,
  options: { screenRecordingFinalization?: boolean } = {}
): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.pipelineEventBuffer.length === 0 && !runtime.pipelineFlushQueued) {
    return;
  }

  await enqueueWithResult(runtime, async () => {
    await drainPipelineBufferBatches(runtime, "drain", options);
  });
}

async function flushContentEventBatchDurably(runtime: SessionRuntime): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  // Always enter the runtime queue, even when the buffer currently looks empty. A prior
  // activation can still be finishing an admitted async materialization ahead of this barrier.
  await enqueueWithResult(runtime, async () => {
    await drainPipelineBufferBatches(runtime, "drain");
  });
}

async function drainPipelineBufferBatches(
  runtime: SessionRuntime,
  reason: "queue" | "drain",
  options: { screenRecordingFinalization?: boolean } = {}
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

    const events = batch.events.map((entry) => entry.event);
    const deliveryByEventId = new Map<string, PipelineDeliveryEventProvenance>();
    for (const entry of batch.events) {
      if (entry.delivery) {
        deliveryByEventId.set(entry.event.id, entry.delivery);
      }
    }

    if (deliveryByEventId.size > 0) {
      await runtime.pipeline.ingestBatchWithDelivery(
        events,
        deliveryByEventId,
        batch.operationId,
        options
      );
    } else {
      await runtime.pipeline.ingestBatch(events, batch.operationId, options);
    }
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
    ingestBatch: async (events, operationId, options = {}) => {
      const normalizedOperationId = normalizeOptionalIngestOperationId(operationId);
      await requestOffscreenPipeline<void>({
        op: "ingestBatchDurably",
        sid,
        events,
        ...(normalizedOperationId === undefined ? {} : { operationId: normalizedOperationId }),
        ...(options.screenRecordingFinalization === true
          ? { screenRecordingFinalization: true }
          : {})
      });
    },
    ingestBatchWithDelivery: async (events, deliveryByEventId, operationId, options = {}) => {
      const normalizedOperationId = normalizeOptionalIngestOperationId(operationId);
      await requestOffscreenPipeline<void>({
        op: "ingestBatchWithDelivery",
        sid,
        events,
        deliverySidecar: [...deliveryByEventId.entries()].map(([eventId, provenance]) => ({
          eventId,
          provenance
        })),
        ...(normalizedOperationId === undefined ? {} : { operationId: normalizedOperationId }),
        ...(options.screenRecordingFinalization === true
          ? { screenRecordingFinalization: true }
          : {})
      });
    },
    getDeliveryReceipt: async (deliveryQuery) => {
      const result = await requestOffscreenPipeline<unknown>({
        op: "getDeliveryReceipt",
        sid,
        deliveryQuery
      });
      return normalizePipelineDeliveryReceipt(result, deliveryQuery);
    },
    commitDeliveryProgress: async (deliveryProgress) => {
      await requestOffscreenPipeline<void>({
        op: "commitDeliveryProgress",
        sid,
        deliveryProgress
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
    putBlob: async (mime, bytes, options = {}) => {
      return requestOffscreenPipeline<string>({
        op: "putBlob",
        sid,
        mime,
        bytes,
        ...(options.screenRecordingFinalization === true
          ? { screenRecordingFinalization: true }
          : {})
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
  if (request.op === "quiesceScreenRecording") {
    return false;
  }
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
      rawMessage as OffscreenScreenRecordingChunkMessage,
      port
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
      const preliminaryFrame =
        event.method === "Page.frameNavigated" && !event.sessionId
          ? asRecord(asRecord(event.params)?.frame)
          : null;
      const preliminaryTopNavigationUrl =
        preliminaryFrame &&
        typeof preliminaryFrame.parentId !== "string" &&
        typeof preliminaryFrame.parentFrameId !== "string"
          ? asString(preliminaryFrame.url)
          : null;
      const preliminaryExactCdpObservation =
        preliminaryTopNavigationUrl &&
        hasExactWebNavigationTracking() &&
        !isRuntimeActivationProvisional(runtime.activationState)
          ? observeExactCdpTopNavigation(
              runtime.exactTopNavigationObservations,
              preliminaryTopNavigationUrl,
              () => advanceCdpRestoreEpoch(runtime),
              (token, restoreEpoch) => {
                const transaction = runtime.exactWebNavigationTransactions.get(token);
                return Boolean(
                  transaction &&
                  transaction.restoreEpoch === restoreEpoch &&
                  isExactWebNavigationTransactionCurrent(runtime, transaction)
                );
              }
            )
          : null;

      if (preliminaryExactCdpObservation) {
        evictExactWebNavigationTransactions(
          runtime,
          preliminaryExactCdpObservation.evictedWebTokens
        );
        if (preliminaryExactCdpObservation.kind === "ignored-stale") {
          if (preliminaryExactCdpObservation.ignoredWebToken !== undefined) {
            runtime.exactWebNavigationTransactions.delete(
              preliminaryExactCdpObservation.ignoredWebToken
            );
          }
          return;
        }
      }
      const targetControlMethod =
        event.method === "Target.attachedToTarget" || event.method === "Target.detachedFromTarget"
          ? event.method
          : null;
      const scopeEvaluation = targetControlMethod
        ? evaluateCdpTargetControlScopeEvent(
            runtime.cdpScope,
            targetControlMethod,
            event.params ?? {},
            event.sessionId
          )
        : evaluateCdpCaptureScopeEvent(
            runtime.cdpScope,
            event.method,
            event.params ?? {},
            event.sessionId
          );

      if (!scopeEvaluation) {
        return;
      }

      if (scopeEvaluation.fatalScopeViolation) {
        requestStopRuntimeIfCurrent(runtime, "cdp-malformed-visual-target");
        return;
      }

      const childSessionClaim = scopeEvaluation.childSessionClaim;
      const eventChildClaim = event.sessionId
        ? getCdpChildSessionClaim(runtime.cdpScope, event.sessionId)
        : null;

      if (childSessionClaim) {
        enqueueCdpChildSessionControl(runtime, candidateRouter, childSessionClaim);
      }

      // Bootstrap events may prime the provisional CDP scope, but they must
      // not enter navigation ownership, capture, or follow-up queues until the
      // restoration transaction commits active.
      if (isRuntimeActivationProvisional(runtime.activationState)) {
        return;
      }

      const cdpFrameTreeMutated = scopeEvaluation.globalFrameTreeMutation === true;
      if (scopeEvaluation.topNavigation || cdpFrameTreeMutated) {
        runtime.cdpPayloadAdmissionBlocked = true;
      }

      const scopeAllowed = scopeEvaluation.allowed;
      const captureAllowed =
        scopeAllowed &&
        isRuntimeCaptureAdmitted(runtime.activationState) &&
        isVolatileCaptureOpen(runtime.captureFence) &&
        !runtime.cdpPayloadAdmissionBlocked &&
        claimRuntimeGlobalCdpCapture(runtime) !== null;
      let frameTreeNavigationClaim: SessionNavigationClaim | null = null;

      if (scopeEvaluation.topNavigation) {
        const { url, decision } = scopeEvaluation.topNavigation;
        const withinDocument = event.method === "Page.navigatedWithinDocument";
        const exactCrossDocumentOwner = !withinDocument && hasExactWebNavigationTracking();
        const exactCdpObservation = exactCrossDocumentOwner ? preliminaryExactCdpObservation : null;

        // A top-frame event starts a new URL-independent restore generation
        // immediately. This lets the new owner bypass an older hung restore,
        // while every continuation of that older task remains fenced out.
        if (!exactCdpObservation) {
          advanceCdpRestoreEpoch(runtime);
        }

        const matchedExactTransaction =
          exactCdpObservation?.matchedWebToken === undefined
            ? undefined
            : runtime.exactWebNavigationTransactions.get(exactCdpObservation.matchedWebToken);
        if (matchedExactTransaction) {
          matchedExactTransaction.restoreEpoch = exactCdpObservation!.restoreEpoch;
          matchedExactTransaction.cdpObserved = true;
        }

        const ownership = resolveCdpTopNavigationOwnership({
          navigationKind: withinDocument ? "same-document" : "cross-document",
          usesExactWebNavigationDocumentOwnership: hasExactWebNavigationTracking(),
          childMutationRevision: runtime.cdpScope.childMutationRevision,
          restoreEpoch: exactCdpObservation?.restoreEpoch ?? runtime.cdpRestoreEpoch
        });

        if (withinDocument) {
          const document = runtime.contentDocuments.getKnownFrameDocument(0);
          const claim = claimCurrentRuntimeNavigation(runtime, "cdp-within-document", url);
          frameTreeNavigationClaim = claim;

          if (!claim) {
            // A provisional root is reconciled by its start/restore transaction.
          } else if (!decision.allowed) {
            requestStopRuntimeIfNavigationClaimCurrent(claim, "cdp-same-document-denied");
          } else if (document) {
            suspendFullCaptureForNavigation(claim, { cdpScopeAlreadyInvalidated: true });
            enqueueNavigationClaim(claim, async () => {
              await handleSameDocumentNavigation(
                {
                  tabId: runtime.tabId,
                  frameId: 0,
                  documentId: document.documentId,
                  url
                },
                () => isSessionNavigationClaimCurrent(claim)
              );

              if (!isSessionNavigationClaimCurrent(claim) || runtime.captureUrl !== url) {
                return;
              }

              const documentActivation = runtime.contentDocuments.waitForKnownDocumentActivation({
                frameId: 0,
                documentId: document.documentId
              });

              if (
                !documentActivation ||
                !(await documentActivation) ||
                !(await waitForLiveParentContentActivation(runtime, {
                  frameId: 0,
                  documentId: document.documentId
                }))
              ) {
                requestStopRuntimeIfNavigationClaimCurrent(
                  claim,
                  "cdp-same-document-root-activation-failed"
                );
                return;
              }

              if (!isSessionNavigationClaimCurrent(claim) || runtime.captureUrl !== url) {
                return;
              }

              launchCdpNavigationRestore(claim, ownership.restore ?? {});
            });
          } else {
            requestStopRuntimeIfNavigationClaimCurrent(
              claim,
              "cdp-same-document-without-active-root"
            );
          }
        } else {
          const source: RuntimeNavigationSource = "cdp-frame-navigated";
          const exactDocumentOwner = ownership.urlOwner === "web-navigation";
          const claim = exactDocumentOwner
            ? (matchedExactTransaction?.claim ??
              snapshotCurrentRuntimeNavigation(runtime, source, url))
            : claimCurrentRuntimeNavigation(runtime, source, url);
          frameTreeNavigationClaim = claim;

          if (!claim) {
            // Root bootstrap has its own atomic transaction and is intentionally
            // not folded into active-runtime navigation ownership.
          } else if (!decision.allowed) {
            requestStopRuntimeIfNavigationClaimCurrent(claim, "cdp-navigation-denied");
          } else {
            suspendFullCaptureForNavigation(claim, { cdpScopeAlreadyInvalidated: true });
            if (!ownership.restore) {
              if (
                matchedExactTransaction &&
                matchedExactTransaction.phase !== "running" &&
                isExactWebNavigationTransactionCurrent(runtime, matchedExactTransaction)
              ) {
                matchedExactTransaction.detachedRestorePending = true;
                launchCdpNavigationRestore(
                  claim,
                  {
                    expectedRestoreEpoch: matchedExactTransaction.restoreEpoch
                  },
                  () => {
                    matchedExactTransaction.detachedRestorePending = false;
                    if (
                      matchedExactTransaction.phase === "completed" &&
                      runtime.exactWebNavigationTransactions.get(matchedExactTransaction.token) ===
                        matchedExactTransaction
                    ) {
                      runtime.exactWebNavigationTransactions.delete(matchedExactTransaction.token);
                    }
                  }
                );
              }
              return;
            }
            enqueueNavigationClaim(claim, async () => {
              if (!exactDocumentOwner) {
                if (!(await handleTabUrlChanged(claim, url))) {
                  return;
                }
              } else if (!isSessionNavigationClaimCurrent(claim)) {
                return;
              }

              launchCdpNavigationRestore(claim, ownership.restore);
            });
          }
        }
      } else if (cdpFrameTreeMutated) {
        const mutationGeneration = runtime.cdpScope.generation;
        const childMutationRevision = runtime.cdpScope.childMutationRevision;
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

        if (claim && !childSessionClaim) {
          enqueueNavigationClaim(claim, async () => {
            if (runtime.cdpScope.generation !== mutationGeneration) {
              return;
            }

            launchCdpNavigationRestore(claim, {
              expectedChildMutationRevision: childMutationRevision
            });
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

      if (
        event.method === "Target.attachedToTarget" ||
        event.method === "Target.detachedFromTarget"
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

          if (!isCdpFollowupClaimCurrent(runtime.cdpScope, event.sessionId, eventChildClaim)) {
            return;
          }

          await processFullModeEvent(
            runtime,
            event.method,
            event.params ?? {},
            event.sessionId,
            eventChildClaim
          );
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

    await bootstrapCdpRoot({
      cdpLevel: runtime.config.capturePolicy?.categories.cdp ?? "off",
      commands: {
        attach: async () => {
          await candidateRouter.attach(runtime.tabId);

          if (!isMapEntrySame(sessionsByTab, runtime.tabId, runtime)) {
            throw new Error("The runtime changed while its root debugger was attaching.");
          }

          runtime.cdpRouter = candidateRouter;
          clearCdpCaptureScopeState(runtime.cdpScope);
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
    const settledFrameTreePrime = await primeCdpRootAfterChildControls(runtime, candidateRouter);

    if (!settledFrameTreePrime.rootValid) {
      throw new Error("The root frame tree became invalid while child CDP sessions settled.");
    }

    if (runtime.screenRecording) {
      if (settledFrameTreePrime.globalCaptureReady) {
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
  router: CdpRouter | null = runtime.cdpRouter,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<CdpRootFrameTreePrime> {
  if (!router) {
    invalidateCdpCaptureFrameTree(runtime.cdpScope);
    return {
      globalCaptureReady: false,
      rootValid: false
    };
  }

  await refreshCdpCaptureFrameTree(runtime.cdpScope, async () => {
    const response = await requireCdpCommand(
      router.send<{ frameTree?: unknown }>({ tabId: runtime.tabId }, "Page.getFrameTree"),
      "root Page.getFrameTree",
      timeoutMs
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

function launchCdpNavigationRestore(
  claim: SessionNavigationClaim,
  options: { expectedChildMutationRevision?: number; expectedRestoreEpoch?: number } = {},
  onSettled: (() => void) | undefined = undefined,
  isFailureCurrent: (() => boolean) | undefined = undefined
): void {
  const runtime = claim.runtime;
  const restoreOptions = {
    expectedChildMutationRevision:
      options.expectedChildMutationRevision ?? runtime.cdpScope.childMutationRevision,
    expectedRestoreEpoch: options.expectedRestoreEpoch ?? runtime.cdpRestoreEpoch
  };
  const failureCurrent =
    isFailureCurrent ??
    (() =>
      isSessionNavigationClaimCurrent(claim) &&
      runtime.cdpScope.childMutationRevision === restoreOptions.expectedChildMutationRevision &&
      isCdpRestoreEpochCurrent(runtime, restoreOptions.expectedRestoreEpoch));

  launchDetachedNavigationTask({
    run: () => restoreCdpGlobalCaptureAfterNavigation(claim, true, restoreOptions),
    onFailure: async (error) => {
      if (failureCurrent()) {
        await stopRuntimeIfNavigationClaimCurrent(claim);
      }

      console.warn("[WebBlackbox] detached CDP navigation restore failed closed", {
        tabId: runtime.tabId,
        sid: runtime.sid,
        revision: claim.revision,
        restoreEpoch: restoreOptions.expectedRestoreEpoch,
        error: error instanceof Error ? error.message : String(error)
      });
    },
    ...(onSettled ? { onSettled } : {}),
    onUnhandledFailure: (error) => {
      console.warn("[WebBlackbox] detached CDP restore cleanup failed", {
        tabId: runtime.tabId,
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

async function restoreCdpGlobalCaptureAfterNavigation(
  claim: SessionNavigationClaim,
  _forceRefresh = false,
  options: { expectedChildMutationRevision?: number; expectedRestoreEpoch?: number } = {}
): Promise<void> {
  const runtime = claim.runtime;
  const restoreOptions = {
    expectedChildMutationRevision:
      options.expectedChildMutationRevision ?? runtime.cdpScope.childMutationRevision,
    expectedRestoreEpoch: options.expectedRestoreEpoch ?? runtime.cdpRestoreEpoch
  };
  const previousTail = resolveCdpRestorePredecessor({
    tail: runtime.cdpRestoreTail,
    tailEpoch: runtime.cdpRestoreTailEpoch,
    expectedRestoreEpoch: restoreOptions.expectedRestoreEpoch
  });
  const task = previousTail
    .catch(() => undefined)
    .then(() => restoreCdpGlobalCaptureAfterNavigationOnce(claim, _forceRefresh, restoreOptions));

  if (isCdpRestoreEpochCurrent(runtime, restoreOptions.expectedRestoreEpoch)) {
    runtime.cdpRestoreTailEpoch = restoreOptions.expectedRestoreEpoch;
    runtime.cdpRestoreTail = task.catch(() => undefined);
  }

  try {
    await task;
  } catch (error) {
    if (
      !isSessionNavigationClaimCurrent(claim) ||
      runtime.cdpScope.childMutationRevision !== restoreOptions.expectedChildMutationRevision ||
      !isCdpRestoreEpochCurrent(runtime, restoreOptions.expectedRestoreEpoch)
    ) {
      return;
    }

    throw error;
  }

  if (
    runtime.cdpScope.childMutationRevision === restoreOptions.expectedChildMutationRevision &&
    isCdpRestoreEpochCurrent(runtime, restoreOptions.expectedRestoreEpoch) &&
    canOpenFullCdpPayloadAdmission(claim, restoreOptions.expectedRestoreEpoch)
  ) {
    runtime.cdpPayloadAdmissionBlocked = false;
  }
}

async function restoreCdpGlobalCaptureAfterNavigationOnce(
  claim: SessionNavigationClaim,
  forceRefresh: boolean,
  options: { expectedChildMutationRevision?: number; expectedRestoreEpoch?: number } = {}
): Promise<void> {
  const runtime = claim.runtime;
  const expectedUrl = claim.candidateUrl ?? runtime.captureUrl;
  const expectedRestoreEpoch = options.expectedRestoreEpoch ?? runtime.cdpRestoreEpoch;
  const isRestoreCurrent = () =>
    isSessionNavigationClaimCurrent(claim) &&
    isCdpRestoreEpochCurrent(runtime, expectedRestoreEpoch) &&
    (options.expectedChildMutationRevision === undefined ||
      runtime.cdpScope.childMutationRevision === options.expectedChildMutationRevision);
  const stopRuntimeIfRestoreCurrent = async () => {
    if (isRestoreCurrent()) {
      await stopRuntimeIfNavigationClaimCurrent(claim);
    }
  };

  if (
    !isRestoreCurrent() ||
    runtime.mode !== "full" ||
    !runtime.cdpRouter ||
    !isRuntimeCaptureScopeActive(runtime) ||
    runtime.captureUrl !== expectedUrl
  ) {
    return;
  }

  const initialRecording = runtime.screenRecording;
  const currentGeneration = claimRuntimeGlobalCdpCapture(runtime, false, true);
  const expectedChildMutationRevision =
    options.expectedChildMutationRevision ?? runtime.cdpScope.childMutationRevision;
  const checkpoint = runtime.cdpRestoreCheckpoint;
  const checkpointCurrent =
    currentGeneration !== null &&
    checkpoint?.navigationRevision === claim.revision &&
    checkpoint.captureUrl === expectedUrl &&
    checkpoint.childMutationRevision === expectedChildMutationRevision &&
    checkpoint.restoreEpoch === expectedRestoreEpoch &&
    checkpoint.generation === currentGeneration;
  const refreshRequired =
    currentGeneration === null ||
    (forceRefresh && !checkpointCurrent) ||
    !isCdpCaptureFrameTreePrimedForRoot(runtime.cdpScope, runtime.captureUrl, currentGeneration);

  if (
    initialRecording &&
    (refreshRequired || initialRecording.cdpScopeGeneration !== currentGeneration)
  ) {
    try {
      await stopScreenRecording(runtime, "navigation-scope", initialRecording, () =>
        isRestoreCurrent()
      );
    } catch {
      await stopRuntimeIfRestoreCurrent();
      return;
    }

    if (!isRestoreCurrent()) {
      return;
    }
  }

  if (refreshRequired || claimRuntimeGlobalCdpCapture(runtime, false, true) === null) {
    const prime = await runGuardedNavigationStep(isRestoreCurrent, () =>
      primeCdpFrameTreeScopes(runtime)
    );

    if (prime.status !== "current" || !isRestoreCurrent() || runtime.captureUrl !== expectedUrl) {
      return;
    }

    const frameTreePrime = prime.value;
    const primeOutcome = resolveCdpNavigationPrimeOutcome(frameTreePrime);

    if (primeOutcome === "root-invalid") {
      const invalidRootRecording = runtime.screenRecording;

      await stopScreenRecording(runtime, "capture-scope", invalidRootRecording, () =>
        isRestoreCurrent()
      ).catch(() => undefined);
      await stopRuntimeIfRestoreCurrent();
      return;
    }

    if (primeOutcome === "global-blocked") {
      const childBlockedRecording = runtime.screenRecording;

      try {
        await stopScreenRecording(runtime, "capture-scope", childBlockedRecording, () =>
          isRestoreCurrent()
        );
      } catch {
        await stopRuntimeIfRestoreCurrent();
      }

      return;
    }
  }

  const finalGeneration = claimRuntimeGlobalCdpCapture(runtime, false, true);

  if (
    finalGeneration !== null &&
    isRestoreCurrent() &&
    canOpenFullCdpPayloadAdmission(claim, expectedRestoreEpoch)
  ) {
    runtime.cdpRestoreCheckpoint = {
      navigationRevision: claim.revision,
      captureUrl: expectedUrl,
      childMutationRevision: expectedChildMutationRevision,
      restoreEpoch: expectedRestoreEpoch,
      generation: finalGeneration
    };
    runtime.cdpPayloadAdmissionBlocked = false;
  }

  const activeRecording = runtime.screenRecording;

  if (
    activeRecording &&
    (finalGeneration === null || activeRecording.cdpScopeGeneration !== finalGeneration)
  ) {
    try {
      await stopScreenRecording(runtime, "navigation-scope", activeRecording, () =>
        isRestoreCurrent()
      );
    } catch {
      await stopRuntimeIfRestoreCurrent();
      return;
    }

    if (!isRestoreCurrent()) {
      return;
    }
  }

  const screenRecordingRequested =
    runtime.config.capturePolicy?.categories.screenRecordings === "allow";

  if (!runtime.screenRecording && screenRecordingRequested) {
    try {
      await startScreenRecording(runtime, false, claim, isRestoreCurrent);
    } catch (error) {
      console.warn("[WebBlackbox] failed to restart screen recording after navigation", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });

      await stopRuntimeIfRestoreCurrent();
      return;
    }

    if (!isRestoreCurrent()) {
      return;
    }

    if (!runtime.screenRecording) {
      // A child-target mutation can invalidate global capture while the
      // requested start is in flight without superseding the top navigation.
      // Its queued snapshot owns the next prime and decides whether the valid
      // root is merely global-blocked or actually invalid.
      if (claimRuntimeGlobalCdpCapture(runtime, false, true) === null) {
        return;
      }

      await stopRuntimeIfRestoreCurrent();
    }
  }
}

function canOpenFullCdpPayloadAdmission(
  claim: SessionNavigationClaim,
  expectedRestoreEpoch: number = claim.runtime.cdpRestoreEpoch
): boolean {
  const runtime = claim.runtime;
  const rootDocument = runtime.contentDocuments.get(0);
  const rootActivation = contentActivations
    .listRuntime(runtime, runtime.captureFence, ["active"])
    .find(
      (activation) =>
        activation.frameId === 0 &&
        activation.documentId === rootDocument?.documentId &&
        activation.url === runtime.captureUrl
    );

  return (
    isSessionNavigationClaimCurrent(claim) &&
    isCdpRestoreEpochCurrent(runtime, expectedRestoreEpoch) &&
    runtime.mode === "full" &&
    runtime.cdpRouter !== null &&
    rootDocument?.url === runtime.captureUrl &&
    rootActivation !== undefined &&
    !runtime.pendingContentPolicyRevisions.has(
      contentActivationParentKey(rootDocument.frameId, rootDocument.documentId)
    ) &&
    claimRuntimeGlobalCdpCapture(runtime, false, true) !== null
  );
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
  allowStarting = false,
  allowNavigationBlocked = false
): number | null {
  const provisionalIdentityCurrent =
    allowStarting &&
    isRuntimeActivationProvisional(runtime.activationState) &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime);

  if (
    (!isRuntimeCaptureAdmitted(runtime.activationState) && !provisionalIdentityCurrent) ||
    (runtime.cdpPayloadAdmissionBlocked && !allowNavigationBlocked) ||
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
  allowStarting = false,
  allowNavigationBlocked = false
): boolean {
  const provisionalIdentityCurrent =
    allowStarting &&
    isRuntimeActivationProvisional(runtime.activationState) &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime);

  return (
    (isRuntimeCaptureAdmitted(runtime.activationState) || provisionalIdentityCurrent) &&
    (!runtime.cdpPayloadAdmissionBlocked || allowNavigationBlocked) &&
    isRuntimeCaptureScopeActive(runtime) &&
    canCaptureGlobalCdpArtifactsForRoot(runtime.cdpScope, runtime.captureUrl, generation)
  );
}

function isRuntimeEventMaterializationAllowed(
  runtime: SessionRuntime,
  stopDrainClaim: StopDrainClaim | null,
  batchAdmission: ContentEventBatchAdmission | null = null
): boolean {
  if (stopDrainClaim) {
    return (
      isStopDrainClaimValid(stopDrainClaim, runtime, runtime.captureFence) &&
      evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
        url: stopDrainClaim.capability.documentUrl,
        tabId: runtime.tabId,
        frameId: stopDrainClaim.capability.frameId
      }).allowed
    );
  }

  if (batchAdmission) {
    return (
      isContentEventBatchAdmissionValid(batchAdmission, runtime) &&
      evaluateCaptureDocumentScope(runtime.config.capturePolicy, {
        url: batchAdmission.documentUrl,
        tabId: runtime.tabId,
        frameId: batchAdmission.frameId
      }).allowed
    );
  }

  return (
    isRuntimeCaptureScopeActive(runtime) &&
    (runtime.mode !== "full" || !runtime.cdpPayloadAdmissionBlocked)
  );
}

function isContentEventBatchAdmissionValid(
  admission: ContentEventBatchAdmission,
  runtime: SessionRuntime
): boolean {
  return isContentEventBatchAdmissionLive(
    admission,
    runtime,
    runtime.captureFence,
    (activationId) => contentActivations.lookupByActivationId(activationId, ["active", "draining"])
  );
}

function isRuntimeDocumentWithinScope(runtime: SessionRuntime): boolean {
  return evaluateRuntimeFrameDocument(runtime, runtime.captureUrl, true);
}

async function processFullModeEvent(
  runtime: SessionRuntime,
  method: string,
  params: unknown,
  sessionId: string | undefined,
  childClaim: CdpChildSessionClaim | null
): Promise<void> {
  const isEventCurrent = () =>
    isRuntimeCaptureScopeActive(runtime) &&
    !runtime.cdpPayloadAdmissionBlocked &&
    claimRuntimeGlobalCdpCapture(runtime) !== null &&
    isCdpFollowupClaimCurrent(runtime.cdpScope, sessionId, childClaim);

  if (!isEventCurrent()) {
    return;
  }

  const payload = asRecord(params);

  if (method === "Network.responseReceived") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const response = asRecord(payload?.response);
    const resourceType = typeof payload?.type === "string" ? payload.type : undefined;

    if (requestId) {
      upsertRequestMeta(
        runtime.requestMeta,
        buildCdpFollowupRequestMetaKey(requestId, sessionId, childClaim),
        {
          url: typeof response?.url === "string" ? response.url : undefined,
          mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
          status: typeof response?.status === "number" ? response.status : undefined,
          resourceType
        }
      );
    }

    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const requestMetaKey = requestId
      ? buildCdpFollowupRequestMetaKey(requestId, sessionId, childClaim)
      : null;

    if (
      requestId &&
      requestMetaKey &&
      shouldCaptureResponseBody(runtime, requestMetaKey, payload)
    ) {
      await captureResponseBody(runtime, requestId, requestMetaKey, sessionId, isEventCurrent);
    }

    if (requestId && requestMetaKey) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);

      if (isEventCurrent()) {
        forgetCdpRequestScope(runtime.cdpScope, requestId, sessionId);
      }
    }

    return;
  }

  if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
    if (method === "Network.loadingFailed") {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

      if (requestId) {
        deleteRequestMeta(
          runtime.requestMeta,
          buildCdpFollowupRequestMetaKey(requestId, sessionId, childClaim)
        );

        if (isEventCurrent()) {
          forgetCdpRequestScope(runtime.cdpScope, requestId, sessionId);
        }
      }
    }

    if (isEventCurrent() && shouldCaptureIncidentArtifacts(runtime)) {
      await captureIncidentArtifacts(runtime, method, isEventCurrent);
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

async function captureResponseBody(
  runtime: SessionRuntime,
  requestId: string,
  requestMetaKey: string,
  sessionId: string | undefined,
  isEventCurrent: () => boolean
): Promise<void> {
  if (!runtime.cdpRouter || !isEventCurrent()) {
    return;
  }

  const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
  const response = await sendCdpCommand<{
    body?: string;
    base64Encoded?: boolean;
  }>(runtime, target, "Network.getResponseBody", { requestId });

  if (!response?.body || !isEventCurrent()) {
    return;
  }

  const metadata = getRequestMeta(runtime.requestMeta, requestMetaKey);
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

  if (!isEventCurrent()) {
    return;
  }

  const hash = await putRuntimeCaptureBlob(
    runtime,
    metadata?.mimeType ?? "application/octet-stream",
    transformed.sampledBytes
  );

  if (!hash || !isEventCurrent()) {
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
  requestMetaKey: string,
  loadingFinishedPayload: Record<string, unknown> | null
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

  const metadata = getRequestMeta(runtime.requestMeta, requestMetaKey);

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

async function captureIncidentArtifacts(
  runtime: SessionRuntime,
  reason: string,
  additionalCurrent: () => boolean = () => true
): Promise<void> {
  if (!additionalCurrent()) {
    return;
  }

  await Promise.allSettled([
    captureScreenshot(runtime, reason, additionalCurrent),
    captureTraceMetrics(runtime, reason, additionalCurrent)
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

async function captureScreenshot(
  runtime: SessionRuntime,
  reason: string,
  additionalCurrent: () => boolean = () => true
): Promise<void> {
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!additionalCurrent() || !runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (
    !screenshot?.data ||
    !additionalCurrent() ||
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
  ) {
    return;
  }

  const bytes = decodeBase64(screenshot.data);
  const hash = await putRuntimeCaptureBlob(runtime, "image/webp", bytes);

  if (
    !hash ||
    !additionalCurrent() ||
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
  ) {
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
  navigationClaim?: SessionNavigationClaim,
  additionalCurrent: () => boolean = () => true
): Promise<void> {
  const isCurrentNavigation = () =>
    additionalCurrent() &&
    (navigationClaim === undefined || isSessionNavigationClaimCurrent(navigationClaim));
  const navigationRestore = navigationClaim !== undefined;
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime, provisional, navigationRestore);

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
    !isRuntimeGlobalCdpCaptureClaimValid(
      runtime,
      cdpScopeGeneration,
      provisional,
      navigationRestore
    )
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
    chunkWrites: new ScreenRecordingChunkWriteLedger(),
    stopPromise: null,
    finalization: new ScreenRecordingFinalizationGate(),
    finalizing: false,
    durabilityEvidenceQueued: false,
    terminalEvidenceQueued: false
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
      !isRuntimeGlobalCdpCaptureClaimValid(
        runtime,
        cdpScopeGeneration,
        provisional,
        navigationRestore
      )
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

  if (reason !== "session-stop" && isRuntimeAwaitingDurableStop(runtime)) {
    await quiesceScreenRecordingForStop(runtime).catch(() => undefined);
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

async function quiesceScreenRecordingForStop(runtime: SessionRuntime): Promise<void> {
  const recording = runtime.screenRecording;

  if (!recording) {
    return;
  }

  const result = await requestOffscreenPipeline<{ quiesced: boolean }>({
    op: "quiesceScreenRecording",
    sid: runtime.sid,
    recordingId: recording.recordingId
  });
  if (result.quiesced !== true) {
    throw new Error("Offscreen screen recording did not confirm stop quiescence.");
  }
}

function isRuntimeAwaitingDurableStop(runtime: SessionRuntime): boolean {
  return (
    runtime.activationState === "active" &&
    runtime.stopRequestedAt !== undefined &&
    !runtime.stopping &&
    !runtime.stoppedAt &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime)
  );
}

async function handleOffscreenScreenRecordingChunk(
  message: OffscreenScreenRecordingChunkMessage,
  port: PortLike
): Promise<void> {
  const runtime = sessionsBySid.get(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime || !recording || recording.recordingId !== message.recordingId) {
    return;
  }

  const activeAdmission =
    recording.cdpScopeGeneration !== null &&
    isRuntimeGlobalCdpCaptureClaimValid(
      runtime,
      recording.cdpScopeGeneration,
      recording.provisional
    );
  const stopAdmission = isRuntimeOwnedScreenRecordingStopAdmission(runtime, recording);
  if (!activeAdmission && !stopAdmission) {
    await stopScreenRecording(runtime, "capture-scope").catch(() => undefined);
    return;
  }

  const bytes = asUint8Array(message.bytes);

  if (
    !bytes ||
    bytes.byteLength === 0 ||
    message.size !== bytes.byteLength ||
    !Number.isSafeInteger(message.index) ||
    message.index < 0 ||
    message.index >= PIPELINE_RESUME_MAX_SCREEN_CHUNKS ||
    typeof message.mime !== "string" ||
    message.mime.length === 0 ||
    message.mime.length > 256
  ) {
    return;
  }

  const index = message.index;
  const fingerprint = JSON.stringify([
    message.mime,
    message.size,
    normalizeRecordingOffset(message.startOffsetMs),
    normalizeRecordingOffset(message.endOffsetMs),
    normalizeRecordingOffset(message.durationMs)
  ]);
  const task = recording.chunkWrites.execute({
    index,
    fingerprint,
    putBlob: async () => {
      const hash = stopAdmission
        ? await runtime.pipeline.putBlob(message.mime, bytes, {
            screenRecordingFinalization: true
          })
        : await putRuntimeCaptureBlob(runtime, message.mime, bytes);
      if (!hash) {
        throw new Error("Screen recording chunk blob was not admitted.");
      }
      return hash;
    },
    enqueueEvent: async (hash) => {
      const rawEvent: RawRecorderEvent = {
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
          mime: message.mime,
          size: message.size,
          startOffsetMs: normalizeRecordingOffset(message.startOffsetMs),
          endOffsetMs: normalizeRecordingOffset(message.endOffsetMs),
          durationMs: normalizeRecordingOffset(message.durationMs)
        }
      };
      if (stopAdmission) {
        if (!isRuntimeOwnedScreenRecordingStopAdmission(runtime, recording)) {
          throw new Error("Screen recording stop-chunk admission expired.");
        }
        runtime.recorder.ingest(rawEvent);
      } else if (!(await ingestRawEvent(rawEvent))) {
        throw new Error("Screen recording chunk event was not admitted.");
      }
    },
    flush: () =>
      flushBufferedPipelineEvents(runtime, {
        screenRecordingFinalization: stopAdmission
      }),
    getDurableHash: () => recording.chunks[index],
    commitDurable: (hash) => {
      if (runtime.screenRecording !== recording) {
        throw new Error("Screen recording changed before its chunk became durable.");
      }
      recording.chunks[index] = hash;
      recording.chunkCount = Math.max(recording.chunkCount, index + 1);
      recording.sizeBytes += message.size;
    }
  });
  const pendingWrite = task.then(
    () => undefined,
    () => undefined
  );
  recording.pendingWrites.add(pendingWrite);
  void task.then(
    () => recording.pendingWrites.delete(pendingWrite),
    () => {
      recording.pendingWrites.delete(pendingWrite);
    }
  );
  const hash = await task;
  const acknowledgement: ScreenRecordingChunkAckMessage = {
    kind: "sw.screen-recording-chunk-ack",
    sid: runtime.sid,
    recordingId: recording.recordingId,
    index,
    size: message.size,
    chunkId: hash
  };

  try {
    port.postMessage(acknowledgement);
  } catch {
    // The offscreen delivery registry keeps the exact bytes and replays them
    // after the resilient port binds to the next worker.
  }
}

function isRuntimeOwnedScreenRecordingStopAdmission(
  runtime: SessionRuntime,
  recording: ScreenRecordingRuntime
): boolean {
  return (
    runtime.screenRecording === recording &&
    runtime.stoppedAt === undefined &&
    isRuntimeCaptureAdmitted(runtime.activationState) &&
    isMapEntrySame(sessionsByTab, runtime.tabId, runtime) &&
    isMapEntrySame(sessionsBySid, runtime.sid, runtime) &&
    (recording.stopPromise !== null ||
      (runtime.stopRequestedAt !== undefined && !isVolatileCaptureOpen(runtime.captureFence)))
  );
}

async function handleOffscreenScreenRecordingEnded(
  message: OffscreenScreenRecordingEndedMessage
): Promise<void> {
  const runtime = sessionsBySid.get(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime || !recording || recording.recordingId !== message.result.recordingId) {
    return;
  }

  await retryScreenRecordingFinalization({
    maxAttempts: SCREEN_RECORDING_FINALIZATION_MAX_ATTEMPTS,
    isCurrent: () => runtime.screenRecording === recording,
    finalize: () => finalizeScreenRecording(runtime, message.result),
    waitForRetry: (attempt) =>
      wait(Math.min(SCREEN_RECORDING_FINALIZATION_RETRY_INITIAL_MS * 2 ** (attempt - 1), 2_000))
  });
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

  await recording.finalization.run(() => finalizeScreenRecordingOnce(runtime, recording, result));
}

async function finalizeScreenRecordingOnce(
  runtime: SessionRuntime,
  recording: ScreenRecordingRuntime,
  result: OffscreenScreenRecordingStopResult
): Promise<void> {
  if (runtime.screenRecording !== recording || recording.recordingId !== result.recordingId) {
    return;
  }

  await waitForScreenRecordingChunkWrites(recording);
  const chunks = compactScreenRecordingChunkHashes(recording.chunks);
  const reportedChunkCount = normalizeNonNegativeInt(result.chunkCount);
  const reportedSize = normalizeNonNegativeInt(result.size);
  const acknowledgedChunkCount = normalizeNonNegativeInt(result.durableChunkCount);
  const acknowledgedSize = normalizeNonNegativeInt(result.durableSize);
  const durabilityMismatch =
    result.degraded === true ||
    reportedChunkCount === null ||
    reportedSize === null ||
    reportedChunkCount !== chunks.length ||
    reportedSize !== recording.sizeBytes ||
    (acknowledgedChunkCount !== null && acknowledgedChunkCount !== chunks.length) ||
    (acknowledgedSize !== null && acknowledgedSize !== recording.sizeBytes);

  const mismatchError = durabilityMismatch
    ? new Error(
        `Offscreen screen recording durability mismatch: reported=${reportedChunkCount ?? "invalid"}/${reportedSize ?? "invalid"}, acknowledged=${acknowledgedChunkCount ?? "invalid"}/${acknowledgedSize ?? "invalid"}, durable=${chunks.length}/${recording.sizeBytes}.`
      )
    : null;

  await runDurableScreenRecordingFinalization({
    beginCompletionCheckpoint: () => {
      recording.finalizing = true;
    },
    rollbackCompletionCheckpoint: () => {
      recording.finalizing = false;
    },
    persistCompletionCheckpoint: () => persistRuntimeState({ required: true }),
    writeTerminalEvidence: async () => {
      if (
        mismatchError &&
        !recording.durabilityEvidenceQueued &&
        !(await ingestRawEvent({
          source: "system",
          rawType: "screen.recording.error",
          sid: runtime.sid,
          tabId: runtime.tabId,
          t: Date.now(),
          mono: monotonicTime(),
          payload: {
            recordingId: recording.recordingId,
            name: mismatchError.name,
            message: mismatchError.message,
            stage: "durability"
          }
        }))
      ) {
        throw new Error("Screen recording durability evidence was not admitted.");
      }
      if (mismatchError) {
        recording.durabilityEvidenceQueued = true;
      }

      if (!recording.terminalEvidenceQueued) {
        const ended = await ingestRawEvent({
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
            reason: durabilityMismatch ? "screen-chunk-durability-mismatch" : result.reason
          }
        });
        if (!ended) {
          throw new Error("Screen recording terminal evidence was not admitted.");
        }
        recording.terminalEvidenceQueued = true;
      }
      await flushBufferedPipelineEvents(runtime);
      await runtime.pipeline.flush();
    },
    commit: () => {
      if (runtime.screenRecording !== recording) {
        throw new Error("Screen recording changed before finalization committed.");
      }
      runtime.screenRecording = null;
    }
  });
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

async function captureTraceMetrics(
  runtime: SessionRuntime,
  reason: string,
  additionalCurrent: () => boolean = () => true
): Promise<void> {
  const cdpScopeGeneration = claimRuntimeGlobalCdpCapture(runtime);

  if (!additionalCurrent() || !runtime.cdpRouter || cdpScopeGeneration === null) {
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

  if (
    !metrics ||
    !additionalCurrent() ||
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
  ) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(metrics));
  const hash = await putRuntimeCaptureBlob(runtime, "application/json", bytes);

  if (
    !hash ||
    !additionalCurrent() ||
    !isRuntimeGlobalCdpCaptureClaimValid(runtime, cdpScopeGeneration)
  ) {
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
          allowNavigationFallback: !usesExactContentTopDocumentAuthorization(runtime),
          currentCaptureUrl: runtime.captureUrl,
          ready
        })
      : ready
        ? runtime.contentDocuments.authorize(authorizationInput)
        : runtime.contentDocuments.authorizeEvent(authorizationInput);

  if (!authorized) {
    return false;
  }

  if (
    shouldContentSenderClaimCaptureUrl({
      frameId,
      senderUrl,
      currentCaptureUrl: runtime.captureUrl,
      usesExactTopDocumentAuthorization: usesExactContentTopDocumentAuthorization(runtime)
    })
  ) {
    runtime.captureUrl = senderUrl;
    runtime.cdpScope.captureUrl = senderUrl;
    runtime.url = sanitizeUrlForPrivacy(senderUrl);
  }

  syncAuthorizedContentFrames(runtime);
  return true;
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

  return true;
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

  void revokeContentFrameActivations(runtime, frameId, "document-failed", documentId);
  runtime.contentMainWorldProofs.delete(contentActivationParentKey(frameId, documentId));
  const navigationFailed = runtime.contentDocuments.failNavigation(frameId, documentId);
  const activeRevoked =
    frameId === 0
      ? runtime.contentDocuments.revoke(frameId, documentId)
      : runtime.contentDocuments.blockDocument(frameId, documentId);
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
  sender: MessageSenderLike | undefined
): Promise<void> {
  if (shouldStopRuntimeForDeniedContentSender(runtime, sender)) {
    await stopRuntimeIfCurrent(runtime);
    return;
  }

  const frameId = normalizeSenderFrameId(sender);

  if (frameId < 0) {
    return;
  }

  failContentSender(runtime, sender);
}

function resetAuthorizedContentFrames(
  runtime: SessionRuntime,
  topDocumentUrl = runtime.captureUrl
): void {
  revokeRuntimeContent(runtime, "authorization-reset");
  runtime.contentActivationParents.clear();
  runtime.contentMainWorldProofs.clear();
  runtime.contentNavigationRevisions.clear();
  runtime.pendingContentPolicyRevisions.clear();
  runtime.pendingLiteNetworkPolicyRevisions.clear();
  runtime.sameDocumentTransitions.clear();
  runtime.contentDocuments.reset({ url: topDocumentUrl });
  syncAuthorizedContentFrames(runtime);
}

function usesExactLiteTopDocumentAuthorization(runtime: SessionRuntime): boolean {
  try {
    return canUseExactLiteTopDocumentAuthorization({
      mode: runtime.mode,
      permissions: chromeApi?.runtime?.getManifest?.().permissions,
      hasWebNavigationApi: typeof chromeApi?.webNavigation?.onCommitted?.addListener === "function",
      hasSameDocumentNavigationApi:
        typeof chromeApi?.webNavigation?.onHistoryStateUpdated?.addListener === "function" &&
        typeof chromeApi?.webNavigation?.onReferenceFragmentUpdated?.addListener === "function",
      hasScriptingApi: typeof chromeApi?.scripting?.executeScript === "function"
    });
  } catch {
    return false;
  }
}

function hasExactWebNavigationTracking(): boolean {
  const permissions = chromeApi?.runtime?.getManifest?.().permissions;
  return (
    Array.isArray(permissions) &&
    permissions.includes("webNavigation") &&
    typeof chromeApi?.webNavigation?.onCommitted?.addListener === "function" &&
    typeof chromeApi?.webNavigation?.onHistoryStateUpdated?.addListener === "function" &&
    typeof chromeApi?.webNavigation?.onReferenceFragmentUpdated?.addListener === "function" &&
    typeof chromeApi?.scripting?.executeScript === "function"
  );
}

function usesExactContentTopDocumentAuthorization(runtime: SessionRuntime): boolean {
  return runtime.mode === "full"
    ? hasExactWebNavigationTracking()
    : usesExactLiteTopDocumentAuthorization(runtime);
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

function normalizePipelineDeliveryReceipt(
  raw: unknown,
  query: PipelineDeliveryReceiptQuery
): PipelineDeliveryReceipt | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const row = asRecord(raw);
  if (
    !row ||
    Object.keys(row).length !== 8 ||
    row.tabId !== query.tabId ||
    row.frameId !== query.frameId ||
    row.documentId !== query.documentId ||
    row.batchId !== query.batchId ||
    typeof row.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
    !Number.isSafeInteger(row.eventCount) ||
    (row.eventCount as number) <= 0 ||
    (row.eventCount as number) > CONTENT_EVENT_BATCH_MAX ||
    !Array.isArray(row.indexes) ||
    row.indexes.length > (row.eventCount as number) ||
    typeof row.complete !== "boolean"
  ) {
    throw new Error("Invalid offscreen pipeline delivery receipt.");
  }

  const indexes: PipelineDeliveryReceipt["indexes"] = [];
  const seen = new Set<number>();
  for (const candidate of row.indexes) {
    const index = asRecord(candidate);
    if (
      !index ||
      !Number.isSafeInteger(index.eventIndex) ||
      (index.eventIndex as number) < 0 ||
      (index.eventIndex as number) >= (row.eventCount as number) ||
      seen.has(index.eventIndex as number)
    ) {
      throw new Error("Invalid offscreen pipeline delivery receipt index.");
    }
    seen.add(index.eventIndex as number);

    if (index.outcome === "no-output" && Object.keys(index).length === 2) {
      indexes.push({ eventIndex: index.eventIndex as number, outcome: "no-output" });
      continue;
    }
    if (
      index.outcome === "event" &&
      Object.keys(index).length === 3 &&
      typeof index.eventId === "string" &&
      /^E-[0-9]{1,16}$/.test(index.eventId)
    ) {
      indexes.push({
        eventIndex: index.eventIndex as number,
        outcome: "event",
        eventId: index.eventId
      });
      continue;
    }
    throw new Error("Invalid offscreen pipeline delivery receipt outcome.");
  }
  indexes.sort((left, right) => left.eventIndex - right.eventIndex);
  if (row.complete !== (indexes.length === row.eventCount)) {
    throw new Error("Offscreen pipeline delivery receipt completion is inconsistent.");
  }

  return {
    tabId: query.tabId,
    frameId: query.frameId,
    documentId: query.documentId,
    batchId: query.batchId,
    fingerprint: row.fingerprint,
    eventCount: row.eventCount as number,
    indexes,
    complete: row.complete
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
  const contentTarget = resolveContentScriptInjectionTarget(
    runtime.config.capturePolicy,
    runtime.tabId
  );
  const injection = await injectRootPageAgentsForMode(chromeApi, {
    mode: runtime.mode,
    contentTarget,
    mainWorldTarget: contentTarget.allFrames
      ? { tabId: runtime.tabId, allFrames: true }
      : { tabId: runtime.tabId, frameId: 0 },
    ...guards
  });
  const { contentResults, mainWorldResults } = injection;
  guards.assertCurrent?.();
  const rootResult = contentResults.find((result) => result.frameId === 0);

  if (
    !rootResult ||
    typeof rootResult.documentId !== "string" ||
    rootResult.documentId.length === 0 ||
    rootResult.error
  ) {
    throw new Error("Exact root content injection did not return a document identity.");
  }

  if (runtime.mode === "lite") {
    for (const contentResult of contentResults) {
      if (
        typeof contentResult.documentId !== "string" ||
        contentResult.documentId.length === 0 ||
        contentResult.error
      ) {
        continue;
      }

      const mainWorldResult = mainWorldResults.find(
        (candidate) =>
          candidate.frameId === contentResult.frameId &&
          candidate.documentId === contentResult.documentId &&
          !candidate.error
      );

      if (mainWorldResult) {
        if (
          !rememberMainWorldController(
            runtime,
            contentActivationParentKey(contentResult.frameId, contentResult.documentId),
            mainWorldResult.controller
          )
        ) {
          throw new Error("Root MAIN-world controller conflicted with its isolated singleton.");
        }
      }
    }

    if (
      !runtime.contentMainWorldProofs.has(
        contentActivationParentKey(rootResult.frameId, rootResult.documentId)
      )
    ) {
      throw new Error("Exact root MAIN-world injection did not match the content document.");
    }
  }

  await populateInitialContentActivationParents(runtime, contentResults);
  guards.assertCurrent?.();
  await requestFreshContentActivation(runtime, {
    frameId: 0,
    documentId: rootResult.documentId,
    assertCurrent: guards.assertCurrent
  });
  guards.assertCurrent?.();

  const pendingChildren = contentResults.filter(
    (result): result is typeof result & { documentId: string } =>
      result.frameId > 0 &&
      typeof result.documentId === "string" &&
      result.documentId.length > 0 &&
      !result.error &&
      (runtime.mode === "full" ||
        runtime.contentMainWorldProofs.has(
          contentActivationParentKey(result.frameId, result.documentId)
        )) &&
      runtime.contentActivationParents.has(
        contentActivationParentKey(result.frameId, result.documentId)
      )
  );

  while (pendingChildren.length > 0) {
    const live = contentActivations.listRuntime(runtime, runtime.captureFence);
    const readyChildren = pendingChildren.filter((result) => {
      const parent = runtime.contentActivationParents.get(
        contentActivationParentKey(result.frameId, result.documentId)
      );
      return live.some(
        (activation) =>
          activation.frameId === parent?.frameId && activation.documentId === parent.documentId
      );
    });

    if (readyChildren.length === 0) {
      break;
    }

    for (const child of readyChildren) {
      pendingChildren.splice(pendingChildren.indexOf(child), 1);
    }

    await Promise.all(
      readyChildren.map((result) =>
        requestFreshContentActivation(runtime, {
          frameId: result.frameId,
          documentId: result.documentId,
          assertCurrent: guards.assertCurrent
        }).catch(() => null)
      )
    );
  }
  guards.assertCurrent?.();
}

async function populateInitialContentActivationParents(
  runtime: SessionRuntime,
  results: readonly { frameId: number; documentId?: string }[]
): Promise<void> {
  if (!chromeApi?.webNavigation?.getAllFrames) {
    return;
  }

  let frames: Awaited<ReturnType<NonNullable<typeof chromeApi.webNavigation.getAllFrames>>>;

  try {
    frames = await chromeApi.webNavigation.getAllFrames({ tabId: runtime.tabId });
  } catch {
    return;
  }

  const resultDocumentByFrame = new Map(
    results.flatMap((result) =>
      typeof result.documentId === "string" && result.documentId.length > 0
        ? [[result.frameId, result.documentId] as const]
        : []
    )
  );

  for (const frame of frames) {
    if (frame.frameId <= 0 || frame.parentFrameId < 0) {
      continue;
    }

    const documentId = frame.documentId;
    const parent = resolveExactInitialContentParent({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      documentId,
      parentDocumentId: frame.parentDocumentId,
      injectedDocumentId: resultDocumentByFrame.get(frame.frameId),
      injectedParentDocumentId: resultDocumentByFrame.get(frame.parentFrameId)
    });

    if (!documentId || !parent) {
      continue;
    }

    runtime.contentActivationParents.set(
      contentActivationParentKey(frame.frameId, documentId),
      parent
    );
  }
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
    if (!isLiteWebRequestPolicyAdmissionOpen(runtime)) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
    if (
      !isLiteWebRequestDocumentUrlUnambiguous(
        runtime.config.capturePolicy?.scope.excludedUrlPatterns ?? [],
        details.type
      )
    ) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
    const existingMetadata = getRequestMeta(runtime.requestMeta, requestMetaKey);
    const navigationFrameId =
      typeof details.frameId === "number" && Number.isSafeInteger(details.frameId)
        ? Math.max(0, details.frameId)
        : 0;
    const previousNavigationDocument =
      details.type === "main_frame" || details.type === "sub_frame"
        ? runtime.contentDocuments.get(navigationFrameId)
        : null;

    if (previousNavigationDocument) {
      blockKnownContentSubtree(runtime, previousNavigationDocument, "navigation-start");
    }

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

    if (
      !isLiteWebRequestActivationAuthorized(
        runtime,
        authorization,
        details.parentFrameId,
        details.parentDocumentId
      )
    ) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
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

    if (authorization.kind === "top-navigation" || authorization.kind === "subframe-navigation") {
      return;
    }

    void ingestRawEvent(
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
    if (!isLiteWebRequestPolicyAdmissionOpen(runtime)) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
    if (
      !isLiteWebRequestDocumentUrlUnambiguous(
        runtime.config.capturePolicy?.scope.excludedUrlPatterns ?? [],
        details.type ?? metadata?.resourceType
      )
    ) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
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

    if (!isLiteWebRequestActivationAuthorized(runtime, authorization)) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }

    if (authorization.kind === "top-navigation" || authorization.kind === "subframe-navigation") {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }

    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    void ingestRawEvent(
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
    if (!isLiteWebRequestPolicyAdmissionOpen(runtime)) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
    if (
      !isLiteWebRequestDocumentUrlUnambiguous(
        runtime.config.capturePolicy?.scope.excludedUrlPatterns ?? [],
        details.type ?? metadata?.resourceType
      )
    ) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }
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

    if (!isLiteWebRequestActivationAuthorized(runtime, authorization)) {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      return;
    }

    if (authorization.kind === "top-navigation" || authorization.kind === "subframe-navigation") {
      deleteRequestMeta(runtime.requestMeta, requestMetaKey);
      if (authorization.kind === "top-navigation" && authorization.navigationCurrent === true) {
        requestStopRuntimeIfCurrent(runtime, "navigation-error");
      }
      return;
    }

    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    void ingestRawEvent(
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

function isLiteWebRequestPolicyAdmissionOpen(runtime: SessionRuntime): boolean {
  return (
    runtime.pendingContentPolicyRevisions.size === 0 &&
    runtime.pendingLiteNetworkPolicyRevisions.size === 0
  );
}

function isLiteWebRequestActivationAuthorized(
  runtime: SessionRuntime,
  decision: LiteWebRequestAuthorizationDecision,
  parentFrameId?: number,
  parentDocumentId?: string
): boolean {
  if (decision.kind === "top-navigation") {
    return true;
  }

  if (decision.kind === "subframe-navigation") {
    return (
      typeof parentFrameId === "number" &&
      typeof parentDocumentId === "string" &&
      hasLiveContentActivationAncestry(runtime, parentFrameId, parentDocumentId)
    );
  }

  const document = runtime.contentDocuments.get(decision.frameId);
  return (
    document !== null &&
    hasLiveContentActivationAncestry(runtime, document.frameId, document.documentId)
  );
}

function hasLiveContentActivationAncestry(
  runtime: SessionRuntime,
  frameId: number,
  documentId: string
): boolean {
  const active = contentActivations.listRuntime(runtime, runtime.captureFence, ["active"]);
  const byDocument = new Map(
    active.map((activation) => [
      contentActivationParentKey(activation.frameId, activation.documentId),
      activation
    ])
  );
  let current = byDocument.get(contentActivationParentKey(frameId, documentId));
  const visited = new Set<string>();

  while (current) {
    const key = contentActivationParentKey(current.frameId, current.documentId);
    if (visited.has(key)) {
      return false;
    }
    visited.add(key);

    if (current.frameId === 0) {
      return current.parent === undefined;
    }
    const parent = current.parent;
    if (!parent) {
      return false;
    }
    current = byDocument.get(contentActivationParentKey(parent.frameId, parent.documentId));
  }

  return false;
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
  await offscreenDocumentLifecycle.ensure({
    exists: async () => {
      const contexts = chromeApi.runtime?.getContexts
        ? await chromeApi.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl]
          })
        : [];
      return contexts.length > 0;
    },
    create: () =>
      chromeApi.offscreen!.createDocument!({
        url: OFFSCREEN_PATH,
        reasons: ["DOM_PARSER", "USER_MEDIA"],
        justification:
          "WebBlackbox uses offscreen document for persistent local recording pipeline and optional tab video capture."
      })
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
    requestStopRuntimeIfCurrent(runtime, "consent-expired");
    return;
  }

  runtime.consentExpiryTimer = setTimeout(
    () => {
      runtime.consentExpiryTimer = null;

      if (Date.now() >= Date.parse(expiresAt)) {
        requestStopRuntimeIfCurrent(runtime, "consent-expired");
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

function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
  return runtimeDisposeTasks.run(runtime, () => disposeStoppedSessionOnce(runtime));
}

async function disposeStoppedSessionOnce(runtime: SessionRuntime): Promise<void> {
  if (!runtime.stoppedAt || !isMapEntrySame(sessionsBySid, runtime.sid, runtime)) {
    return;
  }

  const previousCleanupDeadline = runtime.cleanupDeadline;
  const retryDeadline = Date.now() + RETAINED_STOPPING_RETRY_DELAY_MS;
  runtime.cleanupDeadline = retryDeadline;
  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    runtime.cleanupDeadline = previousCleanupDeadline;
    throw error;
  }

  try {
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

    if (!(await persistStoppedRuntimeRemoval(runtime))) {
      throw new Error("The stopped runtime changed before its removal checkpoint.");
    }
  } catch (error) {
    if (isMapEntrySame(sessionsBySid, runtime.sid, runtime)) {
      await runtimeCleanupScheduler.schedule(runtime.sid, retryDeadline).catch(() => undefined);
    }
    throw error;
  }

  await runtimeCleanupScheduler.cancel(runtime.sid).catch(() => undefined);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await closeOffscreenIfUnused().catch(() => undefined);
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

async function persistStoppedRuntimeRemoval(runtime: SessionRuntime): Promise<boolean> {
  if (!chromeApi?.storage?.local?.set) {
    throw new Error("Chrome storage is unavailable for the stopped-session removal checkpoint.");
  }
  return sessionAnnotationMutations.run(runtime.sid, async () => {
    const previousAnnotation = sessionAnnotations.get(runtime.sid);
    return commitDurableRemoval({
      remove: () => {
        if (!deleteMapEntryIfSame(sessionsBySid, runtime.sid, runtime)) {
          return false;
        }
        sessionAnnotations.delete(runtime.sid);
        return true;
      },
      persist: () =>
        enqueueRuntimeStatePersist(async () => {
          await chromeApi.storage!.local.set({
            [ACTIVE_SESSION_STORAGE_KEY]: createCurrentRuntimeStateSnapshot(),
            [SESSION_ANNOTATIONS_STORAGE_KEY]: serializeSessionAnnotations()
          });
        }),
      restore: () => {
        if (sessionsBySid.has(runtime.sid)) {
          throw new Error("Stopped runtime identity was replaced during removal rollback.");
        }
        sessionsBySid.set(runtime.sid, runtime);
        if (previousAnnotation) {
          sessionAnnotations.set(runtime.sid, previousAnnotation);
        }
      }
    });
  });
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
  await offscreenDocumentLifecycle
    .closeIfUnused({
      isUnused: () =>
        sessionsBySid.size === 0 &&
        retainedStoppingRuntimesBySid.size === 0 &&
        pendingRuntimeRestorationsBySid.size === 0 &&
        runtimeRestorationSourceRowsBySid.size === 0 &&
        offscreenSessionRecovery.size === 0,
      close: async () => {
        await chromeApi?.offscreen?.closeDocument?.();
      }
    })
    .catch(() => undefined);
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

  if (nextUrl && !usesExactContentTopDocumentAuthorization(runtime)) {
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
    const exactTopDocument = usesExactContentTopDocumentAuthorization(runtime);
    const exactDocument = exactTopDocument ? runtime.contentDocuments.get(0) : null;

    if (exactTopDocument && (!exactDocument || exactDocument.url !== nextUrl)) {
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
      if (exactTopDocument) {
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
      if (!exactTopDocument) {
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
    launchCdpNavigationRestore(navigationClaim);
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
  claim: SessionNavigationClaim,
  rawUrl: string
): Promise<void> {
  const runtime = claim.runtime;

  if (!isSessionNavigationClaimCurrent(claim) || !usesExactLiteTopDocumentAuthorization(runtime)) {
    return;
  }

  const decision = await resolveCurrentTabUrlPolicyDecision({
    candidateUrl: rawUrl,
    evaluateAllowed: () => isRuntimeTopDocumentAllowed(runtime, rawUrl),
    resolveCurrentUrl: () => resolveCurrentTabCaptureUrl(runtime.tabId)
  });

  if (!isSessionNavigationClaimCurrent(claim) || decision === "stale") {
    return;
  }

  if (decision === "denied") {
    await stopRuntimeIfNavigationClaimCurrent(claim);
    return;
  }

  // tabs.onUpdated is only an early-deny signal in exact mode. The exact
  // webNavigation document transaction is the sole owner of captureUrl.
}

async function handleTabUrlChanged(
  claim: SessionNavigationClaim,
  rawUrl: string
): Promise<boolean> {
  const runtime = claim.runtime;

  if (
    !isSessionNavigationClaimCurrent(claim) ||
    usesExactContentTopDocumentAuthorization(runtime)
  ) {
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
  await sessionAnnotationMutations.run(sid, async () => {
    const runtime = sessionsBySid.get(sid);
    if (!runtime) {
      return;
    }
    const previousRuntimeAnnotation = { tags: [...runtime.tags], note: runtime.note };
    const previousAnnotation = sessionAnnotations.get(sid);

    await commitSessionAnnotationMutation({
      apply: () => {
        if (runtime) {
          runtime.tags = [...tags];
          runtime.note = note;
        }
        sessionAnnotations.set(sid, {
          tags: [...tags],
          note
        });
      },
      rollback: () => {
        runtime.tags = previousRuntimeAnnotation.tags;
        runtime.note = previousRuntimeAnnotation.note;
        if (previousAnnotation) {
          sessionAnnotations.set(sid, previousAnnotation);
        } else {
          sessionAnnotations.delete(sid);
        }
      },
      persist: persistRuntimeAndAnnotations
    });
  });
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

function mergeStoredSessionAnnotation(runtime: PersistedRuntime): PersistedRuntime {
  return mergePersistedSessionAnnotation(runtime, sessionAnnotations.get(runtime.sid));
}

async function deleteSessionAnnotationDurably(sid: string): Promise<boolean> {
  return sessionAnnotationMutations.run(sid, async () => {
    const previous = sessionAnnotations.get(sid);
    if (!previous) {
      return false;
    }

    sessionAnnotations.delete(sid);
    try {
      await persistSessionAnnotations();
      return true;
    } catch (error) {
      if (!sessionAnnotations.has(sid)) {
        sessionAnnotations.set(sid, previous);
      }
      throw error;
    }
  });
}

async function loadSessionAnnotations(): Promise<void> {
  sessionAnnotations.clear();

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(SESSION_ANNOTATIONS_STORAGE_KEY);
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
    throw new Error("Chrome storage is unavailable for session annotations.");
  }

  await enqueueRuntimeStatePersist(async () => {
    await chromeApi.storage!.local.set({
      [SESSION_ANNOTATIONS_STORAGE_KEY]: serializeSessionAnnotations()
    });
  });
}

async function persistRuntimeAndAnnotations(): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    throw new Error("Chrome storage is unavailable for the session annotation checkpoint.");
  }

  await enqueueRuntimeStatePersist(async () => {
    await chromeApi.storage!.local.set({
      [ACTIVE_SESSION_STORAGE_KEY]: createCurrentRuntimeStateSnapshot(),
      [SESSION_ANNOTATIONS_STORAGE_KEY]: serializeSessionAnnotations()
    });
  });
}

function serializeSessionAnnotations(): Record<string, SessionAnnotation> {
  const serialized: Record<string, SessionAnnotation> = {};

  for (const [sid, annotation] of sessionAnnotations.entries()) {
    serialized[sid] = {
      tags: [...annotation.tags],
      note: annotation.note
    };
  }

  return serialized;
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
          state: "stopping",
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

async function persistRuntimeStoppedCheckpoint(
  runtime: SessionRuntime,
  stoppedAt: number,
  cleanupDeadline: number
): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    throw new Error("Chrome storage is unavailable for the stopped checkpoint.");
  }

  await enqueueRuntimeStatePersist(async () => {
    const snapshot = createCurrentRuntimeStateSnapshot({
      state: "stopped",
      runtime,
      stoppedAt,
      cleanupDeadline
    });
    await chromeApi.storage!.local.set({
      [ACTIVE_SESSION_STORAGE_KEY]: snapshot
    });
  });
}

function createCurrentRuntimeStateSnapshot(
  checkpoint?:
    | {
        state: "stopping";
        runtime: SessionRuntime;
        stopRequestedAt: number;
        cleanupDeadline: number;
      }
    | {
        state: "stopped";
        runtime: SessionRuntime;
        stoppedAt: number;
        cleanupDeadline: number;
      }
) {
  const finalizingScreenRecordings = new Set(
    [...sessionsBySid.values()]
      .filter((runtime) => runtime.screenRecording?.finalizing === true)
      .map((runtime) => runtime.sid)
  );
  const omitCompletedScreenRecording = <Runtime extends PersistedRuntime>(
    runtime: Runtime
  ): Runtime => {
    if (!finalizingScreenRecordings.has(runtime.sid) || !runtime.screenRecording) {
      return runtime;
    }
    const { screenRecording: _completed, ...base } = runtime;
    void _completed;
    return base as Runtime;
  };
  const liveSessions = [...sessionsBySid.values()].map((runtime) => {
    const persisted = toPersistedRuntime(runtime);

    if (checkpoint?.runtime !== runtime) {
      return persisted;
    }

    if (checkpoint.state === "stopped") {
      if (persisted.state !== "active" && persisted.state !== "stopping") {
        throw new Error("Only a live runtime can enter the stopped checkpoint.");
      }

      return createStoppedRuntimeTombstone(
        persisted,
        checkpoint.stoppedAt,
        checkpoint.cleanupDeadline
      );
    }

    if (persisted.state !== "active") {
      throw new Error("Only an active runtime can enter the stopping checkpoint.");
    }
    return createStoppingRuntimeTombstone(
      persisted,
      checkpoint.stopRequestedAt,
      checkpoint.cleanupDeadline
    );
  });
  return createRuntimeStateSnapshot(
    mergeRuntimeStateWithStoppingTombstones(
      [
        ...[...pendingRuntimeRestorationsBySid.values()].map(omitCompletedScreenRecording),
        ...liveSessions
      ],
      [...retainedStoppingRuntimesBySid.values()].map(omitCompletedScreenRecording)
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
  const screenRecording: PersistedScreenRecording | undefined =
    runtime.screenRecording && !runtime.screenRecording.finalizing
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
  runtimeRestorationSourceRowsBySid.clear();
  runtimeRestorationCheckpointRewriteAllowed = false;

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
  const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];
  const snapshot = parseRuntimeStateSnapshot(persisted);
  runtimeRestorationCheckpointRewriteAllowed = persisted === undefined || snapshot !== null;

  if (persisted !== undefined && !snapshot) {
    const identities = extractPersistedRuntimeIdentities(persisted);

    for (const identity of identities) {
      await notifyTabContentReset(identity.tabId, "invalid-runtime-snapshot");
      await purgePersistedRuntimeData(
        {
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
        },
        {
          rethrow: true
        }
      );
    }

    sessionAnnotations.clear();
    await persistSessionAnnotations();
    await chromeApi.storage.local.set({
      [ACTIVE_SESSION_STORAGE_KEY]: createRuntimeStateSnapshot([])
    });
    runtimeRestorationCheckpointRewriteAllowed = true;
    await clearStaleRuntimeCleanupAlarms(new Set());
  } else if (snapshot) {
    const restoredSessions = snapshot.sessions.map(mergeStoredSessionAnnotation);
    runtimeRestorationSourceRowsBySid.clear();
    for (const runtime of restoredSessions) {
      runtimeRestorationSourceRowsBySid.set(runtime.sid, runtime);
      pendingRuntimeRestorationsBySid.set(runtime.sid, runtime);
    }

    const enterprisePolicy = await loadEnterprisePolicy();
    const performanceBudget = await loadPerformanceBudgetConfig();
    const stoppedRuntimes: SessionRuntime[] = [];
    const restorationOrder = [
      ...restoredSessions.filter((runtime) => runtime.state === "stopping"),
      ...restoredSessions.filter((runtime) => runtime.state !== "stopping")
    ];

    for (const persistedRuntime of restorationOrder) {
      let keepPendingRestoration = false;
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

        if (restorationPlan.kind === "finalize-stopping") {
          const retainedTombstone: PersistedStoppingRuntime = {
            ...restorationPlan.runtime,
            config
          };
          retainedStoppingRuntimesBySid.set(retainedTombstone.sid, retainedTombstone);
          await notifyTabContentReset(restorationPlan.runtime.tabId, "stopping-runtime-recovery");
          const runtime = await finalizeRetainedStoppingRuntime(
            retainedTombstone,
            config,
            performanceBudget
          );
          stoppedRuntimes.push(runtime);
          continue;
        }

        const restoration = await restoreActiveRuntime(
          restorationPlan.runtime,
          config,
          performanceBudget
        );

        if (restoration.kind === "rejected") {
          await notifyTabContentReset(restorationPlan.runtime.tabId, "runtime-restore-rejected");
          const retained = await checkpointFailedActiveRuntimeCleanup({
            ...restorationPlan.runtime,
            config
          });
          const runtime = await finalizeRetainedStoppingRuntime(
            retained,
            config,
            performanceBudget
          );
          stoppedRuntimes.push(runtime);
          continue;
        }

        if (restoration.kind === "failed-cleaned") {
          const retained = retainedStoppingRuntimesBySid.get(restorationPlan.runtime.sid);

          if (!retained) {
            throw new Error("Failed active restoration is missing its retained stopping row.");
          }

          const runtime = await finalizeRetainedStoppingRuntime(
            retained,
            config,
            performanceBudget
          );
          stoppedRuntimes.push(runtime);
        }
      } catch (error) {
        console.warn("[WebBlackbox] failed closed while restoring session", {
          sid: persistedRuntime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
        await notifyTabContentReset(persistedRuntime.tabId, "runtime-restore-failed");

        if (persistedRuntime.state === "stopping") {
          console.warn("[WebBlackbox] retained stopping tombstone for recovery retry", {
            sid: persistedRuntime.sid
          });
          const retained = retainedStoppingRuntimesBySid.get(persistedRuntime.sid) ?? {
            ...persistedRuntime,
            config
          };
          retainedStoppingRuntimesBySid.set(retained.sid, retained);
          await scheduleRetainedStoppingRuntimeRecovery(retained).catch((scheduleError) => {
            console.warn("[WebBlackbox] stopping recovery retry schedule failed", {
              sid: persistedRuntime.sid,
              error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError)
            });
          });
          continue;
        }

        if (persistedRuntime.state === "stopped") {
          const retainedStopped: PersistedStoppedRuntime = {
            ...persistedRuntime,
            config
          };
          pendingRuntimeRestorationsBySid.set(retainedStopped.sid, retainedStopped);
          keepPendingRestoration = true;
          await scheduleRetainedStoppedRuntimeRecovery(retainedStopped).catch(() => undefined);
          continue;
        }

        const retained =
          retainedStoppingRuntimesBySid.get(persistedRuntime.sid) ??
          (await checkpointFailedActiveRuntimeCleanup({ ...persistedRuntime, config }));

        try {
          const runtime = await finalizeRetainedStoppingRuntime(
            retained,
            config,
            performanceBudget
          );
          stoppedRuntimes.push(runtime);
        } catch (retentionError) {
          console.warn("[WebBlackbox] active restoration retention remains pending", {
            sid: persistedRuntime.sid,
            error: retentionError instanceof Error ? retentionError.message : String(retentionError)
          });
          await scheduleRetainedStoppingRuntimeRecovery(retained).catch(() => undefined);
        }
      } finally {
        if (!keepPendingRestoration) {
          pendingRuntimeRestorationsBySid.delete(persistedRuntime.sid);
        }
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
    runtimeRestorationSourceRowsBySid.clear();
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
  const durableRecoveryCheckpoint = new DurableRuntimeRecoveryCheckpoint();
  const currentRows: PersistedRuntime[] = [];
  for (const runtime of runtimes) {
    try {
      currentRows.push(toPersistedRuntime(runtime));
    } catch (error) {
      console.warn("[WebBlackbox] failed to snapshot a partial restored runtime", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const recoveryRows = preserveRuntimeRowsAfterGlobalRestoreFailure({
    rows: [
      ...runtimeRestorationSourceRowsBySid.values(),
      ...pendingRuntimeRestorationsBySid.values(),
      ...currentRows,
      ...retainedStoppingRuntimesBySid.values()
    ],
    failedAt: Date.now(),
    resolveLocalTtlMs: (runtime) => resolveRuntimeLocalTtlMs(runtime.config.capturePolicy)
  });

  if (runtimeRestorationCheckpointRewriteAllowed || recoveryRows.length > 0) {
    let checkpointError: unknown;
    const persisted = await durableRecoveryCheckpoint.attempt(async () => {
      try {
        if (!chromeApi?.storage?.local?.set) {
          throw new Error("Chrome storage is unavailable for fail-closed restoration.");
        }
        await chromeApi.storage.local.set({
          [ACTIVE_SESSION_STORAGE_KEY]: createRuntimeStateSnapshot(recoveryRows)
        });
      } catch (error) {
        checkpointError = error;
        throw error;
      }
    });
    if (!persisted) {
      console.warn(
        "[WebBlackbox] failed to persist fail-closed restoration identities",
        checkpointError
      );
    }
  } else {
    console.warn(
      "[WebBlackbox] left the unread runtime checkpoint untouched after restore failure"
    );
  }

  sessionsByTab.clear();
  uninstallLiteWebRequestCaptureIfUnused();

  for (const runtime of runtimes) {
    await runtimeCleanupScheduler.cancel(runtime.sid).catch(() => undefined);
    blockVolatileCapture(runtime.captureFence);
    runtime.queueAccepting = false;
    cancelRuntimeStopDrain(runtime);

    if (!runtime.stoppedAt) {
      await notifyAuthorizedContentFrames(runtime, false).catch(() => undefined);
      await teardownCaptureInstrumentation(runtime).catch(() => undefined);
    }

    resetAuthorizedContentFrames(runtime);

    await runtime.pipeline.close({ purge: false }).catch((error) => {
      console.warn("[WebBlackbox] failed to retain a partial restored pipeline", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    deleteMapEntryIfSame(sessionsBySid, runtime.sid, runtime);
  }

  sessionsBySid.clear();
  retainedStoppingRuntimesBySid.clear();
  pendingRuntimeRestorationsBySid.clear();
  runtimeRestorationSourceRowsBySid.clear();

  for (const runtime of recoveryRows) {
    if (runtime.state === "stopping") {
      retainedStoppingRuntimesBySid.set(runtime.sid, runtime);
      await scheduleRetainedStoppingRuntimeRecovery(runtime).catch(() => undefined);
    } else if (runtime.state === "stopped") {
      pendingRuntimeRestorationsBySid.set(runtime.sid, runtime);
      await scheduleRetainedStoppedRuntimeRecovery(runtime).catch(() => undefined);
    }
  }

  if (runtimeRestorationCheckpointRewriteAllowed || recoveryRows.length > 0) {
    let checkpointError: unknown;
    const persisted = await durableRecoveryCheckpoint.attempt(async () => {
      try {
        await persistRuntimeState({ required: true });
      } catch (error) {
        checkpointError = error;
        throw error;
      }
    });
    if (!persisted) {
      console.warn(
        "[WebBlackbox] fail-closed restoration checkpoint remains pending",
        checkpointError
      );
    }
  }

  for (const port of connectedPorts) {
    if (port.name === PORT_NAMES.content) {
      contentActivations.unbindPort(port);
      port.disconnect?.();
    }
  }

  await setIdleBadge();
  pushSessionList();
  notifyOffscreenPipelineStatus();

  durableRecoveryCheckpoint.requirePersisted();
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
      if (screenRecordingStatus.active && screenRecordingStatus.quiescedForStop) {
        throw new Error("Recovered screen recording carries an unfinished stop intent.");
      }
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
      const armedRoot = requireArmedRootContentActivation(runtime);

      if (
        !isMapEntrySame(sessionsByTab, runtime.tabId, runtime) ||
        !isMapEntrySame(sessionsBySid, runtime.sid, runtime) ||
        !isVolatileCaptureOpen(runtime.captureFence) ||
        runtime.activationState !== "starting" ||
        runtime.stopping ||
        runtime.stoppedAt !== undefined ||
        (runtime.screenRecording !== null && !runtime.screenRecording.provisional)
      ) {
        throw new Error("The restoring runtime lost its content activation identity.");
      }

      activateArmedRuntimeContent(runtime, armedRoot.activationId);
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

  console.warn("[WebBlackbox] partial active runtime restoration retained as stopping", {
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

  return { kind: "failed-cleaned" };
}

async function cleanupFailedPipelineRestoration(
  persisted: PersistedActiveRuntime,
  pipeline: SessionPipelineClient,
  existingTombstone?: PersistedStoppingRuntime
): Promise<void> {
  await runDurableFailedRuntimeRetention({
    persistStopping: async () => {
      await checkpointFailedActiveRuntimeCleanup(persisted, undefined, existingTombstone);
    },
    retain: () => pipeline.close({ purge: false })
  });
}

async function cleanupFailedActiveRuntimeRestoration(
  persisted: PersistedActiveRuntime,
  runtime: SessionRuntime,
  existingTombstone?: PersistedStoppingRuntime
): Promise<void> {
  await runDurableFailedRuntimeRetention({
    persistStopping: async () => {
      await checkpointFailedActiveRuntimeCleanup(persisted, runtime, existingTombstone);
    },
    retain: () => retainFailedActiveRuntimeRestoration(runtime)
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
  let recoverySource = persisted;

  if (runtime && !existingTombstone) {
    const snapshot = toPersistedRuntime(runtime);

    if (snapshot.state === "active") {
      recoverySource = snapshot;
    }
  }

  const tombstone =
    existingTombstone ??
    createStoppingRuntimeTombstone(recoverySource, stopRequestedAt, cleanupDeadline);

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

async function retainFailedActiveRuntimeRestoration(runtime: SessionRuntime): Promise<void> {
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

  await quiesceScreenRecordingForStop(runtime).catch((error) => {
    console.warn("[WebBlackbox] failed to quiesce recorder during retained restoration cleanup", {
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
  await drainPipelineBufferBatches(runtime, "drain").catch((error) => {
    console.warn("[WebBlackbox] failed to retain the provisional pipeline tail", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });
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

  await runtime.pipeline.close({ purge: false });
}

function cancelRuntimeStopDrain(runtime: SessionRuntime): void {
  const pending = pendingStopDrainAcks.get(runtime.sid);

  preparedStopDrainPlans.delete(runtime);

  if (!pending || pending.runtime !== runtime) {
    return;
  }

  pendingStopDrainAcks.delete(runtime.sid);
  clearTimeout(pending.timeout);
  clearInterval(pending.retryTimer);
  for (const capability of pending.capabilities.values()) {
    closeStopDrain(capability);
  }
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

async function finalizeRetainedStoppingRuntime(
  tombstone: PersistedStoppingRuntime,
  config: typeof DEFAULT_RECORDER_CONFIG,
  performanceBudget: PerformanceBudgetConfig
): Promise<SessionRuntime> {
  if (retainedStoppingRuntimesBySid.get(tombstone.sid) !== tombstone) {
    throw new Error("Stopping recovery lost its durable tombstone identity.");
  }

  await ensureOffscreenDocument();
  const pipeline = createOffscreenPipelineClient(tombstone.sid);
  await pipeline.start(
    {
      sid: tombstone.sid,
      tabId: tombstone.tabId,
      startedAt: tombstone.startedAt,
      endedAt: tombstone.stopRequestedAt,
      mode: tombstone.mode,
      url: tombstone.url,
      title: tombstone.title,
      tags: [...tombstone.tags]
    },
    config.redaction,
    config.capturePolicy
  );
  const resumeState = await pipeline.getResumeState();
  const restoredCounters = mergeRuntimeCountersWithSequenceWatermark(
    tombstone.counters,
    resumeState.sequenceWatermark
  );
  const terminalRecoveryConfig = config.capturePolicy
    ? {
        ...config,
        capturePolicy: {
          ...config.capturePolicy,
          categories: {
            ...config.capturePolicy.categories,
            screenRecordings: "allow" as const
          }
        }
      }
    : config;
  let recoveryRuntime: SessionRuntime | null = null;
  let claimedRecordingId: string | undefined;
  let stoppedCounters = restoredCounters;

  await recoverStoppingRuntimeForRetention({
    getScreenRecordingStatus: async () =>
      normalizeOffscreenScreenRecordingStatus(
        await requestOffscreenPipeline<unknown>({
          op: "getScreenRecordingStatus",
          sid: tombstone.sid
        })
      ),
    claimRuntime: (status) => {
      if (recoveryRuntime) {
        throw new Error("Stopping recovery already owns a runtime claim.");
      }
      if (sessionsBySid.has(tombstone.sid) || sessionsByTab.has(tombstone.tabId)) {
        throw new Error("Stopping recovery runtime identity conflicts with a live session.");
      }

      const durable = status.active
        ? resumeState.screenRecordings.find(
            (recording) => recording.recordingId === status.recordingId
          )
        : undefined;
      const persisted =
        status.active && tombstone.screenRecording?.recordingId === status.recordingId
          ? tombstone.screenRecording
          : undefined;
      const provisionalScreenRecording = status.active
        ? (persisted ?? {
            recordingId: status.recordingId,
            startedAt: tombstone.screenRecording?.startedAt ?? tombstone.startedAt,
            startedMono: tombstone.screenRecording?.startedMono ?? 0,
            mime: status.mime,
            width: status.width,
            height: status.height,
            frameRate: status.frameRate,
            chunkCount: 0,
            sizeBytes: 0
          })
        : undefined;
      const reconciled = reconcileScreenRecordingResumeState(provisionalScreenRecording, durable);
      const screenRecording = provisionalScreenRecording
        ? (reconciled.screenRecording ?? {
            ...provisionalScreenRecording,
            chunkCount: 0,
            sizeBytes: 0
          })
        : undefined;
      const runtime = createSessionRuntime({
        sid: tombstone.sid,
        tabId: tombstone.tabId,
        mode: tombstone.mode,
        url: tombstone.url,
        captureUrl: tombstone.url,
        title: tombstone.title,
        tags: tombstone.tags,
        note: tombstone.note,
        config: terminalRecoveryConfig,
        startedAt: tombstone.startedAt,
        pipeline,
        performanceBudget,
        counters: restoredCounters,
        screenRecording,
        screenRecordingChunks: reconciled.chunks
      });
      blockVolatileCapture(runtime.captureFence);
      runtime.stopping = true;
      runtime.stopRequestedAt = tombstone.stopRequestedAt;
      runtime.cleanupDeadline = tombstone.cleanupDeadline;
      sessionsByTab.set(runtime.tabId, runtime);
      sessionsBySid.set(runtime.sid, runtime);
      recoveryRuntime = runtime;
      claimedRecordingId = status.active ? status.recordingId : undefined;
    },
    stopScreenRecording: async (status) => {
      const runtime = recoveryRuntime;
      const recording = runtime?.screenRecording;

      if (!runtime || !recording || recording.recordingId !== status.recordingId) {
        throw new Error("Stopping recovery lost its exact screen-recording claim.");
      }

      await stopScreenRecording(runtime, "stop-tombstone-recovery", recording);
    },
    retain: async () => {
      const runtime = recoveryRuntime;

      if (!runtime) {
        throw new Error("Stopping recovery is missing its runtime claim.");
      }

      const interrupted = buildInterruptedScreenRecordingRecoveries({
        persisted: tombstone.screenRecording,
        resumeState,
        status: claimedRecordingId
          ? {
              active: true,
              recordingId: claimedRecordingId,
              mime: runtime.screenRecording?.mime ?? tombstone.screenRecording?.mime ?? "video/webm"
            }
          : { active: false },
        claimedRecordingId
      });

      for (const recording of interrupted) {
        await appendInterruptedScreenRecordingTerminalEvents(
          runtime,
          recording,
          "stop-tombstone-recovery-incomplete"
        );
      }

      await flushBufferedPipelineEvents(runtime);
      await pipeline.flush();
      stoppedCounters = toPersistedRuntime(runtime).counters;
      await pipeline.close({ purge: false });
    },
    releaseRuntimeClaim: () => {
      const runtime = recoveryRuntime;

      if (!runtime) {
        return;
      }

      if (runtime.pipelineFlushTimer !== null) {
        clearTimeout(runtime.pipelineFlushTimer);
        runtime.pipelineFlushTimer = null;
      }
      blockVolatileCapture(runtime.captureFence);
      runtime.queueAccepting = false;
      deleteMapEntryIfSame(sessionsByTab, runtime.tabId, runtime);
      deleteMapEntryIfSame(sessionsBySid, runtime.sid, runtime);
      recoveryRuntime = null;
    }
  });

  const { screenRecording: completedScreenRecording, ...terminalizedBase } = tombstone;
  void completedScreenRecording;
  const terminalizedTombstone: PersistedStoppingRuntime = {
    ...terminalizedBase,
    counters: stoppedCounters
  };

  if (retainedStoppingRuntimesBySid.get(tombstone.sid) !== tombstone) {
    throw new Error("Stopping recovery tombstone changed before terminal evidence checkpointing.");
  }
  retainedStoppingRuntimesBySid.set(tombstone.sid, terminalizedTombstone);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    if (retainedStoppingRuntimesBySid.get(tombstone.sid) === terminalizedTombstone) {
      retainedStoppingRuntimesBySid.set(tombstone.sid, tombstone);
    }
    throw error;
  }

  const stopped = createStoppedRuntimeTombstone(
    terminalizedTombstone,
    tombstone.stopRequestedAt,
    tombstone.cleanupDeadline
  );
  const restored = await restoreStoppedRuntime(stopped, config, performanceBudget);
  const pending = pendingRuntimeRestorationsBySid.get(tombstone.sid);

  if (!deleteMapEntryIfSame(retainedStoppingRuntimesBySid, tombstone.sid, terminalizedTombstone)) {
    deleteMapEntryIfSame(sessionsBySid, restored.sid, restored);
    await restored.pipeline.close({ purge: false }).catch(() => undefined);
    throw new Error("Stopping recovery tombstone changed before its stopped checkpoint.");
  }
  pendingRuntimeRestorationsBySid.delete(tombstone.sid);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    deleteMapEntryIfSame(sessionsBySid, restored.sid, restored);
    await restored.pipeline.close({ purge: false }).catch(() => undefined);
    retainedStoppingRuntimesBySid.set(tombstone.sid, terminalizedTombstone);
    if (pending) {
      pendingRuntimeRestorationsBySid.set(tombstone.sid, pending);
    }
    await scheduleRetainedStoppingRuntimeRecovery(terminalizedTombstone).catch(() => undefined);
    throw error;
  }

  await scheduleStoppedRuntimeCleanup(restored).catch((error) => {
    console.warn("[WebBlackbox] recovered stopped-session cleanup scheduled for retry", {
      sid: restored.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return restored;
}

async function appendInterruptedScreenRecordingTerminalEvents(
  runtime: SessionRuntime,
  interrupted: ReturnType<typeof buildInterruptedScreenRecordingRecoveries>[number],
  reason: string
): Promise<void> {
  const hashes = [...interrupted.chunks]
    .sort((left, right) => left.index - right.index)
    .map((chunk) => chunk.hash);
  const endedAt = Date.now();
  const endAccepted = await ingestRawEvent({
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
      reason
    }
  });
  const errorAccepted = await ingestRawEvent({
    source: "system",
    rawType: "screen.recording.error",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: endedAt,
    mono: monotonicTime(),
    payload: {
      recordingId: interrupted.recordingId,
      name: "OffscreenRecordingInterrupted",
      message: "Screen recording was interrupted while a stopping runtime was recovered.",
      stage: "restart"
    }
  });

  if (!endAccepted || !errorAccepted) {
    throw new Error("Stopping recovery could not persist screen-recording terminal evidence.");
  }
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
  try {
    await deleteSessionAnnotationDurably(runtime.sid);
  } catch (error) {
    if (options.rethrow) {
      throw error;
    }
    console.warn("[WebBlackbox] failed to delete purged-session annotation", error);
  }

  try {
    await ensureOffscreenDocument();
    const pipeline = createOffscreenPipelineClient(runtime.sid);
    const metadata: SessionMetadata = {
      sid: runtime.sid,
      tabId: runtime.tabId,
      startedAt: runtime.startedAt,
      mode: runtime.mode,
      url: sanitizeUrlForPrivacy(runtime.url),
      title: runtime.title,
      tags: [...runtime.tags]
    };
    try {
      await pipeline.start(metadata, runtime.config.redaction, runtime.config.capturePolicy);
    } catch {
      // A surviving offscreen pipeline may carry a now-untrusted policy
      // fingerprint. Purge that exact instance, then recreate an empty client
      // so storage cleanup remains possible without accepting the old policy.
      await pipeline.close({ purge: true });
      await pipeline.start(metadata, runtime.config.redaction, runtime.config.capturePolicy);
    }

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

async function scheduleRetainedStoppedRuntimeRecovery(
  runtime: PersistedStoppedRuntime
): Promise<void> {
  const retryAt = Math.min(runtime.cleanupDeadline, Date.now() + RETAINED_STOPPING_RETRY_DELAY_MS);
  await runtimeCleanupScheduler.schedule(runtime.sid, retryAt);
}

async function retryRetainedStoppingRuntimeRecovery(
  runtime: PersistedStoppingRuntime
): Promise<void> {
  const enterprisePolicy = await loadEnterprisePolicy();
  const config = applyEnterprisePolicyToRecorderConfig(runtime.config, enterprisePolicy);
  const performanceBudget = await loadPerformanceBudgetConfig();
  await finalizeRetainedStoppingRuntime(runtime, config, performanceBudget);
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

async function retryRetainedStoppedRuntimeRecovery(
  runtime: PersistedStoppedRuntime
): Promise<void> {
  if (pendingRuntimeRestorationsBySid.get(runtime.sid) !== runtime) {
    return;
  }

  if (Date.now() >= runtime.cleanupDeadline) {
    await purgePersistedRuntimeData(runtime, { rethrow: true });
    pendingRuntimeRestorationsBySid.delete(runtime.sid);

    try {
      await persistRuntimeState({ required: true });
    } catch (error) {
      pendingRuntimeRestorationsBySid.set(runtime.sid, runtime);
      throw error;
    }
    return;
  }

  const enterprisePolicy = await loadEnterprisePolicy();
  const config = applyEnterprisePolicyToRecorderConfig(runtime.config, enterprisePolicy);
  const performanceBudget = await loadPerformanceBudgetConfig();
  const restored = await restoreStoppedRuntime(runtime, config, performanceBudget);
  pendingRuntimeRestorationsBySid.delete(runtime.sid);

  try {
    await persistRuntimeState({ required: true });
  } catch (error) {
    deleteMapEntryIfSame(sessionsBySid, restored.sid, restored);
    await restored.pipeline.close({ purge: false }).catch(() => undefined);
    pendingRuntimeRestorationsBySid.set(runtime.sid, runtime);
    throw error;
  }

  await scheduleStoppedRuntimeCleanup(restored);
  pushSessionList();
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
      !runtime.stoppedAt &&
      ((isVolatileCaptureOpen(runtime.captureFence) && !runtime.stopping) ||
        isRuntimeAwaitingDurableStop(runtime))
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

async function notifyTabContentReset(tabId: number, reason: string): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  await chromeApi.tabs
    .sendMessage(tabId, { kind: "sw.content-reset", reason })
    .catch(() => undefined);
}

function quiesceRuntimeContentProducers(runtime: SessionRuntime): void {
  for (const activation of contentActivations.listRuntime(runtime, runtime.captureFence, [
    "active"
  ])) {
    const message = {
      kind: "sw.content-quiesce" as const,
      activationId: activation.activationId
    };
    let deliveredToPort = false;

    for (const port of connectedPorts) {
      if (
        port.name !== PORT_NAMES.content ||
        !contentActivations.validatePort(port, activation, ["active"])
      ) {
        continue;
      }

      try {
        port.postMessage(message);
        deliveredToPort = true;
        break;
      } catch (error) {
        logPortSendFailure("sw.content-quiesce", error, {
          activationId: activation.activationId,
          frameId: activation.frameId
        });
      }
    }

    if (!deliveredToPort) {
      void sendContentActivationMessage(activation, message, { required: true }).catch((error) => {
        logInboundMessageFailure("sw.content-quiesce", error, undefined, {
          activationId: activation.activationId,
          frameId: activation.frameId
        });
      });
    }
  }
}

async function notifyAuthorizedContentFrames(
  runtime: SessionRuntime,
  active: boolean,
  stopDrains?: ReadonlyMap<ContentActivationId, StopDrainNotice>
): Promise<void> {
  if (active) {
    const activated = isRuntimeCaptureAdmitted(runtime.activationState)
      ? activateArmedRuntimeContent(runtime)
      : [];
    const current = [
      ...activated,
      ...contentActivations.listRuntime(runtime, runtime.captureFence, ["active"])
    ];
    const unique = new Map(current.map((activation) => [activation.activationId, activation]));
    await Promise.all(
      [...unique.values()].map((activation) =>
        sendContentActivationMessage(activation, {
          kind: "sw.content-activated",
          activationId: activation.activationId
        })
      )
    );
    return;
  }

  const live = contentActivations.listRuntime(runtime, runtime.captureFence);
  const shouldDrain = (activation: SessionContentActivation): boolean =>
    activation.state === "draining" && stopDrains?.has(activation.activationId) === true;

  await Promise.all(
    live.map(async (activation) => {
      const stopDrain = stopDrains?.get(activation.activationId);

      if (stopDrain && shouldDrain(activation)) {
        await sendContentActivationMessage(activation, stopDrain, { required: true });
        return;
      }

      await revokeContentActivationOnce(activation, "runtime-stop");
    })
  );
}

function adjustInFlightContentMessages(activationId: ContentActivationId, delta: 1 | -1): void {
  const next = (inFlightContentMessagesByActivation.get(activationId) ?? 0) + delta;

  if (next <= 0) {
    inFlightContentMessagesByActivation.delete(activationId);
    resolveStopDrainAckForActivation(activationId);
    return;
  }

  inFlightContentMessagesByActivation.set(activationId, next);
}

function getOrCreateContentEventBatchRecord(
  activationId: ContentActivationId,
  batchId: ContentEventBatchId,
  fingerprint: string,
  port: PortLike
): { record: ContentEventBatchRecord<PortLike>; process: boolean } {
  const result = contentEventBatchLedger.begin(activationId, batchId, fingerprint, port);
  return { record: result.record, process: result.kind === "process" };
}

function retryContentEventBatch(
  activationId: ContentActivationId,
  batchId: ContentEventBatchId,
  record: ContentEventBatchRecord<PortLike>
): void {
  contentEventBatchLedger.retry(activationId, batchId, record);
}

function completeContentEventBatch(
  activationId: ContentActivationId,
  batchId: ContentEventBatchId,
  record: ContentEventBatchRecord<PortLike>
): void {
  for (const port of contentEventBatchLedger.complete(activationId, batchId, record)) {
    sendContentEventBatchAck(port, activationId, batchId);
  }
}

function sendContentEventBatchAck(
  port: PortLike,
  activationId: ContentActivationId,
  batchId: ContentEventBatchId
): void {
  try {
    port.postMessage({
      kind: "sw.content-events-ack",
      activationId,
      batchId
    });
  } catch (error) {
    logPortSendFailure("sw.content-events-ack", error, { activationId, batchId });
  }
}

function invalidateContentEventBatchAdmissions(activationId: ContentActivationId): void {
  const admissions = contentEventBatchAdmissionsByActivation.get(activationId);
  if (admissions) {
    for (const admission of admissions) {
      admission.valid = false;
    }
    contentEventBatchAdmissionsByActivation.delete(activationId);
  }
  contentEventBatchLedger.invalidate(activationId);
}

function createStopDrainAck(runtime: SessionRuntime): {
  wait: Promise<void>;
  notices: ReadonlyMap<ContentActivationId, StopDrainNotice>;
} {
  const existing = pendingStopDrainAcks.get(runtime.sid);

  if (existing) {
    clearTimeout(existing.timeout);
    clearInterval(existing.retryTimer);
    pendingStopDrainAcks.delete(runtime.sid);
    for (const capability of existing.capabilities.values()) {
      closeStopDrain(capability);
    }
    existing.resolve();
  }

  const deadline = Date.now() + STOP_DRAIN_ACK_TIMEOUT_MS;
  const ordinaryEventCutoff = runtime.stopRequestedAt ?? Date.now();
  const capabilities = new Map<ContentActivationId, StopDrainCapability>();
  const notices = new Map<ContentActivationId, StopDrainNotice>();

  for (const activation of contentActivations.listRuntime(runtime, runtime.captureFence, [
    "active"
  ])) {
    const draining = contentActivations.drain(activation);

    if (!draining) {
      continue;
    }

    try {
      const capability = createStopDrainCapability({
        runtime,
        fence: runtime.captureFence,
        activationId: draining.activationId,
        sid: runtime.sid,
        tabId: runtime.tabId,
        frameId: draining.frameId,
        documentId: draining.documentId,
        documentUrl: draining.url,
        deadline,
        ordinaryEventCutoff
      });
      capabilities.set(capability.activationId, capability);
      notices.set(capability.activationId, toStopDrainNotice(capability));
    } catch (error) {
      console.warn("[WebBlackbox] stop-drain capability creation failed closed", {
        sid: runtime.sid,
        frameId: draining.frameId,
        error: error instanceof Error ? error.message : String(error)
      });
      void revokeContentFrameActivations(
        runtime,
        draining.frameId,
        "stop-drain-capability-failed",
        draining.documentId
      );
    }
  }

  if (capabilities.size === 0) {
    return { wait: Promise.resolve(), notices };
  }

  let pending!: PendingStopDrainAck;
  const wait = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      void finalizeExpiredStopDrain(pending);
    }, STOP_DRAIN_ACK_TIMEOUT_MS);
    const retryTimer = setInterval(() => {
      retryPendingStopDrainNotices(pending);
    }, STOP_DRAIN_NOTIFICATION_RETRY_MS);

    pending = {
      sid: runtime.sid,
      runtime,
      capabilities,
      acknowledged: new Set(),
      settling: false,
      timeoutFinalizing: false,
      timeoutNoticeQueued: false,
      resolve,
      timeout,
      retryTimer
    };
    pendingStopDrainAcks.set(runtime.sid, pending);
  });

  return {
    wait,
    notices
  };
}

async function finalizeExpiredStopDrain(pending: PendingStopDrainAck): Promise<void> {
  if (
    pendingStopDrainAcks.get(pending.sid) !== pending ||
    pending.settling ||
    pending.timeoutFinalizing
  ) {
    return;
  }

  pending.timeoutFinalizing = true;
  const expired = [...pending.capabilities].filter(
    ([activationId]) => !pending.acknowledged.has(activationId)
  );

  try {
    if (!pending.timeoutNoticeQueued && expired.length > 0) {
      for (const [activationId, capability] of expired) {
        capability.accepting = false;
        const expectedArtifacts = resolveExpectedStopDrainArtifactsForCapability(
          pending.runtime,
          capability
        );
        const timeoutEvidence = resolveStopDrainTimeoutEvidence(capability, expectedArtifacts);
        pending.runtime.recorder.ingest({
          source: "system",
          rawType: "notice",
          sid: pending.runtime.sid,
          tabId: pending.runtime.tabId,
          t: Date.now(),
          mono: monotonicTime(),
          frame: normalizeContentFrameId(capability.frameId),
          payload: {
            message: "stop-drain-timeout",
            activationId,
            frameId: capability.frameId,
            documentId: capability.documentId,
            documentUrl: sanitizeUrlForPrivacy(capability.documentUrl),
            ...timeoutEvidence,
            droppedOrdinaryEvents: capability.droppedOrdinaryEvents
          }
        });
      }
      pending.timeoutNoticeQueued = true;
    }

    await flushContentEventBatchDurably(pending.runtime);
  } catch (error) {
    logInboundMessageFailure("stop-drain-timeout", error, undefined, {
      sid: pending.sid,
      frames: expired.length
    });
    pending.timeoutFinalizing = false;
    pending.timeout = setTimeout(() => {
      void finalizeExpiredStopDrain(pending);
    }, STOP_DRAIN_NOTIFICATION_RETRY_MS);
    return;
  }

  for (const [activationId, capability] of expired) {
    capability.accepting = false;
    capability.acknowledged = true;
    pending.acknowledged.add(activationId);
    invalidateContentEventBatchAdmissions(activationId);
  }
  pending.timeoutFinalizing = false;
  resolveStopDrainAckIfReady(pending, true);
}

function prepareRuntimeStopDrain(runtime: SessionRuntime): {
  wait: Promise<void>;
  notification: Promise<void>;
} {
  const existing = preparedStopDrainPlans.get(runtime);

  if (existing) {
    return existing;
  }

  const drain = createStopDrainAck(runtime);
  const rawNotification = notifyAuthorizedContentFrames(runtime, false, drain.notices);
  const plan = {
    wait: drain.wait,
    notification: withCdpCommandTimeout(rawNotification, STOP_DRAIN_NOTIFICATION_TIMEOUT_MS).then(
      (outcome) => {
        if (!outcome.ok) {
          throw new Error("Timed out notifying exact content documents to drain.");
        }
      }
    )
  };
  preparedStopDrainPlans.set(runtime, plan);
  return plan;
}

function getStopDrainCapability(
  sid: string,
  activationId: ContentActivationId
): StopDrainCapability | undefined {
  return pendingStopDrainAcks.get(sid)?.capabilities.get(activationId);
}

function toStopDrainNotice(capability: StopDrainCapability): StopDrainNotice {
  return {
    kind: "sw.content-drain",
    activationId: capability.activationId,
    sid: capability.sid,
    token: capability.token,
    deadline: capability.deadline,
    documentUrl: capability.documentUrl
  };
}

function sendStopDrainNotice(port: PortLike, capability: StopDrainCapability): boolean {
  try {
    port.postMessage(toStopDrainNotice(capability));
    return true;
  } catch (error) {
    logPortSendFailure("sw.content-drain", error, {
      activationId: capability.activationId,
      sid: capability.sid
    });
    return false;
  }
}

function retryPendingStopDrainNotices(pending: PendingStopDrainAck): void {
  if (pendingStopDrainAcks.get(pending.sid) !== pending || pending.settling) {
    return;
  }

  for (const [activationId, capability] of pending.capabilities) {
    if (pending.acknowledged.has(activationId)) {
      continue;
    }
    const activation = contentActivations.lookupByActivationId(activationId, ["draining"]);
    if (!activation) {
      continue;
    }

    let deliveredToPort = false;
    for (const port of connectedPorts) {
      if (
        port.name === PORT_NAMES.content &&
        contentActivations.validatePort(port, activation, ["draining"])
      ) {
        deliveredToPort = sendStopDrainNotice(port, capability);
        if (deliveredToPort) {
          break;
        }
      }
    }

    if (!deliveredToPort) {
      void sendContentActivationMessage(activation, toStopDrainNotice(capability), {
        required: true
      }).catch((error) => {
        logInboundMessageFailure("sw.content-drain", error, undefined, {
          activationId,
          stage: "retry"
        });
      });
    }
  }
}

async function markStopDrainAckReceived(
  message: Extract<ExtensionInboundMessage, { kind: "content.stop-drained" }>,
  port: PortLike | undefined,
  sender: MessageSenderLike | undefined
): Promise<void> {
  const pending = pendingStopDrainAcks.get(message.sid);

  if (!pending) {
    return;
  }

  const runtime = sessionsBySid.get(message.sid);
  const capability = pending.capabilities.get(message.activationId);
  const activation = resolveBoundContentActivation(
    message.activationId,
    message.documentUrl,
    port,
    sender,
    ["draining"]
  );
  const binding = runtime
    ? {
        runtime,
        fence: runtime.captureFence,
        activationId: message.activationId,
        token: message.token,
        sid: message.sid,
        tabId: sender?.tab?.id ?? -1,
        frameId: normalizeSenderFrameId(sender),
        documentId: sender?.documentId ?? "",
        documentUrl: message.documentUrl
      }
    : null;

  if (
    !runtime ||
    runtime !== pending.runtime ||
    !capability ||
    !activation ||
    activation.runtime !== runtime ||
    !binding ||
    !canAdmitStopDrainBatch(capability, binding)
  ) {
    return;
  }

  const expectedArtifacts = resolveExpectedStopDrainArtifacts(runtime, activation);
  const committedArtifacts = new Set(getCommittedStopDrainArtifactTypes(capability));
  const emittedArtifacts = expectedArtifacts.filter((artifact) =>
    artifact === "main-world-tail"
      ? message.emittedArtifacts.includes(artifact)
      : committedArtifacts.has(artifact)
  );
  const omittedArtifacts = expectedArtifacts.filter(
    (artifact) => !emittedArtifacts.includes(artifact)
  );
  const evidenceMismatch =
    !sameStringSet(message.expectedArtifacts, expectedArtifacts) ||
    !sameStringSet(message.emittedArtifacts, emittedArtifacts) ||
    !sameStringSet(message.omittedArtifacts, omittedArtifacts);

  if (
    omittedArtifacts.length > 0 ||
    message.degradationReasons.length > 0 ||
    evidenceMismatch ||
    capability.droppedOrdinaryEvents > 0
  ) {
    const noticeClaim = claimStopDrainEvent(capability, {
      ...binding,
      batchId: `b1_${capability.token}`,
      eventIndex: 0,
      rawType: "notice",
      reason: "stop"
    });
    if (!noticeClaim) {
      return;
    }

    try {
      const persisted = await ingestRawEvent(
        {
          source: "system",
          rawType: "notice",
          sid: runtime.sid,
          tabId: runtime.tabId,
          t: Date.now(),
          mono: monotonicTime(),
          frame: normalizeContentFrameId(activation.frameId),
          payload: {
            message: "stop-artifacts-omitted",
            expectedArtifacts,
            emittedArtifacts,
            omittedArtifacts,
            degradationReasons: message.degradationReasons,
            evidenceMismatch,
            droppedOrdinaryEvents: capability.droppedOrdinaryEvents
          }
        },
        noticeClaim
      );
      if (!persisted) {
        throw new Error("Stop-drain degradation notice was not accepted.");
      }
      await flushContentEventBatchDurably(runtime);
      if (!commitStopDrainClaim(noticeClaim, runtime, runtime.captureFence)) {
        throw new Error("Stop-drain degradation notice could not be committed.");
      }
    } catch (error) {
      releaseStopDrainClaim(noticeClaim);
      logInboundMessageFailure("content.stop-drained", error, port, {
        activationId: activation.activationId,
        stage: "degradation-notice"
      });
      return;
    }
  }

  if (!acknowledgeStopDrain(capability, binding)) {
    return;
  }

  pending.acknowledged.add(message.activationId);
  resolveStopDrainAckIfReady(pending);
}

function resolveExpectedStopDrainArtifacts(
  runtime: SessionRuntime,
  activation: Pick<SessionContentActivation, "frameId">
): Array<"main-world-tail" | "snapshot" | "localStorageSnapshot" | "screenshot"> {
  if (runtime.mode !== "lite") {
    return [];
  }

  const expected: Array<"main-world-tail" | "snapshot" | "localStorageSnapshot" | "screenshot"> = [
    "main-world-tail"
  ];
  if (activation.frameId !== 0) {
    return expected;
  }
  if (runtime.config.capturePolicy?.categories.dom !== "off") {
    expected.push("snapshot");
  }
  if (runtime.config.capturePolicy?.categories.storage !== "off") {
    expected.push("localStorageSnapshot");
  }
  if (
    runtime.config.sampling.screenshotIdleMs > 0 &&
    runtime.config.capturePolicy?.categories.screenshots === "allow"
  ) {
    expected.push("screenshot");
  }
  return expected;
}

function resolveExpectedStopDrainArtifactsForCapability(
  runtime: SessionRuntime,
  capability: StopDrainCapability
): Array<"main-world-tail" | "snapshot" | "localStorageSnapshot" | "screenshot"> {
  return resolveExpectedStopDrainArtifacts(runtime, capability);
}

function sameStringSet(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value) => second.includes(value));
}

function resolveStopDrainAckForActivation(activationId: ContentActivationId): void {
  for (const pending of pendingStopDrainAcks.values()) {
    if (pending.capabilities.has(activationId)) {
      resolveStopDrainAckIfReady(pending);
    }
  }
}

function resolveStopDrainAckIfReady(pending: PendingStopDrainAck, force = false): void {
  if (pending.acknowledged.size !== pending.capabilities.size || pending.settling) {
    return;
  }

  if (
    !force &&
    [...pending.capabilities.keys()].some(
      (activationId) => (inFlightContentMessagesByActivation.get(activationId) ?? 0) > 0
    )
  ) {
    return;
  }

  pending.settling = true;

  const finalize = () => {
    if (pendingStopDrainAcks.get(pending.sid) === pending) {
      pendingStopDrainAcks.delete(pending.sid);
    }

    clearTimeout(pending.timeout);
    clearInterval(pending.retryTimer);
    const drainingSnapshots = [...pending.capabilities.keys()]
      .map((activationId) => contentActivations.lookupByActivationId(activationId, ["draining"]))
      .filter((activation): activation is SessionContentActivation => activation !== null);

    for (const [activationId, capability] of pending.capabilities) {
      closeStopDrain(capability);
      invalidateContentEventBatchAdmissions(activationId);
    }
    void revokeContentActivationSnapshots(drainingSnapshots, "stop-drained");
    pending.resolve();
  };

  void withCdpCommandTimeout(pending.runtime.queue, STOP_DRAIN_QUEUE_SETTLE_TIMEOUT_MS).then(
    finalize,
    finalize
  );
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
