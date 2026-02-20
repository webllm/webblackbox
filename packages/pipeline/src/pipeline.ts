import type {
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { CHUNK_CODECS } from "@webblackbox/protocol";

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
};

export type ExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
};

export type ExportBundleOptions = {
  passphrase?: string;
};

export class FlightRecorderPipeline {
  private readonly chunker: EventChunker;

  private readonly indexer = new EventIndexer();

  private readonly blobHashes = new Set<string>();

  public constructor(private readonly options: FlightRecorderPipelineOptions) {
    const codec = options.chunkCodec ?? "none";
    const maxChunkBytes = options.maxChunkBytes ?? 512 * 1024;
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

  public async flush(): Promise<void> {
    const chunk = await this.chunker.flush();

    if (!chunk) {
      return;
    }

    await this.persistChunk(chunk.meta.chunkId, chunk.meta.seq, chunk.events, chunk.bytes);
  }

  public async putBlob(mime: string, bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);

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
    const indexes = await this.finalizeIndexes();
    const chunks = await this.options.storage.listChunks(this.options.session.sid);
    const blobs = await this.options.storage.listBlobs();
    const manifest = this.buildManifest(chunks);

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
        codec: this.options.chunkCodec ?? "none",
        sha256: hash
      },
      bytes
    };

    await this.options.storage.putChunk(chunk);
    this.indexer.addChunk(chunk.meta);
    this.indexer.addEvents(events);
  }

  private buildManifest(chunks: StoredChunk[]): ExportManifest {
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
      chunkCodec: this.options.chunkCodec ?? "none",
      redactionProfile: {
        redactHeaders: [],
        redactCookieNames: [],
        redactBodyPatterns: [],
        blockedSelectors: [],
        hashSensitiveValues: true
      },
      stats: {
        eventCount: chunks.reduce((count, chunk) => count + chunk.meta.eventCount, 0),
        chunkCount: chunks.length,
        blobCount: this.blobHashes.size,
        durationMs: Math.max(0, last - first)
      }
    };
  }
}
