import type {
  CapturePolicy,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RedactionProfile,
  RequestIndexEntry,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { CHUNK_CODECS, DEFAULT_EXPORT_POLICY, sanitizeUrlForPrivacy } from "@webblackbox/protocol";

import { decodeChunkEvents, encodeChunkEvents } from "./codec.js";
import { EventChunker } from "./chunker.js";
import { createWebBlackboxArchive } from "./exporter.js";
import { sha256Hex } from "./hash.js";
import { EventIndexer } from "./indexer.js";
import { assertPrivacyScannerPassed, buildPrivacyManifest } from "./privacy.js";
import {
  assertPipelineResumeChangesWithinLimits,
  isPipelineDeliveryEventProvenance,
  isPipelineResumeDelta,
  isPipelineResumeState,
  PIPELINE_STORAGE_SECURITY,
  type PipelineDeliveryEventChange,
  type PipelineDeliveryEventProvenance,
  type PipelineDeliveryNoOutputChange,
  type PipelineDeliveryReceipt,
  type PipelineDeliveryReceiptQuery,
  type PipelineResumeDelta,
  type PipelineResumeState,
  type PipelineStorage,
  type RecorderSequenceWatermark,
  type ScreenRecordingChunkReference,
  type ScreenRecordingResumeChange,
  type ScreenRecordingResumeState,
  type StoredBlob,
  type StoredChunk
} from "./storage.js";

export type FlightRecorderPipelineOptions = {
  session: SessionMetadata;
  storage: PipelineStorage;
  maxChunkBytes?: number;
  chunkCodec?: (typeof CHUNK_CODECS)[number];
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  trustedPlaintextExemptionEvidenceRefs?: readonly string[];
};

export type PipelineDeliverySidecar = ReadonlyMap<string, PipelineDeliveryEventProvenance>;

export type ExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest;
};

export type ExportBundleOptions = {
  passphrase?: string;
  includeScreenshots?: boolean;
  includeScreenRecordings?: boolean;
  maxArchiveBytes?: number | null;
  recentWindowMs?: number | null;
  strictPrivacyScanner?: boolean;
  /**
   * @deprecated Plaintext export eligibility is determined exclusively by the active capture
   * policy and trusted capture-context evidence. This flag is retained for source compatibility
   * and cannot bypass encryption requirements.
   */
  allowPlaintextLocalExport?: boolean;
};

type PreparedExportChunk = {
  chunk: StoredChunk;
  events: WebBlackboxEvent[];
  blobHashes: string[];
};

type ScreenRecordingChunkCheckpoint = Omit<ScreenRecordingChunkReference, "index">;

type ExportIndexes = {
  time: ReturnType<EventIndexer["snapshot"]>["time"];
  request: RequestIndexEntry[];
  inverted: InvertedIndexEntry[];
};

type ResolvedExportPolicy = {
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number | null;
  recentWindowMs: number | null;
  cutoffTimestamp: number;
  strictPrivacyScanner: boolean;
};

