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
