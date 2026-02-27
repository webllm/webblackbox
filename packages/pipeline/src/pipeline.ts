import type {
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  RedactionProfile,
  RequestIndexEntry,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { CHUNK_CODECS } from "@webblackbox/protocol";

import { decodeEventsNdjson, encodeEventsNdjson } from "./codec.js";
import { EventChunker } from "./chunker.js";
import { createWebBlackboxArchive } from "./exporter.js";
import { sha256Hex } from "./hash.js";
import { EventIndexer } from "./indexer.js";
import type { PipelineStorage, StoredBlob, StoredChunk } from "./storage.js";

export type FlightRecorderPipelineOptions = {
  session: SessionMetadata;
  storage: PipelineStorage;
  maxChunkBytes?: number;
  chunkCodec?: (typeof CHUNK_CODECS)[number];
  redactionProfile?: RedactionProfile;
};

export type ExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
};

export type ExportBundleOptions = {
  passphrase?: string;
  includeScreenshots?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
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
};

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SCREENSHOT_EVENT_TYPE: WebBlackboxEvent["type"] = "screen.screenshot";
const EXPORT_OVERHEAD_RESERVE_BYTES = 2 * 1024 * 1024;

export class FlightRecorderPipeline {
  private readonly chunker: EventChunker;
  private readonly chunkCodec: (typeof CHUNK_CODECS)[number];

  private readonly indexer = new EventIndexer();

  private readonly blobHashes = new Set<string>();
  private readonly sessionBlobHashes = new Set<string>();

  public constructor(private readonly options: FlightRecorderPipelineOptions) {
    const codec = resolveChunkCodec(options.chunkCodec);
    const maxChunkBytes = options.maxChunkBytes ?? 512 * 1024;
    this.chunkCodec = codec;
    this.chunker = new EventChunker(maxChunkBytes, codec);
  }

  public async start(): Promise<void> {
    await this.options.storage.putSession(this.options.session);
  }

  public async ingest(event: WebBlackboxEvent): Promise<void> {
    const chunk = await this.chunker.append(event);

    if (!chunk) {
      return;
    }

    await this.persistChunk(chunk.meta.chunkId, chunk.meta.seq, chunk.events, chunk.bytes);
  }

