import type {
  ChunkTimeIndexEntry,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  SessionMetadata
} from "@webblackbox/protocol";

import { decodeEventsNdjson } from "./codec.js";

export type StoredChunk = {
  sid: string;
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
};

export type StoredBlob = {
  hash: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
  createdAt: number;
  refCount: number;
};

export type StoredIndexes = {
  time: ChunkTimeIndexEntry[];
  request: RequestIndexEntry[];
  inverted: InvertedIndexEntry[];
};

export type PipelineStorage = {
  putSession(metadata: SessionMetadata): Promise<void>;
  getSession(sid: string): Promise<SessionMetadata | undefined>;
  putChunk(chunk: StoredChunk): Promise<void>;
  listChunks(sid: string): Promise<StoredChunk[]>;
  getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined>;
  putBlob(blob: StoredBlob, sidHint?: string): Promise<void>;
  getBlob(hash: string): Promise<StoredBlob | undefined>;
  listBlobs(): Promise<StoredBlob[]>;
  putIndexes(sid: string, indexes: StoredIndexes): Promise<void>;
  getIndexes(sid: string): Promise<StoredIndexes>;
  putIntegrity(sid: string, manifest: HashesManifest): Promise<void>;
  getIntegrity(sid: string): Promise<HashesManifest | undefined>;
  deleteSession(sid: string, blobHashes?: string[]): Promise<void>;
};

const EMPTY_INDEXES: StoredIndexes = {
  time: [],
  request: [],
  inverted: []
};
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_QUOTA_RECOVERY_ATTEMPTS = 2;
const STORAGE_ENCRYPTION_MAGIC = new Uint8Array([0x57, 0x42, 0x45, 0x31]); // WBE1
const STORAGE_ENCRYPTION_IV_BYTES = 12;
const STORAGE_ENCRYPTION_KDF_ITERATIONS = 120_000;

export type PipelineStorageKeyOptions = {
  salt?: Uint8Array;
  iterations?: number;
};

export type DerivedPipelineStorageKey = {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
};

export type EncryptedPipelineStorageOptions = {
  key: CryptoKey | Promise<CryptoKey>;
};

export class MemoryPipelineStorage implements PipelineStorage {
  private readonly sessions = new Map<string, SessionMetadata>();

  private readonly chunks = new Map<string, StoredChunk[]>();

  private readonly blobs = new Map<string, StoredBlob>();

  private readonly indexes = new Map<string, StoredIndexes>();

  private readonly integrity = new Map<string, HashesManifest>();

  public async putSession(metadata: SessionMetadata): Promise<void> {
    this.sessions.set(metadata.sid, metadata);
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    return this.sessions.get(sid);
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    const existing = this.chunks.get(chunk.sid) ?? [];
    existing.push(chunk);
    this.chunks.set(chunk.sid, existing);
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const chunks = this.chunks.get(sid) ?? [];
    return [...chunks].sort((left, right) => left.meta.seq - right.meta.seq);
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const chunks = this.chunks.get(sid) ?? [];
    return chunks.find((chunk) => chunk.meta.chunkId === chunkId);
  }

  public async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    void sidHint;
    const existing = this.blobs.get(blob.hash);

    if (existing) {
      existing.refCount += 1;
      this.blobs.set(blob.hash, existing);
      return;
    }

    this.blobs.set(blob.hash, blob);
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    return this.blobs.get(hash);
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    return [...this.blobs.values()];
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    this.indexes.set(sid, indexes);
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    return this.indexes.get(sid) ?? EMPTY_INDEXES;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    this.integrity.set(sid, manifest);
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    return this.integrity.get(sid);
  }

  public async deleteSession(sid: string, blobHashes: string[] = []): Promise<void> {
    this.sessions.delete(sid);
    this.chunks.delete(sid);
    this.indexes.delete(sid);
    this.integrity.delete(sid);

    for (const hash of blobHashes) {
      const blob = this.blobs.get(hash);

      if (!blob) {
        continue;
      }

      if (blob.refCount <= 1) {
        this.blobs.delete(hash);
      } else {
        this.blobs.set(hash, {
          ...blob,
          refCount: blob.refCount - 1
        });
      }
    }
  }
}

/**
 * Derives an AES-GCM key for at-rest pipeline storage encryption.
 * Persist the returned salt to derive the same key for future reads.
 */
export async function derivePipelineStorageKey(
  passphrase: string,
  options: PipelineStorageKeyOptions = {}
): Promise<DerivedPipelineStorageKey> {
  const iterations = normalizePositiveInt(options.iterations, STORAGE_ENCRYPTION_KDF_ITERATIONS);
  const salt = options.salt ? Uint8Array.from(options.salt) : randomBytes(16);
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await cryptoApi.subtle.deriveKey(
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
    ["encrypt", "decrypt"]
  );

  return {
    key,
    salt,
    iterations
  };
}

