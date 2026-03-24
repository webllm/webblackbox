import * as zlib from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import type { ChunkTimeIndexEntry, ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";

describe("WebBlackboxPlayer", () => {
  it("opens archive and supports query/search/getBlob", async () => {
    const bytes = await createFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);

    expect(player.status).toBe("loaded");
    expect(player.archive.manifest.protocolVersion).toBe(1);

    const networkEvents = player.query({ types: ["network.request"] });
    expect(networkEvents).toHaveLength(1);
    expect(networkEvents[0]?.id).toBe("E-3");

    const reqEvents = player.query({ requestId: "R-1" });
    expect(reqEvents.map((event) => event.id)).toEqual(["E-3", "E-4"]);

    const textEvents = player.query({ text: "boom" });
    expect(textEvents.map((event) => event.id)).toContain("E-5");
    expect(player.query({ text: "example.com/api" }).map((event) => event.id)).toContain("E-3");
    expect(
      player.query({
        range: {
          monoStart: 3,
          monoEnd: 4
        }
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "E-3" }),
        expect.objectContaining({ id: "E-4" })
      ])
    );
    expect(
      player.query({
        range: {
          monoStart: 6,
          monoEnd: 5
        }
      })
    ).toHaveLength(0);

    const searchResults = player.search("api");
    expect(searchResults[0]?.eventId).toBe("E-3");

    const blob = await player.getBlob("blob1");
    expect(blob?.mime).toBe("image/webp");
    expect(Array.from(blob?.bytes ?? [])).toEqual([1, 2, 3]);
  });

  it("supports range-preloaded open via time index chunks", async () => {
    const bytes = await createTwoChunkFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes, {
      range: {
        monoStart: 50,
        monoEnd: 60
      }
    });

    expect(player.events.map((event) => event.id)).toEqual(["E-2"]);
    expect(player.query().map((event) => event.id)).toEqual(["E-2"]);
  });

  it("accepts ArrayBuffer and Blob archive inputs", async () => {
    const bytes = await createFixtureArchive();
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const fromArrayBuffer = await WebBlackboxPlayer.open(arrayBuffer);
    expect(fromArrayBuffer.events.length).toBeGreaterThan(0);

    const fromBlob = await WebBlackboxPlayer.open(new Blob([arrayBuffer]));
    expect(fromBlob.events.length).toBeGreaterThan(0);
  });

  it("opens plain archives without global Web Crypto when Node crypto is available", async () => {
    const bytes = await createFixtureArchive();
    const originalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      const player = await WebBlackboxPlayer.open(bytes);
      expect(player.events.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        writable: true,
        value: originalCrypto
      });
    }
  });

  it("throws for unsupported archive input type", async () => {
    await expect(WebBlackboxPlayer.open("invalid-input" as unknown as Uint8Array)).rejects.toThrow(
      /unsupported archive input type/i
    );
  });

  it("infers blob mime types by extension and rejects empty blob hashes", async () => {
    const fixture = await createFixtureArchive();
    const zip = await JSZip.loadAsync(fixture);
    zip.file("blobs/sha256-blobpng.png", Uint8Array.from([9]));
    zip.file("blobs/sha256-blobbin.bin", Uint8Array.from([8]));
    await writeIntegrityManifest(zip);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const player = await WebBlackboxPlayer.open(bytes);

    await expect(player.getBlob("   ")).resolves.toBeNull();
    await expect(player.getBlob("blobpng")).resolves.toEqual(
      expect.objectContaining({
        mime: "image/png"
      })
    );
    await expect(player.getBlob("blobbin")).resolves.toEqual(
      expect.objectContaining({
        mime: "application/octet-stream"
      })
    );
  });

  it("parses chunks lazily when queried", async () => {
    const bytes = await createLazyParseFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);

    expect(
      player.query({
        range: {
          monoStart: 0,
          monoEnd: 50
        }
      })
    ).toEqual([expect.objectContaining({ id: "E-L-1" })]);

    expect(() =>
      player.query({
        range: {
          monoStart: 90,
          monoEnd: 120
        }
      })
    ).toThrow(/chunk-000002/i);
  });

  it("memoizes full-range queries and derived analyzers", async () => {
    const bytes = await createFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      const firstEvents = player.events;
      const parseCountAfterFirstRead = parseSpy.mock.calls.length;

      expect(firstEvents.length).toBeGreaterThan(0);
      expect(parseCountAfterFirstRead).toBe(firstEvents.length);

      const secondEvents = player.events;
      const firstDerived = player.buildDerived();
      const secondDerived = player.buildDerived();
      const firstWaterfall = player.getNetworkWaterfall();
      const secondWaterfall = player.getNetworkWaterfall();
      const firstStorage = player.getStorageTimeline();
      const secondStorage = player.getStorageTimeline();
      const firstPerf = player.getPerformanceArtifacts();
      const secondPerf = player.getPerformanceArtifacts();

      expect(secondEvents).toBe(firstEvents);
      expect(secondDerived).toBe(firstDerived);
      expect(secondWaterfall).toBe(firstWaterfall);
      expect(secondStorage).toBe(firstStorage);
      expect(secondPerf).toBe(firstPerf);
      expect(parseSpy.mock.calls).toHaveLength(parseCountAfterFirstRead);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("opens archives with compressed chunk codecs", async () => {
    const codecs = supportedCompressedCodecsForTest();
    expect(codecs.length).toBeGreaterThan(0);

    for (const codec of codecs) {
      const bytes = await createCompressedCodecArchive(codec);
      const player = await WebBlackboxPlayer.open(bytes);

      expect(player.archive.manifest.chunkCodec).toBe(codec);
      expect(player.events.map((event) => event.id)).toEqual(["E-C-1", "E-C-2"]);
      expect(player.query({ requestId: `R-${codec}` }).map((event) => event.id)).toEqual(["E-C-2"]);
    }
  });

  it("opens encrypted archives when passphrase is provided", async () => {
    const bytes = await createEncryptedArchive(await createFixtureArchive(), "test-passphrase");

    await expect(WebBlackboxPlayer.open(bytes)).rejects.toThrow(/encrypted/i);

    const player = await WebBlackboxPlayer.open(bytes, {
      passphrase: "test-passphrase"
    });

    expect(player.query({ types: ["network.request"] })).toHaveLength(1);

    const blob = await player.getBlob("blob1");
    expect(Array.from(blob?.bytes ?? [])).toEqual([1, 2, 3]);
  });

  it("opens encrypted archives when atob is unavailable (Buffer fallback)", async () => {
    const originalAtob = (globalThis as unknown as { atob?: typeof atob }).atob;
    const bytes = await createEncryptedArchive(await createFixtureArchive(), "test-passphrase");

    Object.defineProperty(globalThis, "atob", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      const player = await WebBlackboxPlayer.open(bytes, {
        passphrase: "test-passphrase"
      });
      expect(player.events.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, "atob", {
        configurable: true,
        writable: true,
        value: originalAtob
      });
    }
  });

  it("fails encrypted archive open when Web Crypto API is unavailable", async () => {
    const bytes = await createEncryptedArchive(await createFixtureArchive(), "test-passphrase");
    const originalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      await expect(
        WebBlackboxPlayer.open(bytes, {
          passphrase: "test-passphrase"
        })
      ).rejects.toThrow(/Web Crypto API is required/i);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        writable: true,
        value: originalCrypto
      });
    }
  });

  it("rejects archives that use deprecated index/integrity layout paths", async () => {
    const bytes = await createDeprecatedLayoutArchive();

    await expect(WebBlackboxPlayer.open(bytes)).rejects.toThrow("integrity/hashes.json");
  });

  it("does not resolve blobs that omit the sha256- prefix in path names", async () => {
    const bytes = await createArchiveWithDeprecatedBlobPath();
    const player = await WebBlackboxPlayer.open(bytes);

    await expect(player.getBlob("blob1")).resolves.toBeNull();
    await expect(player.getBlob("sha256-blob1")).resolves.toBeNull();
    await expect(player.getBlob("blobs/blob1.webp")).resolves.toBeNull();
  });

  it("rejects archives with tampered manifest contents", async () => {
    const bytes = await tamperArchiveFile(
      await createFixtureArchive(),
      "manifest.json",
      JSON.stringify({
        protocolVersion: 999,
        createdAt: new Date(0).toISOString()
      })
    );

    await expect(WebBlackboxPlayer.open(bytes)).rejects.toThrow(/integrity mismatch/i);
  });

  it("rejects tampered blobs on demand", async () => {
    const bytes = await tamperArchiveFile(
      await createFixtureArchive(),
      "blobs/sha256-blob1.webp",
      Uint8Array.from([9, 9, 9, 9])
    );
    const player = await WebBlackboxPlayer.open(bytes);

    await expect(player.getBlob("blob1")).rejects.toThrow(/integrity mismatch/i);
  });

  it("rejects archives with undeclared event chunks", async () => {
    const source = await createFixtureArchive();
    const zip = await JSZip.loadAsync(source);
    zip.file(
      "events/chunk-999999.ndjson",
      JSON.stringify({
        v: 1,
        sid: "S-1",
        tab: 1,
        t: 999,
        mono: 999,
        type: "user.marker",
        id: "E-extra",
        data: { message: "extra" }
      })
    );

    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(WebBlackboxPlayer.open(bytes)).rejects.toThrow(
      /integrity manifest does not match archive contents/i
    );
  });

  it("builds derived action spans", async () => {
    const bytes = await createFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);
    const derived = player.buildDerived();

    expect(derived.totals.events).toBe(5);
    expect(derived.totals.errors).toBe(1);
    expect(derived.totals.requests).toBe(1);
    expect(new Set(derived.actionSpans.map((span) => span.actId))).toEqual(
      new Set(["A-1", "derived:E-2"])
    );
  });

  it("builds action timeline with request, error, and screenshot context", async () => {
    const bytes = await createRichFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);
    const timeline = player.getActionTimeline();
    const action = timeline.find((entry) => entry.actId === "A-2");

    expect(action).toBeDefined();
    expect(action?.triggerType).toBe("user.click");
    expect(action?.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reqId: "R-1",
          method: "POST",
          url: "https://example.com/api"
        })
      ])
    );
    expect(action?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "E-16",
          type: "error.exception"
        })
      ])
    );
    expect(action?.screenshot).toEqual(
      expect.objectContaining({
        eventId: "E-14S",
        shotId: "SHOT-1",
        format: "webp"
      })
    );
  });

  it("builds network waterfall and export helpers", async () => {
    const bytes = await createRichFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);

    const waterfall = player.getNetworkWaterfall();
    expect(waterfall).toHaveLength(1);
    expect(waterfall[0]?.reqId).toBe("R-1");
    expect(waterfall[0]?.status).toBe(200);
    expect(waterfall[0]?.responseBodyHash).toBe("blob-body-1");

    const curl = player.generateCurl("R-1");
    expect(curl).toContain("curl 'https://example.com/api'");
    expect(curl).toContain("-X POST");

    const fetchSnippet = player.generateFetch("R-1");
    expect(fetchSnippet).toContain("await fetch");
    expect(fetchSnippet).toContain("https://example.com/api");

    const har = JSON.parse(player.exportHar()) as {
      log: {
        entries: Array<{
          request: { method: string };
          response: { status: number };
        }>;
      };
    };
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]?.request.method).toBe("POST");
    expect(har.log.entries[0]?.response.status).toBe(200);
  });

  it("builds storage timeline, report, and playwright script", async () => {
    const bytes = await createRichFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);

    const timeline = player.getStorageTimeline();
    expect(timeline.some((entry) => entry.kind === "local")).toBe(true);

    const perfArtifacts = player.getPerformanceArtifacts();
    expect(perfArtifacts.some((entry) => entry.kind === "cpu")).toBe(true);
    expect(perfArtifacts.some((entry) => entry.kind === "heap")).toBe(true);

    const realtime = player.getRealtimeNetworkTimeline();
    expect(realtime.some((entry) => entry.protocol === "ws")).toBe(true);
    expect(realtime.some((entry) => entry.protocol === "sse")).toBe(true);

    const report = player.generateBugReport({ title: "Issue Snapshot" });
    expect(report).toContain("# Issue Snapshot");
    expect(report).toContain("## Errors");

    const githubIssue = player.generateGitHubIssueTemplate({
      title: "Checkout flow failure",
      labels: ["bug", "checkout"],
      assignees: ["qa-owner"]
    });
    expect(githubIssue.title).toBe("Checkout flow failure");
    expect(githubIssue.body).toContain("WebBlackbox Evidence");
    expect(githubIssue.labels).toEqual(["bug", "checkout"]);

    const jiraIssue = player.generateJiraIssueTemplate({
      title: "Checkout flow failure",
      projectKey: "WBX",
      priority: "High"
    });
    expect(jiraIssue.fields.project?.key).toBe("WBX");
    expect(jiraIssue.fields.priority?.name).toBe("High");
    expect(jiraIssue.fields.description).toContain("WebBlackbox Evidence");

    const script = player.generatePlaywrightScript({ includeHarReplay: true });
    expect(script).toContain("context.routeFromHAR");
    expect(script).toContain("page.click");

    const mockScript = await player.generatePlaywrightMockScript({ maxMocks: 5 });
    expect(mockScript).toContain("context.route(");
    expect(mockScript).toContain("route.fulfill");

    const domSnapshots = player.getDomSnapshots();
    expect(domSnapshots).toHaveLength(2);
    expect(domSnapshots[0]?.contentHash).toBe("dom-hash-1");

    const domDiff = await player.compareDomSnapshots("E-18", "E-19");
    expect(domDiff).not.toBeNull();
    expect(domDiff?.summary.added).toBeGreaterThan(0);
    expect(domDiff?.summary.removed).toBeGreaterThan(0);

    const domTimeline = await player.getDomDiffTimeline();
    expect(domTimeline).toHaveLength(1);
  });

  it("diffs lite DOM snapshots stored as HTML blobs", async () => {
    const bytes = await createLiteDomFixtureArchive();
    const player = await WebBlackboxPlayer.open(bytes);

    const domDiff = await player.compareDomSnapshots("E-lite-1", "E-lite-2");
    expect(domDiff).not.toBeNull();
    expect(domDiff?.summary.added).toBeGreaterThan(0);
    expect(domDiff?.summary.removed).toBeGreaterThan(0);

    const domTimeline = await player.getDomDiffTimeline();
    expect(domTimeline).toHaveLength(1);
    expect(domTimeline[0]?.summary.added).toBeGreaterThan(0);
  });

  it("compares two recordings", async () => {
    const left = await WebBlackboxPlayer.open(await createFixtureArchive());
    const right = await WebBlackboxPlayer.open(await createRichFixtureArchive());

    const comparison = left.compareWith(right);
    expect(comparison.leftSessionId).toBe("S-1");
    expect(comparison.rightSessionId).toBe("S-2");
    expect(comparison.leftSid).toBe("S-1");
    expect(comparison.rightSid).toBe("S-2");
    expect(comparison.eventDelta).toBeGreaterThan(0);
    expect(comparison.requestDelta).toBe(0);
    expect(comparison.typeDeltas.length).toBeGreaterThan(0);
    expect(comparison.endpointRegressions.length).toBeGreaterThan(0);
    expect(comparison.endpointRegressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "https://example.com/api",
          rightCount: 1
        })
      ])
    );

    const storageComparison = left.compareStorageWith(right);
    expect(storageComparison.rightEvents).toBeGreaterThan(storageComparison.leftEvents);
    expect(
      storageComparison.kindDeltas.some((delta) => delta.kind === "local" && delta.right > 0)
    ).toBe(true);
  });
});