type PreparedArchive = Awaited<ReturnType<typeof createWebBlackboxArchive>> & {
  privacyManifest: PrivacyManifest;
};

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SCREENSHOT_EVENT_TYPE: WebBlackboxEvent["type"] = "screen.screenshot";
const SCREEN_RECORDING_EVENT_PREFIX = "screen.recording.";
const EXPORT_OVERHEAD_RESERVE_BYTES = 2 * 1024 * 1024;
const LOW_RISK_OVERRIDE_BLOCKED_CATEGORIES = new Set([
  "dom",
  "screenshots",
  "screenRecordings",
  "console",
  "network",
  "storage"
]);
const LOCAL_DEBUG_EVIDENCE_PATTERN = /^local-attestation:[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/;
const SYNTHETIC_EVIDENCE_PATTERN = /^(?:synthetic-fixture|ci-run):[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/;
const EVENT_SEQUENCE_PATTERN = /^E-(\d+)$/;
const ACTION_SEQUENCE_PATTERN = /^A-(\d+)$/;
const BLOB_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PIPELINE_RESUME_MAX_SCREEN_CHUNKS = 500_000;

export class FlightRecorderPipeline {
  private readonly chunker: EventChunker;
  private readonly chunkCodec: (typeof CHUNK_CODECS)[number];
  private storageReadyPromise: Promise<void> | null = null;
  private chunkOperationTail: Promise<void> = Promise.resolve();
  private acceptingEvents = true;
  private closePromise: Promise<void> | null = null;
  private sequenceWatermark: RecorderSequenceWatermark = { event: 0, action: 0 };
  private readonly screenRecordingChunks = new Map<
    string,
    Map<number, ScreenRecordingChunkCheckpoint>
  >();
  private readonly pendingEventIds = new Set<string>();
  private readonly pendingDeliveryByEventId = new Map<string, PipelineDeliveryEventChange>();

  public constructor(private readonly options: FlightRecorderPipelineOptions) {
    const codec = resolveChunkCodec(options.chunkCodec);
    const maxChunkBytes = options.maxChunkBytes ?? 512 * 1024;
    this.chunkCodec = codec;
    this.chunker = new EventChunker(maxChunkBytes, codec, async (chunk) => {
      await this.persistChunk(
        chunk.meta.chunkId,
        chunk.meta.seq,
        chunk.meta.codec,
        chunk.events,
        chunk.bytes
      );
    });
  }

  public async start(): Promise<void> {
    await this.ensureStorageReady();
    const latestMeta = await this.options.storage.getLatestChunkMeta(this.options.session.sid);
    const lastSequence = latestMeta?.seq ?? 0;

    this.chunker.restoreSequence(lastSequence);
    if (latestMeta) {
      this.chunker.restoreTimelineBoundary(latestMeta.tEnd, latestMeta.monoEnd);
    }
    const resumeState = latestMeta
      ? await this.restoreResumeStateFromLatestChunk(latestMeta.chunkId, latestMeta.seq)
      : emptyPipelineResumeState();
    this.sequenceWatermark = resumeState.sequenceWatermark;
    this.restoreScreenRecordingResumeState(resumeState.screenRecordings);

    if (latestMeta) {
      await this.options.storage.initializeResumeState?.(
        this.options.session.sid,
        latestMeta.seq,
        resumeState
      );
    }

    await this.options.storage.putSession(this.options.session);
  }

  /** Updates mutable archive metadata while preserving the pipeline's exact recording identity. */
  public async rebindSessionMetadata(session: SessionMetadata): Promise<void> {
    if (
      session.sid !== this.options.session.sid ||
      session.tabId !== this.options.session.tabId ||
      session.startedAt !== this.options.session.startedAt ||
      session.mode !== this.options.session.mode
    ) {
      throw new Error("Pipeline session metadata changed immutable recording identity.");
    }

    const rebound: SessionMetadata = {
      ...session,
      tags: [...session.tags]
    };
    await this.enqueueChunkOperation(async () => {
      await this.ensureStorageReady();
      await this.options.storage.putSession(rebound);
      this.options.session = rebound;
    });
  }

  public async ingest(event: WebBlackboxEvent): Promise<void> {
    assertPrivacyClassifiedEvent(event);
    if (!this.acceptingEvents) {
      throw new Error("FlightRecorderPipeline cannot ingest events after close() has started.");
    }

    await this.enqueueChunkOperation(async () => {
      this.assertEventResumeStateWithinLimits(event);
      this.assertEventIdIsNotPending(event.id);
      this.pendingEventIds.add(event.id);

      try {
        await this.chunker.append(event);
      } catch (error) {
        this.pendingEventIds.delete(event.id);
        throw error;
      }
      this.applyEventToResumeState(event);
    });
  }

  public async ingestBatch(events: WebBlackboxEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      assertPrivacyClassifiedEvent(event);
    }

    if (!this.acceptingEvents) {
      throw new Error("FlightRecorderPipeline cannot ingest events after close() has started.");
    }

    await this.enqueueChunkOperation(async () => {
      for (const event of events) {
        this.assertEventResumeStateWithinLimits(event);
        this.assertEventIdIsNotPending(event.id);
        this.pendingEventIds.add(event.id);

        try {
          await this.chunker.append(event);
        } catch (error) {
          this.pendingEventIds.delete(event.id);
          throw error;
        }
        this.applyEventToResumeState(event);
      }
    });
  }

  public async ingestBatchWithDelivery(
    events: WebBlackboxEvent[],
    deliveryByEventId: PipelineDeliverySidecar
  ): Promise<void> {
    if (events.length === 0) {
      if (deliveryByEventId.size > 0) {
        throw new Error("Pipeline delivery sidecar references an empty event batch.");
      }
      return;
    }

    this.requireDeliveryStorage();
    const changes = normalizePipelineDeliverySidecar(
      this.options.session.sid,
      events,
      deliveryByEventId
    );

    for (const event of events) {
      assertPrivacyClassifiedEvent(event);
    }

    if (!this.acceptingEvents) {
      throw new Error("FlightRecorderPipeline cannot ingest events after close() has started.");
    }

    await this.enqueueChunkOperation(async () => {
      await this.ensureStorageReady();
      const durableReceipts = new Map<string, PipelineDeliveryReceipt | undefined>();

      for (const change of changes.values()) {
        const key = createPipelineDeliveryBatchKey(change);

        if (!durableReceipts.has(key)) {
          durableReceipts.set(
            key,
            await this.options.storage.getDeliveryReceipt!(this.options.session.sid, {
              tabId: change.tabId,
              frameId: change.frameId,
              documentId: change.documentId,
              batchId: change.batchId
            })
          );
        }
      }

      for (const event of events) {
        this.assertEventResumeStateWithinLimits(event);
        const change = changes.get(event.id);
        const pendingForEventId = this.pendingDeliveryByEventId.get(event.id);

        if (!change) {
          this.assertEventIdIsNotPending(event.id);

          this.pendingEventIds.add(event.id);

          try {
            await this.chunker.append(event);
          } catch (error) {
            this.pendingEventIds.delete(event.id);
            throw error;
          }
          this.applyEventToResumeState(event);
          continue;
        }

        if (pendingForEventId) {
          if (isSamePipelineDeliveryEventChange(pendingForEventId, change)) {
            continue;
          }

          throw new Error("Pipeline event id was reused with different delivery provenance.");
        }

        if (this.pendingEventIds.has(event.id)) {
          throw new Error("Pipeline event id is already pending without delivery provenance.");
        }

        const pendingForIndex = [...this.pendingDeliveryByEventId.values()].find((pending) =>
          isSamePipelineDeliveryBatchIndex(pending, change)
        );

        if (pendingForIndex) {
          throw new Error("Pipeline delivery batch index already has a different pending event.");
        }

        const durableReceipt = durableReceipts.get(createPipelineDeliveryBatchKey(change));
        const durableIndex = durableReceipt?.indexes.find(
          (index) => index.eventIndex === change.eventIndex
        );

        if (durableReceipt) {
          if (
            durableReceipt.fingerprint !== change.fingerprint ||
            durableReceipt.eventCount !== change.eventCount
          ) {
            throw new Error("Pipeline delivery batch identity was reused with different content.");
          }

          if (durableIndex) {
            if (durableIndex.outcome === "event" && durableIndex.eventId === event.id) {
              continue;
            }

            throw new Error("Pipeline delivery batch index already has a different outcome.");
          }
        }

        this.pendingDeliveryByEventId.set(event.id, change);
        this.pendingEventIds.add(event.id);

        try {
          await this.chunker.append(event);
        } catch (error) {
          this.pendingEventIds.delete(event.id);
          if (this.pendingDeliveryByEventId.get(event.id) === change) {
            this.pendingDeliveryByEventId.delete(event.id);
          }
          throw error;
        }
        this.applyEventToResumeState(event);
      }
    });
  }

  public async commitDeliveryProgress(
    changes: readonly PipelineDeliveryNoOutputChange[]
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    this.requireDeliveryStorage();
    await this.enqueueChunkOperation(async () => {
      await this.ensureStorageReady();
      const pendingConflicts = this.findPendingDeliveryOutcomeConflicts(changes);

      // Output provenance is only durable once its containing chunk is committed. Flush before
      // metadata-only progress so a completed receipt can never acknowledge an in-memory output.
      await this.chunker.flush();

      if (pendingConflicts.length > 0) {
        throw new Error(
          "Pipeline delivery progress conflicts with pending output provenance for the same batch index."
        );
      }

      await this.options.storage.commitDeliveryProgress!(this.options.session.sid, changes);
    });
  }

  public async getDeliveryReceipt(
    query: PipelineDeliveryReceiptQuery
  ): Promise<PipelineDeliveryReceipt | undefined> {
    this.requireDeliveryStorage();
    await this.enqueueChunkOperation(async () => undefined);
    await this.ensureStorageReady();
    return this.options.storage.getDeliveryReceipt!(this.options.session.sid, query);
  }

  public async getSequenceWatermark(): Promise<RecorderSequenceWatermark> {
    return (await this.getResumeState()).sequenceWatermark;
  }

  public async getResumeState(): Promise<PipelineResumeState> {
    await this.enqueueChunkOperation(async () => undefined);
    return this.snapshotResumeState();
  }

  public async flush(): Promise<void> {
    await this.enqueueChunkOperation(async () => {
      await this.chunker.flush();
    });
  }

  public close(options: { purge?: boolean } = {}): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.acceptingEvents = false;
    const attempt = this.enqueueChunkOperation(async () => {
      await this.chunker.close();

      if (options.purge) {
        await this.options.storage.deleteSession(this.options.session.sid);
      }
    });
    const tracked = attempt.finally(() => {
      if (this.closePromise === tracked) {
        this.closePromise = null;
      }
    });

    this.closePromise = tracked;
    return tracked;
  }

  private requireDeliveryStorage(): void {
    if (!this.options.storage.getDeliveryReceipt || !this.options.storage.commitDeliveryProgress) {
      throw new Error("Pipeline storage does not support durable delivery receipts.");
    }
  }

  private assertEventIdIsNotPending(eventId: string): void {
    if (this.pendingEventIds.has(eventId)) {
      throw new Error("Pipeline event id is already pending in the current chunk.");
    }
  }

  private findPendingDeliveryOutcomeConflicts(
    changes: readonly PipelineDeliveryNoOutputChange[]
  ): PipelineDeliveryEventChange[] {
    return [...this.pendingDeliveryByEventId.values()].filter((pending) =>
      changes.some((change) => isSamePipelineDeliveryBatchIndex(change, pending))
    );
  }

  public async putBlob(mime: string, bytes: Uint8Array): Promise<string> {
    await this.ensureStorageReady();
    const hash = await sha256Hex(bytes);
    const blob: StoredBlob = {
      hash,
      mime,
      size: bytes.byteLength,
      bytes,
      createdAt: Date.now(),
      refCount: 1
    };

    await this.options.storage.putBlob(blob, this.options.session.sid);
    return hash;
  }

  public async finalizeIndexes(): Promise<{
    time: ReturnType<EventIndexer["snapshot"]>["time"];
    request: RequestIndexEntry[];
    inverted: InvertedIndexEntry[];
  }> {
    await this.ensureStorageReady();
    await this.flush();
    const chunks = await this.options.storage.listChunks(this.options.session.sid);
    const snapshot = await this.buildIndexesFromChunks(chunks);
    await this.options.storage.putIndexes(this.options.session.sid, snapshot);
    return snapshot;
  }

  public async exportBundle(options: ExportBundleOptions = {}): Promise<ExportResult> {
    this.assertExportEncryptionPolicy(options);
    await this.ensureStorageReady();
    await this.flush();
    const rawChunks = await this.options.storage.listChunks(this.options.session.sid);
    const exportPolicy = resolveExportPolicy(options, {
      latestEventTimestamp: rawChunks[rawChunks.length - 1]?.meta.tEnd,
      sessionStartedAt: this.options.session.startedAt,
      sessionEndedAt: this.options.session.endedAt
    });
    const hasCustomSelection =
      !exportPolicy.includeScreenshots ||
      !exportPolicy.includeScreenRecordings ||
      exportPolicy.maxArchiveBytes !== null ||
      exportPolicy.recentWindowMs !== null;

    if (!hasCustomSelection) {
      const indexes = await this.buildIndexesFromChunks(rawChunks);
      await this.options.storage.putIndexes(this.options.session.sid, indexes);
      const chunks = rawChunks;
      const blobs = await this.listReferencedSessionBlobsFromChunks(chunks);
      const manifest = this.buildManifest(chunks, blobs.length);
      const events = await this.decodeEventsFromChunks(chunks);
      const encrypted = typeof options.passphrase === "string" && options.passphrase.length > 0;
      const privacyManifest = await buildPrivacyManifest({
        events,
        blobs,
        expectedBlobCount: blobs.length,
        capturePolicy: this.options.capturePolicy,
        encrypted,
        transfer: buildExportTransferPolicy({
          capturePolicy: this.options.capturePolicy,
          encrypted,
          includeScreenshots: exportPolicy.includeScreenshots,
          includeScreenRecordings: exportPolicy.includeScreenRecordings,
          maxArchiveBytes: exportPolicy.maxArchiveBytes,
          recentWindowMs: exportPolicy.recentWindowMs
        })
      });
      if (options.strictPrivacyScanner === true) {
        assertPrivacyScannerPassed(privacyManifest.scanner);
      }

      assertLowRiskOverrideAllowed(privacyManifest, this.options.capturePolicy);

      const { bytes, integrity } = await createWebBlackboxArchive(
        {
          manifest,
          chunks,
          blobs,
          timeIndex: indexes.time,
          requestIndex: indexes.request,
          invertedIndex: indexes.inverted,
          privacyManifest
        },
        {
          passphrase: options.passphrase
        }
      );

      await this.options.storage.putIntegrity(this.options.session.sid, integrity);

      return {
        fileName: `${this.options.session.sid}.webblackbox`,
        bytes,
        integrity,
        privacyManifest
      };
    }

    const prepared = await this.prepareExportChunks(rawChunks, exportPolicy);
    const blobsByHash = await this.listSessionBlobMap();
    let selected = this.selectChunksBySize(prepared, blobsByHash, exportPolicy.maxArchiveBytes);
    let archive = await this.createArchiveForSelection(
      selected,
      blobsByHash,
      exportPolicy,
      options.passphrase
    );

    if (
      exportPolicy.maxArchiveBytes !== null &&
      archive.bytes.byteLength > exportPolicy.maxArchiveBytes &&
      selected.length > 0
    ) {
      const fitted = await this.fitSelectionToArchiveLimit(
        selected,
        blobsByHash,
        exportPolicy,
        exportPolicy.maxArchiveBytes,
        options.passphrase
      );

      selected = fitted.selected;
      archive = fitted.archive;
    }

    const { bytes, integrity, privacyManifest } = archive;

    await this.options.storage.putIntegrity(this.options.session.sid, integrity);

    return {
      fileName: `${this.options.session.sid}.webblackbox`,
      bytes,
      integrity,
      privacyManifest
    };
  }

  private assertExportEncryptionPolicy(options: ExportBundleOptions): void {
    const hasPassphrase = typeof options.passphrase === "string" && options.passphrase.length > 0;

    if (hasPassphrase) {
      return;
    }

    const policy = this.options.capturePolicy;

    if (!policy) {
      throw new Error(
        "Export encryption is required unless the active capture policy grants a trusted synthetic or local-debug plaintext exemption."
      );
    }

    if (policy.captureContext === "real-user") {
      throw new Error("Real-user archives must be encrypted before export or share.");
    }

    if (policy.encryption.archive === "required") {
      throw new Error("Export encryption is required by the active capture policy.");
    }

    assertTrustedPlaintextExemptionEvidence(
      policy,
      this.options.trustedPlaintextExemptionEvidenceRefs
    );
  }

  private async listSessionBlobs(): Promise<StoredBlob[]> {
    const chunks = await this.options.storage.listChunks(this.options.session.sid);
    const hashes = new Set<string>();
    const blobs: StoredBlob[] = [];

    for (const chunk of chunks) {
      const events = await decodeChunkEvents(chunk.bytes, chunk.meta.codec);

      for (const hash of collectBlobHashesFromEvents(events)) {
        hashes.add(hash);
      }
    }

    for (const hash of [...hashes].sort()) {
      const blob = await this.options.storage.getBlob(hash);

      if (blob) {
        blobs.push(blob);
      }
    }

    return blobs;
  }

  private async listSessionBlobMap(): Promise<Map<string, StoredBlob>> {
    const blobs = await this.listSessionBlobs();
    const byHash = new Map<string, StoredBlob>();

    for (const blob of blobs) {
      byHash.set(blob.hash, blob);
    }

    return byHash;
  }

  private async listReferencedSessionBlobsFromChunks(chunks: StoredChunk[]): Promise<StoredBlob[]> {
    const referencedHashes = new Set<string>();

    for (const chunk of chunks) {
      const events = await decodeChunkEvents(chunk.bytes, chunk.meta.codec);
      const hashes = collectBlobHashesFromEvents(events);

      for (const hash of hashes) {
        referencedHashes.add(hash);
      }
    }

    const referenced: StoredBlob[] = [];

    for (const hash of [...referencedHashes].sort()) {
      const blob = await this.options.storage.getBlob(hash);

      if (blob) {
        referenced.push(blob);
      }
    }

    return referenced;
  }

  private async prepareExportChunks(
    chunks: StoredChunk[],
    exportPolicy: ResolvedExportPolicy
  ): Promise<PreparedExportChunk[]> {
    const output: PreparedExportChunk[] = [];

    for (const chunk of chunks) {
      const decoded = await decodeChunkEvents(chunk.bytes, chunk.meta.codec);
      const filtered = decoded.filter((event) => shouldIncludeEvent(event, exportPolicy));

      if (filtered.length === 0) {
        continue;
      }

      const blobHashes = collectBlobHashesFromEvents(filtered);

      if (filtered.length === decoded.length) {
        output.push({
          chunk,
          events: filtered,
          blobHashes
        });
        continue;
      }

      const encoded = await encodeChunkEvents(filtered, chunk.meta.codec);
      const bytes = encoded.bytes;
      const first = filtered[0];
      const last = filtered[filtered.length - 1];

      output.push({
        chunk: {
          sid: chunk.sid,
          meta: {
            ...chunk.meta,
            tStart: first?.t ?? chunk.meta.tStart,
            tEnd: last?.t ?? chunk.meta.tEnd,
            monoStart: first?.mono ?? chunk.meta.monoStart,
            monoEnd: last?.mono ?? chunk.meta.monoEnd,
            eventCount: filtered.length,
            byteLength: bytes.byteLength,
            codec: encoded.codec,
            sha256: await sha256Hex(bytes)
          },
          bytes
        },
        events: filtered,
        blobHashes
      });
    }

    return output;
  }

  private selectChunksBySize(
    chunks: PreparedExportChunk[],
    blobsByHash: Map<string, StoredBlob>,
    maxArchiveBytes: number | null
  ): PreparedExportChunk[] {
    if (maxArchiveBytes === null || chunks.length === 0) {
      return chunks;
    }

    const reserve = Math.min(EXPORT_OVERHEAD_RESERVE_BYTES, Math.floor(maxArchiveBytes * 0.1));
    const budget = Math.max(0, maxArchiveBytes - reserve);
    const selected: PreparedExportChunk[] = [];
    const selectedBlobHashes = new Set<string>();
    let totalBytes = 0;

    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const candidate = chunks[index];

      if (!candidate) {
        continue;
      }

      let additionalBlobBytes = 0;

      for (const hash of candidate.blobHashes) {
        if (selectedBlobHashes.has(hash)) {
          continue;
        }

        additionalBlobBytes += blobsByHash.get(hash)?.bytes.byteLength ?? 0;
      }

      const candidateBytes = candidate.chunk.bytes.byteLength + additionalBlobBytes;
      const nextTotal = totalBytes + candidateBytes;

      if (nextTotal > budget && selected.length > 0) {
        break;
      }

      selected.push(candidate);
      totalBytes = nextTotal;

      for (const hash of candidate.blobHashes) {
        selectedBlobHashes.add(hash);
      }
    }

    return selected.reverse();
  }

  private buildExportSnapshot(
    selectedChunks: PreparedExportChunk[],
    blobsByHash: Map<string, StoredBlob>
  ): {
    chunks: StoredChunk[];
    blobs: StoredBlob[];
    indexes: ExportIndexes;
  } {
    const chunks = selectedChunks.map((entry) => entry.chunk);
    const indexer = new EventIndexer();
    const blobHashes = new Set<string>();

    for (const chunk of selectedChunks) {
      indexer.addChunk(chunk.chunk.meta);
      indexer.addEvents(chunk.events);

      for (const hash of chunk.blobHashes) {
        blobHashes.add(hash);
      }
    }

    const blobs: StoredBlob[] = [];

    for (const hash of [...blobHashes].sort()) {
      const blob = blobsByHash.get(hash);

      if (blob) {
        blobs.push(blob);
      }
    }

    return {
      chunks,
      blobs,
      indexes: indexer.snapshot()
    };
  }

  private async createArchiveForSelection(
    selectedChunks: PreparedExportChunk[],
    blobsByHash: Map<string, StoredBlob>,
    exportPolicy: ResolvedExportPolicy,
    passphrase?: string
  ): Promise<PreparedArchive> {
    const exportData = this.buildExportSnapshot(selectedChunks, blobsByHash);
    const manifest = this.buildManifest(exportData.chunks, exportData.blobs.length);
    const events = selectedChunks.flatMap((chunk) => chunk.events);
    const encrypted = typeof passphrase === "string" && passphrase.length > 0;
    const privacyManifest = await buildPrivacyManifest({
      events,
      blobs: exportData.blobs,
      expectedBlobCount: exportData.blobs.length,
      capturePolicy: this.options.capturePolicy,
      encrypted,
      transfer: buildExportTransferPolicy({
        capturePolicy: this.options.capturePolicy,
        encrypted,
        includeScreenshots: exportPolicy.includeScreenshots,
        includeScreenRecordings: exportPolicy.includeScreenRecordings,
        maxArchiveBytes: exportPolicy.maxArchiveBytes,
        recentWindowMs: exportPolicy.recentWindowMs
      })
    });
    if (exportPolicy.strictPrivacyScanner) {
      assertPrivacyScannerPassed(privacyManifest.scanner);
    }

    assertLowRiskOverrideAllowed(privacyManifest, this.options.capturePolicy);

    const archive = await createWebBlackboxArchive(
      {
        manifest,
        chunks: exportData.chunks,
        blobs: exportData.blobs,
        timeIndex: exportData.indexes.time,
        requestIndex: exportData.indexes.request,
        invertedIndex: exportData.indexes.inverted,
        privacyManifest
      },
      {
        passphrase
      }
    );

    return {
      ...archive,
      privacyManifest
    };
  }

  private async fitSelectionToArchiveLimit(
    selected: PreparedExportChunk[],
    blobsByHash: Map<string, StoredBlob>,
    exportPolicy: ResolvedExportPolicy,
    maxArchiveBytes: number,
    passphrase?: string
  ): Promise<{
    selected: PreparedExportChunk[];
    archive: PreparedArchive;
  }> {
    let left = 1;
    let right = selected.length;
    let bestSelection: PreparedExportChunk[] | null = null;
    let bestArchive: PreparedArchive | null = null;

    while (left <= right) {
      const dropCount = Math.floor((left + right) / 2);
      const candidateSelection = selected.slice(dropCount);
      const candidateArchive = await this.createArchiveForSelection(
        candidateSelection,
        blobsByHash,
        exportPolicy,
        passphrase
      );

      if (candidateArchive.bytes.byteLength <= maxArchiveBytes) {
        bestSelection = candidateSelection;
        bestArchive = candidateArchive;
        right = dropCount - 1;
      } else {
        left = dropCount + 1;
      }
    }

    if (bestSelection && bestArchive) {
      return {
        selected: bestSelection,
        archive: bestArchive
      };
    }

    const emptySelection = selected.slice(selected.length);
    const emptyArchive = await this.createArchiveForSelection(
      emptySelection,
      blobsByHash,
      exportPolicy,
      passphrase
    );

    return {
      selected: emptySelection,
      archive: emptyArchive
    };
  }

  private async persistChunk(
    chunkId: string,
    seq: number,
    codec: (typeof CHUNK_CODECS)[number],
    events: WebBlackboxEvent[],
    bytes: Uint8Array
  ): Promise<void> {
    await this.ensureStorageReady();
    const first = events[0];
    const last = events[events.length - 1];
    const hash = await sha256Hex(bytes);
    const deliveryChanges = events.flatMap((event) => {
      const change = this.pendingDeliveryByEventId.get(event.id);
      return change ? [change] : [];
    });

    const chunk: StoredChunk = {
      sid: this.options.session.sid,
      meta: {
        chunkId,
        seq,
        tStart: first?.t ?? 0,
        tEnd: last?.t ?? 0,
        monoStart: first?.mono ?? 0,
        monoEnd: last?.mono ?? 0,
        eventCount: events.length,
        byteLength: bytes.byteLength,
        codec,
        sha256: hash
      },
      bytes,
      resumeDelta: derivePipelineResumeDelta(this.sequenceWatermark, events, deliveryChanges)
    };

    await this.options.storage.putChunk(chunk);

    for (const event of events) {
      this.pendingEventIds.delete(event.id);
    }

    for (const change of deliveryChanges) {
      if (this.pendingDeliveryByEventId.get(change.eventId) === change) {
        this.pendingDeliveryByEventId.delete(change.eventId);
      }
    }
  }

  private async restoreResumeStateFromLatestChunk(
    chunkId: string,
    chunkSequence: number
  ): Promise<PipelineResumeState> {
    const normalized = await this.options.storage.getResumeState?.(
      this.options.session.sid,
      chunkSequence
    );

    if (normalized !== undefined) {
      if (!isPipelineResumeState(normalized)) {
        throw new Error("Pipeline storage returned an invalid resume state.");
      }

      return clonePipelineResumeState(normalized);
    }

    const latest = await this.options.storage.getChunk(this.options.session.sid, chunkId);

    if (!latest) {
      throw new Error("Latest pipeline chunk metadata points to missing chunk payload.");
    }

    if (isPipelineResumeState(latest.resumeState)) {
      const checkpoint = clonePipelineResumeState(latest.resumeState);
      const events = await decodeChunkEvents(latest.bytes, latest.meta.codec);
      return applyPipelineResumeDelta(
        checkpoint,
        derivePipelineResumeDelta(checkpoint.sequenceWatermark, events)
      );
    }

    if (isPipelineResumeDelta(latest.resumeDelta)) {
      return this.rebuildResumeStateFromChunkCheckpoints();
    }

    const events = await decodeChunkEvents(latest.bytes, latest.meta.codec);

    // Legacy chunks did not persist an exact action high-water. Advancing the
    // action sequence to the durable event high-water is deterministic and
    // prevents reuse without scanning an unbounded archive history.
    const empty = emptyPipelineResumeState();
    const legacy = applyPipelineResumeDelta(
      empty,
      derivePipelineResumeDelta(empty.sequenceWatermark, events)
    );
    legacy.sequenceWatermark.action = Math.max(
      legacy.sequenceWatermark.action,
      legacy.sequenceWatermark.event
    );
    return legacy;
  }

  private async rebuildResumeStateFromChunkCheckpoints(): Promise<PipelineResumeState> {
    const chunks = await this.options.storage.listChunks(this.options.session.sid);
    let sequenceWatermark: RecorderSequenceWatermark = { event: 0, action: 0 };
    let recordings = new Map<string, Map<number, ScreenRecordingChunkCheckpoint>>();

    for (const chunk of chunks.sort((left, right) => left.meta.seq - right.meta.seq)) {
      if (isPipelineResumeState(chunk.resumeState)) {
        sequenceWatermark = mergeSequenceWatermarks(
          sequenceWatermark,
          chunk.resumeState.sequenceWatermark
        );
        recordings = screenRecordingCheckpointMapFromState(chunk.resumeState);
        const events = await decodeChunkEvents(chunk.bytes, chunk.meta.codec);
        const replay = derivePipelineResumeDelta(sequenceWatermark, events);
        assertPipelineResumeChangesWithinLimits(recordings, replay.screenRecordingChanges);
        sequenceWatermark = mergeSequenceWatermarks(sequenceWatermark, replay.sequenceWatermark);

        for (const change of replay.screenRecordingChanges) {
          applyScreenRecordingResumeChange(recordings, change);
        }
        continue;
      }

      if (isPipelineResumeDelta(chunk.resumeDelta)) {
        assertPipelineResumeChangesWithinLimits(
          recordings,
          chunk.resumeDelta.screenRecordingChanges
        );
        sequenceWatermark = mergeSequenceWatermarks(
          sequenceWatermark,
          chunk.resumeDelta.sequenceWatermark
        );

        for (const change of chunk.resumeDelta.screenRecordingChanges) {
          applyScreenRecordingResumeChange(recordings, change);
        }
      }
    }

    return createPipelineResumeStateFromCheckpoints(sequenceWatermark, recordings);
  }

  private applyEventToResumeState(event: WebBlackboxEvent): void {
    this.sequenceWatermark = mergeSequenceWatermarks(
      this.sequenceWatermark,
      deriveRecorderSequenceWatermark([event])
    );
    applyScreenRecordingEvent(this.screenRecordingChunks, event);
  }

  private assertEventResumeStateWithinLimits(event: WebBlackboxEvent): void {
    const change = readScreenRecordingResumeChange(event);

    if (change) {
      assertPipelineResumeChangesWithinLimits(this.screenRecordingChunks, [change]);
    }
  }

  private snapshotResumeState(): PipelineResumeState {
    return {
      sequenceWatermark: { ...this.sequenceWatermark },
      screenRecordings: [...this.screenRecordingChunks.entries()]
        .map(([recordingId, chunks]) => ({
          recordingId,
          chunks: [...chunks.entries()]
            .map(([index, checkpoint]) => ({ index, ...checkpoint }))
            .sort((left, right) => left.index - right.index)
        }))
        .sort((left, right) => left.recordingId.localeCompare(right.recordingId))
    };
  }

  private restoreScreenRecordingResumeState(
    screenRecordings: readonly ScreenRecordingResumeState[]
  ): void {
    this.screenRecordingChunks.clear();

    for (const recording of screenRecordings) {
      this.screenRecordingChunks.set(
        recording.recordingId,
        new Map(
          recording.chunks.map((chunk) => [
            chunk.index,
            {
              hash: chunk.hash,
              ...(chunk.size === undefined ? {} : { size: chunk.size })
            }
          ])
        )
      );
    }
  }

  private enqueueChunkOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.chunkOperationTail.then(operation);
    this.chunkOperationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private ensureStorageReady(): Promise<void> {
    this.storageReadyPromise ??= assertLocalAtRestStorage(
      this.options.storage,
      this.options.capturePolicy
    );
    return this.storageReadyPromise;
  }

  private async buildIndexesFromChunks(chunks: StoredChunk[]): Promise<ExportIndexes> {
    const indexer = new EventIndexer();

    for (const chunk of chunks) {
      indexer.addChunk(chunk.meta);
      indexer.addEvents(await decodeChunkEvents(chunk.bytes, chunk.meta.codec));
    }

    return indexer.snapshot();
  }

  private async decodeEventsFromChunks(chunks: StoredChunk[]): Promise<WebBlackboxEvent[]> {
    const events: WebBlackboxEvent[] = [];

    for (const chunk of chunks) {
      events.push(...(await decodeChunkEvents(chunk.bytes, chunk.meta.codec)));
    }

    return events;
  }

  private buildManifest(chunks: StoredChunk[], blobCount: number): ExportManifest {
    const first = chunks[0]?.meta.tStart ?? this.options.session.startedAt;
    const last = chunks[chunks.length - 1]?.meta.tEnd ?? this.options.session.startedAt;
    const chunkCodec = chunks[0]?.meta.codec ?? this.chunkCodec;

    return {
      protocolVersion: 1,
      createdAt: new Date().toISOString(),
      mode: this.options.session.mode,
      site: {
        origin: sanitizeUrlForPrivacy(this.options.session.url),
        title: this.options.session.title
      },
      chunkCodec,
      redactionProfile: this.options.redactionProfile ?? {
        redactHeaders: [],
        redactCookieNames: [],
        redactBodyPatterns: [],
        blockedSelectors: [],
        hashSensitiveValues: true
      },
      stats: {
        eventCount: chunks.reduce((count, chunk) => count + chunk.meta.eventCount, 0),
        chunkCount: chunks.length,
        blobCount,
        durationMs: Math.max(0, last - first)
      }
    };
  }
}

