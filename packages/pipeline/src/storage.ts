import type {
  ChunkTimeIndexEntry,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  SessionMetadata
} from "@webblackbox/protocol";

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
  putBlob(blob: StoredBlob): Promise<void>;
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

  public async putBlob(blob: StoredBlob): Promise<void> {
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
    await this.put<SessionRow>("sessions", {
      key: metadata.sid,
      value: metadata
    });
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    const row = await this.get<SessionRow>("sessions", sid);
    return row?.value;
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    await this.put<ChunkRow>("chunks", {
      key: this.chunkKey(chunk.sid, chunk.meta.chunkId),
      sid: chunk.sid,
      seq: chunk.meta.seq,
      value: chunk
    });
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

  public async putBlob(blob: StoredBlob): Promise<void> {
    const existing = await this.getBlob(blob.hash);

    if (existing) {
      await this.put<BlobRow>("blobs", {
        key: blob.hash,
        value: {
          ...existing,
          refCount: existing.refCount + 1
        }
      });
      return;
    }

    await this.put<BlobRow>("blobs", {
      key: blob.hash,
      value: blob
    });
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
    await this.put<IndexRow>("indexes", {
      key: sid,
      value: indexes
    });
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    const row = await this.get<IndexRow>("indexes", sid);
    return row?.value ?? EMPTY_INDEXES;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    await this.put<IntegrityRow>("integrity", {
      key: sid,
      value: manifest
    });
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

  private async put<TRow>(storeName: string, value: TRow): Promise<void> {
    const db = await this.db();

    await runTransaction(db, storeName, "readwrite", (store) => {
      store.put(value);
    });
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

    await this.put<BlobRow>("blobs", {
      key: hash,
      value: {
        ...existing,
        refCount: existing.refCount - 1
      }
    });
  }
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