async function createFixtureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-1",
      tab: 1,
      t: 1000,
      mono: 1,
      type: "meta.session.start",
      id: "E-1",
      data: {}
    },
    {
      v: 1,
      sid: "S-1",
      tab: 1,
      t: 1001,
      mono: 2,
      type: "user.click",
      id: "E-2",
      data: {
        target: "button"
      }
    },
    {
      v: 1,
      sid: "S-1",
      tab: 1,
      t: 1002,
      mono: 3,
      type: "network.request",
      id: "E-3",
      ref: {
        req: "R-1",
        act: "A-1"
      },
      data: {
        url: "https://example.com/api"
      }
    },
    {
      v: 1,
      sid: "S-1",
      tab: 1,
      t: 1003,
      mono: 4,
      type: "network.response",
      id: "E-4",
      ref: {
        req: "R-1",
        act: "A-1"
      },
      data: {
        status: 200
      }
    },
    {
      v: 1,
      sid: "S-1",
      tab: 1,
      t: 1004,
      mono: 5,
      type: "error.exception",
      id: "E-5",
      lvl: "error",
      data: {
        text: "boom"
      }
    }
  ];

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "Example"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 1,
      durationMs: 4
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file("index/req.json", JSON.stringify([{ reqId: "R-1", eventIds: ["E-3", "E-4"] }]));
  zip.file("index/inv.json", JSON.stringify([{ term: "api", eventIds: ["E-3"] }]));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file("blobs/sha256-blob1.webp", new Uint8Array([1, 2, 3]));

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

