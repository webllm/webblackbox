import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  type CapturePolicy,
  DEFAULT_CAPTURE_POLICY,
  type ExportManifest,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { decodeChunkEvents, encodeChunkEvents } from "./codec.js";
import { readWebBlackboxArchive } from "./exporter.js";
import {
  FlightRecorderPipeline,
  type FlightRecorderPipelineOptions,
  type PipelineDeliverySidecar
} from "./pipeline.js";
import {
  deleteIndexedDbDatabase,
  derivePipelineStorageKey,
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  MemoryPipelineStorage,
  type StoredChunk
} from "./storage.js";

const SESSION: SessionMetadata = {
  sid: "S-test",
  tabId: 1,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com",
  tags: []
};
const FULL_EXPORT_OPTIONS = {
  includeScreenshots: true,
  includeScreenRecordings: true,
  maxArchiveBytes: null,
  recentWindowMs: null
} as const;
const TRUSTED_SYNTHETIC_EVIDENCE_REF = "synthetic-fixture:pipeline-export-0001";
const TRUSTED_LOCAL_DEBUG_EVIDENCE_REF = "local-attestation:low-risk-override-0001";
const TRUSTED_PLAINTEXT_TEST_POLICY = {
  ...DEFAULT_CAPTURE_POLICY,
  captureContext: "synthetic",
  captureContextEvidenceRef: TRUSTED_SYNTHETIC_EVIDENCE_REF,
  encryption: {
    localAtRest: "required",
    archive: "synthetic-local-debug-exempt",
    archiveKeyEnvelope: "none"
  }
} satisfies CapturePolicy;

function createTestPipeline(options: FlightRecorderPipelineOptions): FlightRecorderPipeline {
  return new FlightRecorderPipeline({
    capturePolicy: TRUSTED_PLAINTEXT_TEST_POLICY,
    trustedPlaintextExemptionEvidenceRefs: [TRUSTED_SYNTHETIC_EVIDENCE_REF],
    ...options
  });
}

class FailOnceChunkStorage extends MemoryPipelineStorage {
  private shouldFail = true;

  public override async putChunk(chunk: StoredChunk): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated chunk persistence failure");
    }

    await super.putChunk(chunk);
  }
}

class CheckpointBlindStorage extends MemoryPipelineStorage {
  public override async getResumeState(): Promise<undefined> {
    return undefined;
  }

  public override async initializeResumeState(): Promise<void> {
    // Simulates a compatible third-party storage implementation without normalized indexes.
  }
}