/**
 * PipelineStorage wrapper that encrypts chunk/blob payload bytes before writing
 * and decrypts on read. Metadata/indexes remain plaintext for queryability.
 */
export class EncryptedPipelineStorage implements PipelineStorage {
  private readonly keyPromise: Promise<CryptoKey>;

  public constructor(
    private readonly storage: PipelineStorage,
    options: EncryptedPipelineStorageOptions
  ) {
    this.keyPromise = Promise.resolve(options.key);
  }

  public async putSession(metadata: SessionMetadata): Promise<void> {
    await this.storage.putSession(metadata);
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    return this.storage.getSession(sid);
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    await this.storage.putChunk({
      ...chunk,
      bytes: await this.encryptStoredBytes(chunk.bytes)
    });
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const chunks = await this.storage.listChunks(sid);
    return Promise.all(
      chunks.map(async (chunk) => {
        return {
          ...chunk,
          bytes: await this.decryptStoredBytes(chunk.bytes)
        };
      })
    );
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const chunk = await this.storage.getChunk(sid, chunkId);

    if (!chunk) {
      return undefined;
    }

    return {
      ...chunk,
      bytes: await this.decryptStoredBytes(chunk.bytes)
    };
  }

  public async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    await this.storage.putBlob(
      {
        ...blob,
        bytes: await this.encryptStoredBytes(blob.bytes)
      },
      sidHint
    );
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    const blob = await this.storage.getBlob(hash);

    if (!blob) {
      return undefined;
    }

    return {
      ...blob,
      bytes: await this.decryptStoredBytes(blob.bytes)
    };
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    const blobs = await this.storage.listBlobs();
    return Promise.all(
      blobs.map(async (blob) => {
        return {
          ...blob,
          bytes: await this.decryptStoredBytes(blob.bytes)
        };
      })
    );
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    await this.storage.putIndexes(sid, indexes);
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    return this.storage.getIndexes(sid);
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    await this.storage.putIntegrity(sid, manifest);
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    return this.storage.getIntegrity(sid);
  }

  public async deleteSession(sid: string, blobHashes?: string[]): Promise<void> {
    await this.storage.deleteSession(sid, blobHashes);
  }

  private async encryptStoredBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const key = await this.keyPromise;
    const iv = randomBytes(STORAGE_ENCRYPTION_IV_BYTES);
    const cryptoApi = requireCryptoApi();
    const encrypted = await cryptoApi.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv)
      },
      key,
      toArrayBuffer(bytes)
    );

    return concatBytes(STORAGE_ENCRYPTION_MAGIC, iv, new Uint8Array(encrypted));
  }

  private async decryptStoredBytes(bytes: Uint8Array): Promise<Uint8Array> {
    if (!looksEncryptedStorageBytes(bytes)) {
      return bytes;
    }

    const key = await this.keyPromise;
    const ivStart = STORAGE_ENCRYPTION_MAGIC.byteLength;
    const ivEnd = ivStart + STORAGE_ENCRYPTION_IV_BYTES;
    const iv = bytes.slice(ivStart, ivEnd);
    const encrypted = bytes.slice(ivEnd);
    const cryptoApi = requireCryptoApi();

    try {
      const decrypted = await cryptoApi.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(iv)
        },
        key,
        toArrayBuffer(encrypted)
      );

      return new Uint8Array(decrypted);
    } catch {
      throw new Error("Unable to decrypt pipeline storage payload.");
    }
  }
}

type DbRow<TData> = {
  key: string;
  value: TData;
};

type ChunkRow = {
  key: string;
  sid: string;
  seq: number;
  value: StoredChunk;
};
type BlobRow = DbRow<StoredBlob>;
type SessionRow = DbRow<SessionMetadata>;
type IndexRow = DbRow<StoredIndexes>;
type IntegrityRow = DbRow<HashesManifest>;

const DB_VERSION = 2;
const CHUNKS_BY_SID_SEQ_INDEX = "by-sid-seq";