async function createDeprecatedLayoutArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: {
      origin: "https://example.com",
      title: "Deprecated Layout"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: 1,
      chunkCount: 1,
      blobCount: 0,
      durationMs: 0
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("indexes/time.json", JSON.stringify([]));
  zip.file("indexes/requests.json", JSON.stringify([]));
  zip.file("indexes/inverted.json", JSON.stringify([]));
  zip.file("integrity.json", JSON.stringify({ manifestSha256: "x", files: {} }));
  zip.file(
    "events/chunk-000001.ndjson",
    JSON.stringify({
      v: 1,
      sid: "S-DEPRECATED",
      tab: 1,
      t: 1,
      mono: 1,
      type: "meta.session.start",
      id: "E-1",
      data: {}
    })
  );

  return zip.generateAsync({ type: "uint8array" });
}

async function createTwoChunkFixtureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const eventsChunk1: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-3",
      tab: 1,
      t: 3000,
      mono: 10,
      type: "user.click",
      id: "E-1",
      data: {
        target: "button.first"
      }
    }
  ];
  const eventsChunk2: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-3",
      tab: 1,
      t: 3050,
      mono: 55,
      type: "error.exception",
      id: "E-2",
      lvl: "error",
      data: {
        message: "second chunk"
      }
    }
  ];
  const timeIndex: ChunkTimeIndexEntry[] = [
    {
      chunkId: "chunk-000001",
      seq: 1,
      tStart: 3000,
      tEnd: 3000,
      monoStart: 10,
      monoEnd: 10,
      eventCount: 1,
      byteLength: 128,
      codec: "none",
      sha256: "sha-1"
    },
    {
      chunkId: "chunk-000002",
      seq: 2,
      tStart: 3050,
      tEnd: 3050,
      monoStart: 55,
      monoEnd: 55,
      eventCount: 1,
      byteLength: 128,
      codec: "none",
      sha256: "sha-2"
    }
  ];

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "Two Chunk"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: 2,
      chunkCount: 2,
      blobCount: 0,
      durationMs: 45
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file(
    "events/chunk-000001.ndjson",
    eventsChunk1.map((event) => JSON.stringify(event)).join("\n")
  );
  zip.file(
    "events/chunk-000002.ndjson",
    eventsChunk2.map((event) => JSON.stringify(event)).join("\n")
  );

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

