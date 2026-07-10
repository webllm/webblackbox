import "fake-indexeddb/auto";

import type { ChunkTimeIndexEntry, SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  assertPipelineResumeChangesWithinLimits,
  deleteIndexedDbDatabase,
  derivePipelineStorageKey,
  EncryptedPipelineStorage,
  getOrCreateIndexedDbPipelineStorageKey,
  IndexedDbPipelineStorage,
  MemoryPipelineStorage,
  type StoredBlob,
  type StoredChunk
} from "./storage.js";

const SESSION_A: SessionMetadata = {
  sid: "S-storage-A",
  tabId: 1,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com/a",
  tags: []
};

const SESSION_B: SessionMetadata = {
  sid: "S-storage-B",
  tabId: 2,
  startedAt: Date.now() + 1,
  mode: "full",
  url: "https://example.com/b",
  tags: []
};

function chunkMeta(chunkId: string, seq: number): ChunkTimeIndexEntry {
  return {
    chunkId,
    seq,
    tStart: seq * 1000,
    tEnd: seq * 1000 + 100,
    monoStart: seq * 1000,
    monoEnd: seq * 1000 + 100,
    eventCount: 1,
    byteLength: 16,
    codec: "none",
    sha256: "a".repeat(64)
  };
}

function createChunk(sid: string, chunkId: string, seq: number, text: string): StoredChunk {
  return {
    sid,
    meta: chunkMeta(chunkId, seq),
    bytes: new TextEncoder().encode(text)
  };
}

function createBlob(hash: string, bytes: Uint8Array): StoredBlob {
  return {
    hash,
    mime: "application/octet-stream",
    size: bytes.byteLength,
    bytes,
    createdAt: Date.now(),
    refCount: 1
  };
}