export class IndexedDbPipelineStorage implements PipelineStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  public constructor(private readonly dbName = "webblackbox-pipeline") {}

  public async putSession(metadata: SessionMetadata): Promise<void> {
    await this.put<SessionRow>(
      "sessions",
      {
        key: metadata.sid,
        value: metadata
      },
      {
        allowQuotaRecovery: true,
        protectedSid: metadata.sid
      }
    );
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    const row = await this.get<SessionRow>("sessions", sid);
    return row?.value;
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    await this.put<ChunkRow>(
      "chunks",
      {
        key: this.chunkKey(chunk.sid, chunk.meta.chunkId),
        sid: chunk.sid,
        seq: chunk.meta.seq,
        value: chunk
      },
      {
        allowQuotaRecovery: true,
        protectedSid: chunk.sid
      }
    );
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const db = await this.db();

    return runTransaction(db, "chunks", "readonly", (store) => {
      if (!store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        return requestToPromise<ChunkRow[]>(store.getAll()).then((rows) =>
          rows
            .map((row) => row.value)
            .filter((chunk) => chunk.sid === sid)
            .sort((left, right) => left.meta.seq - right.meta.seq)
        );
      }

      const index = store.index(CHUNKS_BY_SID_SEQ_INDEX);
      const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);

      return requestToPromise<ChunkRow[]>(index.getAll(range)).then((rows) =>
        rows.map((row) => row.value)
      );
    });
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const row = await this.get<ChunkRow>("chunks", this.chunkKey(sid, chunkId));
    return row?.value;
  }

  public async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    const existing = await this.getBlob(blob.hash);

    if (existing) {
      await this.put<BlobRow>(
        "blobs",
        {
          key: blob.hash,
          value: {
            ...existing,
            refCount: existing.refCount + 1
          }
        },
        {
          allowQuotaRecovery: false
        }
      );
      return;
    }

    await this.put<BlobRow>(
      "blobs",
      {
        key: blob.hash,
        value: blob
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sidHint
      }
    );
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    const row = await this.get<BlobRow>("blobs", hash);
    return row?.value;
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    const rows = await this.getAll<BlobRow>("blobs");
    return rows.map((row) => row.value);
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    await this.put<IndexRow>(
      "indexes",
      {
        key: sid,
        value: indexes
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sid
      }
    );
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    const row = await this.get<IndexRow>("indexes", sid);
    return row?.value ?? EMPTY_INDEXES;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    await this.put<IntegrityRow>(
      "integrity",
      {
        key: sid,
        value: manifest
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sid
      }
    );
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    const row = await this.get<IntegrityRow>("integrity", sid);
    return row?.value;
  }

  public async deleteSession(sid: string, blobHashes: string[] = []): Promise<void> {
    const db = await this.db();

    await runTransaction(db, "sessions", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await runTransaction(db, "indexes", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await runTransaction(db, "integrity", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await this.deleteChunksBySid(sid);

    for (const hash of blobHashes) {
      await this.decrementOrDeleteBlob(hash);
    }
  }

  private chunkKey(sid: string, chunkId: string): string {
    return `${sid}:${chunkId}`;
  }

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.open();
    }

    return this.dbPromise;
  }

  private async put<TRow>(
    storeName: string,
    value: TRow,
    options: {
      allowQuotaRecovery?: boolean;
      protectedSid?: string;
    } = {}
  ): Promise<void> {
    const allowQuotaRecovery = options.allowQuotaRecovery === true;
    const recoveryAttempts = allowQuotaRecovery ? MAX_QUOTA_RECOVERY_ATTEMPTS : 0;
    let attempt = 0;

    while (true) {
      const db = await this.db();

      try {
        await runTransaction(db, storeName, "readwrite", (store) => {
          store.put(value);
        });
        return;
      } catch (error) {
        if (!isQuotaExceededError(error) || attempt >= recoveryAttempts) {
          throw error;
        }

        attempt += 1;

        const recovered = await this.recoverQuotaPressure(options.protectedSid);

        if (!recovered) {
          throw error;
        }
      }
    }
  }

  private async get<TRow>(storeName: string, key: string): Promise<TRow | undefined> {
    const db = await this.db();

    return runTransaction(db, storeName, "readonly", (store) => {
      return requestToPromise<TRow | undefined>(store.get(key));
    });
  }

  private async getAll<TRow>(storeName: string): Promise<TRow[]> {
    const db = await this.db();

    return runTransaction(db, storeName, "readonly", (store) => {
      return requestToPromise<TRow[]>(store.getAll());
    });
  }

  private async recoverQuotaPressure(protectedSid?: string): Promise<boolean> {
    const before = await getNavigatorStorageEstimate();
    const evictedSid = await this.evictOldestSession(protectedSid);

    if (!evictedSid) {
      console.warn(
        "[WebBlackbox] IndexedDB quota pressure detected, no evictable sessions remain",
        {
          protectedSid,
          usage: before?.usage ?? null,
          quota: before?.quota ?? null
        }
      );
      return false;
    }

    const after = await getNavigatorStorageEstimate();

    console.warn("[WebBlackbox] IndexedDB quota pressure detected, evicted oldest session", {
      evictedSid,
      protectedSid,
      usageBefore: before?.usage ?? null,
      usageAfter: after?.usage ?? null,
      quota: after?.quota ?? before?.quota ?? null
    });

    return true;
  }

  private async evictOldestSession(protectedSid?: string): Promise<string | null> {
    const rows = await this.getAll<SessionRow>("sessions");
    const candidates = rows
      .map((row) => row.value)
      .filter((session) => session.sid !== protectedSid)
      .sort((left, right) => left.startedAt - right.startedAt);
    const oldest = candidates[0];

    if (!oldest) {
      return null;
    }

    await this.deleteSessionWithBlobCleanup(oldest.sid);
    return oldest.sid;
  }

  private async deleteSessionWithBlobCleanup(sid: string): Promise<void> {
    const chunks = await this.listChunks(sid);
    const blobHashes = collectBlobHashesFromChunks(chunks);
    await this.deleteSession(sid, [...blobHashes]);
  }

  private open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) {
      return Promise.reject(new Error("indexedDB is unavailable in this runtime"));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        for (const storeName of ["sessions", "chunks", "blobs", "indexes", "integrity"]) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "key" });
          }
        }

        const transaction = request.transaction;
        const chunksStore = transaction?.objectStore("chunks");

        if (chunksStore && !chunksStore.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
          chunksStore.createIndex(CHUNKS_BY_SID_SEQ_INDEX, ["sid", "seq"], { unique: false });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB"));
      };
    });
  }

  private async deleteChunksBySid(sid: string): Promise<void> {
    const db = await this.db();

    await runTransaction(db, "chunks", "readwrite", (store) => {
      if (store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        const index = store.index(CHUNKS_BY_SID_SEQ_INDEX);
        const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
        return deleteByCursor(index.openCursor(range));
      }

      return requestToPromise<ChunkRow[]>(store.getAll()).then(async (rows) => {
        for (const row of rows) {
          if (row.value.sid !== sid) {
            continue;
          }

          await requestToPromise(store.delete(row.key));
        }
      });
    });
  }

  private async decrementOrDeleteBlob(hash: string): Promise<void> {
    const existing = await this.getBlob(hash);

    if (!existing) {
      return;
    }

    if (existing.refCount <= 1) {
      const db = await this.db();
      await runTransaction(db, "blobs", "readwrite", (store) => {
        return requestToPromise(store.delete(hash));
      });
      return;
    }

    await this.put<BlobRow>(
      "blobs",
      {
        key: hash,
        value: {
          ...existing,
          refCount: existing.refCount - 1
        }
      },
      {
        allowQuotaRecovery: false
      }
    );
  }
}

