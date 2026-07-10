import { describe, expect, it, vi } from "vitest";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { EventChunker, type FinalizedChunk } from "./chunker.js";

function createEvent(index: number): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-chunker-concurrency",
    tab: 1,
    t: index,
    mono: index,
    type: "user.marker",
    id: `E-${index}`,
    privacy: {
      category: "actions",
      sensitivity: "low",
      redacted: true
    },
    data: {
      index
    }
  };
}

function finalized(chunks: Array<FinalizedChunk | null>): FinalizedChunk[] {
  return chunks.filter((chunk): chunk is FinalizedChunk => chunk !== null);
}

describe("EventChunker concurrency", () => {
  it("serializes concurrent threshold-crossing appends without duplicates or gaps", async () => {
    const chunker = new EventChunker(1, "none");
    const chunks = finalized(
      await Promise.all(
        Array.from({ length: 40 }, (_, index) => chunker.append(createEvent(index)))
      )
    );

    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1)
    );
    expect(chunks.flatMap((chunk) => chunk.events.map((event) => event.id))).toEqual(
      Array.from({ length: 40 }, (_, index) => `E-${index}`)
    );
    expect(new Set(chunks.map((chunk) => chunk.meta.chunkId)).size).toBe(40);
  });

  it("preserves invocation order when append and flush calls are interleaved", async () => {
    const chunker = new EventChunker(1024 * 1024, "none");
    const chunks = finalized(
      await Promise.all([
        chunker.append(createEvent(1)),
        chunker.flush(),
        chunker.append(createEvent(2)),
        chunker.append(createEvent(3)),
        chunker.flush()
      ])
    );

    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual([1, 2]);
    expect(chunks.map((chunk) => chunk.events.map((event) => event.id))).toEqual([
      ["E-1"],
      ["E-2", "E-3"]
    ]);
  });

  it("uses close as an ordered barrier and rejects later appends", async () => {
    const chunker = new EventChunker(1024 * 1024, "none");
    const first = chunker.append(createEvent(1));
    const second = chunker.append(createEvent(2));
    const closing = chunker.close();

    await expect(chunker.append(createEvent(3))).rejects.toThrow(/after close\(\) has started/i);

    const chunks = finalized(await Promise.all([first, second, closing]));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.meta.seq).toBe(1);
    expect(chunks[0]?.events.map((event) => event.id)).toEqual(["E-1", "E-2"]);
    await expect(chunker.close()).resolves.toBeNull();
    await expect(chunker.flush()).resolves.toBeNull();
  });

  it("orders delayed events by their sampled timeline before finalizing a chunk", async () => {
    const chunker = new EventChunker(1024 * 1024, "none");
    await chunker.append(createEvent(30));
    await chunker.append(createEvent(10));
    await chunker.append(createEvent(20));

    const chunk = await chunker.flush();

    expect(chunk?.events.map((event) => event.id)).toEqual(["E-10", "E-20", "E-30"]);
    expect(chunk?.meta).toMatchObject({
      tStart: 10,
      tEnd: 30,
      monoStart: 10,
      monoEnd: 30
    });
  });

  it("keeps wall and monotonic clocks ordered when their sampled order conflicts", async () => {
    const chunker = new EventChunker(1024 * 1024, "none");
    await chunker.append({ ...createEvent(10), t: 30 });
    await chunker.append({ ...createEvent(20), t: 10 });

    const chunk = await chunker.flush();

    expect(chunk?.events.map(({ t, mono }) => ({ t, mono }))).toEqual([
      { t: 30, mono: 10 },
      { t: 30, mono: 20 }
    ]);
    expect(chunk?.meta).toMatchObject({
      tStart: 30,
      tEnd: 30,
      monoStart: 10,
      monoEnd: 20
    });
  });

  it("clamps events that arrive behind an already finalized timeline boundary", async () => {
    const chunker = new EventChunker(1, "none");
    const first = await chunker.append(createEvent(30));
    const delayedInput = createEvent(10);
    const delayed = await chunker.append(delayedInput);

    expect(first?.events[0]).toMatchObject({ t: 30, mono: 30 });
    expect(delayed?.events[0]).toMatchObject({ id: "E-10", t: 30, mono: 30 });
    expect(delayedInput).toMatchObject({ t: 10, mono: 10 });
  });

  it("restores the durable timeline boundary before accepting resumed events", async () => {
    const chunker = new EventChunker(1, "none");
    chunker.restoreSequence(7);
    chunker.restoreTimelineBoundary(80, 100);

    const resumed = await chunker.append(createEvent(5));

    expect(resumed?.meta).toMatchObject({
      seq: 8,
      tStart: 80,
      tEnd: 80,
      monoStart: 100,
      monoEnd: 100
    });
    expect(resumed?.events[0]).toMatchObject({ t: 80, mono: 100 });
  });

  it("does not advance the timeline boundary when a chunk commit fails", async () => {
    const commit = vi
      .fn<(chunk: FinalizedChunk) => Promise<void>>()
      .mockRejectedValueOnce(new Error("simulated commit failure"))
      .mockResolvedValue(undefined);
    const chunker = new EventChunker(1, "none", commit);

    await expect(chunker.append(createEvent(50))).rejects.toThrow("simulated commit failure");
    const retried = await chunker.append(createEvent(10));

    expect(retried?.events[0]).toMatchObject({ t: 10, mono: 10 });
  });

  it("rolls back a failed append finalization without poisoning later operations", async () => {
    const commit = vi
      .fn<(chunk: FinalizedChunk) => Promise<void>>()
      .mockRejectedValueOnce(new Error("simulated commit failure"))
      .mockResolvedValue(undefined);
    const chunker = new EventChunker(1, "none", commit);

    await expect(chunker.append(createEvent(1))).rejects.toThrow("simulated commit failure");

    const retried = await chunker.append(createEvent(1));

    expect(retried?.meta.seq).toBe(1);
    expect(retried?.events.map((event) => event.id)).toEqual(["E-1"]);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.map(([chunk]) => chunk.meta.seq)).toEqual([1, 1]);
  });

  it("retains pending events when close finalization fails and permits close retry", async () => {
    const chunker = new EventChunker(1024 * 1024, "none");
    await chunker.append(createEvent(1));
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("simulated close failure"));

    await expect(chunker.close()).rejects.toThrow("simulated close failure");
    digest.mockRestore();
    await expect(chunker.append(createEvent(2))).rejects.toThrow(/after close\(\) has started/i);

    const retried = await chunker.close();

    expect(retried?.meta.seq).toBe(1);
    expect(retried?.events.map((event) => event.id)).toEqual(["E-1"]);
  });
});