async function assertLocalAtRestStorage(
  storage: PipelineStorage,
  capturePolicy: CapturePolicy | undefined
): Promise<void> {
  const localAtRest = capturePolicy?.encryption.localAtRest ?? "required";

  if (localAtRest !== "required") {
    return;
  }

  const capability = storage[PIPELINE_STORAGE_SECURITY];

  if (!capability) {
    throw new Error(
      "Pipeline storage does not declare a verifiable local-at-rest security capability."
    );
  }

  if (
    capability.persistence === "persistent" &&
    (capability.payloadProtection !== "authenticated-encryption" ||
      capability.algorithm !== "AES-GCM")
  ) {
    throw new Error(
      "capturePolicy.encryption.localAtRest is required; persistent pipeline storage must use authenticated AES-GCM payload encryption."
    );
  }

  await storage.assertReady?.();
}

function resolveExportPolicy(
  options: ExportBundleOptions,
  context: {
    latestEventTimestamp?: number;
    sessionStartedAt: number;
    sessionEndedAt?: number;
  }
): ResolvedExportPolicy {
  const includeScreenshots =
    typeof options.includeScreenshots === "boolean"
      ? options.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof options.includeScreenRecordings === "boolean"
      ? options.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;
  const maxArchiveBytes =
    options.maxArchiveBytes === null
      ? null
      : normalizeBoundedPositiveInt(
          options.maxArchiveBytes ?? DEFAULT_EXPORT_POLICY.maxArchiveBytes
        );
  const recentWindowMs =
    options.recentWindowMs === null
      ? null
      : normalizeBoundedPositiveInt(options.recentWindowMs ?? DEFAULT_EXPORT_POLICY.recentWindowMs);
  const anchorTimestamp =
    typeof context.sessionEndedAt === "number"
      ? Math.max(
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionEndedAt,
          context.sessionStartedAt
        )
      : Math.max(
          Date.now(),
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionStartedAt
        );
  const cutoffTimestamp =
    recentWindowMs === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(0, anchorTimestamp - recentWindowMs);

  return {
    includeScreenshots,
    includeScreenRecordings,
    maxArchiveBytes,
    recentWindowMs,
    cutoffTimestamp,
    strictPrivacyScanner: options.strictPrivacyScanner === true
  };
}

