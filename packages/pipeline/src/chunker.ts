import type { ChunkCodec, ChunkTimeIndexEntry, WebBlackboxEvent } from "@webblackbox/protocol";

import { createChunkId } from "@webblackbox/protocol";

import { encodeChunkEvents } from "./codec.js";
import { sha256Hex } from "./hash.js";

export type FinalizedChunk = {
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
  events: WebBlackboxEvent[];
};

export class EventChunker {
  private readonly pending: WebBlackboxEvent[] = [];

  private pendingBytes = 0;

  private sequence = 0;

  public constructor(
    private readonly maxChunkBytes: number,
    private readonly codec: ChunkCodec
  ) {}

  public async append(event: WebBlackboxEvent): Promise<FinalizedChunk | null> {
    this.pending.push(event);
    this.pendingBytes += estimateEventNdjsonBytes(event);

    if (this.pendingBytes < this.maxChunkBytes) {
      return null;
    }

    return this.finalize();
  }

  public async flush(): Promise<FinalizedChunk | null> {
    if (this.pending.length === 0) {
      return null;
    }

    return this.finalize();
  }

  public restoreSequence(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence <= this.sequence) {
      return;
    }

    this.sequence = Math.floor(sequence);
  }

  private async finalize(): Promise<FinalizedChunk> {
    this.sequence += 1;

    const events = [...this.pending];
    const encoded = await encodeChunkEvents(events, this.codec);
    const bytes = encoded.bytes;
    const first = events[0];
    const last = events[events.length - 1];
    const hash = await sha256Hex(bytes);

    this.pending.length = 0;
    this.pendingBytes = 0;

    return {
      meta: {
        chunkId: createChunkId(this.sequence),
        seq: this.sequence,
        tStart: first?.t ?? 0,
        tEnd: last?.t ?? 0,
        monoStart: first?.mono ?? 0,
        monoEnd: last?.mono ?? 0,
        eventCount: events.length,
        byteLength: bytes.byteLength,
        codec: encoded.codec,
        sha256: hash
      },
      bytes,
      events
    };
  }
}

function estimateEventNdjsonBytes(event: WebBlackboxEvent): number {
  return JSON.stringify(event).length + 1;
}
