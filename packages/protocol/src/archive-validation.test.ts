import { describe, expect, it } from "vitest";

import type {
  ChunkTimeIndexEntry,
  ExportManifest,
  PrivacyManifest,
  WebBlackboxEvent
} from "./types.js";

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

  it.each([
    "blobs/private.json",
    "blobs/sha256-nested/value.json",
    "blobs/sha256-.json",
    "blobs/sha256-not-a-digest.json",
    `blobs/sha256-${"a".repeat(64)}.exe`
  ])("rejects non-canonical blob path %s", (blobPath) => {
    const manifest = createManifest();
    manifest.stats.blobCount = 1;

    expect(() =>
      assertArchiveLayout({
        paths: [
          "manifest.json",
          "index/time.json",
          "index/req.json",
          "index/inv.json",
          "events/chunk-000001.ndjson",
          "events/chunk-000002.ndjson",
          blobPath
        ],
        manifest,
        timeIndex: [createIndexEntry(1, 50, 100, 1, 10), createIndexEntry(2, 100, 120, 10, 30)],
        requestIndex: [],
        invertedIndex: [],
        privacyManifest: null
      })
    ).toThrow(/invalid blob path/i);
  });

  it("rejects two blob paths that alias the same content digest", () => {
    const manifest = createManifest();
    manifest.stats.blobCount = 2;
    const hash = "a".repeat(64);

    expect(() =>
      assertArchiveLayout({
        paths: [
          "manifest.json",
          "index/time.json",
          "index/req.json",
          "index/inv.json",
          "events/chunk-000001.ndjson",
          "events/chunk-000002.ndjson",
          `blobs/sha256-${hash}.json`,
          `blobs/sha256-${hash}.bin`
        ],
        manifest,
        timeIndex: [createIndexEntry(1, 50, 100, 1, 10), createIndexEntry(2, 100, 120, 10, 30)],
        requestIndex: [],
        invertedIndex: [],
        privacyManifest: null
      })
    ).toThrow(/duplicate blob hash/i);
  });

  it.each(["secrets/private.json", "assets/nested/private.txt"])(
    "rejects unsupported archive file %s",
    (unsupportedPath) => {
      expect(() =>
        assertArchiveLayout({
          paths: [
            "manifest.json",
            "index/time.json",
            "index/req.json",
            "index/inv.json",
            "events/chunk-000001.ndjson",
            "events/chunk-000002.ndjson",
            unsupportedPath
          ],
          manifest: createManifest(),
          timeIndex: [createIndexEntry(1, 50, 100, 1, 10), createIndexEntry(2, 100, 120, 10, 30)],
          requestIndex: [],
          invertedIndex: [],
          privacyManifest: null
        })
      ).toThrow(/unsupported file/i);
    }
  );

  it.each([
    {
      label: "event counts beyond totals",
      mutate: (privacy: PrivacyManifest) => {
        privacy.scanner.coverage!.scannedEventCount = 3;
      },
      expected: /coverage exceeds archive totals/i
    },
    {
      label: "complete coverage below totals",
      mutate: (privacy: PrivacyManifest) => {
        privacy.scanner.coverage!.scannedEventCount = 1;
      },
      expected: /coverage is inconsistent/i
    },
    {
      label: "incomplete coverage without a reason",
      mutate: (privacy: PrivacyManifest) => {
        privacy.scanner.coverage!.complete = false;
      },
      expected: /coverage is inconsistent/i
    }
  ])("rejects $label", ({ mutate, expected }) => {
    const privacy = createPrivacyManifest();
    mutate(privacy);

    expect(() => assertPrivacyLayout(privacy)).toThrow(expected);
  });

  it("rejects privacy scanner status that contradicts its findings", () => {
    const privacy = createPrivacyManifest();
    privacy.scanner.findings.push({
      kind: "private-key",
      severity: "high",
      path: "event:E-1",
      matchCount: 1,
      sampleSha256: SHA256
    });

    expect(() => assertPrivacyLayout(privacy)).toThrow(/status does not match its findings/i);
  });
});

function assertPrivacyLayout(privacyManifest: PrivacyManifest): void {
  assertArchiveLayout({
    paths: [
      "manifest.json",
      "index/time.json",
      "index/req.json",
      "index/inv.json",
      "privacy/manifest.json",
      "events/chunk-000001.ndjson",
      "events/chunk-000002.ndjson"
    ],
    manifest: createManifest(),
    timeIndex: [createIndexEntry(1, 50, 100, 1, 10), createIndexEntry(2, 100, 120, 10, 30)],
    requestIndex: [],
    invertedIndex: [],
    privacyManifest
  });
}

function createPrivacyManifest(): PrivacyManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    categories: [],
    scanner: {
      scannedAt: new Date(0).toISOString(),
      preEncryption: true,
      status: "passed",
      findings: [],
      coverage: {
        complete: true,
        scannedEventCount: 2,
        scannedBlobCount: 0,
        opaqueBlobCount: 0,
        inspectedBytes: 1
      }
    },
    encryption: { archive: "plaintext" },
    totals: { events: 2, blobs: 0, privacyViolations: 0 }
  };
}

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