function shouldIncludeEvent(event: WebBlackboxEvent, exportPolicy: ResolvedExportPolicy): boolean {
  if (!exportPolicy.includeScreenshots && event.type === SCREENSHOT_EVENT_TYPE) {
    return false;
  }

  if (!exportPolicy.includeScreenRecordings && isScreenRecordingEvent(event)) {
    return false;
  }

  if (event.t < exportPolicy.cutoffTimestamp) {
    return false;
  }

  return true;
}

function assertLowRiskOverrideAllowed(
  privacyManifest: PrivacyManifest,
  policy: CapturePolicy | undefined
): void {
  if (policy?.encryption.archive !== "explicit-low-risk-override") {
    return;
  }

  if (!policy.encryption.overrideReasonRef) {
    throw new Error("Explicit low-risk export override requires an audit reason reference.");
  }

  const highRiskSummary = privacyManifest.categories.find(
    (summary) =>
      summary.high > 0 ||
      (LOW_RISK_OVERRIDE_BLOCKED_CATEGORIES.has(summary.category) && summary.unredacted > 0)
  );

  if (highRiskSummary) {
    throw new Error(
      `Explicit low-risk export override is not allowed for high-risk ${highRiskSummary.category} artifacts.`
    );
  }
}

function assertTrustedPlaintextExemptionEvidence(
  policy: CapturePolicy,
  trustedEvidenceRefs: readonly string[] | undefined
): void {
  if (policy.captureContext === "real-user") {
    throw new Error("Plaintext export exemptions are not allowed for real-user capture context.");
  }

  const evidenceRef = policy.captureContextEvidenceRef?.trim();

  if (
    !evidenceRef ||
    !isWellFormedCaptureContextEvidenceRef(policy.captureContext, evidenceRef) ||
    !trustedEvidenceRefs?.includes(evidenceRef)
  ) {
    throw new Error("Plaintext export exemption requires trusted capture context evidence.");
  }
}

