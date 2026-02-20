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

function createEvent(id: string, type: WebBlackboxEvent["type"], t: number): WebBlackboxEvent {
  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    t,
    mono: t,
    type,
    id,
    data: {
      reqId: "R-1",
      message: "hello"
    }
  };
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
});