function createDbName(): string {
  return `wb-storage-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function openRawDb(
  dbName: string,
  version: number,
  onUpgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, version);

    request.onupgradeneeded = () => {
      onUpgrade(request.result);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open raw IndexedDB"));
  });
}

async function writeRawRows(
  db: IDBDatabase,
  storeName: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);

    for (const row of rows) {
      store.put(row);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Raw row write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Raw row write aborted"));
  });
}

async function readRawRows(
  db: IDBDatabase,
  storeName: string
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
    request.onerror = () => reject(request.error ?? new Error("Raw row read failed"));
  });
}

describe("storage", () => {
  it("rejects projected resume states beyond recording and chunk limits", async () => {
    const tooManyRecordings = Array.from({ length: 33 }, (_, index) => ({
      operation: "reset" as const,
      recordingId: `VR-${index}`
    }));

    for (const storage of [
      new MemoryPipelineStorage(),
      new IndexedDbPipelineStorage(createDbName())
    ]) {
      const sid = `S-resume-bounds-${storage.constructor.name}`;
      await storage.putSession({ ...SESSION_A, sid });
      await expect(
        storage.putChunk({
          ...createChunk(sid, "C-bounds", 1, "bounds"),
          resumeDelta: {
            version: 1,
            sequenceWatermark: { event: 33, action: 0 },
            screenRecordingChanges: tooManyRecordings
          }
        })
      ).rejects.toThrow(/too many active screen recordings/i);
      expect(await storage.listChunks(sid)).toEqual([]);
      expect(await storage.getResumeState?.(sid)).toBeUndefined();
    }

    const atChunkLimit = {
      size: 500_000,
      has: () => false
    } as unknown as ReadonlyMap<number, unknown>;
    expect(() =>
      assertPipelineResumeChangesWithinLimits(new Map([["VR-limit", atChunkLimit]]), [
        {
          operation: "put",
          recordingId: "VR-limit",
          index: 499_999,
          hash: "f".repeat(64)
        }
      ])
    ).toThrow(/too many screen-recording chunks/i);
  });

  it("supports memory storage CRUD and session-scoped blob ref-count cleanup", async () => {
    const storage = new MemoryPipelineStorage();
    const hash = "f".repeat(64);

    await storage.putSession(SESSION_A);
    await storage.putSession(SESSION_B);
    await storage.putChunk(createChunk(SESSION_A.sid, "C-2", 2, "second"));
    await storage.putChunk(createChunk(SESSION_A.sid, "C-1", 1, "first"));
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_B.sid);
    await storage.putIndexes(SESSION_A.sid, {
      time: [chunkMeta("C-1", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(SESSION_A.sid, {
      manifestSha256: "b".repeat(64),
      files: {
        "chunks/C-1.ndjson": "c".repeat(64)
      }
    });

    const chunks = await storage.listChunks(SESSION_A.sid);
    expect(chunks.map((chunk) => chunk.meta.chunkId)).toEqual(["C-1", "C-2"]);
    expect((await storage.getLatestChunkMeta(SESSION_A.sid))?.chunkId).toBe("C-2");
    expect(await storage.getSession(SESSION_A.sid)).toEqual(expect.objectContaining(SESSION_A));
    expect((await storage.getBlob(hash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid);
    expect(await storage.getSession(SESSION_A.sid)).toBeUndefined();
    expect((await storage.getBlob(hash))?.refCount).toBe(1);
    expect((await storage.getIndexes(SESSION_A.sid)).time).toEqual([]);
    expect(await storage.getIntegrity(SESSION_A.sid)).toBeUndefined();

    await storage.deleteSession(SESSION_B.sid);
    expect(await storage.getBlob(hash)).toBeUndefined();

    await storage.deleteSession(SESSION_A.sid, ["0".repeat(64), "missing"]);
  });

  it("derives deterministic storage keys with configured PBKDF2 params", async () => {
    const salt = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const derived = await derivePipelineStorageKey("passphrase", {
      salt,
      iterations: 321.9
    });

    expect(derived.iterations).toBe(321);
    expect(Array.from(derived.salt)).toEqual(Array.from(salt));
    expect(derived.key).toBeDefined();
  });

  it("throws a clear error when Web Crypto API is unavailable", async () => {
    const originalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      await expect(derivePipelineStorageKey("passphrase")).rejects.toThrow(/Web Crypto API/i);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        writable: true,
        value: originalCrypto
      });
    }
  });

  it("encrypts chunk/blob payloads via storage wrapper and decrypts on read", async () => {
    const baseStorage = new MemoryPipelineStorage();
    const key = await derivePipelineStorageKey("cache-passphrase", {
      salt: Uint8Array.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    });
    const storage = new EncryptedPipelineStorage(baseStorage, { key: key.key });
    const sid = "S-encrypted";
    const hash = "e".repeat(64);
    const chunk = createChunk(sid, "C-enc", 1, '{"id":"event"}\n');
    const blobBytes = Uint8Array.from([4, 5, 6, 7]);

    await storage.putSession({
      ...SESSION_A,
      sid
    });
    expect(await storage.getSession(sid)).toEqual(expect.objectContaining({ sid }));
    await storage.putChunk(chunk);
    await storage.initializeResumeState(sid, 1, {
      sequenceWatermark: { event: 1, action: 0 },
      screenRecordings: []
    });
    expect(await storage.getResumeState(sid, 1)).toEqual({
      sequenceWatermark: { event: 1, action: 0 },
      screenRecordings: []
    });
    await storage.putBlob(createBlob(hash, blobBytes), sid);
    await storage.putIndexes(sid, {
      time: [chunkMeta("C-enc", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(sid, {
      manifestSha256: "2".repeat(64),
      files: {}
    });

    const rawChunk = await baseStorage.getChunk(sid, "C-enc");
    const rawBlob = await baseStorage.getBlob(hash);
    expect(rawChunk).toBeDefined();
    expect(rawBlob).toBeDefined();
    expect(Array.from(rawChunk?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);
    expect(Array.from(rawBlob?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);

    const decryptedChunk = await storage.getChunk(sid, "C-enc");
    const decryptedBlob = await storage.getBlob(hash);
    const decryptedList = await storage.listBlobs();
    expect((await storage.getLatestChunkMeta(sid))?.chunkId).toBe("C-enc");
    expect(Array.from(decryptedChunk?.bytes ?? [])).toEqual(Array.from(chunk.bytes));
    expect(Array.from(decryptedBlob?.bytes ?? [])).toEqual(Array.from(blobBytes));
    expect(decryptedList).toHaveLength(1);
    expect(await storage.getIndexes(sid)).toEqual({
      time: [chunkMeta("C-enc", 1)],
      request: [],
      inverted: []
    });
    expect(await storage.getIntegrity(sid)).toEqual({
      manifestSha256: "2".repeat(64),
      files: {}
    });

    await baseStorage.putChunk({
      ...createChunk(sid, "C-plain", 2, '{"plain":true}\n'),
      resumeDelta: {
        version: 1,
        sequenceWatermark: { event: 2, action: 0 },
        screenRecordingChanges: []
      }
    });
    await baseStorage.putBlob(createBlob("b".repeat(64), Uint8Array.from([9, 9, 9])), sid);
    await expect(storage.getChunk(sid, "C-plain")).rejects.toThrow(/refusing.*plaintext/i);
    await expect(storage.getBlob("b".repeat(64))).rejects.toThrow(/refusing.*plaintext/i);

    await expect(storage.getChunk(sid, "missing")).resolves.toBeUndefined();
    await expect(storage.getBlob("c".repeat(64))).resolves.toBeUndefined();
    await storage.deleteSession(sid, [hash, "b".repeat(64)]);
  });

  it("removes sid-tracked blob refs on indexeddb deleteSession without explicit blobHashes", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sharedHash = "d".repeat(64);
    const sharedBlob = createBlob(sharedHash, Uint8Array.from([8, 9, 10]));

    await storage.putSession(SESSION_A);
    await storage.putSession(SESSION_B);
    await storage.putChunk(createChunk(SESSION_A.sid, "A-1", 1, "A"));
    await storage.putIndexes(SESSION_A.sid, {
      time: [chunkMeta("A-1", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(SESSION_A.sid, {
      manifestSha256: "1".repeat(64),
      files: {}
    });

    await storage.putBlob(sharedBlob, SESSION_A.sid);
    await storage.putBlob(sharedBlob, SESSION_A.sid);
    await storage.putBlob(sharedBlob, SESSION_B.sid);
    expect((await storage.getBlob(sharedHash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid);
    expect((await storage.getBlob(sharedHash))?.refCount).toBe(1);
    expect(await storage.getSession(SESSION_A.sid)).toBeUndefined();
    expect(await storage.getChunk(SESSION_A.sid, "A-1")).toBeUndefined();
    expect((await storage.getIndexes(SESSION_A.sid)).time).toEqual([]);
    expect(await storage.getIntegrity(SESSION_A.sid)).toBeUndefined();

    await storage.deleteSession(SESSION_B.sid);
    expect(await storage.getBlob(sharedHash)).toBeUndefined();

    await expect(storage.listBlobs()).resolves.toEqual([]);
  });

  it("serializes concurrent indexeddb blob refs exactly once across connections", async () => {
    const databaseName = createDbName();
    const first = new IndexedDbPipelineStorage(databaseName);
    const second = new IndexedDbPipelineStorage(databaseName);
    const sidA = "S-concurrent-blob-A";
    const sidB = "S-concurrent-blob-B";
    const hash = "7".repeat(64);
    const blob = createBlob(hash, Uint8Array.from([7, 7, 7]));

    await Promise.all([first.assertReady(), second.assertReady()]);
    await Promise.all([
      first.putSession({ ...SESSION_A, sid: sidA }),
      second.putSession({ ...SESSION_B, sid: sidB })
    ]);

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 === 0 ? first : second).putBlob(blob, sidA)
      )
    );
    expect((await first.getBlob(hash))?.refCount).toBe(1);

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 === 0 ? second : first).putBlob(blob, sidB)
      )
    );
    expect((await second.getBlob(hash))?.refCount).toBe(2);

    await Promise.all([first.deleteSession(sidA), second.deleteSession(sidA)]);
    expect((await first.getBlob(hash))?.refCount).toBe(1);

    await second.deleteSession(sidB);
    expect(await first.getBlob(hash)).toBeUndefined();
  });

  it("does not reattach blob refs while or after their indexeddb session is deleted", async () => {
    const databaseName = createDbName();
    const first = new IndexedDbPipelineStorage(databaseName);
    const second = new IndexedDbPipelineStorage(databaseName);
    const sid = "S-concurrent-delete";
    const firstHash = "8".repeat(64);
    const racingHash = "9".repeat(64);

    await Promise.all([first.assertReady(), second.assertReady()]);
    await first.putSession({ ...SESSION_A, sid });
    await first.putBlob(createBlob(firstHash, Uint8Array.from([1])), sid);

    await Promise.allSettled([
      first.deleteSession(sid),
      second.putBlob(createBlob(racingHash, Uint8Array.from([2])), sid)
    ]);

    expect(await first.getSession(sid)).toBeUndefined();
    expect(await first.getBlob(firstHash)).toBeUndefined();
    expect(await first.getBlob(racingHash)).toBeUndefined();
    await expect(
      second.putBlob(createBlob("a".repeat(64), Uint8Array.from([3])), sid)
    ).rejects.toThrow(/missing session/i);
    await expect(first.listBlobs()).resolves.toEqual([]);
  });

  it("rolls back the blob row when an indexeddb blob-ref write fails", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sid = "S-put-rollback";
    const hash = "4".repeat(64);
    const blob = createBlob(hash, Uint8Array.from([4, 4]));
    const originalPut = IDBObjectStore.prototype.put;

    await storage.putSession({ ...SESSION_A, sid });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      if (this.name === "blobRefs") {
        throw new Error("simulated blobRefs write failure");
      }

      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    });

    try {
      await expect(storage.putBlob(blob, sid)).rejects.toThrow(/simulated blobRefs/i);
    } finally {
      putSpy.mockRestore();
    }

    expect(await storage.getBlob(hash)).toBeUndefined();
    await storage.putBlob(blob, sid);
    expect((await storage.getBlob(hash))?.refCount).toBe(1);
    await storage.deleteSession(sid);
    expect(await storage.getBlob(hash)).toBeUndefined();
  });

  it("stores indexeddb blob ownership as constant-size rows", async () => {
    const databaseName = createDbName();
    const storage = new IndexedDbPipelineStorage(databaseName);
    const sid = "S-normalized-blob-refs";

    await storage.putSession({ ...SESSION_A, sid });

    for (let index = 0; index < 64; index += 1) {
      const hash = index.toString(16).padStart(64, "0");
      await storage.putBlob(createBlob(hash, Uint8Array.from([index])), sid);
    }

    const db = await openRawDb(databaseName, 4, () => undefined);
    const refs = await readRawRows(db, "blobRefs");
    db.close();

    expect(refs).toHaveLength(64);
    expect(refs.every((row) => row.sid === sid && typeof row.hash === "string")).toBe(true);
    expect(refs.every((row) => row.value === undefined)).toBe(true);
    expect(Math.max(...refs.map((row) => JSON.stringify(row).length))).toBeLessThan(220);

    await storage.deleteSession(sid);
    expect(await storage.listBlobs()).toEqual([]);
  });

  it("migrates a legacy cumulative blob-ref row once", async () => {
    const databaseName = createDbName();
    const sid = "S-legacy-blob-refs";
    const oldHash = "1".repeat(64);
    const newHash = "2".repeat(64);
    const db = await openRawDb(databaseName, 3, (raw) => {
      for (const storeName of ["sessions", "chunks", "blobs", "blobRefs", "indexes", "integrity"]) {
        raw.createObjectStore(storeName, { keyPath: "key" });
      }
    });
    await writeRawRows(db, "sessions", [{ key: sid, value: { ...SESSION_A, sid } }]);
    await writeRawRows(db, "blobs", [
      { key: oldHash, value: createBlob(oldHash, Uint8Array.from([1])) }
    ]);
    await writeRawRows(db, "blobRefs", [{ key: sid, value: [oldHash] }]);
    db.close();

    const storage = new IndexedDbPipelineStorage(databaseName);
    await storage.putBlob(createBlob(oldHash, Uint8Array.from([1])), sid);
    await storage.putBlob(createBlob(newHash, Uint8Array.from([2])), sid);

    const upgraded = await openRawDb(databaseName, 4, () => undefined);
    const refs = await readRawRows(upgraded, "blobRefs");
    upgraded.close();

    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sid, hash: oldHash }),
        expect.objectContaining({ sid, hash: newHash })
      ])
    );
    expect(refs.some((row) => row.key === sid || Array.isArray(row.value))).toBe(false);
    expect((await storage.getBlob(oldHash))?.refCount).toBe(1);

    await storage.deleteSession(sid);
    expect(await storage.listBlobs()).toEqual([]);
  });

  it("commits indexeddb chunks and normalized resume changes atomically", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sid = "S-resume-rollback";
    const hash = "7".repeat(64);
    const chunk: StoredChunk = {
      ...createChunk(sid, "C-resume", 1, "resume-event"),
      resumeDelta: {
        version: 1,
        sequenceWatermark: { event: 41, action: 5 },
        screenRecordingChanges: [
          {
            operation: "put",
            recordingId: "VR-atomic",
            index: 0,
            hash,
            size: 12
          }
        ]
      }
    };
    const originalPut = IDBObjectStore.prototype.put;

    await storage.putSession({ ...SESSION_A, sid });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      if (this.name === "resumeRefs") {
        throw new Error("simulated resumeRefs write failure");
      }

      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    });

    try {
      await expect(storage.putChunk(chunk)).rejects.toThrow(/simulated resumeRefs/i);
    } finally {
      putSpy.mockRestore();
    }

    expect(await storage.getChunk(sid, "C-resume")).toBeUndefined();
    expect(await storage.getResumeState(sid)).toBeUndefined();

    await storage.putChunk(chunk);
    expect(await storage.getResumeState(sid)).toEqual({
      sequenceWatermark: { event: 41, action: 5 },
      screenRecordings: [
        {
          recordingId: "VR-atomic",
          chunks: [{ index: 0, hash, size: 12 }]
        }
      ]
    });
    await storage.putChunk(chunk);
    expect(await storage.listChunks(sid)).toHaveLength(1);
    await expect(
      storage.putChunk({
        ...chunk,
        meta: {
          ...chunk.meta,
          sha256: "9".repeat(64)
        }
      })
    ).rejects.toThrow(/sequence.*conflict/i);

    await storage.putChunk({
      ...createChunk(sid, "C-resume-end", 2, "resume-end"),
      resumeDelta: {
        version: 1,
        sequenceWatermark: { event: 42, action: 5 },
        screenRecordingChanges: [{ operation: "delete", recordingId: "VR-atomic" }]
      }
    });
    await expect(
      storage.putChunk({
        ...createChunk(sid, "C-resume-stale", 1, "resume-stale"),
        resumeDelta: {
          version: 1,
          sequenceWatermark: { event: 1, action: 0 },
          screenRecordingChanges: [
            {
              operation: "put",
              recordingId: "VR-atomic",
              index: 1,
              hash: "8".repeat(64)
            }
          ]
        }
      })
    ).rejects.toThrow(/sequence.*conflict/i);
    expect(await storage.getResumeState(sid, 2)).toEqual({
      sequenceWatermark: { event: 42, action: 5 },
      screenRecordings: []
    });
    expect((await storage.listChunks(sid)).map((candidate) => candidate.meta.chunkId)).toEqual([
      "C-resume",
      "C-resume-end"
    ]);
    await expect(
      storage.putChunk(createChunk(sid, "C-missing-resume-delta", 3, "missing-delta"))
    ).rejects.toThrow(/missing a resume delta/i);
  });

  it("initializes an indexeddb resume index from a legacy checkpoint once", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sid = "S-resume-initialize";
    const state = {
      sequenceWatermark: { event: 9, action: 2 },
      screenRecordings: [{ recordingId: "VR-initialize", chunks: [] }]
    };

    await storage.putSession({ ...SESSION_A, sid });
    await storage.putChunk(createChunk(sid, "C-initialize", 1, "legacy"));
    await storage.initializeResumeState(sid, 1, state);
    await storage.initializeResumeState(sid, 1, {
      sequenceWatermark: { event: 99, action: 99 },
      screenRecordings: []
    });

    expect(await storage.getResumeState(sid, 1)).toEqual(state);
  });

  it("rolls back every indexeddb session store when atomic deletion fails", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sid = "S-delete-rollback";
    const hash = "5".repeat(64);
    const chunk = createChunk(sid, "C-rollback", 1, "rollback-event");
    const indexes = {
      time: [chunkMeta("C-rollback", 1)],
      request: [],
      inverted: []
    };
    const integrity = {
      manifestSha256: "6".repeat(64),
      files: {}
    };

    await storage.putSession({ ...SESSION_A, sid });
    await storage.putChunk(chunk);
    await storage.putBlob(createBlob(hash, Uint8Array.from([5, 5])), sid);
    await storage.putIndexes(sid, indexes);
    await storage.putIntegrity(sid, integrity);

    const originalDelete = IDBObjectStore.prototype.delete;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange
    ): IDBRequest<undefined> {
      if (this.name === "integrity") {
        throw new Error("simulated integrity delete failure");
      }

      return originalDelete.call(this, query);
    });

    try {
      await expect(storage.deleteSession(sid)).rejects.toThrow(/simulated integrity/i);
    } finally {
      deleteSpy.mockRestore();
    }

    expect(await storage.getSession(sid)).toEqual(expect.objectContaining({ sid }));
    expect(await storage.getChunk(sid, "C-rollback")).toEqual(chunk);
    expect(await storage.getBlob(hash)).toEqual(expect.objectContaining({ refCount: 1 }));
    expect(await storage.getIndexes(sid)).toEqual(indexes);
    expect(await storage.getIntegrity(sid)).toEqual(integrity);

    await storage.deleteSession(sid);
    expect(await storage.getSession(sid)).toBeUndefined();
    expect(await storage.getChunk(sid, "C-rollback")).toBeUndefined();
    expect(await storage.getBlob(hash)).toBeUndefined();
    expect((await storage.getIndexes(sid)).time).toEqual([]);
    expect(await storage.getIntegrity(sid)).toBeUndefined();
  });

  it("supports legacy indexeddb layouts where chunks store has no sid/seq index", async () => {
    const sid = "S-legacy-layout";
    const dbName = createDbName();
    const db = await openRawDb(dbName, 3, (raw) => {
      for (const storeName of ["sessions", "chunks", "blobs", "blobRefs", "indexes", "integrity"]) {
        if (!raw.objectStoreNames.contains(storeName)) {
          raw.createObjectStore(storeName, { keyPath: "key" });
        }
      }
    });
    await writeRawRows(db, "sessions", [
      {
        key: sid,
        value: {
          ...SESSION_A,
          sid,
          startedAt: 10
        }
      }
    ]);
    await writeRawRows(db, "chunks", [
      {
        key: `${sid}:C-2`,
        sid,
        seq: 2,
        value: createChunk(sid, "C-2", 2, "legacy-2")
      },
      {
        key: `${sid}:C-1`,
        sid,
        seq: 1,
        value: createChunk(sid, "C-1", 1, "legacy-1")
      }
    ]);
    db.close();

    const storage = new IndexedDbPipelineStorage(dbName);
    const chunks = await storage.listChunks(sid);
    expect(chunks.map((chunk) => chunk.meta.chunkId)).toEqual(["C-1", "C-2"]);
    expect((await storage.getLatestChunkMeta(sid))?.chunkId).toBe("C-2");

    await storage.deleteSession(sid);
    expect(await storage.listChunks(sid)).toEqual([]);
  });

  it("evicts oldest session during quota recovery helper and logs when none is evictable", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const quotaRecovery = (
      storage as unknown as {
        recoverQuotaPressure: (protectedSid?: string) => Promise<boolean>;
      }
    ).recoverQuotaPressure.bind(storage);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(quotaRecovery("S-protected")).resolves.toBe(false);

    await storage.putSession({
      ...SESSION_A,
      sid: "S-oldest",
      startedAt: 1
    });
    await storage.putSession({
      ...SESSION_A,
      sid: "S-newest",
      startedAt: 2
    });

    await expect(quotaRecovery("S-newest")).resolves.toBe(true);
    expect(await storage.getSession("S-oldest")).toBeUndefined();
    expect(await storage.getSession("S-newest")).toEqual(
      expect.objectContaining({ sid: "S-newest" })
    );

    warnSpy.mockRestore();
  });

  it("retains quota recovery for atomic indexeddb blob writes", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const protectedSid = "S-quota-protected";
    const hash = "3".repeat(64);
    const originalPut = IDBObjectStore.prototype.put;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let injectQuotaFailure = true;

    await storage.putSession({ ...SESSION_A, sid: "S-quota-oldest", startedAt: 1 });
    await storage.putSession({ ...SESSION_B, sid: protectedSid, startedAt: 2 });

    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      if (this.name === "blobs" && injectQuotaFailure) {
        injectQuotaFailure = false;
        throw new DOMException("simulated quota pressure", "QuotaExceededError");
      }

      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    });

    try {
      await storage.putBlob(createBlob(hash, Uint8Array.from([3, 3])), protectedSid);
    } finally {
      putSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(await storage.getSession("S-quota-oldest")).toBeUndefined();
    expect(await storage.getSession(protectedSid)).toEqual(
      expect.objectContaining({ sid: protectedSid })
    );
    expect(await storage.getBlob(hash)).toEqual(expect.objectContaining({ refCount: 1 }));
  });

  it("fails fast when indexeddb runtime is unavailable", async () => {
    const originalIndexedDb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;

    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      const storage = new IndexedDbPipelineStorage(createDbName());
      await expect(storage.putSession(SESSION_A)).rejects.toThrow(/indexedDB is unavailable/i);
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        writable: true,
        value: originalIndexedDb
      });
    }
  });

  it("keeps encrypted indexeddb payloads and still cleans tracked blobs on session delete", async () => {
    const innerStorage = new IndexedDbPipelineStorage(createDbName());
    const key = await derivePipelineStorageKey("idb-passphrase", {
      salt: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16])
    });
    const storage = new EncryptedPipelineStorage(innerStorage, { key: key.key });
    const sid = "S-idb-encrypted";
    const hash = "a".repeat(64);
    const chunk = createChunk(sid, "C-1", 1, '{"kind":"screen.screenshot"}\n');

    await storage.putSession({
      ...SESSION_A,
      sid
    });
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 3, 3, 7])), sid);
    await storage.putChunk(chunk);

    const rawChunk = await innerStorage.getChunk(sid, "C-1");
    expect(Array.from(rawChunk?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);

    const wrongKey = await derivePipelineStorageKey("other-passphrase", {
      salt: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16])
    });
    const wrongReader = new EncryptedPipelineStorage(innerStorage, { key: wrongKey.key });
    await expect(wrongReader.getChunk(sid, "C-1")).rejects.toThrow(/Unable to decrypt/i);

    await storage.deleteSession(sid);
    expect(await innerStorage.getBlob(hash)).toBeUndefined();
  });

  it("persists a non-extractable purpose key and recovers encrypted chunks and blobs", async () => {
    const dataDatabaseName = createDbName();
    const keyDatabaseName = `${dataDatabaseName}-keys`;
    const purpose = "pipeline-test:payload:aes-gcm:v1";
    const sid = "S-idb-key-recovery";
    const hash = "f".repeat(64);
    const eventSecret = "EVENT_SECRET_MUST_NOT_BE_PLAINTEXT";
    const blobSecret = "BLOB_SECRET_MUST_NOT_BE_PLAINTEXT";
    const firstManagedKey = await getOrCreateIndexedDbPipelineStorageKey({
      databaseName: keyDatabaseName,
      purpose
    });
    const rawStorage = new IndexedDbPipelineStorage(dataDatabaseName);
    const firstStorage = new EncryptedPipelineStorage(rawStorage, {
      key: firstManagedKey.key
    });

    expect(firstManagedKey.created).toBe(true);
    expect(firstManagedKey.key.extractable).toBe(false);
    await firstStorage.assertReady();
    await firstStorage.putSession({ ...SESSION_A, sid });
    await firstStorage.putChunk(createChunk(sid, "C-secret", 1, `${eventSecret}\n`));
    await firstStorage.putBlob(createBlob(hash, new TextEncoder().encode(blobSecret)), sid);

    const persistedChunk = await rawStorage.getChunk(sid, "C-secret");
    const persistedBlob = await rawStorage.getBlob(hash);
    expect(new TextDecoder().decode(persistedChunk?.bytes)).not.toContain(eventSecret);
    expect(new TextDecoder().decode(persistedBlob?.bytes)).not.toContain(blobSecret);

    const recoveredManagedKey = await getOrCreateIndexedDbPipelineStorageKey({
      databaseName: keyDatabaseName,
      purpose
    });
    const recoveredStorage = new EncryptedPipelineStorage(
      new IndexedDbPipelineStorage(dataDatabaseName),
      { key: recoveredManagedKey.key }
    );

    expect(recoveredManagedKey.created).toBe(false);
    await recoveredStorage.assertReady();
    expect(
      new TextDecoder().decode((await recoveredStorage.getChunk(sid, "C-secret"))?.bytes)
    ).toBe(`${eventSecret}\n`);
    expect(new TextDecoder().decode((await recoveredStorage.getBlob(hash))?.bytes)).toBe(
      blobSecret
    );
  });

  it("fails closed when an encrypted persistent storage key is missing", async () => {
    const storage = new EncryptedPipelineStorage(new IndexedDbPipelineStorage(createDbName()), {
      key: Promise.reject(new Error("simulated missing key"))
    });

    await expect(storage.assertReady()).rejects.toThrow(/key is unavailable/i);
  });

  it("rejects extractable keys for persistent payload encryption", async () => {
    const extractableKey = await crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
    const storage = new EncryptedPipelineStorage(new IndexedDbPipelineStorage(createDbName()), {
      key: extractableKey
    });

    await expect(storage.assertReady()).rejects.toThrow(/non-extractable 256-bit AES-GCM/i);
  });

  it("purges a legacy IndexedDB database before encrypted storage initialization", async () => {
    const databaseName = createDbName();
    const legacy = await openRawDb(databaseName, 1, (db) => {
      db.createObjectStore("legacy", { keyPath: "id" });
    });
    await writeRawRows(legacy, "legacy", [{ id: "secret", value: "PLAINTEXT_LEGACY_DATA" }]);
    legacy.close();

    await deleteIndexedDbDatabase(databaseName);

    const reopened = await openRawDb(databaseName, 1, () => undefined);
    expect(reopened.objectStoreNames.contains("legacy")).toBe(false);
    reopened.close();
  });
});