function isWellFormedCaptureContextEvidenceRef(
  context: CapturePolicy["captureContext"],
  evidenceRef: string
): boolean {
  if (context === "local-debug") {
    return LOCAL_DEBUG_EVIDENCE_PATTERN.test(evidenceRef);
  }

  if (context === "synthetic") {
    return SYNTHETIC_EVIDENCE_PATTERN.test(evidenceRef);
  }

  return false;
}

function buildExportTransferPolicy(input: {
  capturePolicy?: CapturePolicy;
  encrypted: boolean;
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number | null;
  recentWindowMs: number | null;
}): NonNullable<PrivacyManifest["transfer"]> {
  return {
    destination: "local-download",
    archiveKeyEnvelope: input.encrypted
      ? (input.capturePolicy?.encryption.archiveKeyEnvelope ?? "passphrase")
      : "none",
    encrypted: input.encrypted,
    includeScreenshots: input.includeScreenshots,
    includeScreenRecordings: input.includeScreenRecordings,
    maxArchiveBytes: input.maxArchiveBytes,
    recentWindowMs: input.recentWindowMs,
    shareEligible: input.encrypted,
    computedAt: new Date().toISOString()
  };
}

function isScreenRecordingEvent(event: WebBlackboxEvent): boolean {
  return event.type.startsWith(SCREEN_RECORDING_EVENT_PREFIX);
}

