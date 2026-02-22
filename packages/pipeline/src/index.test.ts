import { describe, expect, it } from "vitest";

import type { SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { readWebBlackboxArchive } from "./exporter.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import { MemoryPipelineStorage } from "./storage.js";

const SESSION: SessionMetadata = {
  sid: "S-test",
  tabId: 1,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com",
  tags: []
};

function createEvent(
  id: string,
  type: WebBlackboxEvent["type"],
  t: number,
  data?: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    t,
    mono: t,
    type,
    id,
    data: data ?? {
      reqId: "R-1",
      message: "hello"
    }
  };
}

function createNoisyPayload(size: number, seed: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = ((seed + 1) * 48_271) % 2_147_483_647;
  let output = "";

  for (let index = 0; index < size; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    const cursor = state % chars.length;
    output += chars[cursor] ?? "x";
  }

  return output;
}

describe("pipeline", () => {
  it("chunks events and builds request index", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 100
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-1", "network.request", 1));
    await pipeline.ingest(createEvent("E-2", "network.response", 2));
    await pipeline.flush();
    await pipeline.finalizeIndexes();

    const chunks = await storage.listChunks(SESSION.sid);
    const indexes = await storage.getIndexes(SESSION.sid);

    expect(chunks.length).toBeGreaterThan(0);
    expect(indexes.request.some((entry) => entry.reqId === "R-1")).toBe(true);
  });

  it("deduplicates blobs by sha256", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    const bytes = new TextEncoder().encode("blob-content");

    const first = await pipeline.putBlob("application/octet-stream", bytes);
    const second = await pipeline.putBlob("application/octet-stream", bytes);

    expect(first).toBe(second);
    expect((await storage.listBlobs()).length).toBe(1);
  });

  it("exports and reads .webblackbox archive", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-1", "user.click", 10));
    await pipeline.ingest(createEvent("E-2", "network.request", 20));
    await pipeline.ingest(createEvent("E-3", "network.response", 30));

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events.length).toBeGreaterThanOrEqual(3);
    expect(parsed.manifest.protocolVersion).toBe(1);
    expect(parsed.integrity).not.toBeNull();
  });

  it("supports AES-GCM export encryption with passphrase", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-enc-1", "user.click", 100));
    await pipeline.ingest(createEvent("E-enc-2", "network.request", 120));

    const exported = await pipeline.exportBundle({ passphrase: "secret-passphrase" });

    await expect(readWebBlackboxArchive(exported.bytes)).rejects.toThrow(/encrypted/i);

    const parsed = await readWebBlackboxArchive(exported.bytes, {
      passphrase: "secret-passphrase"
    });

    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.manifest.encryption?.algorithm).toBe("AES-GCM");
    expect(
      Object.keys(parsed.manifest.encryption?.files ?? {}).some((path) =>
        path.startsWith("events/")
      )
    ).toBe(true);
  });

  it("supports export filtering by screenshot and recent time window", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();

    const shotHash = await pipeline.putBlob("image/webp", new Uint8Array([1, 2, 3, 4]));
    const now = Date.now();
    const old = now - 50 * 60 * 1000;
    const recent = now - 5 * 60 * 1000;

    await pipeline.ingest(createEvent("E-old", "user.click", old));
    await pipeline.ingest(
      createEvent("E-shot", "screen.screenshot", recent, {
        shotId: shotHash,
        format: "webp",
        size: 4
      })
    );
    await pipeline.ingest(createEvent("E-new", "user.marker", now, { message: "m" }));

    const exported = await pipeline.exportBundle({
      includeScreenshots: false,
      recentWindowMs: 20 * 60 * 1000,
      maxArchiveBytes: 100 * 1024 * 1024
    });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events.some((event) => event.type === "screen.screenshot")).toBe(false);
    expect(parsed.events.some((event) => event.t < now - 20 * 60 * 1000)).toBe(false);
  });

  it("limits exported archive size to recent suffix of chunks", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    const base = Date.now() - 3 * 60 * 1000;

    for (let index = 0; index < 60; index += 1) {
      await pipeline.ingest(
        createEvent(`E-size-${index}`, "sys.notice", base + index * 1000, {
          index,
          payload: createNoisyPayload(4096, index)
        })
      );
    }

    const exported = await pipeline.exportBundle({
      maxArchiveBytes: 150 * 1024,
      recentWindowMs: 60 * 60 * 1000,
      includeScreenshots: true
    });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(exported.bytes.byteLength).toBeLessThanOrEqual(150 * 1024);
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.events.length).toBeLessThan(60);
  });
});
