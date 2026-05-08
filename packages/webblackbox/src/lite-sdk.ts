import {
  DEFAULT_EXPORT_POLICY,
  DEFAULT_RECORDER_CONFIG,
  createSessionId,
  sanitizeUrlForPrivacy,
  type ExportPolicy,
  type RecorderConfig,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  EncryptedPipelineStorage,
  FlightRecorderPipeline,
  IndexedDbPipelineStorage,
  MemoryPipelineStorage,
  type PipelineStorage
} from "@webblackbox/pipeline";
import {
  WebBlackboxRecorder,
  createDefaultRecorderPlugins,
  type RawRecorderEvent,
  type RecorderPlugin
} from "@webblackbox/recorder";

import {
  INJECTED_CAPTURE_CONFIG_EVENT,
  installInjectedLiteCaptureHooks
} from "./injected-hooks.js";
import { LiteCaptureAgent } from "./lite-capture-agent.js";
import { materializeLiteRawEvent, shouldMaterializeLiteRawEvent } from "./lite-materializer.js";
import type {
  WebBlackboxLiteExportOptions,
  WebBlackboxLiteExportResult,
  WebBlackboxLiteSdkOptions
} from "./types.js";

const DEFAULT_TAB_ID = 0;
const PIPELINE_BATCH_MAX_EVENTS = 160;
const PIPELINE_BATCH_FLUSH_DELAY_MS = 120;
const PIPELINE_BATCH_DRAIN_CHUNK_EVENTS = 160;

/**
 * Browser-focused SDK for recording, buffering, and exporting Lite sessions.
 */
export class WebBlackboxLiteSdk {
  private readonly sid: string;

  private readonly tabId: number;

  private readonly config: RecorderConfig;

  private readonly session: SessionMetadata;

  private readonly storage: PipelineStorage;

  private readonly pipeline: FlightRecorderPipeline;

  private readonly recorder: WebBlackboxRecorder;

  private readonly captureAgent: LiteCaptureAgent;

  private rawQueue: Promise<void> = Promise.resolve();

  private pipelineQueue: Promise<void> = Promise.resolve();

  private readonly pipelineEventBuffer: WebBlackboxEvent[] = [];

  private pipelineFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private pipelineFlushScheduled = false;

  private started = false;

  private recording = false;

  private disposed = false;

  /**
   * Creates a new Lite SDK instance with optional runtime/storage overrides.
   */
  public constructor(options: WebBlackboxLiteSdkOptions = {}) {
    this.sid = normalizeSessionId(options.sid);
    this.tabId = normalizeTabId(options.tabId);
    this.config = mergeRecorderConfig(options.config, options.sampling);
    this.session = createSessionMetadata(this.sid, this.tabId, options);
    this.storage = resolveStorage(options, this.sid);
    this.pipeline = new FlightRecorderPipeline({
      session: this.session,
      storage: this.storage,
      maxChunkBytes: options.maxChunkBytes,
      redactionProfile: this.config.redaction
    });

    const recorderHooks = options.recorderHooks;
    const plugins = resolveRecorderPlugins(options);

    this.recorder = new WebBlackboxRecorder(
      this.config,
      {
        onEvent: (event) => {
          recorderHooks?.onEvent?.(event);
          this.enqueuePipelineIngest(event);
        },
        onFreeze: (reason, event) => {
          recorderHooks?.onFreeze?.(reason, event);
        }
      },
      undefined,
      plugins
    );

    this.captureAgent = new LiteCaptureAgent({
      emitBatch: (events) => {
        this.ingestRawEvents(events);
      },
      showIndicator: options.showIndicator
    });

    if (options.injectHooks !== false) {
      installInjectedLiteCaptureHooks({
        flag: options.injectHookFlag,
        active: false,
        bodyCaptureMaxBytes: this.config.sampling.bodyCaptureMaxBytes,
        capturePolicy: this.config.capturePolicy
      });
    }
  }

  /** Active session id used by this SDK instance. */
  public get sessionId(): string {
    return this.sid;
  }

  /** Whether capture is currently active. */
  public get isRecording(): boolean {
    return this.recording;
  }

  /** Returns a copy of session metadata used for capture/export. */
  public getSessionMetadata(): SessionMetadata {
    return {
      ...this.session,
      tags: [...this.session.tags]
    };
  }