function collectBlobHashesFromEvents(events: WebBlackboxEvent[]): string[] {
  const hashes = new Set<string>();

  for (const event of events) {
    collectBlobHashesFromUnknown(event.data, hashes);
  }

  return [...hashes].sort();
}

function collectBlobHashesFromUnknown(value: unknown, output: Set<string>): void {
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();

    if (typeof current === "string") {
      if (SHA256_HEX_PATTERN.test(current)) {
        output.add(current);
      }

      continue;
    }

    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    for (const entry of Object.values(current as Record<string, unknown>)) {
      stack.push(entry);
    }
  }
}

function assertPrivacyClassifiedEvent(event: WebBlackboxEvent): void {
  if (!event.privacy) {
    throw new Error(`Event ${event.id} is missing privacy classification.`);
  }
}

function deriveRecorderSequenceWatermark(
  events: readonly WebBlackboxEvent[]
): RecorderSequenceWatermark {
  const watermark: RecorderSequenceWatermark = { event: 0, action: 0 };

  for (const event of events) {
    watermark.event = Math.max(
      watermark.event,
      parseCanonicalSequence(event.id, EVENT_SEQUENCE_PATTERN)
    );
    watermark.action = Math.max(
      watermark.action,
      parseCanonicalSequence(event.ref?.act, ACTION_SEQUENCE_PATTERN)
    );
  }

  return watermark;
}

