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
import type { PipelineStorage, StoredBlob, StoredChunk } from "./storage.js";

export type FlightRecorderPipelineOptions = {
  session: SessionMetadata;
  storage: PipelineStorage;
  maxChunkBytes?: number;
  chunkCodec?: (typeof CHUNK_CODECS)[number];
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
  trustedPlaintextExemptionEvidenceRefs?: readonly string[];
};

export type ExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest;
};

export type ExportBundleOptions = {
  passphrase?: string;
  includeScreenshots?: boolean;
  maxArchiveBytes?: number | null;
  recentWindowMs?: number | null;
  strictPrivacyScanner?: boolean;
};

type PreparedExportChunk = {
  chunk: StoredChunk;
  events: WebBlackboxEvent[];
  blobHashes: string[];
};

type ExportIndexes = {
  time: ReturnType<EventIndexer["snapshot"]>["time"];
  request: RequestIndexEntry[];
  inverted: InvertedIndexEntry[];
};

type ResolvedExportPolicy = {
  includeScreenshots: boolean;
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
const EXPORT_OVERHEAD_RESERVE_BYTES = 2 * 1024 * 1024;
const LOW_RISK_OVERRIDE_BLOCKED_CATEGORIES = new Set([
  "dom",
  "screenshots",
  "console",
  "network",
  "storage"
]);
const LOCAL_DEBUG_EVIDENCE_PATTERN = /^local-attestation:[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/;
const SYNTHETIC_EVIDENCE_PATTERN = /^(?:synthetic-fixture|ci-run):[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/;

export class FlightRecorderPipeline {
  private readonly chunker: EventChunker;
  private readonly chunkCodec: (typeof CHUNK_CODECS)[number];

  public constructor(private readonly options: FlightRecorderPipelineOptions) {
    const codec = resolveChunkCodec(options.chunkCodec);
    const maxChunkBytes = options.maxChunkBytes ?? 512 * 1024;
    this.chunkCodec = codec;
    this.chunker = new EventChunker(maxChunkBytes, codec);
  }

  public async start(): Promise<void> {
    const lastSequence =
      (await this.options.storage.getLatestChunkMeta(this.options.session.sid))?.seq ?? 0;

    this.chunker.restoreSequence(lastSequence);
    await this.options.storage.putSession(this.options.session);
  }

  public async ingest(event: WebBlackboxEvent): Promise<void> {
    assertPrivacyClassifiedEvent(event);
    const chunk = await this.chunker.append(event);

    if (!chunk) {
      return;
    }

    await this.persistChunk(
      chunk.meta.chunkId,
      chunk.meta.seq,
      chunk.meta.codec,
      chunk.events,
      chunk.bytes
    );
  }

  public async ingestBatch(events: WebBlackboxEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      assertPrivacyClassifiedEvent(event);
    }

    for (const event of events) {
      const chunk = await this.chunker.append(event);

      if (!chunk) {
        continue;
      }

      await this.persistChunk(
        chunk.meta.chunkId,
        chunk.meta.seq,
        chunk.meta.codec,
        chunk.events,
        chunk.bytes
      );
    }
  }

  public async flush(): Promise<void> {
    const chunk = await this.chunker.flush();

    if (!chunk) {
      return;
    }

    await this.persistChunk(
      chunk.meta.chunkId,
      chunk.meta.seq,
      chunk.meta.codec,
      chunk.events,
      chunk.bytes
    );
  }

  public async close(options: { purge?: boolean } = {}): Promise<void> {
    await this.flush();

    if (options.purge) {
      await this.options.storage.deleteSession(this.options.session.sid);
    }
  }

  public async putBlob(mime: string, bytes: Uint8Array): Promise<string> {
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
    await this.flush();
    const chunks = await this.options.storage.listChunks(this.options.session.sid);
    const snapshot = await this.buildIndexesFromChunks(chunks);
    await this.options.storage.putIndexes(this.options.session.sid, snapshot);
    return snapshot;
  }

  public async exportBundle(options: ExportBundleOptions = {}): Promise<ExportResult> {
    this.assertExportEncryptionPolicy(options);
    await this.flush();
    const rawChunks = await this.options.storage.listChunks(this.options.session.sid);
    const exportPolicy = resolveExportPolicy(options, {
      latestEventTimestamp: rawChunks[rawChunks.length - 1]?.meta.tEnd,
      sessionStartedAt: this.options.session.startedAt,
      sessionEndedAt: this.options.session.endedAt
    });
    const hasCustomSelection =
      !exportPolicy.includeScreenshots ||
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
        capturePolicy: this.options.capturePolicy,
        encrypted,
        transfer: buildExportTransferPolicy({
          capturePolicy: this.options.capturePolicy,
          encrypted,
          includeScreenshots: exportPolicy.includeScreenshots,
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
    const policy = this.options.capturePolicy;

    if (!policy) {
      return;
    }

    const hasPassphrase = typeof options.passphrase === "string" && options.passphrase.length > 0;

    if (policy.encryption.archive === "required" && !hasPassphrase) {
      throw new Error("Export encryption is required by the active capture policy.");
    }

    if (
      !hasPassphrase &&
      (policy.encryption.archive === "synthetic-local-debug-exempt" ||
        policy.encryption.archive === "explicit-low-risk-override")
    ) {
      assertTrustedPlaintextExemptionEvidence(
        policy,
        this.options.trustedPlaintextExemptionEvidenceRefs
      );
    }

    if (
      policy.captureContext === "real-user" &&
      policy.encryption.archive !== "synthetic-local-debug-exempt" &&
      !hasPassphrase
    ) {
      throw new Error("Real-user archives must be encrypted before export or share.");
    }
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
      capturePolicy: this.options.capturePolicy,
      encrypted,
      transfer: buildExportTransferPolicy({
        capturePolicy: this.options.capturePolicy,
        encrypted,
        includeScreenshots: exportPolicy.includeScreenshots,
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
    const first = events[0];
    const last = events[events.length - 1];
    const hash = await sha256Hex(bytes);

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
      bytes
    };

    await this.options.storage.putChunk(chunk);
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
    maxArchiveBytes: input.maxArchiveBytes,
    recentWindowMs: input.recentWindowMs,
    shareEligible: input.encrypted,
    computedAt: new Date().toISOString()
  };
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