  /** Returns a defensive copy of the effective recorder config. */
  public getRecorderConfig(): RecorderConfig {
    return {
      ...this.config,
      sampling: {
        ...this.config.sampling
      },
      redaction: {
        ...this.config.redaction,
        redactHeaders: [...this.config.redaction.redactHeaders],
        redactCookieNames: [...this.config.redaction.redactCookieNames],
        redactBodyPatterns: [...this.config.redaction.redactBodyPatterns],
        blockedSelectors: [...this.config.redaction.blockedSelectors]
      },
      sitePolicies: this.config.sitePolicies.map((policy) => ({
        ...policy,
        bodyMimeAllowlist: [...policy.bodyMimeAllowlist],
        pathAllowlist: [...policy.pathAllowlist],
        pathDenylist: [...policy.pathDenylist]
      }))
    };
  }

  /** Starts the capture pipeline and begins recording if not already active. */
  public async start(): Promise<void> {
    this.assertNotDisposed();

    if (!this.started) {
      await this.pipeline.start();
      this.started = true;
    }

    if (this.recording) {
      return;
    }

    this.recording = true;
    this.syncInjectedHookConfig(true);
    this.captureAgent.setRecordingStatus({
      active: true,
      sid: this.sid,
      tabId: this.tabId,
      mode: "lite",
      sampling: this.config.sampling,
      capturePolicy: this.config.capturePolicy
    });
  }

  /** Stops active capture and flushes all queued raw/normalized events. */
  public async stop(): Promise<void> {
    this.assertNotDisposed();

    if (!this.started) {
      return;
    }

    if (this.recording) {
      this.recording = false;
      this.syncInjectedHookConfig(false);
      this.captureAgent.setRecordingStatus({
        active: false,
        sid: this.sid,
        tabId: this.tabId,
        mode: "lite",
        sampling: this.config.sampling,
        capturePolicy: this.config.capturePolicy
      });
    }

    this.captureAgent.flush();
    await this.waitForQueues();
    await this.pipeline.flush();
  }

  /** Emits a user marker event into the capture stream. */
  public emitMarker(message: string): void {
    this.assertNotDisposed();
    this.captureAgent.emitMarker(message);
  }

  /** Convenience wrapper for ingesting one raw event. */
  public ingestRawEvent(rawEvent: RawRecorderEvent): void {
    this.ingestRawEvents([rawEvent]);
  }

  /** Ingests a batch of raw events into recorder/pipeline queues. */
  public ingestRawEvents(rawEvents: RawRecorderEvent[]): void {
    this.assertNotDisposed();

    if (!this.started || rawEvents.length === 0) {
      return;
    }

    const normalized = rawEvents.map((rawEvent) => withSession(rawEvent, this.sid, this.tabId));

    this.rawQueue = this.rawQueue
      .then(async () => {
        for (const rawEvent of normalized) {
          await this.ingestOne(rawEvent);
        }
      })
      .catch((error) => {
        console.warn("[WebBlackboxLiteSdk] failed to ingest raw event batch", error);
      });
  }

  /** Flushes capture agent, recorder queue, and pipeline queue to storage. */
  public async flush(): Promise<void> {
    this.assertNotDisposed();

    if (!this.started) {
      return;
    }

    this.captureAgent.flush();
    await this.waitForQueues();
    await this.pipeline.flush();
  }

  /** Exports a `.webblackbox` archive for the current session. */
  public async export(
    options: WebBlackboxLiteExportOptions = {}
  ): Promise<WebBlackboxLiteExportResult> {
    this.assertNotDisposed();

    if (!this.started) {
      await this.start();
    }

    if (options.stopCapture !== false) {
      await this.stop();
    } else {
      await this.flush();
    }

    await this.waitForQueues();

    const exported = await this.pipeline.exportBundle({
      passphrase: options.passphrase,
      ...resolveExportPolicy(options)
    });

    return {
      fileName: exported.fileName,
      bytes: exported.bytes,
      integrity: exported.integrity
    };
  }

  /** Downloads an export result using a browser file save flow. */
  public downloadArchive(result: WebBlackboxLiteExportResult, fileName = result.fileName): void {
    WebBlackboxLiteSdk.downloadArchive(result, fileName);
  }