function mergeSequenceWatermarks(
  left: RecorderSequenceWatermark,
  right: RecorderSequenceWatermark
): RecorderSequenceWatermark {
  return {
    event: Math.max(left.event, right.event),
    action: Math.max(left.action, right.action)
  };
}

function createPipelineDeliveryBatchKey(delivery: PipelineDeliveryEventProvenance): string {
  return JSON.stringify([delivery.tabId, delivery.frameId, delivery.documentId, delivery.batchId]);
}

function isSamePipelineDeliveryBatchIndex(
  left: PipelineDeliveryEventProvenance,
  right: PipelineDeliveryEventProvenance
): boolean {
  return (
    left.tabId === right.tabId &&
    left.frameId === right.frameId &&
    left.documentId === right.documentId &&
    left.batchId === right.batchId &&
    left.eventIndex === right.eventIndex
  );
}

function isSamePipelineDeliveryEventChange(
  left: PipelineDeliveryEventChange,
  right: PipelineDeliveryEventChange
): boolean {
  return (
    isSamePipelineDeliveryBatchIndex(left, right) &&
    left.fingerprint === right.fingerprint &&
    left.eventCount === right.eventCount &&
    left.eventId === right.eventId
  );
}

function normalizePipelineDeliverySidecar(
  sid: string,
  events: readonly WebBlackboxEvent[],
  deliveryByEventId: PipelineDeliverySidecar
): Map<string, PipelineDeliveryEventChange> {
  const eventIds = new Set<string>();
  const changes = new Map<string, PipelineDeliveryEventChange>();
  const indexesByBatch = new Map<string, Set<number>>();

  for (const event of events) {
    if (event.sid !== sid) {
      throw new Error("Pipeline delivered event belongs to another session.");
    }
    if (eventIds.has(event.id)) {
      throw new Error("Pipeline delivered event batch contains duplicate event ids.");
    }
    eventIds.add(event.id);

    if (!deliveryByEventId.has(event.id)) {
      continue;
    }
    const provenance = deliveryByEventId.get(event.id);
    if (!isPipelineDeliveryEventProvenance(provenance)) {
      throw new Error("Invalid pipeline delivery event provenance.");
    }

    const batchKey = createPipelineDeliveryBatchKey(provenance);
    const indexes = indexesByBatch.get(batchKey) ?? new Set<number>();
    if (indexes.has(provenance.eventIndex)) {
      throw new Error("Pipeline delivery sidecar repeats a batch event index.");
    }
    indexes.add(provenance.eventIndex);
    indexesByBatch.set(batchKey, indexes);
    changes.set(event.id, {
      ...provenance,
      outcome: "event",
      eventId: event.id
    });
  }

  for (const eventId of deliveryByEventId.keys()) {
    if (!eventIds.has(eventId)) {
      throw new Error("Pipeline delivery sidecar references an event outside its batch.");
    }
  }

  return changes;
}

