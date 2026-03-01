import type {
  ExportPolicy,
  HashesManifest,
  RecorderConfig,
  SessionMetadata
} from "@webblackbox/protocol";
import type { PipelineStorage } from "@webblackbox/pipeline";
import type { RawRecorderEvent, RecorderHooks } from "@webblackbox/recorder";
import type { RecorderPlugin } from "@webblackbox/recorder";

export type LiteCaptureSampling = Pick<
  RecorderConfig["sampling"],
  "mousemoveHz" | "scrollHz" | "domFlushMs" | "snapshotIntervalMs" | "screenshotIdleMs"
>;

export type LiteCaptureState = {
  active: boolean;
  sid?: string;
  tabId?: number;
  mode?: SessionMetadata["mode"] | "freeze";
  sampling?: Partial<LiteCaptureSampling>;
};

export type LiteCaptureAgentOptions = {
  emitBatch: (events: RawRecorderEvent[]) => void;
  onMarker?: (message: string) => void;
  showIndicator?: boolean;
};

export type LiteMaterializerLimits = {
  screenshotMaxDataUrlLength?: number;
  screenshotMaxBytes?: number;
  domSnapshotMaxBytes?: number;
  storageSnapshotMaxBytes?: number;
  defaultBodyCaptureMaxBytes?: number;
};

export type LiteMaterializerContext = {
  config: RecorderConfig;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  limits?: LiteMaterializerLimits;
};

export type LiteRecorderConfigOverride = Partial<
  Omit<RecorderConfig, "mode" | "sampling" | "redaction" | "sitePolicies">
> & {
  sampling?: Partial<RecorderConfig["sampling"]>;
  redaction?: Partial<RecorderConfig["redaction"]>;
  sitePolicies?: RecorderConfig["sitePolicies"];
};

export type WebBlackboxLiteSdkOptions = {
  sid?: string;
  tabId?: number;
  url?: string;
  title?: string;
  tags?: string[];
  config?: LiteRecorderConfigOverride;
  sampling?: Partial<LiteCaptureSampling>;
  showIndicator?: boolean;
  maxChunkBytes?: number;
  indexedDbName?: string;
  storage?: "memory" | "indexeddb";
  pipelineStorage?: PipelineStorage;
  pipelineStorageEncryptionKey?: CryptoKey | Promise<CryptoKey>;
  injectHooks?: boolean;
  injectHookFlag?: string;
  plugins?: RecorderPlugin[];
  useDefaultPlugins?: boolean;
  recorderHooks?: RecorderHooks;
};

export type WebBlackboxLiteExportOptions = {
  passphrase?: string;
  stopCapture?: boolean;
  includeScreenshots?: ExportPolicy["includeScreenshots"];
  maxArchiveBytes?: ExportPolicy["maxArchiveBytes"];
  recentWindowMs?: ExportPolicy["recentWindowMs"];
};

export type WebBlackboxLiteExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
};
