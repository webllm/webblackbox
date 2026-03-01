import "fake-indexeddb/auto";

import type { ChunkTimeIndexEntry, SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  derivePipelineStorageKey,
  EncryptedPipelineStorage,
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

describe("storage", () => {
  it("supports memory storage CRUD and blob ref-count cleanup", async () => {
    const storage = new MemoryPipelineStorage();
    const hash = "f".repeat(64);

    await storage.putSession(SESSION_A);
    await storage.putChunk(createChunk(SESSION_A.sid, "C-2", 2, "second"));
    await storage.putChunk(createChunk(SESSION_A.sid, "C-1", 1, "first"));
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
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
    expect(await storage.getSession(SESSION_A.sid)).toEqual(expect.objectContaining(SESSION_A));
    expect((await storage.getBlob(hash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid, [hash]);
    expect(await storage.getSession(SESSION_A.sid)).toBeUndefined();
    expect((await storage.getBlob(hash))?.refCount).toBe(1);
    expect((await storage.getIndexes(SESSION_A.sid)).time).toEqual([]);
    expect(await storage.getIntegrity(SESSION_A.sid)).toBeUndefined();

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

    await baseStorage.putChunk(createChunk(sid, "C-plain", 2, '{"plain":true}\n'));
    await baseStorage.putBlob(createBlob("b".repeat(64), Uint8Array.from([9, 9, 9])), sid);
    expect(Array.from((await storage.getChunk(sid, "C-plain"))?.bytes ?? [])).toEqual(
      Array.from(new TextEncoder().encode('{"plain":true}\n'))
    );
    expect(Array.from((await storage.getBlob("b".repeat(64)))?.bytes ?? [])).toEqual([9, 9, 9]);

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
});