async function createLazyParseFixtureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const validEvents: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-LAZY",
      tab: 1,
      t: 5000,
      mono: 10,
      type: "user.click",
      id: "E-L-1",
      data: {
        target: "button.safe"
      }
    }
  ];
  const timeIndex: ChunkTimeIndexEntry[] = [
    {
      chunkId: "chunk-000001",
      seq: 1,
      tStart: 5000,
      tEnd: 5000,
      monoStart: 10,
      monoEnd: 10,
      eventCount: 1,
      byteLength: 128,
      codec: "none",
      sha256: "sha-lazy-1"
    },
    {
      chunkId: "chunk-000002",
      seq: 2,
      tStart: 5100,
      tEnd: 5100,
      monoStart: 100,
      monoEnd: 100,
      eventCount: 1,
      byteLength: 128,
      codec: "none",
      sha256: "sha-lazy-2"
    }
  ];
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "Lazy Parse"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: 2,
      chunkCount: 2,
      blobCount: 0,
      durationMs: 100
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file(
    "events/chunk-000001.ndjson",
    validEvents.map((event) => JSON.stringify(event)).join("\n")
  );
  zip.file("events/chunk-000002.ndjson", "{ invalid-json-line");

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

function supportedCompressedCodecsForTest(): Array<"gzip" | "br" | "zst"> {
  const codecs: Array<"gzip" | "br" | "zst"> = [];
  const zstdCompressSync = (
    zlib as unknown as { zstdCompressSync?: (input: Uint8Array) => Uint8Array }
  ).zstdCompressSync;

  if (typeof zlib.gzipSync === "function") {
    codecs.push("gzip");
  }

  if (typeof zlib.brotliCompressSync === "function") {
    codecs.push("br");
  }

  if (typeof zstdCompressSync === "function") {
    codecs.push("zst");
  }

  return codecs;
}

