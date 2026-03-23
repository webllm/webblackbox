import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import type { SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { readWebBlackboxArchive } from "./exporter.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import {
  derivePipelineStorageKey,
  EncryptedPipelineStorage,
  MemoryPipelineStorage
} from "./storage.js";

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

  it("encodes and decodes chunk codecs when runtime support is available", async () => {
    for (const codec of ["gzip", "br", "zst"] as const) {
      const storage = new MemoryPipelineStorage();
      const pipeline = new FlightRecorderPipeline({
        session: {
          ...SESSION,
          sid: `S-codec-${codec}`
        },
        storage,
        maxChunkBytes: 100,
        chunkCodec: codec
      });

      await pipeline.start();
      await pipeline.ingest(
        createEvent(`E-codec-${codec}`, "network.request", 1, {
          reqId: `R-${codec}`,
          payload: "x".repeat(5000)
        })
      );
      await pipeline.flush();

      const chunks = await storage.listChunks(`S-codec-${codec}`);
      const exported = await pipeline.exportBundle();
      const parsed = await readWebBlackboxArchive(exported.bytes);
      const runtimeCodec = chunks[0]?.meta.codec ?? "none";

      expect(parsed.events.some((event) => event.id === `E-codec-${codec}`)).toBe(true);
      expect(parsed.timeIndex[0]?.codec).toBe(runtimeCodec);
      expect(parsed.manifest.chunkCodec).toBe(runtimeCodec);

      if (runtimeCodec !== "none") {
        expect(runtimeCodec).toBe(codec);
      }
    }
  });

  it("ingests batches without losing index coverage", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 120
    });

    await pipeline.start();
    await pipeline.ingestBatch([
      createEvent("E-batch-1", "network.request", 11, { reqId: "R-batch" }),
      createEvent("E-batch-2", "network.response", 12, { reqId: "R-batch", status: 200 }),
      createEvent("E-batch-3", "console.entry", 13, { text: "batch" })
    ]);
    await pipeline.flush();
    await pipeline.finalizeIndexes();

    const chunks = await storage.listChunks(SESSION.sid);
    const indexes = await storage.getIndexes(SESSION.sid);

    expect(chunks.length).toBeGreaterThan(0);
    expect(indexes.request.some((entry) => entry.reqId === "R-batch")).toBe(true);
  });

  it("skips oversized hash/base64-like terms in inverted index", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 256
    });
    const shaLike = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const base64Like = "a".repeat(120);

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-inv-1", "sys.notice", Date.now(), {
        reqId: "R-inv-1",
        message: "normal-term",
        hash: shaLike,
        blob: base64Like
      })
    );
    await pipeline.flush();
    await pipeline.finalizeIndexes();

    const indexes = await storage.getIndexes(SESSION.sid);
    const terms = new Set(indexes.inverted.map((entry) => entry.term));

    expect(terms.has("normal-term")).toBe(true);
    expect(terms.has(shaLike)).toBe(false);
    expect(terms.has(base64Like)).toBe(false);
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

  it("rebuilds indexes and blob lookup from stored chunks after pipeline recovery", async () => {
    const storage = new MemoryPipelineStorage();
    const session: SessionMetadata = {
      ...SESSION,
      sid: "S-recovery"
    };
    const initialPipeline = new FlightRecorderPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await initialPipeline.start();
    const shotHash = await initialPipeline.putBlob("image/webp", Uint8Array.from([1, 2, 3, 4]));
    await initialPipeline.ingest(
      createEvent("E-recovery-shot", "screen.screenshot", 100, {
        shotId: shotHash,
        format: "webp",
        size: 4
      })
    );
    await initialPipeline.ingest(
      createEvent("E-recovery-req", "network.request", 120, {
        reqId: "R-recovery",
        url: "https://example.com/api/recovery"
      })
    );
    await initialPipeline.flush();

    const recoveredPipeline = new FlightRecorderPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await recoveredPipeline.start();

    const exported = await recoveredPipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);
    const zip = await JSZip.loadAsync(exported.bytes);
    const blobPaths = Object.keys(zip.files).filter((path) => path.startsWith("blobs/"));

    expect(parsed.events.map((event) => event.id)).toEqual(
      expect.arrayContaining(["E-recovery-shot", "E-recovery-req"])
    );
    expect(parsed.requestIndex.some((entry) => entry.reqId === "R-recovery")).toBe(true);
    expect(blobPaths.some((path) => path.includes(shotHash))).toBe(true);
  });

  it("continues chunk sequencing after pipeline recovery", async () => {
    const storage = new MemoryPipelineStorage();
    const session: SessionMetadata = {
      ...SESSION,
      sid: "S-recovery-seq"
    };
    const initialPipeline = new FlightRecorderPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await initialPipeline.start();
    await initialPipeline.ingest(
      createEvent("E-recovery-seq-1", "network.request", 10, {
        reqId: "R-recovery-seq-1",
        payload: "x".repeat(80)
      })
    );
    await initialPipeline.flush();

    const recoveredPipeline = new FlightRecorderPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await recoveredPipeline.start();
    await recoveredPipeline.ingest(
      createEvent("E-recovery-seq-2", "network.response", 20, {
        reqId: "R-recovery-seq-1",
        payload: "y".repeat(80)
      })
    );
    await recoveredPipeline.flush();

    const chunks = await storage.listChunks(session.sid);

    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual([1, 2]);
    expect(chunks.map((chunk) => chunk.meta.chunkId)).toEqual(["C-000001", "C-000002"]);
  });

  it("exports only blobs referenced by retained events", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    const referenced = await pipeline.putBlob("image/webp", new Uint8Array([1, 2, 3]));
    const orphan = await pipeline.putBlob("application/json", new TextEncoder().encode('{"x":1}'));

    await pipeline.ingest(
      createEvent("E-ref-blob", "screen.screenshot", Date.now(), {
        shotId: referenced,
        format: "webp",
        size: 3
      })
    );

    const exported = await pipeline.exportBundle();
    const zip = await JSZip.loadAsync(exported.bytes);
    const blobPaths = Object.keys(zip.files).filter((path) => path.startsWith("blobs/"));

    expect(blobPaths.some((path) => path.includes(referenced))).toBe(true);
    expect(blobPaths.some((path) => path.includes(orphan))).toBe(false);
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

  it("rejects archives with integrity mismatches on read", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-integrity-1", "user.click", 10));

    const exported = await pipeline.exportBundle();
    const zip = await JSZip.loadAsync(exported.bytes);
    zip.file(
      "events/C-000001.ndjson",
      JSON.stringify({
        v: 1,
        sid: SESSION.sid,
        tab: 1,
        t: 10,
        mono: 10,
        type: "user.marker",
        id: "E-tampered",
        data: { message: "tampered" }
      })
    );

    const tampered = await zip.generateAsync({ type: "uint8array" });

    await expect(readWebBlackboxArchive(tampered)).rejects.toThrow(/integrity mismatch/i);
  });

  it("writes provided redaction profile into export manifest", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128,
      redactionProfile: {
        redactHeaders: ["authorization"],
        redactCookieNames: ["session"],
        redactBodyPatterns: ["token"],
        blockedSelectors: ["input[type='password']"],
        hashSensitiveValues: false
      }
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-redaction-1", "user.click", Date.now()));

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.manifest.redactionProfile).toEqual({
      redactHeaders: ["authorization"],
      redactCookieNames: ["session"],
      redactBodyPatterns: ["token"],
      blockedSelectors: ["input[type='password']"],
      hashSensitiveValues: false
    });
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

  it("supports optional at-rest encryption for chunk/blob cache payloads", async () => {
    const baseStorage = new MemoryPipelineStorage();
    const key = await derivePipelineStorageKey("cache-passphrase", {
      salt: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    });
    const storage = new EncryptedPipelineStorage(baseStorage, {
      key: key.key
    });
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    const screenshotHash = await pipeline.putBlob("image/webp", Uint8Array.from([1, 2, 3, 4]));
    await pipeline.ingest(
      createEvent("E-atrest-1", "screen.screenshot", 100, {
        shotId: screenshotHash,
        format: "webp",
        size: 4
      })
    );
    await pipeline.ingest(createEvent("E-atrest-2", "network.request", 120));
    await pipeline.flush();

    const rawChunks = await baseStorage.listChunks(SESSION.sid);
    expect(rawChunks.length).toBeGreaterThan(0);
    const rawChunkText = new TextDecoder().decode(rawChunks[0]?.bytes ?? new Uint8Array());
    expect(rawChunkText).not.toContain("E-atrest-1");

    const rawBlob = await baseStorage.getBlob(screenshotHash);
    expect(rawBlob).toBeDefined();
    expect(Array.from(rawBlob?.bytes ?? [])).not.toEqual([1, 2, 3, 4]);

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);
    expect(parsed.events.map((event) => event.id)).toEqual(
      expect.arrayContaining(["E-atrest-1", "E-atrest-2"])
    );
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

  it("anchors recent-window exports to the latest session activity", async () => {
    const storage = new MemoryPipelineStorage();
    const sessionEnd = Date.now() - 2 * 60 * 60 * 1000;
    const session: SessionMetadata = {
      ...SESSION,
      sid: "S-export-anchor",
      startedAt: sessionEnd - 60 * 60 * 1000,
      endedAt: sessionEnd
    };
    const pipeline = new FlightRecorderPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-anchor-old", "user.click", sessionEnd - 50 * 60 * 1000));
    await pipeline.ingest(
      createEvent("E-anchor-recent", "user.marker", sessionEnd - 5 * 60 * 1000)
    );

    const exported = await pipeline.exportBundle({
      includeScreenshots: true,
      recentWindowMs: 20 * 60 * 1000
    });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events.map((event) => event.id)).toEqual(["E-anchor-recent"]);
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

  it("purges session-scoped chunks/indexes/integrity and blob refs on close", async () => {
    const storage = new MemoryPipelineStorage();
    const sessionA: SessionMetadata = {
      ...SESSION,
      sid: "S-purge-a"
    };
    const sessionB: SessionMetadata = {
      ...SESSION,
      sid: "S-purge-b"
    };
    const pipelineA = new FlightRecorderPipeline({
      session: sessionA,
      storage,
      maxChunkBytes: 128
    });
    const pipelineB = new FlightRecorderPipeline({
      session: sessionB,
      storage,
      maxChunkBytes: 128
    });

    await pipelineA.start();
    await pipelineB.start();

    const sharedBytes = new TextEncoder().encode("shared-blob");
    await pipelineA.putBlob("text/plain", sharedBytes);
    await pipelineB.putBlob("text/plain", sharedBytes);

    await pipelineA.ingest(createEvent("E-pa-1", "user.click", 1));
    await pipelineA.flush();
    await pipelineA.finalizeIndexes();
    await pipelineB.ingest(createEvent("E-pb-1", "user.click", 2));
    await pipelineB.flush();
    await pipelineB.finalizeIndexes();

    await pipelineA.close({ purge: true });

    expect(await storage.getSession(sessionA.sid)).toBeUndefined();
    expect(await storage.listChunks(sessionA.sid)).toHaveLength(0);
    expect(await storage.getIntegrity(sessionA.sid)).toBeUndefined();
    expect(await storage.getIndexes(sessionA.sid)).toEqual({
      time: [],
      request: [],
      inverted: []
    });
    expect(await storage.getSession(sessionB.sid)).toBeDefined();
    expect((await storage.listBlobs()).length).toBe(1);

    await pipelineB.close({ purge: true });
    expect((await storage.listBlobs()).length).toBe(0);
  });
});