function isQuotaExceededError(error: unknown): boolean {
  const DomException = globalThis.DOMException;

  if (!DomException || !(error instanceof DomException)) {
    return false;
  }

  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

async function getNavigatorStorageEstimate(): Promise<{ usage?: number; quota?: number } | null> {
  const estimate = globalThis.navigator?.storage?.estimate;

  if (typeof estimate !== "function") {
    return null;
  }

  try {
    const value = await estimate.call(globalThis.navigator.storage);
    return {
      usage: typeof value.usage === "number" ? value.usage : undefined,
      quota: typeof value.quota === "number" ? value.quota : undefined
    };
  } catch {
    return null;
  }
}

function collectBlobHashesFromChunks(chunks: StoredChunk[]): Set<string> {
  const hashes = new Set<string>();

  for (const chunk of chunks) {
    try {
      const events = decodeEventsNdjson(chunk.bytes);

      for (const event of events) {
        collectBlobHashesFromUnknown(event.data, hashes);
      }
    } catch {
      continue;
    }
  }

  return hashes;
}

function collectBlobHashesFromUnknown(value: unknown, output: Set<string>): void {
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();

    if (typeof current === "string") {
      if (SHA256_HEX_PATTERN.test(current)) {
        output.add(current);
      }

      continue;
    }

    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    for (const item of Object.values(current as Record<string, unknown>)) {
      stack.push(item);
    }
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required for pipeline storage encryption.");
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const cryptoApi = requireCryptoApi();
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
}

function looksEncryptedStorageBytes(bytes: Uint8Array): boolean {
  const expectedLength = STORAGE_ENCRYPTION_MAGIC.byteLength + STORAGE_ENCRYPTION_IV_BYTES + 1;

  if (bytes.byteLength < expectedLength) {
    return false;
  }

  for (let index = 0; index < STORAGE_ENCRYPTION_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== STORAGE_ENCRYPTION_MAGIC[index]) {
      return false;
    }
  }

  return true;
}

async function runTransaction<TResult>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => TResult | Promise<TResult>
): Promise<TResult> {
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const result = await handler(store);

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });

  return result;
}

function requestToPromise<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function deleteByCursor(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB cursor iteration failed"));
    };

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    };
  });
}
