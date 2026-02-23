import type {
  CaptureMode,
  ExportPolicy,
  FreezeReason,
  SamplingProfile
} from "@webblackbox/protocol";

import type { RawRecorderEvent } from "@webblackbox/recorder";

export const PORT_NAMES = {
  content: "webblackbox:content",
  popup: "webblackbox:popup",
  options: "webblackbox:options",
  sessions: "webblackbox:sessions",
  offscreen: "webblackbox:offscreen"
} as const;

export type UiStartSessionMessage = {
  kind: "ui.start";
  tabId: number;
  mode: CaptureMode;
};

export type UiStopSessionMessage = {
  kind: "ui.stop";
  tabId: number;
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

export type ContentEventBatchMessage = {
  kind: "content.events";
  events: RawRecorderEvent[];
};

export type ContentMarkerMessage = {
  kind: "content.marker";
  message: string;
};

export type ContentReadyMessage = {
  kind: "content.ready";
};

export type ExtensionInboundMessage =
  | UiStartSessionMessage
  | UiStopSessionMessage
  | UiExportSessionMessage
  | UiDeleteSessionMessage
  | ContentEventBatchMessage
  | ContentMarkerMessage
  | ContentReadyMessage;

export type RecordingStatusMessage = {
  kind: "sw.recording-status";
  active: boolean;
  sid?: string;
  mode?: CaptureMode;
  sampling?: Pick<
    SamplingProfile,
    "mousemoveHz" | "scrollHz" | "domFlushMs" | "snapshotIntervalMs" | "screenshotIdleMs"
  >;
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
};

export type PipelineStatusMessage = {
  kind: "sw.pipeline-status";
  activeSessions: number;
  sessions: SessionListItem[];
  updatedAt: number;
};

export type ExtensionOutboundMessage =
  | RecordingStatusMessage
  | FreezeNoticeMessage
  | SessionListMessage
  | ExportStatusMessage
  | PipelineStatusMessage;