function createEvent(
  id: string,
  type: WebBlackboxEvent["type"],
  t: number,
  data?: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  const defaultData: Record<string, unknown> =
    type === "network.request"
      ? {
          reqId: "R-1",
          url: "https://example.com/api",
          method: "GET"
        }
      : type === "network.response"
        ? {
            reqId: "R-1",
            status: 200
          }
        : type === "console.entry"
          ? {
              level: "info",
              text: "hello"
            }
          : { message: "hello" };
  const dataRecord =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const shouldMergeDefaults =
    (type === "network.request" && !dataRecord?.request) ||
    (type === "network.response" && !dataRecord?.response) ||
    type === "console.entry";
  const eventData =
    dataRecord && shouldMergeDefaults
      ? {
          ...defaultData,
          ...dataRecord
        }
      : (data ?? defaultData);

  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    t,
    mono: t,
    type,
    id,
    privacy: {
      category: type.startsWith("network.")
        ? "network"
        : type.startsWith("screen.recording.")
          ? "screenRecordings"
          : type.startsWith("screen.")
            ? "screenshots"
            : type.startsWith("console.")
              ? "console"
              : type.startsWith("storage.")
                ? "storage"
                : type.startsWith("dom.")
                  ? "dom"
                  : type.startsWith("perf.")
                    ? "performance"
                    : "actions",
      sensitivity:
        type === "screen.screenshot" ||
        type.startsWith("screen.recording.") ||
        type === "network.body" ||
        type.startsWith("storage.")
          ? "high"
          : "low",
      redacted: true
    },
    data: eventData
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
  it("rejects plaintext persistent storage when local-at-rest encryption is required", async () => {
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-plaintext-persistent-storage"
      },
      storage: new IndexedDbPipelineStorage(
        `wb-pipeline-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`
      )
    });

    await expect(
      pipeline.putBlob("text/plain", new TextEncoder().encode("must-not-persist"))
    ).rejects.toThrow(/persistent.*authenticated AES-GCM/i);
    await expect(pipeline.start()).rejects.toThrow(/persistent.*authenticated AES-GCM/i);
  });

  it("fails pipeline startup when the at-rest encryption key is unavailable", async () => {
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-missing-at-rest-key"
      },
      storage: new EncryptedPipelineStorage(new MemoryPipelineStorage(), {
        key: Promise.reject(new Error("simulated missing key"))
      })
    });

    await expect(pipeline.start()).rejects.toThrow(/key is unavailable/i);
  });

  it("rejects events without privacy classification", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 100
    });
    const event = createEvent("E-no-privacy", "user.click", 1);

    await pipeline.start();
    delete event.privacy;

    await expect(pipeline.ingest(event)).rejects.toThrow(/missing privacy classification/i);
  });

  it("chunks events and builds request index", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
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

  it("resumes a partially committed delivery batch across multiple chunks and pipeline restart", async () => {
    const storage = new MemoryPipelineStorage();
    const events = Array.from({ length: 4 }, (_, index) =>
      createEvent(`E-${index + 1}`, "user.marker", index + 1, {
        message: createNoisyPayload(64, index)
      })
    );
    const provenance = (eventIndex: number) => ({
      tabId: 1,
      frameId: 0,
      documentId: "document-delivery",
      batchId: "batch-delivery",
      fingerprint: "a".repeat(64),
      eventCount: events.length,
      eventIndex
    });
    const query = {
      tabId: 1,
      frameId: 0,
      documentId: "document-delivery",
      batchId: "batch-delivery"
    };
    const first = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });

    await first.start();
    await first.ingestBatchWithDelivery(
      events.slice(0, 2),
      new Map(events.slice(0, 2).map((event, index) => [event.id, provenance(index)]))
    );
    await first.flush();
    expect(await first.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({
        complete: false,
        indexes: [
          { eventIndex: 0, outcome: "event", eventId: "E-1" },
          { eventIndex: 1, outcome: "event", eventId: "E-2" }
        ]
      })
    );

    const restarted = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restarted.start();
    await restarted.ingestBatchWithDelivery(
      events.slice(2),
      new Map(events.slice(2).map((event, index) => [event.id, provenance(index + 2)]))
    );
    await restarted.flush();

    const completedReceipt = await restarted.getDeliveryReceipt(query);
    expect(completedReceipt).toEqual(expect.objectContaining({ complete: true }));
    expect(completedReceipt?.indexes).toHaveLength(4);
    const persistedIds = (
      await Promise.all(
        (await storage.listChunks(SESSION.sid)).map((chunk) =>
          decodeChunkEvents(chunk.bytes, chunk.meta.codec)
        )
      )
    )
      .flat()
      .map((event) => event.id);
    expect(persistedIds).toEqual(["E-1", "E-2", "E-3", "E-4"]);
  });

  it("resumes partial multi-chunk delivery through encrypted indexeddb restart", async () => {
    const databaseName = `wb-delivery-restart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt"
    ]);
    const session = { ...SESSION, sid: "S-encrypted-delivery-restart" };
    const events = Array.from({ length: 4 }, (_, index) => ({
      ...createEvent(`E-encrypted-${index + 1}`, "user.marker", index + 1, {
        message: createNoisyPayload(64, index)
      }),
      sid: session.sid
    }));
    const provenance = (eventIndex: number) => ({
      tabId: 1,
      frameId: 0,
      documentId: "document-encrypted-delivery",
      batchId: "batch-encrypted-delivery",
      fingerprint: "6".repeat(64),
      eventCount: events.length,
      eventIndex
    });
    const query = {
      tabId: 1,
      frameId: 0,
      documentId: "document-encrypted-delivery",
      batchId: "batch-encrypted-delivery"
    };
    const firstStorage = new EncryptedPipelineStorage(new IndexedDbPipelineStorage(databaseName), {
      key
    });
    const first = createTestPipeline({ session, storage: firstStorage, maxChunkBytes: 1 });

    await first.start();
    await first.ingestBatchWithDelivery(
      events.slice(0, 2),
      new Map(events.slice(0, 2).map((event, index) => [event.id, provenance(index)]))
    );
    expect(await first.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({ complete: false })
    );

    const restartedStorage = new EncryptedPipelineStorage(
      new IndexedDbPipelineStorage(databaseName),
      { key }
    );
    const restarted = createTestPipeline({
      session,
      storage: restartedStorage,
      maxChunkBytes: 1
    });
    await restarted.start();
    await restarted.ingestBatchWithDelivery(
      events.slice(2),
      new Map(events.slice(2).map((event, index) => [event.id, provenance(index + 2)]))
    );
    await restarted.flush();

    expect(await restarted.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({ complete: true })
    );
    const persisted = (
      await Promise.all(
        (await restartedStorage.listChunks(session.sid)).map((chunk) =>
          decodeChunkEvents(chunk.bytes, chunk.meta.codec)
        )
      )
    ).flat();
    expect(persisted.map((event) => event.id)).toEqual(events.map((event) => event.id));

    await restarted.close({ purge: true });
    await deleteIndexedDbDatabase(databaseName);
  });

  it("commits no-output progress without a chunk and completes only after output flush", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const base = {
      tabId: 1,
      frameId: 2,
      documentId: "document-mixed",
      batchId: "batch-mixed",
      fingerprint: "b".repeat(64),
      eventCount: 2
    };
    const query = {
      tabId: base.tabId,
      frameId: base.frameId,
      documentId: base.documentId,
      batchId: base.batchId
    };
    const event = createEvent("E-1", "user.marker", 1);

    await pipeline.start();
    await pipeline.commitDeliveryProgress([{ ...base, eventIndex: 1, outcome: "no-output" }]);
    expect(await storage.listChunks(SESSION.sid)).toEqual([]);
    await pipeline.ingestBatchWithDelivery(
      [event],
      new Map([[event.id, { ...base, eventIndex: 0 }]])
    );
    expect(await pipeline.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({
        complete: false,
        indexes: [{ eventIndex: 1, outcome: "no-output" }]
      })
    );

    await pipeline.flush();
    const completedReceipt = await pipeline.getDeliveryReceipt(query);
    expect(completedReceipt).toEqual(expect.objectContaining({ complete: true }));
    expect(completedReceipt?.indexes).toHaveLength(2);
  });

  it("flushes pending output before no-output progress can complete its delivery receipt", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const base = {
      tabId: 1,
      frameId: 2,
      documentId: "document-flush-before-progress",
      batchId: "batch-flush-before-progress",
      fingerprint: "e".repeat(64),
      eventCount: 2
    };
    const query = {
      tabId: base.tabId,
      frameId: base.frameId,
      documentId: base.documentId,
      batchId: base.batchId
    };
    const event = createEvent("E-1", "user.marker", 1);

    await pipeline.start();
    await pipeline.ingestBatchWithDelivery(
      [event],
      new Map([[event.id, { ...base, eventIndex: 0 }]])
    );
    expect(await storage.listChunks(SESSION.sid)).toEqual([]);

    await pipeline.commitDeliveryProgress([{ ...base, eventIndex: 1, outcome: "no-output" }]);

    expect(await storage.listChunks(SESSION.sid)).toHaveLength(1);
    expect(await pipeline.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({
        complete: true,
        indexes: [
          { eventIndex: 0, outcome: "event", eventId: event.id },
          { eventIndex: 1, outcome: "no-output" }
        ]
      })
    );
  });

  it("rejects no-output progress that conflicts with pending output provenance", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const base = {
      tabId: 1,
      frameId: 0,
      documentId: "document-outcome-conflict",
      batchId: "batch-outcome-conflict",
      fingerprint: "f".repeat(64),
      eventCount: 1
    };
    const query = {
      tabId: base.tabId,
      frameId: base.frameId,
      documentId: base.documentId,
      batchId: base.batchId
    };
    const event = createEvent("E-1", "user.marker", 1);

    await pipeline.start();
    await pipeline.ingestBatchWithDelivery(
      [event],
      new Map([[event.id, { ...base, eventIndex: 0 }]])
    );

    await expect(
      pipeline.commitDeliveryProgress([{ ...base, eventIndex: 0, outcome: "no-output" }])
    ).rejects.toThrow(/conflicts with pending output provenance/i);
    expect(await pipeline.getDeliveryReceipt(query)).toEqual({
      ...base,
      indexes: [{ eventIndex: 0, outcome: "event", eventId: event.id }],
      complete: true
    });
  });

  it("does not commit no-output progress when flushing pending output fails", async () => {
    const storage = new FailOnceChunkStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const base = {
      tabId: 1,
      frameId: 0,
      documentId: "document-progress-flush-failure",
      batchId: "batch-progress-flush-failure",
      fingerprint: "9".repeat(64),
      eventCount: 2
    };
    const query = {
      tabId: base.tabId,
      frameId: base.frameId,
      documentId: base.documentId,
      batchId: base.batchId
    };
    const event = createEvent("E-1", "user.marker", 1);

    await pipeline.start();
    await pipeline.ingestBatchWithDelivery(
      [event],
      new Map([[event.id, { ...base, eventIndex: 0 }]])
    );

    await expect(
      pipeline.commitDeliveryProgress([{ ...base, eventIndex: 1, outcome: "no-output" }])
    ).rejects.toThrow(/simulated chunk persistence failure/i);
    expect(await pipeline.getDeliveryReceipt(query)).toBeUndefined();
    expect(await storage.listChunks(SESSION.sid)).toEqual([]);

    await pipeline.commitDeliveryProgress([{ ...base, eventIndex: 1, outcome: "no-output" }]);
    expect(await pipeline.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({ complete: true })
    );
  });

  it("does not advance a delivery receipt when its output chunk commit fails", async () => {
    const storage = new FailOnceChunkStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    const event = createEvent("E-1", "user.marker", 1);
    const provenance = {
      tabId: 1,
      frameId: 0,
      documentId: "document-failure",
      batchId: "batch-failure",
      fingerprint: "c".repeat(64),
      eventCount: 1,
      eventIndex: 0
    };
    const query = {
      tabId: provenance.tabId,
      frameId: provenance.frameId,
      documentId: provenance.documentId,
      batchId: provenance.batchId
    };

    await pipeline.start();
    await expect(
      pipeline.ingestBatchWithDelivery([event], new Map([[event.id, provenance]]))
    ).rejects.toThrow(/simulated chunk persistence failure/i);
    expect(await pipeline.getDeliveryReceipt(query)).toBeUndefined();
    expect(await storage.listChunks(SESSION.sid)).toEqual([]);

    await pipeline.ingestBatchWithDelivery([event], new Map([[event.id, provenance]]));
    expect(await pipeline.getDeliveryReceipt(query)).toEqual(
      expect.objectContaining({ complete: true })
    );
  });

  it("retries a delivery batch without duplicating events retained before a failed chunk append", async () => {
    const storage = new FailOnceChunkStorage();
    const events = [
      createEvent("E-retained-1", "user.marker", 1, { value: "first" }),
      createEvent("E-retained-2", "user.marker", 2, { value: "second" })
    ];
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: JSON.stringify(events[0]).length + 2
    });
    const provenance = (eventIndex: number) => ({
      tabId: 1,
      frameId: 0,
      documentId: "document-retained-retry",
      batchId: "batch-retained-retry",
      fingerprint: "4".repeat(64),
      eventCount: events.length,
      eventIndex
    });
    const sidecar = new Map(
      events.map((event, eventIndex) => [event.id, provenance(eventIndex)] as const)
    );

    await pipeline.start();
    await expect(pipeline.ingestBatchWithDelivery(events, sidecar)).rejects.toThrow(
      /simulated chunk persistence failure/i
    );
    await pipeline.ingestBatchWithDelivery(events, sidecar);
    await pipeline.flush();

    const chunks = await storage.listChunks(SESSION.sid);
    const persisted = (
      await Promise.all(chunks.map((chunk) => decodeChunkEvents(chunk.bytes, chunk.meta.codec)))
    ).flat();
    expect(persisted.map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(new Set(persisted.map((event) => event.id)).size).toBe(events.length);
  });

  it("rejects an explicitly undefined delivery sidecar entry instead of dropping provenance", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const event = createEvent("E-undefined-sidecar", "user.marker", 1);
    const sidecar = new Map([[event.id, undefined]]) as unknown as PipelineDeliverySidecar;

    await pipeline.start();
    await expect(pipeline.ingestBatchWithDelivery([event], sidecar)).rejects.toThrow(
      /invalid pipeline delivery event provenance/i
    );
    await pipeline.flush();
    expect(await storage.listChunks(SESSION.sid)).toEqual([]);
  });

  it("deduplicates exact pending and durable delivery retries across calls", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const event = createEvent("E-delivery-retry", "user.marker", 1);
    const provenance = {
      tabId: 1,
      frameId: 0,
      documentId: "document-delivery-retry",
      batchId: "batch-delivery-retry",
      fingerprint: "7".repeat(64),
      eventCount: 1,
      eventIndex: 0
    };
    const sidecar = new Map([[event.id, provenance]]);

    await pipeline.start();
    await pipeline.ingestBatchWithDelivery([event], sidecar);
    await pipeline.ingestBatchWithDelivery([event], sidecar);
    await pipeline.flush();
    await pipeline.ingestBatchWithDelivery([event], sidecar);
    await pipeline.flush();

    const chunks = await storage.listChunks(SESSION.sid);
    const persisted = (
      await Promise.all(chunks.map((chunk) => decodeChunkEvents(chunk.bytes, chunk.meta.codec)))
    ).flat();
    expect(persisted.map((candidate) => candidate.id)).toEqual([event.id]);
    expect(chunks).toHaveLength(1);
  });

  it("rejects cross-call event-id and batch-index provenance conflicts", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1024 * 1024 });
    const event = createEvent("E-delivery-conflict", "user.marker", 1);
    const base = {
      tabId: 1,
      frameId: 0,
      documentId: "document-delivery-conflict",
      batchId: "batch-delivery-conflict",
      fingerprint: "8".repeat(64),
      eventCount: 2
    };

    await pipeline.start();
    await pipeline.ingestBatchWithDelivery(
      [event],
      new Map([[event.id, { ...base, eventIndex: 0 }]])
    );

    await expect(
      pipeline.ingestBatchWithDelivery(
        [event],
        new Map([[event.id, { ...base, batchId: "different-batch", eventIndex: 0 }]])
      )
    ).rejects.toThrow(/event id was reused with different delivery provenance/i);
    await expect(
      pipeline.ingestBatchWithDelivery(
        [createEvent("E-different-event", "user.marker", 2)],
        new Map([
          [
            "E-different-event",
            {
              ...base,
              eventIndex: 0
            }
          ]
        ])
      )
    ).rejects.toThrow(/batch index already has a different pending event/i);

    await pipeline.flush();
    const chunks = await storage.listChunks(SESSION.sid);
    const persisted = (
      await Promise.all(chunks.map((chunk) => decodeChunkEvents(chunk.bytes, chunk.meta.codec)))
    ).flat();
    expect(persisted.map((candidate) => candidate.id)).toEqual([event.id]);
  });

  it("serializes concurrent ingests with close and persists each event exactly once", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1
    });
    const events = Array.from({ length: 30 }, (_, index) =>
      createEvent(`E-concurrent-${index}`, "user.marker", index)
    );

    await pipeline.start();
    const ingests = events.map((event) => pipeline.ingest(event));
    const closing = pipeline.close();

    await expect(
      pipeline.ingest(createEvent("E-after-close", "user.marker", events.length))
    ).rejects.toThrow(/after close\(\) has started/i);
    await Promise.all([...ingests, closing]);

    const chunks = await storage.listChunks(SESSION.sid);
    const persisted = (
      await Promise.all(chunks.map((chunk) => decodeChunkEvents(chunk.bytes, chunk.meta.codec)))
    ).flat();

    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1)
    );
    expect(persisted.map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(new Set(persisted.map((event) => event.id)).size).toBe(events.length);
  });

  it("continues chunk sequencing when an offscreen pipeline is rebuilt after restart", async () => {
    const storage = new MemoryPipelineStorage();
    const first = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1
    });
    await first.start();
    await first.ingest({
      ...createEvent("E-00000051", "user.marker", 1),
      ref: { act: "A-000007" }
    });
    await first.close();

    const restored = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1
    });
    await restored.start();
    expect(await restored.getSequenceWatermark()).toEqual({ event: 51, action: 7 });
    await restored.ingest(createEvent("E-00000052", "user.marker", 2));
    const exported = await restored.exportBundle(FULL_EXPORT_OPTIONS);
    const archive = await readWebBlackboxArchive(exported.bytes);
    await restored.close();

    const chunks = await storage.listChunks(SESSION.sid);
    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual([1, 2]);
    expect(chunks[1]?.resumeDelta?.sequenceWatermark).toEqual({ event: 52, action: 7 });
    expect(archive.events.map((event) => event.id)).toEqual(["E-00000051", "E-00000052"]);
    expect(new Set(archive.events.map((event) => event.id)).size).toBe(archive.events.length);
  });

  it("restores the persisted timeline watermark before ingesting delayed events", async () => {
    const storage = new MemoryPipelineStorage();
    const session = {
      ...SESSION,
      sid: "S-delayed-event-restart"
    };
    const first = createTestPipeline({ session, storage, maxChunkBytes: 1 });
    await first.start();
    await first.ingest({
      ...createEvent("E-00000001", "user.marker", 100),
      sid: session.sid
    });
    await first.close();

    const restored = createTestPipeline({ session, storage, maxChunkBytes: 1 });
    await restored.start();
    await restored.ingest({
      ...createEvent("E-00000002", "user.marker", 10),
      sid: session.sid
    });
    const exported = await restored.exportBundle(FULL_EXPORT_OPTIONS);
    const archive = await readWebBlackboxArchive(exported.bytes);
    await restored.close();

    expect(archive.events.map(({ id, t, mono }) => ({ id, t, mono }))).toEqual([
      { id: "E-00000001", t: 100, mono: 100 },
      { id: "E-00000002", t: 100, mono: 100 }
    ]);
  });

  it("reports pending offscreen events and screen chunk hashes in the live resume state", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1_000_000
    });
    const hash = "c".repeat(64);

    await pipeline.start();
    await pipeline.ingest({
      ...createEvent("E-00000091", "screen.recording.chunk", 1, {
        recordingId: "VR-pending",
        chunkId: hash,
        index: 0,
        mime: "video/webm",
        size: 10
      }),
      ref: { act: "A-000012" }
    });

    expect(await storage.listChunks(SESSION.sid)).toHaveLength(0);
    expect(await pipeline.getResumeState()).toEqual({
      sequenceWatermark: { event: 91, action: 12 },
      screenRecordings: [
        {
          recordingId: "VR-pending",
          chunks: [{ index: 0, hash, size: 10 }]
        }
      ]
    });
  });

  it("restores cumulative screen hashes from the latest durable chunk only", async () => {
    const storage = new MemoryPipelineStorage();
    const before = "d".repeat(64);
    const after = "e".repeat(64);
    const first = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await first.start();
    await first.ingest(
      createEvent("E-00000101", "screen.recording.chunk", 1, {
        recordingId: "VR-restart",
        chunkId: before,
        index: 0
      })
    );
    await first.ingest(
      createEvent("E-00000102", "screen.recording.chunk", 2, {
        recordingId: "VR-restart",
        chunkId: after,
        index: 1
      })
    );
    await first.close();

    const restored = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restored.start();
    expect(await restored.getResumeState()).toEqual({
      sequenceWatermark: { event: 102, action: 0 },
      screenRecordings: [
        {
          recordingId: "VR-restart",
          chunks: [
            { index: 0, hash: before },
            { index: 1, hash: after }
          ]
        }
      ]
    });
  });

  it("stores constant-size resume deltas and prunes completed recording references", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-00000001", "screen.recording.start", 0, {
        recordingId: "VR-bounded"
      })
    );
    expect((await pipeline.getResumeState()).screenRecordings).toEqual([
      { recordingId: "VR-bounded", chunks: [] }
    ]);

    for (let index = 0; index < 100; index += 1) {
      await pipeline.ingest(
        createEvent(`E-${String(index + 2).padStart(8, "0")}`, "screen.recording.chunk", index, {
          recordingId: "VR-bounded",
          chunkId: index.toString(16).padStart(64, "0"),
          index
        })
      );
    }

    const chunks = await storage.listChunks(SESSION.sid);
    const checkpointSizes = chunks.map((chunk) => JSON.stringify(chunk.resumeDelta).length);

    expect(chunks).toHaveLength(101);
    expect(chunks.every((chunk) => chunk.resumeState === undefined)).toBe(true);
    expect(Math.max(...checkpointSizes)).toBeLessThan(300);
    expect((await pipeline.getResumeState()).screenRecordings[0]?.chunks).toHaveLength(100);

    await pipeline.ingest(
      createEvent("E-00000102", "screen.recording.end", 101, {
        recordingId: "VR-bounded"
      })
    );
    expect((await pipeline.getResumeState()).screenRecordings).toEqual([]);
    await pipeline.close();
  });

  it("rejects an over-limit live resume state before buffering the event", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1_000_000
    });

    await pipeline.start();

    for (let index = 0; index < 32; index += 1) {
      await pipeline.ingest(
        createEvent(`E-${String(index + 1).padStart(8, "0")}`, "screen.recording.start", index, {
          recordingId: `VR-live-${index}`
        })
      );
    }

    await expect(
      pipeline.ingest(
        createEvent("E-00000033", "screen.recording.start", 33, {
          recordingId: "VR-live-overflow"
        })
      )
    ).rejects.toThrow(/too many active screen recordings/i);
    expect((await pipeline.getResumeState()).screenRecordings).toHaveLength(32);
    await pipeline.close();
    expect((await storage.listChunks(SESSION.sid))[0]?.meta.eventCount).toBe(32);
  });

  it("rebuilds resume deltas for compatible storage without normalized indexes", async () => {
    const storage = new CheckpointBlindStorage();
    const first = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);

    await first.start();
    await first.ingest(
      createEvent("E-00000201", "screen.recording.chunk", 1, {
        recordingId: "VR-compatible",
        chunkId: firstHash,
        index: 0
      })
    );
    await first.ingest(
      createEvent("E-00000202", "screen.recording.chunk", 2, {
        recordingId: "VR-compatible",
        chunkId: secondHash,
        index: 1
      })
    );
    await first.close();

    const restored = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restored.start();
    expect(await restored.getResumeState()).toEqual({
      sequenceWatermark: { event: 202, action: 0 },
      screenRecordings: [
        {
          recordingId: "VR-compatible",
          chunks: [
            { index: 0, hash: firstHash },
            { index: 1, hash: secondHash }
          ]
        }
      ]
    });
    await restored.close();
  });

  it("applies recording lifecycle events while migrating a cumulative checkpoint", async () => {
    const storage = new MemoryPipelineStorage();
    const hash = "f".repeat(64);
    const ended = createEvent("E-00000301", "screen.recording.end", 3, {
      recordingId: "VR-legacy-ended"
    });
    const encoded = await encodeChunkEvents([ended], "none");

    await storage.putSession(SESSION);
    await storage.putChunk({
      sid: SESSION.sid,
      meta: {
        chunkId: "C-00000001",
        seq: 1,
        tStart: ended.t,
        tEnd: ended.t,
        monoStart: ended.mono,
        monoEnd: ended.mono,
        eventCount: 1,
        byteLength: encoded.bytes.byteLength,
        codec: encoded.codec,
        sha256: "0".repeat(64)
      },
      bytes: encoded.bytes,
      resumeState: {
        sequenceWatermark: { event: 301, action: 0 },
        screenRecordings: [
          {
            recordingId: "VR-legacy-ended",
            chunks: [{ index: 0, hash }]
          }
        ]
      }
    });

    const restored = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restored.start();
    expect(await restored.getResumeState()).toEqual({
      sequenceWatermark: { event: 301, action: 0 },
      screenRecordings: []
    });
    await restored.close();
  });

  it("replays lifecycle events from legacy checkpoints before later deltas", async () => {
    const storage = new CheckpointBlindStorage();
    const hash = "e".repeat(64);
    const ended = createEvent("E-00000311", "screen.recording.end", 3, {
      recordingId: "VR-mixed-ended"
    });
    const encoded = await encodeChunkEvents([ended], "none");

    await storage.putSession(SESSION);
    await storage.putChunk({
      sid: SESSION.sid,
      meta: {
        chunkId: "C-00000001",
        seq: 1,
        tStart: ended.t,
        tEnd: ended.t,
        monoStart: ended.mono,
        monoEnd: ended.mono,
        eventCount: 1,
        byteLength: encoded.bytes.byteLength,
        codec: encoded.codec,
        sha256: "1".repeat(64)
      },
      bytes: encoded.bytes,
      resumeState: {
        sequenceWatermark: { event: 311, action: 0 },
        screenRecordings: [
          {
            recordingId: "VR-mixed-ended",
            chunks: [{ index: 0, hash }]
          }
        ]
      }
    });
    await storage.putChunk({
      sid: SESSION.sid,
      meta: {
        chunkId: "C-00000002",
        seq: 2,
        tStart: 4,
        tEnd: 4,
        monoStart: 4,
        monoEnd: 4,
        eventCount: 0,
        byteLength: 0,
        codec: "none",
        sha256: "2".repeat(64)
      },
      bytes: new Uint8Array(),
      resumeDelta: {
        version: 1,
        sequenceWatermark: { event: 312, action: 0 },
        screenRecordingChanges: []
      }
    });

    const restored = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restored.start();
    expect(await restored.getResumeState()).toEqual({
      sequenceWatermark: { event: 312, action: 0 },
      screenRecordings: []
    });
    await restored.close();
  });

  it("closes a durable recording checkpoint after a restart interruption", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-00000401", "screen.recording.start", 1, {
        recordingId: "VR-interrupted"
      })
    );
    await pipeline.ingest(
      createEvent("E-00000402", "screen.recording.error", 2, {
        recordingId: "VR-interrupted",
        name: "OffscreenRecordingInterrupted",
        message: "runtime restarted",
        stage: "restart"
      })
    );
    expect((await pipeline.getResumeState()).screenRecordings).toEqual([]);
    await pipeline.close();

    const restored = createTestPipeline({ session: SESSION, storage, maxChunkBytes: 1 });
    await restored.start();
    expect((await restored.getResumeState()).screenRecordings).toEqual([]);
    await restored.close();
  });

  it("can retry an ingest after chunk persistence fails without a sequence gap or duplicate", async () => {
    const storage = new FailOnceChunkStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 1
    });
    const event = createEvent("E-persistence-retry", "user.marker", 1);

    await pipeline.start();
    await expect(pipeline.ingest(event)).rejects.toThrow("simulated chunk persistence failure");
    await pipeline.ingest(event);
    await pipeline.close();

    const chunks = await storage.listChunks(SESSION.sid);
    const persisted = (
      await Promise.all(chunks.map((chunk) => decodeChunkEvents(chunk.bytes, chunk.meta.codec)))
    ).flat();

    expect(chunks.map((chunk) => chunk.meta.seq)).toEqual([1]);
    expect(persisted.map((item) => item.id)).toEqual([event.id]);
  });

  it("indexes request ids from nested request payloads", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-nested-request-id"
      },
      storage,
      maxChunkBytes: 100
    });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-nested-1", "network.request", 1, {
        request: {
          requestId: "R-nested-1",
          method: "GET",
          url: "https://example.com/api"
        }
      })
    );
    await pipeline.flush();
    await pipeline.finalizeIndexes();

    const indexes = await storage.getIndexes("S-nested-request-id");

    expect(indexes.request).toContainEqual({
      reqId: "R-nested-1",
      eventIds: ["E-nested-1"]
    });
  });

  it("encodes and decodes chunk codecs when runtime support is available", async () => {
    for (const codec of ["gzip", "br", "zst"] as const) {
      const storage = new MemoryPipelineStorage();
      const pipeline = createTestPipeline({
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
      const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
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

  it("sanitizes session URLs in export manifests", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-manifest-url-privacy",
        url: "https://app.example.test/users/alice@example.test/orders/123?token=secret#frag"
      },
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-url-privacy", "user.marker", Date.now()));
    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.manifest.site.origin).toBe("https://app.example.test/users/:id/orders/:id");
    expect(JSON.stringify(parsed.manifest)).not.toContain("alice@example.test");
    expect(JSON.stringify(parsed.manifest)).not.toContain("token=secret");
    expect(parsed.privacyManifest?.scanner.preEncryption).toBe(true);
    expect(parsed.privacyManifest?.scanner.status).toBe("passed");
    expect(parsed.privacyManifest?.transfer).toMatchObject({
      destination: "local-download",
      archiveKeyEnvelope: "none",
      encrypted: false,
      includeScreenshots: false,
      maxArchiveBytes: 100 * 1024 * 1024,
      recentWindowMs: 20 * 60 * 1000,
      shareEligible: false
    });
    expect(parsed.privacyManifest?.totals.events).toBe(1);
    expect(parsed.integrity?.files["privacy/manifest.json"]).toMatch(/[a-f0-9]{64}/);
  });

  it("applies the default export policy when no options are passed", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-default-export-policy"
      },
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    const now = Date.now();
    const shotHash = await pipeline.putBlob("image/webp", new Uint8Array([1, 2, 3, 4]));

    await pipeline.ingest(createEvent("E-default-old", "user.click", now - 50 * 60 * 1000));
    await pipeline.ingest(
      createEvent("E-default-shot", "screen.screenshot", now - 5 * 60 * 1000, {
        shotId: shotHash,
        format: "webp",
        size: 4
      })
    );
    await pipeline.ingest(createEvent("E-default-marker", "user.marker", now, { message: "m" }));

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events.map((event) => event.id)).toEqual(["E-default-marker"]);
    expect(parsed.privacyManifest?.transfer).toMatchObject({
      includeScreenshots: false,
      maxArchiveBytes: 100 * 1024 * 1024,
      recentWindowMs: 20 * 60 * 1000
    });
  });

  it("allows local export and records scanner findings when raw secrets remain", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-scanner-warning"
      },
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-secret", "console.entry", Date.now(), {
        text: "Authorization: Bearer wbb_test_provider_token_000000000000"
      })
    );

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(exported.privacyManifest.scanner.status).toBe("blocked");
    expect(parsed.privacyManifest?.scanner.status).toBe("blocked");
    expect(parsed.privacyManifest?.scanner.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "bearer-token",
          path: "event:E-secret"
        })
      ])
    );
  });

  it("blocks scanner findings when strict privacy scanning is requested", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-scanner-strict"
      },
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-secret-strict", "console.entry", Date.now(), {
        text: "Authorization: Bearer wbb_test_provider_token_000000000000"
      })
    );

    await expect(pipeline.exportBundle({ strictPrivacyScanner: true })).rejects.toThrow(
      /Privacy scanner blocked export/i
    );
  });

  it("requires encryption for real-user capture policies even when the legacy plaintext flag is set", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-real-user-encryption"
      },
      storage,
      maxChunkBytes: 512,
      capturePolicy: DEFAULT_CAPTURE_POLICY
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-real-user", "user.click", Date.now()));

    await expect(pipeline.exportBundle({ allowPlaintextLocalExport: true })).rejects.toThrow(
      /real-user archives must be encrypted/i
    );
  });

  it("requires encryption when no capture policy can prove a trusted plaintext exemption", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: {
        ...SESSION,
        sid: "S-missing-export-policy"
      },
      storage,
      maxChunkBytes: 512
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-missing-export-policy", "user.click", Date.now()));

    await expect(pipeline.exportBundle({ allowPlaintextLocalExport: true })).rejects.toThrow(
      /trusted synthetic or local-debug plaintext exemption/i
    );
  });

  it("requires encryption when a synthetic capture policy marks archives as required", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-synthetic-encryption-required"
      },
      storage,
      maxChunkBytes: 512,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_SYNTHETIC_EVIDENCE_REF],
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        captureContext: "synthetic",
        captureContextEvidenceRef: TRUSTED_SYNTHETIC_EVIDENCE_REF
      }
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-synthetic-required", "user.click", Date.now()));

    await expect(pipeline.exportBundle({ allowPlaintextLocalExport: true })).rejects.toThrow(
      /encryption is required by the active capture policy/i
    );
  });

  it("rejects plaintext capture-context exemptions without trusted evidence", async () => {
    for (const evidenceRef of [
      undefined,
      "local-attestation-1",
      "local-attestation:forged-local-debug-0001"
    ]) {
      const storage = new MemoryPipelineStorage();
      const pipeline = createTestPipeline({
        session: {
          ...SESSION,
          sid: `S-plaintext-evidence-${evidenceRef ?? "missing"}`
        },
        storage,
        maxChunkBytes: 512,
        capturePolicy: {
          ...DEFAULT_CAPTURE_POLICY,
          captureContext: "local-debug",
          ...(evidenceRef ? { captureContextEvidenceRef: evidenceRef } : {}),
          encryption: {
            localAtRest: "required",
            archive: "synthetic-local-debug-exempt",
            archiveKeyEnvelope: "none"
          }
        }
      });

      await pipeline.start();
      await pipeline.ingest(createEvent(`E-${evidenceRef ?? "missing"}`, "user.click", Date.now()));

      await expect(pipeline.exportBundle()).rejects.toThrow(/trusted capture context evidence/i);
    }
  });

  it("allows plaintext synthetic exemptions with trusted evidence", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-trusted-synthetic-exemption"
      },
      storage,
      maxChunkBytes: 512,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_SYNTHETIC_EVIDENCE_REF],
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        captureContext: "synthetic",
        captureContextEvidenceRef: TRUSTED_SYNTHETIC_EVIDENCE_REF,
        encryption: {
          localAtRest: "required",
          archive: "synthetic-local-debug-exempt",
          archiveKeyEnvelope: "none"
        }
      }
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-trusted-synthetic", "user.click", Date.now()));

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.manifest.encryption).toBeUndefined();
    expect(parsed.privacyManifest?.transfer?.archiveKeyEnvelope).toBe("none");
  });

  it("allows plaintext local-debug exemptions with trusted evidence", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-trusted-local-debug-exemption"
      },
      storage,
      maxChunkBytes: 512,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        captureContext: "local-debug",
        captureContextEvidenceRef: TRUSTED_LOCAL_DEBUG_EVIDENCE_REF,
        encryption: {
          localAtRest: "required",
          archive: "synthetic-local-debug-exempt",
          archiveKeyEnvelope: "none"
        }
      }
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-trusted-local-debug", "user.click", Date.now()));

    const exported = await pipeline.exportBundle();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.manifest.encryption).toBeUndefined();
    expect(parsed.privacyManifest?.transfer?.archiveKeyEnvelope).toBe("none");
  });

  it("rejects explicit low-risk overrides when high-risk artifacts are present", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: {
        ...SESSION,
        sid: "S-low-risk-override-high-risk"
      },
      storage,
      maxChunkBytes: 512,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        captureContext: "local-debug",
        captureContextEvidenceRef: TRUSTED_LOCAL_DEBUG_EVIDENCE_REF,
        encryption: {
          localAtRest: "required",
          archive: "explicit-low-risk-override",
          archiveKeyEnvelope: "none",
          overrideReasonRef: "audit-override-1"
        }
      }
    });

    await pipeline.start();
    await pipeline.ingest(
      createEvent("E-high-risk-override", "screen.screenshot", Date.now(), {
        shotId: "shot-1"
      })
    );

    await expect(pipeline.exportBundle(FULL_EXPORT_OPTIONS)).rejects.toThrow(
      /low-risk export override is not allowed/i
    );
  });

  it("ingests batches without losing index coverage", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
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
    const pipeline = createTestPipeline({
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
    const pipeline = createTestPipeline({
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
    const initialPipeline = createTestPipeline({
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

    const recoveredPipeline = createTestPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await recoveredPipeline.start();

    const exported = await recoveredPipeline.exportBundle(FULL_EXPORT_OPTIONS);
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
    const initialPipeline = createTestPipeline({
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

    const recoveredPipeline = createTestPipeline({
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
    const pipeline = createTestPipeline({
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

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
    const zip = await JSZip.loadAsync(exported.bytes);
    const blobPaths = Object.keys(zip.files).filter((path) => path.startsWith("blobs/"));

    expect(blobPaths.some((path) => path.includes(referenced))).toBe(true);
    expect(blobPaths.some((path) => path.includes(orphan))).toBe(false);
  });

  it("exports and reads .webblackbox archive", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-1", "user.click", 10));
    await pipeline.ingest(createEvent("E-2", "network.request", 20));
    await pipeline.ingest(createEvent("E-3", "network.response", 30));

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
    const parsed = await readWebBlackboxArchive(exported.bytes);
    const zip = await JSZip.loadAsync(exported.bytes);
    const storedIntegrity = JSON.parse(
      await zip.file("integrity/hashes.json")!.async("string")
    ) as typeof exported.integrity;

    expect(parsed.events.length).toBeGreaterThanOrEqual(3);
    expect(parsed.manifest.protocolVersion).toBe(1);
    expect(parsed.integrity).not.toBeNull();
    expect(exported.integrity.files["integrity/hashes.json"]).toBeUndefined();
    expect(storedIntegrity).toEqual(exported.integrity);
  });

  it("reads plain archives without global Web Crypto when Node crypto is available", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-plain-read", "user.click", 10));

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
    const originalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      const parsed = await readWebBlackboxArchive(exported.bytes);
      expect(parsed.events.map((event) => event.id)).toContain("E-plain-read");
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        writable: true,
        value: originalCrypto
      });
    }
  });

  it("rejects archives with integrity mismatches on read", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-integrity-1", "user.click", 10));

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
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

  it("rejects archives with undeclared event chunks on read", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-integrity-extra", "user.click", 10));

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
    const zip = await JSZip.loadAsync(exported.bytes);
    zip.file(
      "events/C-999999.ndjson",
      JSON.stringify({
        v: 1,
        sid: SESSION.sid,
        tab: 1,
        t: 99,
        mono: 99,
        type: "user.marker",
        id: "E-extra",
        data: { message: "extra" }
      })
    );

    const tampered = await zip.generateAsync({ type: "uint8array" });

    await expect(readWebBlackboxArchive(tampered)).rejects.toThrow(
      /integrity manifest does not match archive contents/i
    );
  });

  it("writes provided redaction profile into export manifest", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
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

    const exported = await pipeline.exportBundle({
      ...FULL_EXPORT_OPTIONS,
      passphrase: "secret-passphrase"
    });

    await expect(readWebBlackboxArchive(exported.bytes)).rejects.toThrow(/encrypted/i);

    const parsed = await readWebBlackboxArchive(exported.bytes, {
      passphrase: "secret-passphrase"
    });
    const zip = await JSZip.loadAsync(exported.bytes);
    const rawInvertedIndex = await zip.file("index/inv.json")?.async("uint8array");
    const rawPrivacyManifest = await zip.file("privacy/manifest.json")?.async("uint8array");
    const rawInvertedText = new TextDecoder().decode(rawInvertedIndex ?? new Uint8Array());
    const rawPrivacyText = new TextDecoder().decode(rawPrivacyManifest ?? new Uint8Array());

    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.manifest.encryption?.algorithm).toBe("AES-GCM");
    expect(parsed.manifest.encryption?.files["index/time.json"]).toBeDefined();
    expect(parsed.manifest.encryption?.files["index/req.json"]).toBeDefined();
    expect(parsed.manifest.encryption?.files["index/inv.json"]).toBeDefined();
    expect(parsed.manifest.encryption?.files["privacy/manifest.json"]).toBeDefined();
    expect(rawInvertedText).not.toContain("network.request");
    expect(rawInvertedText).not.toContain("E-enc-2");
    expect(rawPrivacyText).not.toContain("local-download");
    expect(parsed.privacyManifest?.scanner.preEncryption).toBe(true);
    expect(parsed.privacyManifest?.encryption.archive).toBe("encrypted");
    expect(parsed.privacyManifest?.transfer).toMatchObject({
      destination: "local-download",
      archiveKeyEnvelope: "passphrase",
      encrypted: true,
      shareEligible: true
    });
    expect(
      Object.keys(parsed.manifest.encryption?.files ?? {}).some((path) =>
        path.startsWith("events/")
      )
    ).toBe(true);
  });

  it("rejects plaintext fallback when an encrypted manifest omits private file metadata", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-encryption-map", "user.click", 100));
    const exported = await pipeline.exportBundle({
      ...FULL_EXPORT_OPTIONS,
      passphrase: "secret-passphrase"
    });
    const zip = await JSZip.loadAsync(exported.bytes);
    const manifestFile = zip.file("manifest.json");

    if (!manifestFile) {
      throw new Error("Missing encrypted archive manifest");
    }

    const manifest = JSON.parse(await manifestFile.async("string")) as ExportManifest;

    if (!manifest.encryption) {
      throw new Error("Expected encrypted archive metadata");
    }

    manifest.encryption.files = {};
    zip.file("manifest.json", JSON.stringify(manifest));
    await writeArchiveIntegrityForTest(zip);
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      readWebBlackboxArchive(bytes, { passphrase: "secret-passphrase" })
    ).rejects.toThrow(/schema validation|at least one private file/i);
  });

  it("rejects schema-invalid event payloads while reading an archive", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });
    const invalidEvent = createEvent("E-invalid-payload", "network.request", 100);
    invalidEvent.data = {};

    await pipeline.start();
    await pipeline.ingest(invalidEvent);
    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);

    await expect(readWebBlackboxArchive(exported.bytes)).rejects.toThrow(
      /event line 1 failed schema validation/i
    );
  });

  it("supports optional at-rest encryption for chunk/blob cache payloads", async () => {
    const baseStorage = new MemoryPipelineStorage();
    const key = await derivePipelineStorageKey("cache-passphrase", {
      salt: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    });
    const storage = new EncryptedPipelineStorage(baseStorage, {
      key: key.key
    });
    const pipeline = createTestPipeline({
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

    const exported = await pipeline.exportBundle(FULL_EXPORT_OPTIONS);
    const parsed = await readWebBlackboxArchive(exported.bytes);
    expect(parsed.events.map((event) => event.id)).toEqual(
      expect.arrayContaining(["E-atrest-1", "E-atrest-2"])
    );
  });

  it("supports export filtering by screenshot and recent time window", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
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

  it("supports independent export filtering for screen recordings", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
      session: SESSION,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();

    const chunkHash = await pipeline.putBlob("video/webm", new Uint8Array([9, 8, 7, 6]));
    const now = Date.now();

    await pipeline.ingest(createEvent("E-before", "user.click", now - 2));
    await pipeline.ingest(
      createEvent("E-video-start", "screen.recording.start", now - 1, {
        recordingId: "VR-1",
        source: "tab",
        mime: "video/webm"
      })
    );
    await pipeline.ingest(
      createEvent("E-video-chunk", "screen.recording.chunk", now, {
        recordingId: "VR-1",
        chunkId: chunkHash,
        index: 0,
        mime: "video/webm",
        size: 4
      })
    );
    await pipeline.ingest(
      createEvent("E-video-end", "screen.recording.end", now + 1, {
        recordingId: "VR-1",
        chunks: [chunkHash],
        chunkCount: 1,
        size: 4,
        durationMs: 1000
      })
    );

    const withoutVideo = await pipeline.exportBundle({
      includeScreenshots: true,
      includeScreenRecordings: false,
      recentWindowMs: null,
      maxArchiveBytes: null
    });
    const parsedWithoutVideo = await readWebBlackboxArchive(withoutVideo.bytes);

    expect(parsedWithoutVideo.events.map((event) => event.id)).toEqual(["E-before"]);

    const withVideo = await pipeline.exportBundle({
      includeScreenshots: true,
      includeScreenRecordings: true,
      recentWindowMs: null,
      maxArchiveBytes: null
    });
    const zip = await JSZip.loadAsync(withVideo.bytes);
    const parsedWithVideo = await readWebBlackboxArchive(withVideo.bytes);

    expect(parsedWithVideo.events.some((event) => event.type === "screen.recording.chunk")).toBe(
      true
    );
    expect(zip.file(`blobs/sha256-${chunkHash}.webm`)).toBeTruthy();
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
    const pipeline = createTestPipeline({
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

  it("anchors active recent-window exports to export time", async () => {
    const storage = new MemoryPipelineStorage();
    const now = Date.now();
    const session: SessionMetadata = {
      ...SESSION,
      sid: "S-export-live-anchor",
      startedAt: now - 60 * 60 * 1000
    };
    const pipeline = createTestPipeline({
      session,
      storage,
      maxChunkBytes: 128
    });

    await pipeline.start();
    await pipeline.ingest(createEvent("E-live-old", "user.click", now - 50 * 60 * 1000));

    const exported = await pipeline.exportBundle({
      includeScreenshots: true,
      recentWindowMs: 20 * 60 * 1000
    });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events).toEqual([]);
  });

  it("limits exported archive size to recent suffix of chunks", async () => {
    const storage = new MemoryPipelineStorage();
    const pipeline = createTestPipeline({
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
    const pipelineA = createTestPipeline({
      session: sessionA,
      storage,
      maxChunkBytes: 128
    });
    const pipelineB = createTestPipeline({
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
    const deliveryProgress = {
      tabId: 1,
      frameId: 0,
      documentId: "document-purge-a",
      batchId: "batch-purge-a",
      fingerprint: "5".repeat(64),
      eventCount: 1,
      eventIndex: 0,
      outcome: "no-output" as const
    };
    const deliveryQuery = {
      tabId: deliveryProgress.tabId,
      frameId: deliveryProgress.frameId,
      documentId: deliveryProgress.documentId,
      batchId: deliveryProgress.batchId
    };
    await pipelineA.commitDeliveryProgress([deliveryProgress]);
    expect(await pipelineA.getDeliveryReceipt(deliveryQuery)).toEqual(
      expect.objectContaining({ complete: true })
    );

    await pipelineA.close({ purge: true });

    expect(await storage.getSession(sessionA.sid)).toBeUndefined();
    expect(await storage.listChunks(sessionA.sid)).toHaveLength(0);
    expect(await storage.getIntegrity(sessionA.sid)).toBeUndefined();
    expect(await storage.getDeliveryReceipt(sessionA.sid, deliveryQuery)).toBeUndefined();
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

async function writeArchiveIntegrityForTest(zip: JSZip): Promise<void> {
  const files: Record<string, string> = {};

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || path === "integrity/hashes.json") {
      continue;
    }

    const bytes = await file.async("uint8array");
    const digest = await crypto.subtle.digest("SHA-256", toArrayBufferForTest(bytes));
    files[path] = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({
      manifestSha256: files["manifest.json"] ?? "",
      files
    })
  );
}

function toArrayBufferForTest(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
