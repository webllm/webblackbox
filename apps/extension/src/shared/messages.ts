import type {
  CaptureMode,
  CapturePolicy,
  ExportPolicy,
  FreezeReason,
  PrivacyScannerFindingKind,
  SamplingProfile
} from "@webblackbox/protocol";

import type { RawRecorderEvent } from "@webblackbox/recorder";
import type { InjectedDirectControlResult } from "webblackbox/injected-hooks";

import type {
  ContentActivationId,
  ContentEventBatchId,
  ContentReadyId
} from "./content-activation-protocol.js";
import type { MainWorldControllerHint } from "./main-world-controller.js";

export const PORT_NAMES = {
  content: "webblackbox:content",
  popup: "webblackbox:popup",
  options: "webblackbox:options",
  sessions: "webblackbox:sessions",
  offscreen: "webblackbox:offscreen"
} as const;

export const CONTENT_EVENT_BATCH_MAX = 120;

export type OffscreenScreenRecordingChunkMessage = {
  kind: "offscreen.screen-recording-chunk";
  sid: string;
  recordingId: string;
  index: number;
  mime: string;
  bytes: Uint8Array;
  size: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
  durationMs?: number;
};

export type ScreenRecordingChunkAckMessage = {
  kind: "sw.screen-recording-chunk-ack";
  sid: string;
  recordingId: string;
  index: number;
  size: number;
  chunkId: string;
};

export type FullModeVisualCapture = "screenshots" | "recording" | "both" | "none";

export type UiStartSessionMessage = {
  kind: "ui.start";
  tabId?: number;
  mode: CaptureMode;
  reloadPage?: boolean;
  visualCapture?: FullModeVisualCapture;
  /**
   * Backward-compatible alias for older popup/runtime callers. New callers
   * should send `visualCapture` so screenshots can be disabled for
   * recording-only full sessions.
   */
  recordScreen?: boolean;
};

export type UiStopSessionMessage = {
  kind: "ui.stop";
  tabId?: number;
};

export type UiExportSessionMessage = {
  kind: "ui.export";
  sid: string;
  passphrase?: string;
  saveAs?: boolean;
  policy?: Partial<ExportPolicy>;
};

export type UiDeleteSessionMessage = {
  kind: "ui.delete";
  sid: string;
};

export type UiAnnotateSessionMessage = {
  kind: "ui.annotate";
  sid: string;
  tags?: string[];
  note?: string;
};

export type UiRequestSessionListMessage = {
  kind: "ui.request-session-list";
};

export type ContentEventBatchMessage = {
  kind: "content.events";
  activationId: ContentActivationId;
  batchId: ContentEventBatchId;
  events: RawRecorderEvent[];
  documentUrl: string;
  stopDrainToken?: string;
};

export type ContentEventBatchAckMessage = {
  kind: "sw.content-events-ack";
  activationId: ContentActivationId;
  batchId: ContentEventBatchId;
};

export type ContentMarkerMessage = {
  kind: "content.marker";
  activationId: ContentActivationId;
  message: string;
  documentUrl: string;
};

export type ContentReadyMessage = {
  kind: "content.ready";
  readyId: ContentReadyId;
  reason: "requested" | "pageshow" | "recovery";
  currentActivationId?: ContentActivationId;
  documentUrl: string;
  mainWorldController: MainWorldControllerHint | null;
};

export type ContentMainWorldControlMessage = {
  kind: "content.main-world-control";
  activationId: ContentActivationId;
  documentUrl: string;
  operation: "activate" | "deactivate" | "drain";
};

export type ContentArmedMessage = {
  kind: "content.armed";
  readyId: ContentReadyId;
  activationId: ContentActivationId;
  documentUrl: string;
};

export type ContentBindMessage = {
  kind: "content.bind";
  activationId: ContentActivationId;
  documentUrl: string;
};

export type ContentStopDrainedMessage = {
  kind: "content.stop-drained";
  activationId: ContentActivationId;
  sid: string;
  token: string;
  documentUrl: string;
  expectedArtifacts: ContentStopDrainArtifact[];
  emittedArtifacts: ContentStopDrainArtifact[];
  omittedArtifacts: ContentStopDrainOmission[];
  degradationReasons: ContentStopDrainDegradationReason[];
};

export type ContentStopDrainArtifact =
  | "main-world-tail"
  | "snapshot"
  | "localStorageSnapshot"
  | "screenshot";
export type ContentStopDrainOmission = ContentStopDrainArtifact;
export type ContentStopDrainDegradationReason =
  | "artifact-error"
  | "disposed"
  | "inactive"
  | "out-of-scope"
  | "main-world-tail-timeout"
  | "content-drain-error";