  public async ingestBatch(events: WebBlackboxEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      const chunk = await this.chunker.append(event);

      if (!chunk) {
        continue;
      }

      await this.persistChunk(chunk.meta.chunkId, chunk.meta.seq, chunk.events, chunk.bytes);
    }
  }

  public async flush(): Promise<void> {
    const chunk = await this.chunker.flush();

    if (!chunk) {
      return;
    }

    await this.persistChunk(chunk.meta.chunkId, chunk.meta.seq, chunk.events, chunk.bytes);
  }

  public async close(options: { purge?: boolean } = {}): Promise<void> {
    await this.flush();

    if (options.purge) {
      await this.options.storage.deleteSession(this.options.session.sid, [
        ...this.sessionBlobHashes
      ]);
    }

    this.sessionBlobHashes.clear();
    this.blobHashes.clear();
  }

  public async putBlob(mime: string, bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    this.sessionBlobHashes.add(hash);

    if (this.blobHashes.has(hash)) {
      return hash;
    }

    this.blobHashes.add(hash);

    const blob: StoredBlob = {
      hash,
      mime,
      size: bytes.byteLength,
      bytes,
      createdAt: Date.now(),
      refCount: 1
    };

    await this.options.storage.putBlob(blob);
    return hash;
  }

  public async finalizeIndexes(): Promise<{
    time: ReturnType<EventIndexer["snapshot"]>["time"];
    request: RequestIndexEntry[];
    inverted: InvertedIndexEntry[];
  }> {
    const snapshot = this.indexer.snapshot();
    await this.options.storage.putIndexes(this.options.session.sid, snapshot);
    return snapshot;
  }

  public async exportBundle(options: ExportBundleOptions = {}): Promise<ExportResult> {
    await this.flush();
    const hasCustomSelection =
      options.includeScreenshots === false ||
      typeof options.maxArchiveBytes === "number" ||
      typeof options.recentWindowMs === "number";

    if (!hasCustomSelection) {
      const indexes = await this.finalizeIndexes();
      const chunks = await this.options.storage.listChunks(this.options.session.sid);
      const blobs = await this.listReferencedSessionBlobsFromChunks(chunks);
      const manifest = this.buildManifest(chunks, blobs.length);

      const { bytes, integrity } = await createWebBlackboxArchive(
        {
          manifest,
          chunks,
          blobs,
          timeIndex: indexes.time,
          requestIndex: indexes.request,
          invertedIndex: indexes.inverted
        },
        {
          passphrase: options.passphrase
        }
      );

      await this.options.storage.putIntegrity(this.options.session.sid, integrity);

      return {
        fileName: `${this.options.session.sid}.webblackbox`,
        bytes,
        integrity
      };
    }

    const rawChunks = await this.options.storage.listChunks(this.options.session.sid);
    const exportPolicy = resolveExportPolicy(options);
    const prepared = await this.prepareExportChunks(rawChunks, exportPolicy);
    const blobsByHash = await this.listSessionBlobMap();
    let selected = this.selectChunksBySize(prepared, blobsByHash, exportPolicy.maxArchiveBytes);
    let archive = await this.createArchiveForSelection(selected, blobsByHash, options.passphrase);

    if (
      exportPolicy.maxArchiveBytes !== null &&
      archive.bytes.byteLength > exportPolicy.maxArchiveBytes &&
      selected.length > 0
    ) {
      const fitted = await this.fitSelectionToArchiveLimit(
        selected,
        blobsByHash,
        exportPolicy.maxArchiveBytes,
        options.passphrase
      );

      selected = fitted.selected;
      archive = fitted.archive;
    }

    const { bytes, integrity } = archive;

    await this.options.storage.putIntegrity(this.options.session.sid, integrity);

    return {
      fileName: `${this.options.session.sid}.webblackbox`,
      bytes,
      integrity
    };
  }

  private async listSessionBlobs(): Promise<StoredBlob[]> {
    const hashes = [...this.sessionBlobHashes].sort();
    const blobs: StoredBlob[] = [];

    for (const hash of hashes) {
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
    const blobsByHash = await this.listSessionBlobMap();
    const referencedHashes = new Set<string>();

    for (const chunk of chunks) {
      const events = decodeEventsNdjson(chunk.bytes);
      const hashes = collectBlobHashesFromEvents(events);

      for (const hash of hashes) {
        referencedHashes.add(hash);
      }
    }

    const referenced: StoredBlob[] = [];

    for (const hash of [...referencedHashes].sort()) {
      const blob = blobsByHash.get(hash);

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
      const decoded = decodeEventsNdjson(chunk.bytes);
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

      const bytes = encodeEventsNdjson(filtered);
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
    passphrase?: string
  ): Promise<Awaited<ReturnType<typeof createWebBlackboxArchive>>> {
    const exportData = this.buildExportSnapshot(selectedChunks, blobsByHash);
    const manifest = this.buildManifest(exportData.chunks, exportData.blobs.length);

    return createWebBlackboxArchive(
      {
        manifest,
        chunks: exportData.chunks,
        blobs: exportData.blobs,
        timeIndex: exportData.indexes.time,
        requestIndex: exportData.indexes.request,
        invertedIndex: exportData.indexes.inverted
      },
      {
        passphrase
      }
    );
  }

  private async fitSelectionToArchiveLimit(
    selected: PreparedExportChunk[],
    blobsByHash: Map<string, StoredBlob>,
    maxArchiveBytes: number,
    passphrase?: string
  ): Promise<{
    selected: PreparedExportChunk[];
    archive: Awaited<ReturnType<typeof createWebBlackboxArchive>>;
  }> {
    let left = 1;
    let right = selected.length;
    let bestSelection: PreparedExportChunk[] | null = null;
    let bestArchive: Awaited<ReturnType<typeof createWebBlackboxArchive>> | null = null;

    while (left <= right) {
      const dropCount = Math.floor((left + right) / 2);
      const candidateSelection = selected.slice(dropCount);
      const candidateArchive = await this.createArchiveForSelection(
        candidateSelection,
        blobsByHash,
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
        codec: this.chunkCodec,
        sha256: hash
      },
      bytes
    };

    await this.options.storage.putChunk(chunk);
    this.indexer.addChunk(chunk.meta);
    this.indexer.addEvents(events);
  }

  private buildManifest(chunks: StoredChunk[], blobCount: number): ExportManifest {
    const first = chunks[0]?.meta.tStart ?? this.options.session.startedAt;
    const last = chunks[chunks.length - 1]?.meta.tEnd ?? this.options.session.startedAt;

    return {
      protocolVersion: 1,
      createdAt: new Date().toISOString(),
      mode: this.options.session.mode,
      site: {
        origin: this.options.session.url,
        title: this.options.session.title
      },
      chunkCodec: this.chunkCodec,
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

function resolveExportPolicy(options: ExportBundleOptions): ResolvedExportPolicy {
  const includeScreenshots = options.includeScreenshots !== false;
  const maxArchiveBytes = normalizeBoundedPositiveInt(options.maxArchiveBytes);
  const recentWindowMs = normalizeBoundedPositiveInt(options.recentWindowMs);
  const now = Date.now();
  const cutoffTimestamp =
    recentWindowMs === null ? Number.NEGATIVE_INFINITY : Math.max(0, now - recentWindowMs);

  return {
    includeScreenshots,
    maxArchiveBytes,
    recentWindowMs,
    cutoffTimestamp
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

function normalizeBoundedPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.round(value));
}

function resolveChunkCodec(
  codec: (typeof CHUNK_CODECS)[number] | undefined
): (typeof CHUNK_CODECS)[number] {
  if (!codec || codec === "none") {
    return "none";
  }

  console.warn(
    `[WebBlackbox] chunk codec '${codec}' is not implemented yet; falling back to 'none'.`
  );
  return "none";
}
