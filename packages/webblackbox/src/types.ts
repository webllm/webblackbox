import type {
  CapturePolicy,
  ExportPolicy,
  HashesManifest,
  RecorderConfig,
  SessionMetadata
} from "@webblackbox/protocol";
import type { PipelineStorage } from "@webblackbox/pipeline";
import type { RawRecorderEvent, RecorderHooks } from "@webblackbox/recorder";
import type { RecorderPlugin } from "@webblackbox/recorder";

/**
 * Lite capture sampling knobs exposed by the browser SDK.
 */
export type LiteCaptureSampling = Pick<
  RecorderConfig["sampling"],
  "mousemoveHz" | "scrollHz" | "domFlushMs" | "snapshotIntervalMs" | "screenshotIdleMs"
>;

/**
 * Runtime capture status payload mirrored to UI and hooks.
 */
export type LiteCaptureState = {
  active: boolean;
  sid?: string;
  tabId?: number;
  mode?: SessionMetadata["mode"] | "freeze";
  sampling?: Partial<LiteCaptureSampling>;
  capturePolicy?: CapturePolicy;
};

/**
 * Options for wiring a low-level capture agent.
 */
export type LiteCaptureAgentOptions = {
  /** Emits a normalized batch of raw recorder events. */
  emitBatch: (events: RawRecorderEvent[]) => void;
  /** Optional marker callback used by custom hosts. */
  onMarker?: (message: string) => void;
  /** Toggles in-page recording indicator UI. */
  showIndicator?: boolean;
  /** Overrides frame-role detection for tests or custom embedding. */
  frameScope?: "auto" | "top" | "child";
};

/**
 * Byte limits for payload materialization in lite mode.
 */
export type LiteMaterializerLimits = {
  screenshotMaxDataUrlLength?: number;
  screenshotMaxBytes?: number;
  domSnapshotMaxBytes?: number;
  storageSnapshotMaxBytes?: number;
  defaultBodyCaptureMaxBytes?: number;
};

/**
 * Context passed to raw-event materializers.
 */
export type LiteMaterializerContext = {
  config: RecorderConfig;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  limits?: LiteMaterializerLimits;
};

/**
 * Partial override model for recorder config in lite mode.
 */
export type LiteRecorderConfigOverride = Partial<
  Omit<RecorderConfig, "mode" | "sampling" | "redaction" | "sitePolicies">
> & {
  sampling?: Partial<RecorderConfig["sampling"]>;
  redaction?: Partial<RecorderConfig["redaction"]>;
  sitePolicies?: RecorderConfig["sitePolicies"];
};

/**
 * High-level constructor options for `WebBlackboxLiteSdk`.
 */
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

/**
 * Export-time options for generating `.webblackbox` archives.
 */
export type WebBlackboxLiteExportOptions = {
  passphrase?: string;
  stopCapture?: boolean;
  includeScreenshots?: ExportPolicy["includeScreenshots"];
  maxArchiveBytes?: ExportPolicy["maxArchiveBytes"];
  recentWindowMs?: ExportPolicy["recentWindowMs"];
};

/**
 * Result payload returned by `WebBlackboxLiteSdk.export()`.
 */
export type WebBlackboxLiteExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
};
