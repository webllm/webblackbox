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
