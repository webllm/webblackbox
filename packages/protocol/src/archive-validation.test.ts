import { describe, expect, it } from "vitest";

import type { ChunkTimeIndexEntry, ExportManifest, WebBlackboxEvent } from "./types.js";

import { assertArchiveChunk, assertArchiveLayout } from "./archive-validation.js";
import { DEFAULT_REDACTION_PROFILE } from "./defaults.js";

const SHA256 = "0".repeat(64);

describe("archive timeline validation", () => {
  it("rejects wall-clock regressions inside an otherwise bounded chunk", () => {
    const index = createIndexEntry(1, 100, 200, 1, 4, 4);
    const events = [
      createEvent("E-1", 100, 1),
      createEvent("E-2", 150, 2),
      createEvent("E-3", 120, 3),
      createEvent("E-4", 200, 4)
    ];

    expect(() =>
      assertArchiveChunk({
        path: "events/chunk-000001.ndjson",
        index,
        encodedByteLength: index.byteLength,
        encodedSha256: index.sha256,
        events
      })
    ).toThrow(/events are not in wall-clock order/i);
  });

  it.each([
    {
      label: "wall-clock",
      second: createIndexEntry(2, 90, 120, 20, 30),
      expected: /wall-clock ranges move backwards/i
    },
    {
      label: "monotonic",
      second: createIndexEntry(2, 110, 120, 9, 30),
      expected: /monotonic ranges move backwards/i
    }
  ])("rejects $label regressions between chunks", ({ second, expected }) => {
    expect(() => assertTwoChunkLayout(second)).toThrow(expected);
  });

  it("accepts adjacent chunks that share their boundary timestamps", () => {
    const second = createIndexEntry(2, 100, 120, 10, 30);

    expect(() => assertTwoChunkLayout(second)).not.toThrow();
  });
});

function assertTwoChunkLayout(second: ChunkTimeIndexEntry): void {
  const entries = [createIndexEntry(1, 50, 100, 1, 10), second];

  assertArchiveLayout({
    paths: [
      "manifest.json",
      "index/time.json",
      "index/req.json",
      "index/inv.json",
      "events/chunk-000001.ndjson",
      "events/chunk-000002.ndjson"
    ],
    manifest: createManifest(),
    timeIndex: entries,
    requestIndex: [],
    invertedIndex: [],
    privacyManifest: null
  });
}

function createIndexEntry(
  seq: number,
  tStart: number,
  tEnd: number,
  monoStart: number,
  monoEnd: number,
  eventCount = 1
): ChunkTimeIndexEntry {
  return {
    chunkId: `chunk-${String(seq).padStart(6, "0")}`,
    seq,
    tStart,
    tEnd,
    monoStart,
    monoEnd,
    eventCount,
    byteLength: 1,
    codec: "none",
    sha256: SHA256
  };
}

function createManifest(): ExportManifest {
  return {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: {
      origin: "https://example.com"
    },
    chunkCodec: "none",
    redactionProfile: DEFAULT_REDACTION_PROFILE,
    stats: {
      eventCount: 2,
      chunkCount: 2,
      blobCount: 0,
      durationMs: 70
    }
  };
}

function createEvent(id: string, t: number, mono: number): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-archive-validation",
    tab: 1,
    t,
    mono,
    type: "user.marker",
    id,
    data: {}
  };
}
