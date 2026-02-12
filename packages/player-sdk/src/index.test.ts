import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

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

    const searchResults = player.search("api");
    expect(searchResults[0]?.eventId).toBe("E-3");

    const blob = await player.getBlob("blob1");
    expect(blob?.mime).toBe("image/webp");
    expect(Array.from(blob?.bytes ?? [])).toEqual([1, 2, 3]);
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

    const report = player.generateBugReport({ title: "Issue Snapshot" });
    expect(report).toContain("# Issue Snapshot");
    expect(report).toContain("## Errors");

    const script = player.generatePlaywrightScript({ includeHarReplay: true });
    expect(script).toContain("context.routeFromHAR");
    expect(script).toContain("page.click");
  });

  it("compares two recordings", async () => {
    const left = await WebBlackboxPlayer.open(await createFixtureArchive());
    const right = await WebBlackboxPlayer.open(await createRichFixtureArchive());

    const comparison = left.compareWith(right);
    expect(comparison.eventDelta).toBeGreaterThan(0);
    expect(comparison.requestDelta).toBe(0);
    expect(comparison.typeDeltas.length).toBeGreaterThan(0);
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
  zip.file("integrity/hashes.json", JSON.stringify({ manifestSha256: "x", files: {} }));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file("blobs/sha256-blob1.webp", new Uint8Array([1, 2, 3]));

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
        req: "R-1",
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
        req: "R-1",
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
        req: "R-1",
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
      t: 2006,
      mono: 19,
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
      t: 2007,
      mono: 20,
      type: "user.marker",
      id: "E-17",
      data: {
        message: "bug here"
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
      blobCount: 2,
      durationMs: 10
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file(
    "index/req.json",
    JSON.stringify([{ reqId: "R-1", eventIds: ["E-12", "E-13", "E-14"] }])
  );
  zip.file("index/inv.json", JSON.stringify([{ term: "unexpected", eventIds: ["E-16"] }]));
  zip.file("integrity/hashes.json", JSON.stringify({ manifestSha256: "x", files: {} }));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  zip.file("blobs/sha256-blob1.webp", new Uint8Array([1, 2, 3]));
  zip.file("blobs/sha256-blob-body-1.json", new TextEncoder().encode('{"ok":true}'));

  return zip.generateAsync({ type: "uint8array" });
}
