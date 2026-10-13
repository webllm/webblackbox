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
    // Size the event before buffering it: an event that cannot be serialized
    // must be rejected here, not left behind to fail every later encode.
    const eventBytes = estimateEventNdjsonBytes(event);
    this.pending.push(event);
    this.pendingBytes += eventBytes;

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
    // Claim the sequence number and detach the buffer synchronously: encoding
    // and hashing below yield, and a finalize() that overlaps this one must get
    // its own chunk id and its own events. Reading this.sequence after the
    // awaits would hand both chunks the same id, and storage keyed by chunk id
    // would then keep only one of them.
    const sequence = ++this.sequence;
    const pendingBytes = this.pendingBytes;
    const events = this.pending.splice(0, this.pending.length);
    this.pendingBytes = 0;

    let encoded: Awaited<ReturnType<typeof encodeChunkEvents>>;
    let hash: string;

    try {
      encoded = await encodeChunkEvents(events, this.codec);
      hash = await sha256Hex(encoded.bytes);
    } catch (error) {
      // Put the events back so a later flush can retry them; otherwise callers
      // whose appends already resolved would lose them silently.
      this.pending.unshift(...events);
      this.pendingBytes += pendingBytes;
      throw error;
    }

    const bytes = encoded.bytes;
    const first = events[0];
    const last = events[events.length - 1];

    return {
      meta: {
        chunkId: createChunkId(sequence),
        seq: sequence,
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
