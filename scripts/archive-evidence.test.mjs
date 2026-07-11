import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyRealWorldArchiveEvidence,
  verifyScreenRecordingArchiveEvidence
} from "../apps/extension/scripts/lib/archive-evidence.mjs";

test("real-world archive evidence reports exact missing markers, URLs, and event types", () => {
  const player = createPlayer({
    events: [
      {
        type: "console.entry",
        data: { message: "[wb-realworld] checkout ready" }
      },
      {
        type: "network.request",
        data: { url: "https://app.example/api/large-response?bytes=1024" }
      }
    ]
  });

  assert.deepEqual(
    verifyRealWorldArchiveEvidence(player, {
      markers: ["[wb-realworld] checkout ready", "[wb-realworld] upload complete"],
      urls: ["/api/large-response", "/api/missing"],
      eventTypes: ["console.entry", "dom.snapshot"]
    }),
    {
      ok: false,
      eventCount: 2,
      missingMarkers: ["[wb-realworld] upload complete"],
      missingUrls: ["/api/missing"],
      missingEventTypes: ["dom.snapshot"]
    }
  );
});

test("screen recording evidence reads every referenced recording blob", async () => {
  const chunkA = "a".repeat(64);
  const chunkB = "b".repeat(64);
  const reads = [];
  const player = createPlayer({
    events: [
      { type: "screen.recording.start", data: {} },
      { type: "screen.recording.chunk", data: { chunkId: chunkA } },
      { type: "screen.recording.end", data: { chunks: [chunkA, chunkB] } }
    ],
    files: {
      [`blobs/${chunkA}.webm`]: "hash-a",
      [`blobs/${chunkB}.webm`]: "hash-b"
    },
    blobs: new Map([
      [chunkA, { mime: "video/webm", bytes: new Uint8Array([1, 2]) }],
      [chunkB, { mime: "video/webm", bytes: new Uint8Array([3]) }]
    ]),
    reads
  });

  const result = await verifyScreenRecordingArchiveEvidence(player, {
    captureScreenshots: false,
    maxBlobBytes: 1024
  });

  assert.equal(result.ok, true);
  assert.equal(result.referencedChunks, 2);
  assert.deepEqual(result.missingChunkBlobs, []);
  assert.deepEqual(result.invalidChunkBlobs, []);
  assert.deepEqual(reads, [
    [chunkA, 1024],
    [chunkB, 1024]
  ]);
});

test("screen recording evidence fails on unreadable chunks and screenshot leakage", async () => {
  const missingChunk = "c".repeat(64);
  const invalidChunk = "d".repeat(64);
  const player = createPlayer({
    events: [
      { type: "screen.recording.start", data: {} },
      { type: "screen.recording.chunk", data: { chunkId: missingChunk } },
      { type: "screen.recording.end", data: { chunks: [missingChunk, invalidChunk] } },
      { type: "screen.screenshot", data: {} }
    ],
    files: {
      [`blobs/${invalidChunk}.webm`]: "hash-video",
      [`blobs/${"e".repeat(64)}.webp`]: "hash-screenshot"
    },
    blobs: new Map([[invalidChunk, { mime: "video/webm", bytes: new Uint8Array() }]])
  });

  const result = await verifyScreenRecordingArchiveEvidence(player, {
    captureScreenshots: false,
    maxBlobBytes: 1024
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingChunkBlobs, [missingChunk]);
  assert.deepEqual(result.invalidChunkBlobs, [
    { hash: invalidChunk, mime: "video/webm", bytes: 0 }
  ]);
  assert.equal(result.screenshotLeak, true);
});

function createPlayer({ events = [], files = {}, blobs = new Map(), reads = [] }) {
  return {
    events,
    archive: { integrity: { files } },
    async readBlobTransient(hash, maxBytes) {
      reads.push([hash, maxBytes]);
      return blobs.get(hash) ?? null;
    }
  };
}
