import type { CaptureMode, FreezeReason } from "@webblackbox/protocol";

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
};

export type ContentEventBatchMessage = {
  kind: "content.events";
  events: RawRecorderEvent[];
};

export type ContentMarkerMessage = {
  kind: "content.marker";
  message: string;
};

export type ExtensionInboundMessage =
  | UiStartSessionMessage
  | UiStopSessionMessage
  | UiExportSessionMessage
  | ContentEventBatchMessage
  | ContentMarkerMessage;

export type RecordingStatusMessage = {
  kind: "sw.recording-status";
  active: boolean;
  sid?: string;
  mode?: CaptureMode;
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
};

export type SessionListMessage = {
  kind: "sw.session-list";
  sessions: SessionListItem[];
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
  | PipelineStatusMessage;
