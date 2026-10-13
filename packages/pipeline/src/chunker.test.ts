import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { encodeChunkEvents } from "./codec.js";
import { EventChunker } from "./chunker.js";

vi.mock("./codec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codec.js")>();
  return {
    ...actual,
    encodeChunkEvents: vi.fn(actual.encodeChunkEvents)
  };
});

function createEvent(id: string, t: number, data: WebBlackboxEvent["data"] = {}): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-chunker",
    tab: 1,
    t,
    mono: t,
    type: "console.entry",
    id,
    data
  };
}

describe("EventChunker", () => {
  afterEach(() => {
    vi.mocked(encodeChunkEvents).mockClear();
  });

  it("assigns distinct chunk ids to finalizes that overlap", async () => {
    const chunker = new EventChunker(1, "none");

    const [first, second] = await Promise.all([
      chunker.append(createEvent("E-1", 1)),
      chunker.append(createEvent("E-2", 2))
    ]);

    expect(first?.meta).toMatchObject({ chunkId: "C-000001", seq: 1 });
    expect(second?.meta).toMatchObject({ chunkId: "C-000002", seq: 2 });
    expect(first?.events.map((event) => event.id)).toEqual(["E-1"]);
    expect(second?.events.map((event) => event.id)).toEqual(["E-2"]);
  });

  it("keeps buffered events when encoding a chunk fails", async () => {
    const chunker = new EventChunker(Number.MAX_SAFE_INTEGER, "none");

    await chunker.append(createEvent("E-1", 1));
    await chunker.append(createEvent("E-2", 2));

    vi.mocked(encodeChunkEvents).mockRejectedValueOnce(new Error("encode failed"));
    await expect(chunker.flush()).rejects.toThrow("encode failed");

    const retried = await chunker.flush();

    expect(retried?.events.map((event) => event.id)).toEqual(["E-1", "E-2"]);
  });

  it("rejects an unserializable event without buffering it", async () => {
    const chunker = new EventChunker(Number.MAX_SAFE_INTEGER, "none");

    await chunker.append(createEvent("E-1", 1));
    await expect(chunker.append(createEvent("E-bad", 2, { value: 1n }))).rejects.toThrow();

    const chunk = await chunker.flush();

    expect(chunk?.events.map((event) => event.id)).toEqual(["E-1"]);
  });
});
