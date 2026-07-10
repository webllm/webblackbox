import type { ChunkCodec, ChunkTimeIndexEntry, WebBlackboxEvent } from "@webblackbox/protocol";

import { createChunkId } from "@webblackbox/protocol";

import { encodeChunkEvents } from "./codec.js";
import { sha256Hex } from "./hash.js";

export type FinalizedChunk = {
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
  events: WebBlackboxEvent[];
};

/**
 * Persists a finalized chunk while the chunker's exclusive operation queue is held.
 * The callback must not call back into this EventChunker. A rejection does not
 * advance the sequence: append rolls back its event, while flush/close retain the
 * pending buffer, so the failed operation can be retried safely.
 */
export type FinalizedChunkCommit = (chunk: FinalizedChunk) => Promise<void>;

export class EventChunker {
  private readonly pending: WebBlackboxEvent[] = [];

  private pendingBytes = 0;

  private sequence = 0;

  private finalizedTimeEnd = Number.NEGATIVE_INFINITY;

  private finalizedMonoEnd = Number.NEGATIVE_INFINITY;

  private operationTail: Promise<void> = Promise.resolve();

  private acceptingEvents = true;

  private closed = false;

  private closePromise: Promise<FinalizedChunk | null> | null = null;

  public constructor(
    private readonly maxChunkBytes: number,
    private readonly codec: ChunkCodec,
    private readonly commit?: FinalizedChunkCommit
  ) {}

  public async append(event: WebBlackboxEvent): Promise<FinalizedChunk | null> {
    if (!this.acceptingEvents) {
      throw new Error("EventChunker cannot append events after close() has started.");
    }

    const eventBytes = estimateEventNdjsonBytes(event);

    return this.enqueue(async () => {
      this.pending.push(event);
      this.pendingBytes += eventBytes;

      if (this.pendingBytes < this.maxChunkBytes) {
        return null;
      }

      try {
        return await this.finalize();
      } catch (error) {
        this.pending.pop();
        this.pendingBytes -= eventBytes;
        throw error;
      }
    });
  }

  public async flush(): Promise<FinalizedChunk | null> {
    if (this.closed) {
      return null;
    }

    return this.enqueue(() => this.finalizePending());
  }

  public close(): Promise<FinalizedChunk | null> {
    if (this.closed) {
      return Promise.resolve(null);
    }

    if (this.closePromise) {
      return this.closePromise;
    }

    this.acceptingEvents = false;
    const attempt = this.enqueue(async () => {
      const chunk = await this.finalizePending();
      this.closed = true;
      return chunk;
    });
    const tracked = attempt.finally(() => {
      if (this.closePromise === tracked) {
        this.closePromise = null;
      }
    });

    this.closePromise = tracked;
    return tracked;
  }

  public restoreSequence(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence <= this.sequence) {
      return;
    }

    this.sequence = Math.floor(sequence);
  }

  public restoreTimelineBoundary(tEnd: number, monoEnd: number): void {
    if (Number.isFinite(tEnd)) {
      this.finalizedTimeEnd = Math.max(this.finalizedTimeEnd, tEnd);
    }

    if (Number.isFinite(monoEnd)) {
      this.finalizedMonoEnd = Math.max(this.finalizedMonoEnd, monoEnd);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    // A failed operation rejects its own caller but must not poison the queue.
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async finalizePending(): Promise<FinalizedChunk | null> {
    if (this.pending.length === 0) {
      return null;
    }

    return this.finalize();
  }

  private async finalize(): Promise<FinalizedChunk> {
    const events = canonicalizeEventTimeline(
      this.pending,
      this.finalizedTimeEnd,
      this.finalizedMonoEnd
    );
    const encoded = await encodeChunkEvents(events, this.codec);
    const bytes = encoded.bytes;
    const first = events[0];
    const last = events[events.length - 1];
    const hash = await sha256Hex(bytes);
    const sequence = this.sequence + 1;
    const chunk: FinalizedChunk = {
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

    await this.commit?.(chunk);

    this.pending.length = 0;
    this.pendingBytes = 0;
    this.sequence = sequence;
    this.finalizedTimeEnd = last?.t ?? this.finalizedTimeEnd;
    this.finalizedMonoEnd = last?.mono ?? this.finalizedMonoEnd;

    return chunk;
  }
}

function canonicalizeEventTimeline(
  events: readonly WebBlackboxEvent[],
  previousTimeEnd: number,
  previousMonoEnd: number
): WebBlackboxEvent[] {
  let time = previousTimeEnd;
  let mono = previousMonoEnd;

  return events
    .map((event, ordinal) => ({ event, ordinal }))
    .sort(
      (left, right) =>
        left.event.mono - right.event.mono ||
        left.event.t - right.event.t ||
        left.ordinal - right.ordinal
    )
    .map(({ event }) => {
      const nextTime = Math.max(time, event.t);
      const nextMono = Math.max(mono, event.mono);
      time = nextTime;
      mono = nextMono;

      if (nextTime === event.t && nextMono === event.mono) {
        return event;
      }

      return {
        ...event,
        t: nextTime,
        mono: nextMono
      };
    });
}

function estimateEventNdjsonBytes(event: WebBlackboxEvent): number {
  return JSON.stringify(event).length + 1;
}
