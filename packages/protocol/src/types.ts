import type {
  CAPTURE_MODES,
  CHUNK_CODECS,
  EVENT_LEVELS,
  FREEZE_REASONS,
  MESSAGE_TYPES,
  STORAGE_SNAPSHOT_MODES,
  WEBBLACKBOX_EVENT_TYPES
} from "./constants.js";

export type EventLevel = (typeof EVENT_LEVELS)[number];

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type ChunkCodec = (typeof CHUNK_CODECS)[number];

export type WebBlackboxEventType = (typeof WEBBLACKBOX_EVENT_TYPES)[number];

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type FreezeReason = (typeof FREEZE_REASONS)[number];

export type StorageSnapshotMode = (typeof STORAGE_SNAPSHOT_MODES)[number];

export type EventReference = {
  act?: string;
  req?: string;
  mut?: string;
  shot?: string;
  err?: string;
  task?: string;
  prev?: string;
};

export type WebBlackboxEvent<TData = unknown> = {
  v: 1;
  sid: string;
  tab: number;
  nav?: string;
  frame?: string;
  tgt?: string;
  cdp?: string;
  t: number;
  mono: number;
  dt?: number;
  type: WebBlackboxEventType;
  id: string;
  lvl?: EventLevel;
  ref?: EventReference;
  data: TData;
};

export type TimeWindow = {
  t0: number;
  t1: number;
};

export type SamplingProfile = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  screenshotIdleMs: number;
  snapshotIntervalMs: number;
  actionWindowMs: number;
  bodyCaptureMaxBytes: number;
};

export type RedactionProfile = {
  redactHeaders: string[];
  redactCookieNames: string[];
  redactBodyPatterns: string[];
  blockedSelectors: string[];
  hashSensitiveValues: boolean;
};

export type SiteCapturePolicy = {
  originPattern: string;
  mode: CaptureMode;
  enabled: boolean;
  allowBodyCapture: boolean;
  bodyMimeAllowlist: string[];
  pathAllowlist: string[];
  pathDenylist: string[];
};

export type RecorderConfig = {
  mode: CaptureMode;
  ringBufferMinutes: number;
  freezeOnError: boolean;
  freezeOnNetworkFailure: boolean;
  freezeOnLongTaskSpike: boolean;
  sampling: SamplingProfile;
  redaction: RedactionProfile;
  sitePolicies: SiteCapturePolicy[];
};

export type SessionMetadata = {
  sid: string;
  tabId: number;
  windowId?: number;
  startedAt: number;
  endedAt?: number;
  mode: CaptureMode;
  url: string;
  title?: string;
  tags: string[];
};

export type ChunkTimeIndexEntry = {
  chunkId: string;
  seq: number;
  tStart: number;
  tEnd: number;
  monoStart: number;
  monoEnd: number;
  eventCount: number;
  byteLength: number;
  codec: ChunkCodec;
  sha256: string;
};

export type RequestIndexEntry = {
  reqId: string;
  eventIds: string[];
};

export type InvertedIndexEntry = {
  term: string;
  eventIds: string[];
};

export type HashesManifest = {
  manifestSha256: string;
  files: Record<string, string>;
};

export type ExportStats = {
  eventCount: number;
  chunkCount: number;
  blobCount: number;
  durationMs: number;
};

export type ExportManifest = {
  protocolVersion: 1;
  createdAt: string;
  mode: CaptureMode;
  site: {
    origin: string;
    title?: string;
  };
  chunkCodec: ChunkCodec;
  redactionProfile: RedactionProfile;
  stats: ExportStats;
};

export type SessionStartMessage = {
  t: "CTRL.START_SESSION";
  sid: string;
  tabId: number;
  mode: CaptureMode;
  config: RecorderConfig;
};

export type SessionStopMessage = {
  t: "CTRL.STOP_SESSION";
  sid: string;
  tabId: number;
  reason?: string;
};

export type FreezeMessage = {
  t: "CTRL.FREEZE";
  sid: string;
  tabId: number;
  why: FreezeReason;
};

export type ExportMessage = {
  t: "CTRL.EXPORT";
  sid: string;
  passphrase?: string;
};

export type EventBatchMessage = {
  t: "EVT.BATCH";
  sid: string;
  tabId: number;
  seq: number;
  events: WebBlackboxEvent[];
};

export type BlobPutMessage = {
  t: "PIPE.BLOB_PUT";
  sid: string;
  hash: string;
  mime: string;
  bytes: ArrayBuffer;
};

export type ChunkPutMessage = {
  t: "PIPE.CHUNK_PUT";
  sid: string;
  chunkId: string;
  tStart: number;
  tEnd: number;
  codec: ChunkCodec;
  bytes: ArrayBuffer;
  sha256: string;
};

export type BuildIndexMessage = {
  t: "PIPE.BUILD_INDEX";
  sid: string;
};

export type ExportDoneMessage = {
  t: "PIPE.EXPORT_DONE";
  sid: string;
  size: number;
  fileName?: string;
};

export type WebBlackboxMessage =
  | SessionStartMessage
  | SessionStopMessage
  | FreezeMessage
  | ExportMessage
  | EventBatchMessage
  | BlobPutMessage
  | ChunkPutMessage
  | BuildIndexMessage
  | ExportDoneMessage;

export type NetworkBodyCaptureRule = {
  enabled: boolean;
  mimeAllowlist: string[];
  maxBytes: number;
};