function derivePipelineResumeDelta(
  base: RecorderSequenceWatermark,
  events: readonly WebBlackboxEvent[],
  deliveryChanges: readonly PipelineDeliveryEventChange[] = []
): PipelineResumeDelta {
  let sequenceWatermark = { ...base };
  const screenRecordingChanges: ScreenRecordingResumeChange[] = [];

  for (const event of events) {
    sequenceWatermark = mergeSequenceWatermarks(
      sequenceWatermark,
      deriveRecorderSequenceWatermark([event])
    );
    const change = readScreenRecordingResumeChange(event);

    if (change) {
      screenRecordingChanges.push(change);
    }
  }

  return deliveryChanges.length > 0
    ? {
        version: 2,
        sequenceWatermark,
        screenRecordingChanges,
        deliveryChanges: deliveryChanges.map((change) => ({ ...change }))
      }
    : {
        version: 1,
        sequenceWatermark,
        screenRecordingChanges
      };
}

function applyPipelineResumeDelta(
  base: PipelineResumeState,
  delta: PipelineResumeDelta
): PipelineResumeState {
  const screenRecordingChunks = screenRecordingCheckpointMapFromState(base);
  assertPipelineResumeChangesWithinLimits(screenRecordingChunks, delta.screenRecordingChanges);

  for (const change of delta.screenRecordingChanges) {
    applyScreenRecordingResumeChange(screenRecordingChunks, change);
  }

  return createPipelineResumeStateFromCheckpoints(delta.sequenceWatermark, screenRecordingChunks);
}

function screenRecordingCheckpointMapFromState(
  state: PipelineResumeState
): Map<string, Map<number, ScreenRecordingChunkCheckpoint>> {
  return new Map(
    state.screenRecordings.map((recording) => [
      recording.recordingId,
      new Map(
        recording.chunks.map((chunk) => [
          chunk.index,
          {
            hash: chunk.hash,
            ...(chunk.size === undefined ? {} : { size: chunk.size })
          }
        ])
      )
    ])
  );
}

function createPipelineResumeStateFromCheckpoints(
  sequenceWatermark: RecorderSequenceWatermark,
  screenRecordingChunks: Map<string, Map<number, ScreenRecordingChunkCheckpoint>>
): PipelineResumeState {
  return {
    sequenceWatermark: { ...sequenceWatermark },
    screenRecordings: [...screenRecordingChunks.entries()]
      .map(([recordingId, chunks]) => ({
        recordingId,
        chunks: [...chunks.entries()]
          .map(([index, checkpoint]) => ({ index, ...checkpoint }))
          .sort((left, right) => left.index - right.index)
      }))
      .sort((left, right) => left.recordingId.localeCompare(right.recordingId))
  };
}

function applyScreenRecordingEvent(
  output: Map<string, Map<number, ScreenRecordingChunkCheckpoint>>,
  event: WebBlackboxEvent
): void {
  const change = readScreenRecordingResumeChange(event);

  if (!change) {
    return;
  }

  applyScreenRecordingResumeChange(output, change);
}

function applyScreenRecordingResumeChange(
  output: Map<string, Map<number, ScreenRecordingChunkCheckpoint>>,
  change: ScreenRecordingResumeChange
): void {
  if (change.operation === "delete") {
    output.delete(change.recordingId);
    return;
  }

  if (change.operation === "reset") {
    output.set(change.recordingId, new Map());
    return;
  }

  const chunks =
    output.get(change.recordingId) ?? new Map<number, ScreenRecordingChunkCheckpoint>();
  chunks.set(change.index, {
    hash: change.hash,
    ...(change.size === undefined ? {} : { size: change.size })
  });
  output.set(change.recordingId, chunks);
}

function readScreenRecordingResumeChange(
  event: WebBlackboxEvent
): ScreenRecordingResumeChange | null {
  if (
    event.type !== "screen.recording.start" &&
    event.type !== "screen.recording.chunk" &&
    event.type !== "screen.recording.end" &&
    event.type !== "screen.recording.error"
  ) {
    return null;
  }

  const data = asUnknownRecord(event.data);
  const recordingId = data?.recordingId;

  if (typeof recordingId !== "string" || recordingId.length === 0 || recordingId.length > 256) {
    return null;
  }

  if (event.type === "screen.recording.start") {
    return {
      operation: "reset",
      recordingId
    };
  }

  if (event.type === "screen.recording.end") {
    return {
      operation: "delete",
      recordingId
    };
  }

  if (event.type === "screen.recording.error") {
    return data?.stage === "restart"
      ? {
          operation: "delete",
          recordingId
        }
      : null;
  }

  const hash = data?.chunkId;
  const index = data?.index;
  const size = data?.size;

  if (
    typeof hash !== "string" ||
    !BLOB_HASH_PATTERN.test(hash) ||
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    (index as number) >= PIPELINE_RESUME_MAX_SCREEN_CHUNKS
  ) {
    return null;
  }

  return {
    operation: "put",
    recordingId,
    index: index as number,
    hash,
    ...(Number.isSafeInteger(size) && (size as number) >= 0 ? { size: size as number } : {})
  };
}

function emptyPipelineResumeState(): PipelineResumeState {
  return {
    sequenceWatermark: { event: 0, action: 0 },
    screenRecordings: []
  };
}

function clonePipelineResumeState(state: PipelineResumeState): PipelineResumeState {
  return {
    sequenceWatermark: { ...state.sequenceWatermark },
    screenRecordings: state.screenRecordings.map((recording) => ({
      recordingId: recording.recordingId,
      chunks: recording.chunks.map((chunk) => ({ ...chunk }))
    }))
  };
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCanonicalSequence(value: unknown, pattern: RegExp): number {
  if (typeof value !== "string") {
    return 0;
  }

  const match = pattern.exec(value);
  const sequence = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

function normalizeBoundedPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.round(value));
}

function resolveChunkCodec(
  codec: (typeof CHUNK_CODECS)[number] | undefined
): (typeof CHUNK_CODECS)[number] {
  if (!codec) {
    return "none";
  }

  return CHUNK_CODECS.includes(codec) ? codec : "none";
}