  /** Static helper for downloading archive bytes as a local file. */
  public static downloadArchive(
    result: Pick<WebBlackboxLiteExportResult, "bytes" | "fileName">,
    fileName = result.fileName
  ): void {
    const bytes = new Uint8Array(result.bytes.byteLength);
    bytes.set(result.bytes);

    const blob = new Blob([bytes], {
      type: "application/octet-stream"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }

  /** Stops capture (if needed) and releases capture agent resources. */
  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.started) {
      await this.stop();
    }

    this.captureAgent.dispose();
    this.disposed = true;
  }

  private async ingestOne(rawEvent: RawRecorderEvent): Promise<void> {
    let nextRawEvent: RawRecorderEvent | null = rawEvent;

    if (shouldMaterializeLiteRawEvent(rawEvent)) {
      nextRawEvent = await materializeLiteRawEvent(rawEvent, {
        config: this.config,
        putBlob: (mime, bytes) => this.pipeline.putBlob(mime, bytes)
      });
    }

    if (!nextRawEvent) {
      return;
    }

    this.recorder.ingest(nextRawEvent);
  }

  private enqueuePipelineIngest(event: WebBlackboxEvent): void {
    this.pipelineEventBuffer.push(event);

    if (this.pipelineEventBuffer.length >= PIPELINE_BATCH_MAX_EVENTS) {
      this.flushPipelineBufferIntoQueue();
      return;
    }

    if (this.pipelineFlushTimer !== null || this.pipelineFlushScheduled) {
      return;
    }

    this.pipelineFlushTimer = setTimeout(() => {
      this.pipelineFlushTimer = null;
      this.flushPipelineBufferIntoQueue();
    }, PIPELINE_BATCH_FLUSH_DELAY_MS);
  }

  private flushPipelineBufferIntoQueue(): void {
    if (this.pipelineFlushTimer !== null) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    if (this.pipelineFlushScheduled || this.pipelineEventBuffer.length === 0) {
      return;
    }

    this.pipelineFlushScheduled = true;

    this.pipelineQueue = this.pipelineQueue
      .then(async () => {
        while (this.pipelineEventBuffer.length > 0) {
          const batch = this.pipelineEventBuffer.splice(0, PIPELINE_BATCH_DRAIN_CHUNK_EVENTS);

          if (batch.length === 0) {
            break;
          }

          await this.pipeline.ingestBatch(batch);

          if (this.pipelineEventBuffer.length > 0) {
            await waitForNextTick();
          }
        }
      })
      .catch((error) => {
        console.warn("[WebBlackboxLiteSdk] failed to ingest normalized event batch", error);
      })
      .finally(() => {
        this.pipelineFlushScheduled = false;

        if (this.pipelineEventBuffer.length > 0) {
          this.flushPipelineBufferIntoQueue();
        }
      });
  }

  private async waitForQueues(): Promise<void> {
    await this.rawQueue;

    if (this.pipelineFlushTimer !== null) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    this.flushPipelineBufferIntoQueue();
    await this.pipelineQueue;
  }

  private assertNotDisposed(): void {
    if (!this.disposed) {
      return;
    }

    throw new Error("WebBlackboxLiteSdk has been disposed.");
  }

  private syncInjectedHookConfig(active: boolean): void {
    if (typeof window === "undefined") {
      return;
    }

    window.dispatchEvent(
      new CustomEvent(INJECTED_CAPTURE_CONFIG_EVENT, {
        detail: {
          active,
          bodyCaptureMaxBytes: active ? this.config.sampling.bodyCaptureMaxBytes : 0,
          capturePolicy: this.config.capturePolicy
        }
      })
    );
  }
}

function normalizeSessionId(value: string | undefined): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return createSessionId();
}

function normalizeTabId(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TAB_ID;
  }

  return Math.max(0, Math.round(value));
}

function createSessionMetadata(
  sid: string,
  tabId: number,
  options: WebBlackboxLiteSdkOptions
): SessionMetadata {
  const startedAt = Date.now();
  const url = resolveSessionUrl(options.url);
  const title = resolveSessionTitle(options.title);
  const tags = normalizeTags(options.tags);

  return {
    sid,
    tabId,
    startedAt,
    mode: "lite",
    url,
    title,
    tags
  };
}