async function createCompressedCodecArchive(codec: "gzip" | "br" | "zst"): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: `S-C-${codec}`,
      tab: 3,
      t: 4000,
      mono: 40,
      type: "meta.session.start",
      id: "E-C-1",
      data: {}
    },
    {
      v: 1,
      sid: `S-C-${codec}`,
      tab: 3,
      t: 4001,
      mono: 41,
      type: "network.request",
      id: "E-C-2",
      ref: {
        req: `R-${codec}`
      },
      data: {
        requestId: `R-${codec}`,
        request: {
          method: "GET",
          url: `https://example.com/api/${codec}`
        }
      }
    }
  ];
  const ndjson = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
  const chunkBytes = compressBytesForCodec(ndjson, codec);
  const timeIndex: ChunkTimeIndexEntry[] = [
    {
      chunkId: "chunk-000001",
      seq: 1,
      tStart: 4000,
      tEnd: 4001,
      monoStart: 40,
      monoEnd: 41,
      eventCount: events.length,
      byteLength: chunkBytes.byteLength,
      codec,
      sha256: `sha-${codec}`
    }
  ];
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "Compressed Codec"
    },
    chunkCodec: codec,
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 0,
      durationMs: 1
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file("index/req.json", JSON.stringify([{ reqId: `R-${codec}`, eventIds: ["E-C-2"] }]));
  zip.file("index/inv.json", JSON.stringify([{ term: codec, eventIds: ["E-C-2"] }]));
  zip.file("events/chunk-000001.ndjson", chunkBytes);

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