export type ExtensionInboundMessage =
  | UiStartSessionMessage
  | UiStopSessionMessage
  | UiExportSessionMessage
  | UiDeleteSessionMessage
  | UiAnnotateSessionMessage
  | UiRequestSessionListMessage
  | ContentEventBatchMessage
  | ContentMarkerMessage
  | ContentReadyMessage
  | ContentMainWorldControlMessage
  | ContentArmedMessage
  | ContentBindMessage
  | ContentStopDrainedMessage;

export type RecordingStatusMessage = {
  kind: "sw.recording-status";
  active: boolean;
  tabId?: number;
  sid?: string;
  mode?: CaptureMode;
  sampling?: Pick<
    SamplingProfile,
    | "mousemoveHz"
    | "scrollHz"
    | "domFlushMs"
    | "snapshotIntervalMs"
    | "screenshotIdleMs"
    | "bodyCaptureMaxBytes"
  >;
  capturePolicy?: CapturePolicy;
  stopDrain?: {
    token: string;
    deadline: number;
    documentUrl: string;
  };
};

export type RequestContentReadyMessage = {
  kind: "sw.request-content-ready";
  sameDocumentTransition?: ContentSameDocumentTransition;
};

export type ContentSameDocumentTransition = {
  previousActivationId: ContentActivationId;
  frameId: number;
  documentId: string;
  previousDocumentUrl: string;
  documentUrl: string;
  revision: number;
};

export type ContentPrepareMessage = {
  kind: "sw.content-prepare";
  readyId: ContentReadyId;
  activationId: ContentActivationId;
  sid: string;
  tabId: number;
  mode: CaptureMode;
  sampling: RecordingStatusMessage["sampling"];
  capturePolicy: CapturePolicy;
  mainWorldController: MainWorldControllerHint | null;
};

export type ContentInactiveMessage = {
  kind: "sw.content-inactive";
  readyId: ContentReadyId;
};

export type ContentActivatedMessage = {
  kind: "sw.content-activated";
  activationId: ContentActivationId;
};

export type ContentMainWorldControlResultMessage = {
  kind: "sw.main-world-control-result";
  activationId: ContentActivationId;
  operation: ContentMainWorldControlMessage["operation"];
  controller: MainWorldControllerHint;
  result: InjectedDirectControlResult;
};

export type ContentBoundMessage = {
  kind: "sw.content-bound";
  activationId: ContentActivationId;
};

export type ContentUrlChangedMessage = {
  kind: "sw.content-url";
  activationId: ContentActivationId;
  documentUrl: string;
  revision: number;
};

export type ContentDrainMessage = {
  kind: "sw.content-drain";
  activationId: ContentActivationId;
  sid: string;
  token: string;
  deadline: number;
  documentUrl: string;
};

export type ContentQuiesceMessage = {
  kind: "sw.content-quiesce";
  activationId: ContentActivationId;
};

export type ContentRevokedMessage = {
  kind: "sw.content-revoked";
  activationId: ContentActivationId;
  reason: string;
};

export type ContentResetMessage = {
  kind: "sw.content-reset";
  reason: string;
};

export type FreezeNoticeMessage = {
  kind: "sw.freeze";
  sid: string;
  reason: FreezeReason;
};

export type SessionListItem = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  startedAt: number;
  active: boolean;
  stoppedAt?: number;
  url?: string;
  title?: string;
  ringBufferMinutes?: number;
  eventCount?: number;
  errorCount?: number;
  budgetAlertCount?: number;
  sizeBytes?: number;
  tags?: string[];
  note?: string;
};

export type SessionListMessage = {
  kind: "sw.session-list";
  sessions: SessionListItem[];
};

export type ExportStatusMessage = {
  kind: "sw.export-status";
  sid: string;
  ok: boolean;
  fileName?: string;
  error?: string;
  privacyWarning?: ExportPrivacyWarning;
};

export type ExportPrivacyWarning = {
  findingCount: number;
  summary: string;
  findings: Array<{
    kind: PrivacyScannerFindingKind;
    path: string;
    matchCount: number;
  }>;
};

export type PipelineStatusMessage = {
  kind: "sw.pipeline-status";
  activeSessions: number;
  sessions: SessionListItem[];
  updatedAt: number;
};

export type ExtensionOutboundMessage =
  | RecordingStatusMessage
  | RequestContentReadyMessage
  | ContentPrepareMessage
  | ContentInactiveMessage
  | ContentActivatedMessage
  | ContentMainWorldControlResultMessage
  | ContentBoundMessage
  | ContentEventBatchAckMessage
  | ContentUrlChangedMessage
  | ContentQuiesceMessage
  | ContentDrainMessage
  | ContentRevokedMessage
  | ContentResetMessage
  | FreezeNoticeMessage
  | SessionListMessage
  | ExportStatusMessage
  | PipelineStatusMessage;