function resolveSessionUrl(value: string | undefined): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return sanitizeUrlForPrivacy(value);
  }

  if (typeof location !== "undefined" && typeof location.href === "string") {
    return sanitizeUrlForPrivacy(location.href);
  }

  return "about:blank";
}

function resolveSessionTitle(value: string | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof document === "undefined") {
    return undefined;
  }

  return document.title;
}

function normalizeTags(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];

  for (const candidate of value) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();

    if (!trimmed || output.includes(trimmed)) {
      continue;
    }

    output.push(trimmed);
  }

  return output;
}

function mergeRecorderConfig(
  config: WebBlackboxLiteSdkOptions["config"],
  sampling: WebBlackboxLiteSdkOptions["sampling"]
): RecorderConfig {
  const baseConfig = resolveLiteSdkBaseConfig();
  const topLevelConfig = config ?? {};
  const {
    sampling: samplingFromConfig,
    redaction: redactionFromConfig,
    sitePolicies,
    ...topLevelOverrides
  } = topLevelConfig;

  return {
    ...baseConfig,
    ...topLevelOverrides,
    mode: "lite",
    sampling: {
      ...baseConfig.sampling,
      ...samplingFromConfig,
      ...sampling
    },
    redaction: {
      ...baseConfig.redaction,
      ...redactionFromConfig
    },
    sitePolicies: Array.isArray(sitePolicies)
      ? sitePolicies.map((policy) => ({
          ...policy,
          bodyMimeAllowlist: [...policy.bodyMimeAllowlist],
          pathAllowlist: [...policy.pathAllowlist],
          pathDenylist: [...policy.pathDenylist],
          mode: "lite"
        }))
      : [...baseConfig.sitePolicies]
  };
}

function resolveLiteSdkBaseConfig(): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "lite",
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling,
      mousemoveHz: 14,
      scrollHz: 10,
      domFlushMs: 160,
      snapshotIntervalMs: 30_000,
      screenshotIdleMs: DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: 0
    }
  };
}

function resolveExportPolicy(options: WebBlackboxLiteExportOptions): ExportPolicy {
  return {
    includeScreenshots:
      typeof options.includeScreenshots === "boolean"
        ? options.includeScreenshots
        : DEFAULT_EXPORT_POLICY.includeScreenshots,
    maxArchiveBytes: normalizeExportBoundedInt(
      options.maxArchiveBytes,
      DEFAULT_EXPORT_POLICY.maxArchiveBytes,
      64 * 1024,
      5 * 1024 * 1024 * 1024
    ),
    recentWindowMs: normalizeExportBoundedInt(
      options.recentWindowMs,
      DEFAULT_EXPORT_POLICY.recentWindowMs,
      1 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000
    )
  };
}

function normalizeExportBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function resolveStorage(options: WebBlackboxLiteSdkOptions, sid: string): PipelineStorage {
  if (options.pipelineStorage) {
    return maybeWrapEncryptedStorage(options.pipelineStorage, options);
  }

  if (options.storage === "indexeddb") {
    if (typeof indexedDB === "undefined") {
      console.warn("[WebBlackboxLiteSdk] indexedDB unavailable; falling back to memory storage");
      return maybeWrapEncryptedStorage(new MemoryPipelineStorage(), options);
    }

    return maybeWrapEncryptedStorage(
      new IndexedDbPipelineStorage(options.indexedDbName ?? `webblackbox-lite-${sid}`),
      options
    );
  }

  return maybeWrapEncryptedStorage(new MemoryPipelineStorage(), options);
}

function maybeWrapEncryptedStorage(
  storage: PipelineStorage,
  options: WebBlackboxLiteSdkOptions
): PipelineStorage {
  if (!options.pipelineStorageEncryptionKey) {
    return storage;
  }

  return new EncryptedPipelineStorage(storage, {
    key: options.pipelineStorageEncryptionKey
  });
}

function resolveRecorderPlugins(options: WebBlackboxLiteSdkOptions): RecorderPlugin[] {
  if (Array.isArray(options.plugins)) {
    return options.plugins;
  }

  if (options.useDefaultPlugins === false) {
    return [];
  }

  return createDefaultRecorderPlugins();
}

function withSession(rawEvent: RawRecorderEvent, sid: string, tabId: number): RawRecorderEvent {
  return {
    ...rawEvent,
    sid,
    tabId
  };
}

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