function compressBytesForCodec(input: Uint8Array, codec: "gzip" | "br" | "zst"): Uint8Array {
  const zstdCompressSync = (
    zlib as unknown as { zstdCompressSync?: (input: Uint8Array) => Uint8Array }
  ).zstdCompressSync;

  if (codec === "gzip") {
    return toUint8Array(zlib.gzipSync(input));
  }

  if (codec === "br") {
    return toUint8Array(zlib.brotliCompressSync(input));
  }

  if (typeof zstdCompressSync !== "function") {
    throw new Error("zstd compression is unavailable in this runtime.");
  }

  return toUint8Array(zstdCompressSync(input));
}

function toUint8Array(value: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

async function createArchiveWithDeprecatedBlobPath(): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-DEPRECATED-BLOB",
      tab: 1,
      t: 1000,
      mono: 1,
      type: "meta.session.start",
      id: "E-B1",
      data: {}
    },
    {
      v: 1,
      sid: "S-DEPRECATED-BLOB",
      tab: 1,
      t: 1001,
      mono: 2,
      type: "screen.screenshot",
      id: "E-B2",
      data: {
        shotId: "blobs/blob1.webp",
        format: "webp"
      }
    }
  ];

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: {
      origin: "https://example.com",
      title: "Deprecated Blob Path"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 1,
      durationMs: 1
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file("blobs/blob1.webp", new Uint8Array([9, 8, 7]));

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

async function createRichFixtureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2000,
      mono: 10,
      type: "meta.session.start",
      id: "E-10",
      data: {}
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2001,
      mono: 11,
      type: "user.click",
      id: "E-11",
      ref: {
        act: "A-2"
      },
      data: {
        target: {
          selector: "button.submit"
        }
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2002,
      mono: 12,
      type: "network.request",
      id: "E-12",
      ref: {
        act: "A-2"
      },
      data: {
        requestId: "R-1",
        request: {
          method: "POST",
          url: "https://example.com/api",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer token"
          },
          postData: '{"hello":"world"}'
        }
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2003,
      mono: 15,
      type: "network.response",
      id: "E-13",
      ref: {
        act: "A-2"
      },
      data: {
        requestId: "R-1",
        response: {
          status: 200,
          statusText: "OK",
          mimeType: "application/json",
          headers: {
            "content-type": "application/json"
          }
        }
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2004,
      mono: 17,
      type: "network.body",
      id: "E-14",
      ref: {
        act: "A-2"
      },
      data: {
        reqId: "R-1",
        contentHash: "blob-body-1",
        size: 42
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2005,
      mono: 18,
      type: "screen.screenshot",
      id: "E-14S",
      ref: {
        act: "A-2"
      },
      data: {
        shotId: "SHOT-1",
        format: "webp",
        reason: "action",
        size: 128
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2005,
      mono: 18.05,
      type: "network.ws.open",
      id: "E-14A",
      data: {
        requestId: "WS-1",
        url: "wss://example.com/socket"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2005,
      mono: 18.2,
      type: "network.ws.frame",
      id: "E-14B",
      data: {
        requestId: "WS-1",
        direction: "received",
        frame: {
          opcode: 1,
          payloadLength: 5,
          payloadPreview: "hello"
        }
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2005,
      mono: 18.4,
      type: "network.sse.message",
      id: "E-14C",
      data: {
        phase: "message",
        url: "https://example.com/events",
        data: "evt"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2006,
      mono: 19,
      type: "storage.local.snapshot",
      id: "E-15",
      data: {
        hash: "storage-hash-1",
        count: 2,
        reason: "freeze:error"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2007,
      mono: 20,
      type: "error.exception",
      id: "E-16",
      lvl: "error",
      data: {
        message: "Unexpected failure"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2008,
      mono: 21,
      type: "user.marker",
      id: "E-17",
      data: {
        message: "bug here"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2009,
      mono: 22,
      type: "dom.snapshot",
      id: "E-18",
      data: {
        snapshotId: "D-1",
        contentHash: "dom-hash-1",
        source: "cdp",
        nodeCount: 5,
        reason: "interval"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2011,
      mono: 24,
      type: "dom.snapshot",
      id: "E-19",
      data: {
        snapshotId: "D-2",
        contentHash: "dom-hash-2",
        source: "cdp",
        nodeCount: 5,
        reason: "freeze:error"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2013,
      mono: 25,
      type: "perf.cpu.profile",
      id: "E-20",
      data: {
        profileHash: "cpu-hash-1",
        size: 128,
        reason: "freeze:error"
      }
    },
    {
      v: 1,
      sid: "S-2",
      tab: 9,
      t: 2014,
      mono: 26,
      type: "perf.heap.snapshot",
      id: "E-21",
      data: {
        snapshotHash: "heap-hash-1",
        size: 256,
        reason: "freeze:error"
      }
    }
  ];

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.com",
      title: "Example"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 6,
      durationMs: 16
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file(
    "index/req.json",
    JSON.stringify([{ reqId: "R-1", eventIds: ["E-12", "E-13", "E-14"] }])
  );
  zip.file("index/inv.json", JSON.stringify([{ term: "unexpected", eventIds: ["E-16"] }]));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file("blobs/sha256-blob1.webp", new Uint8Array([1, 2, 3]));
  zip.file("blobs/sha256-blob-body-1.json", new TextEncoder().encode('{"ok":true}'));
  zip.file("blobs/sha256-cpu-hash-1.json", new TextEncoder().encode('{"nodes":[]}'));
  zip.file("blobs/sha256-heap-hash-1.json", new TextEncoder().encode('{"snapshot":true}'));
  zip.file(
    "blobs/sha256-dom-hash-1.json",
    new TextEncoder().encode(JSON.stringify(createDomSnapshotPayload(["DIV", "P"])))
  );
  zip.file(
    "blobs/sha256-dom-hash-2.json",
    new TextEncoder().encode(JSON.stringify(createDomSnapshotPayload(["DIV", "SPAN"])))
  );

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

async function createLiteDomFixtureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid: "S-lite-dom",
      tab: 3,
      t: 3000,
      mono: 1,
      type: "meta.session.start",
      id: "E-lite-start",
      data: {}
    },
    {
      v: 1,
      sid: "S-lite-dom",
      tab: 3,
      t: 3001,
      mono: 2,
      type: "dom.snapshot",
      id: "E-lite-1",
      data: {
        snapshotId: "D-lite-1",
        contentHash: "dom-lite-1",
        source: "html",
        nodeCount: 3,
        reason: "interval"
      }
    },
    {
      v: 1,
      sid: "S-lite-dom",
      tab: 3,
      t: 3002,
      mono: 3,
      type: "dom.snapshot",
      id: "E-lite-2",
      data: {
        snapshotId: "D-lite-2",
        contentHash: "dom-lite-2",
        source: "html",
        nodeCount: 4,
        reason: "interval"
      }
    }
  ];

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: {
      origin: "https://example.com",
      title: "Example"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 2,
      durationMs: 2
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file(
    "blobs/sha256-dom-lite-1.html",
    new TextEncoder().encode("<html><body><div><p></p></div></body></html>")
  );
  zip.file(
    "blobs/sha256-dom-lite-2.html",
    new TextEncoder().encode("<html><body><div><span></span><a></a></div></body></html>")
  );

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

async function tamperArchiveFile(
  source: Uint8Array,
  path: string,
  content: string | Uint8Array
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(source);
  zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

async function writeIntegrityManifest(zip: JSZip): Promise<void> {
  const fileHashes: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    if (path === "integrity/hashes.json") {
      continue;
    }

    const file = zip.file(path);

    if (!file) {
      continue;
    }

    fileHashes[path] = await sha256HexForTest(await file.async("uint8array"));
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify(
      {
        manifestSha256: fileHashes["manifest.json"] ?? "",
        files: fileHashes
      },
      null,
      2
    )
  );
}

async function sha256HexForTest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function createDomSnapshotPayload(bodyChildren: string[]): Record<string, unknown> {
  const strings = ["#document", "HTML", "BODY", ...bodyChildren];
  const parentIndex = [-1, 0, 1];
  const nodeName = [0, 1, 2];

  for (let index = 0; index < bodyChildren.length; index += 1) {
    parentIndex.push(2);
    nodeName.push(3 + index);
  }

  return {
    strings,
    documents: [
      {
        nodes: {
          parentIndex,
          nodeName
        }
      }
    ]
  };
}

async function createEncryptedArchive(source: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(source);
  const manifestFile = zip.file("manifest.json");

  if (!manifestFile) {
    throw new Error("Missing manifest in fixture archive");
  }

  const manifest = JSON.parse(await manifestFile.async("string")) as ExportManifest;
  const salt = randomBytes(16);
  const iterations = 120_000;
  const key = await deriveArchiveKey(passphrase, salt, iterations);
  const files: Record<string, { ivBase64: string }> = {};

  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("events/") && !path.startsWith("blobs/")) {
      continue;
    }

    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const plain = await file.async("uint8array");
    const iv = randomBytes(12);
    const encrypted = await encryptBytes(plain, key, iv);
    zip.file(path, encrypted);
    files[path] = {
      ivBase64: toBase64(iv)
    };
  }

  manifest.encryption = {
    algorithm: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      saltBase64: toBase64(salt)
    },
    files
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  await writeIntegrityManifest(zip);
  return zip.generateAsync({ type: "uint8array" });
}

async function deriveArchiveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toArrayBuffer(salt)
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt"]
  );
}

async function encryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(bytes)
  );

  return new Uint8Array(encrypted);
}

function randomBytes(size: number): Uint8Array {
  const cryptoApi = requireCryptoApi();
  const bytes = new Uint8Array(size);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API unavailable in test environment.");
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  throw new Error("Base64 encoding is unavailable in this environment.");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
