# @webblackbox/pipeline

The event processing pipeline for WebBlackbox. Handles chunking, indexing, blob storage, and archive export for recorded sessions.

## Overview

- **FlightRecorderPipeline** — Main pipeline orchestrating the full event processing lifecycle
- **EventChunker** — Groups events into size-bounded chunks with codec support
- **EventIndexer** — Builds time-based, request-based, and inverted text search indexes
- **Codec** — NDJSON chunk codec support for `none`, `gzip`, `br`, and `zst`
- **Archive Export** — Creates `.webblackbox` ZIP archives with optional AES-GCM encryption
- **PipelineStorage** — Abstract storage interface with in-memory implementation
- **IndexedDB Quota Recovery** — Indexed storage evicts oldest sessions on quota pressure (best-effort)

## Usage

### Basic Pipeline

```typescript
import { FlightRecorderPipeline, MemoryPipelineStorage } from "@webblackbox/pipeline";
import type { SessionMetadata } from "@webblackbox/protocol";

const session: SessionMetadata = {
  sid: "S-1706000000000-abc",
  tabId: 123,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com",
  tags: ["debug"]
};

const pipeline = new FlightRecorderPipeline({
  session,
  storage: new MemoryPipelineStorage(),
  maxChunkBytes: 512 * 1024, // 512KB per chunk
  chunkCodec: "gzip" // supported codecs: none | gzip | br | zst
});

// Start the pipeline
await pipeline.start();

// Ingest events
for (const event of events) {
  await pipeline.ingest(event);
}

// Flush remaining events
await pipeline.flush();

// Build search indexes
const indexes = await pipeline.finalizeIndexes();

// Export as archive
const result = await pipeline.exportBundle({
  passphrase: "optional-encryption-key",
  includeScreenshots: true,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
});

console.log(`Exported: ${result.fileName} (${result.bytes.length} bytes)`);
```

`includeScreenshots`, `maxArchiveBytes`, and `recentWindowMs` are optional export filters. If omitted, export includes the full retained session.

### Optional At-Rest Storage Encryption

`EncryptedPipelineStorage` encrypts chunk/blob cache payload bytes before persistence (for example when using IndexedDB storage).

```typescript
import {
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  derivePipelineStorageKey
} from "@webblackbox/pipeline";

const derived = await derivePipelineStorageKey("cache-passphrase");

const storage = new EncryptedPipelineStorage(
  new IndexedDbPipelineStorage("webblackbox-flight-recorder"),
  {
    key: derived.key
  }
);

// Persist derived.salt + derived.iterations with your own secure key policy.
```

Note: this protects event/blob payload bytes at rest; indexes and session metadata remain plaintext for queryability.

### Blob Storage

```typescript
// Store binary data (screenshots, DOM snapshots, response bodies)
const hash = await pipeline.putBlob("image/webp", screenshotBytes);
// Returns SHA-256 hash for content-addressable retrieval
```

## Event Chunking

The `EventChunker` groups events into size-bounded chunks:

```typescript
import { EventChunker } from "@webblackbox/pipeline";

const chunker = new EventChunker(
  512 * 1024, // Max 512KB per chunk
  "gzip" // Codec: none | gzip | br | zst
);

// Append events; returns a finalized chunk when size threshold is reached
const chunk = await chunker.append(event);
if (chunk) {
  // chunk.meta: ChunkTimeIndexEntry (timestamps, size, hash)
  // chunk.bytes: Uint8Array (encoded NDJSON)
  // chunk.events: WebBlackboxEvent[] (original events)
}

// Flush remaining events
const remaining = await chunker.flush();
```

### FinalizedChunk

```typescript
type FinalizedChunk = {
  meta: ChunkTimeIndexEntry; // Chunk metadata for indexing
  bytes: Uint8Array; // Encoded event data
  events: WebBlackboxEvent[]; // Original events in this chunk
};
```

## Indexing

The `EventIndexer` builds three types of indexes:

```typescript
import { EventIndexer } from "@webblackbox/pipeline";

const indexer = new EventIndexer();

// Add chunk metadata for time-based indexing
indexer.addChunk(chunkMeta);

// Add events for request and text indexing
indexer.addEvents(events);

// Get all indexes
const { time, request, inverted } = indexer.snapshot();
```

### Index Types

| Index              | Purpose                      | Structure                                                                                   |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| **Time Index**     | Locate chunks by timestamp   | `{ chunkId, seq, tStart, tEnd, monoStart, monoEnd, eventCount, byteLength, codec, sha256 }` |
| **Request Index**  | Map request IDs to event IDs | `{ reqId, eventIds[] }`                                                                     |
| **Inverted Index** | Full-text search             | `{ term, eventIds[] }`                                                                      |

## Codec

```typescript
import { encodeEventsNdjson, decodeEventsNdjson } from "@webblackbox/pipeline";

// Encode events as NDJSON
const bytes = encodeEventsNdjson(events);

// Decode NDJSON back to events
const decoded = decodeEventsNdjson(bytes);
```

## SHA-256 Hashing

```typescript
import { sha256Hex } from "@webblackbox/pipeline";

const hash = await sha256Hex(data); // Returns hex string
```

## Storage Interface

```typescript
import type { PipelineStorage } from "@webblackbox/pipeline";

// Implement custom storage backend
class CustomStorage implements PipelineStorage {
  async putSession(metadata: SessionMetadata): Promise<void> {
    /* ... */
  }
  async getSession(sid: string): Promise<SessionMetadata | undefined> {
    /* ... */
  }
  async putChunk(chunk: StoredChunk): Promise<void> {
    /* ... */
  }
  async listChunks(sid: string): Promise<StoredChunk[]> {
    /* ... */
  }
  async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    /* ... */
  }
  async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    /* ... */
  }
  async getBlob(hash: string): Promise<StoredBlob | undefined> {
    /* ... */
  }
  async listBlobs(): Promise<StoredBlob[]> {
    /* ... */
  }
  async putIndexes(sid: string, indexes: object): Promise<void> {
    /* ... */
  }
  async getIndexes(sid: string): Promise<object> {
    /* ... */
  }
  async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    /* ... */
  }
  async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    /* ... */
  }
}
```

### MemoryPipelineStorage

In-memory implementation using Maps. Features:

- Blob deduplication by SHA-256 hash
- Reference counting for shared blobs
- Suitable for extension offscreen documents and testing

## Archive Format

### Structure

```
session.webblackbox (ZIP)
├── manifest.json           # Export metadata
├── events/
│   ├── C-000001.ndjson     # Event chunks (NDJSON)
│   └── ...
├── index/
│   ├── time.json           # Time-based chunk index
│   ├── req.json            # Request ID mapping
│   └── inv.json            # Full-text search index
├── blobs/
│   ├── sha256-<hash>.webp  # Binary blobs (screenshots, etc.)
│   └── ...
└── integrity/
    └── hashes.json         # SHA-256 hashes
```

### Encryption

```typescript
const result = await pipeline.exportBundle({
  passphrase: "my-secret-key"
});
```

When a passphrase is provided:

- **KDF**: PBKDF2 with SHA-256, 120,000 iterations, random salt
- **Encryption**: AES-GCM with per-file random IVs
- **Scope**: Event chunks, indexes, and blobs are encrypted
- **Manifest**: Remains unencrypted (contains encryption metadata)
- **Integrity**: SHA-256 hashes computed on encrypted content

### Archive Creation

```typescript
import { createWebBlackboxArchive } from "@webblackbox/pipeline";

const { bytes, integrity } = await createWebBlackboxArchive(
  {
    manifest,
    chunks, // StoredChunk[]
    timeIndex, // ChunkTimeIndexEntry[]
    requestIndex, // RequestIndexEntry[]
    invertedIndex, // InvertedIndexEntry[]
    blobs // StoredBlob[]
  },
  {
    passphrase: "optional"
  }
);
```
