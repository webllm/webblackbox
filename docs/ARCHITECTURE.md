# Architecture

This document describes the high-level architecture of WebBlackbox, the design decisions behind it, and how the components interact.

## System Overview

WebBlackbox is a three-tier system:

1. **Recording Tier** — A Chrome extension captures events from multiple sources
2. **Processing Tier** — A pipeline chunks, compresses, indexes, and archives events
3. **Playback Tier** — A Player SDK and React UI provide analysis and visualization

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RECORDING TIER                              │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ Injected │→ │ Content  │→ │  Service   │← │   CDP Router     │ │
│  │  Script  │  │  Script  │  │  Worker    │  │ (chrome.debugger) │ │
│  └──────────┘  └──────────┘  └─────┬──────┘  └──────────────────┘ │
│                                    │                                │
│                              ┌─────▼──────┐                        │
│                              │  Recorder  │                        │
│                              │ (normalize │                        │
│                              │  + buffer) │                        │
│                              └─────┬──────┘                        │
└────────────────────────────────────┼────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────┐
│                        PROCESSING TIER                              │
│                                                                     │
│  ┌───────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  Chunker  │→ │  Codec  │→ │ Indexer   │→ │ Archive Exporter │  │
│  └───────────┘  └─────────┘  └──────────┘  └────────┬─────────┘  │
│                                                      │             │
│  ┌────────────────────────────┐                      │             │
│  │  Blob Storage (SHA-256    │                      │             │
│  │  dedup, ref counting)     │──────────────────────┘             │
│  └────────────────────────────┘                                    │
└──────────────────────────────────────────┬─────────────────────────┘
                                           │
                                    .webblackbox
                                     ZIP archive
                                           │
┌──────────────────────────────────────────▼─────────────────────────┐
│                         PLAYBACK TIER                               │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    Player SDK                              │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │    │
│  │  │  Query   │ │ Network  │ │   DOM    │ │    Code     │  │    │
│  │  │  Engine  │ │ Waterfall│ │  Differ  │ │  Generator  │  │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    Player UI (React)                        │    │
│  │  Timeline │ Network │ Console │ Storage │ DOM │ Perf       │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Design Principles

### 1. Protocol-First

All data flows through the `@webblackbox/protocol` package. Every event, message, and configuration has a corresponding TypeScript type and Zod validation schema. This ensures:

- **Type safety** across all packages at compile time
- **Runtime validation** at system boundaries
- **Forward compatibility** via the `v: 1` protocol version field
- **Strict schemas** prevent accidental data corruption

### 2. Event Sourcing

WebBlackbox uses an event-sourced architecture. All state changes are captured as immutable events with monotonic timestamps. The ring buffer and archive are append-only event logs that can be replayed to reconstruct session state at any point in time.

### 3. Content-Addressable Storage

Binary data (screenshots, DOM snapshots, response bodies) is stored as blobs identified by SHA-256 hashes. This provides:

- **Automatic deduplication** — Identical content is stored once
- **Integrity verification** — Hashes are checked on read
- **Reference counting** — Blobs are cleaned up when no longer referenced

### 4. Privacy by Default

Sensitive data is redacted before it enters the pipeline:

- Headers like `Authorization`, `Cookie`, and `Set-Cookie` are scrubbed
- Body content matching patterns like `password`, `token`, `secret` is masked
- DOM elements matching CSS selectors like `input[type='password']` are blocked
- Optional SHA-256 hashing preserves correlation analysis without exposing raw values

### 5. Separation of Concerns

Each package has a single responsibility:

| Package      | Responsibility                       |
| ------------ | ------------------------------------ |
| `protocol`   | Data definitions and validation      |
| `recorder`   | Event collection and normalization   |
| `pipeline`   | Event processing and archival        |
| `player-sdk` | Session analysis and code generation |
| `cdp-router` | Chrome DevTools Protocol management  |

## Recording Architecture

### Event Sources

WebBlackbox captures events from three sources:

#### CDP (Chrome DevTools Protocol)

- **Network domain** — HTTP requests, responses, WebSocket frames, failures
- **Runtime domain** — JavaScript exceptions, console API calls
- **Log domain** — Browser log entries
- **Page domain** — Navigation events, frame lifecycle

#### Content Script

- **User interactions** — click, dblclick, keydown, input, submit, scroll, mousemove, focus, blur, resize, visibilitychange
- **DOM mutations** — Batched MutationObserver records
- **DOM snapshots** — Full page snapshots at intervals
- **Screenshots** — SnapDOM captures on idle and after actions

#### Injected Script

- **Console** — Intercepts `console.log/warn/error/etc.` calls
- **Storage** — Monitors localStorage, sessionStorage, and IndexedDB operations
- **Network/Error hooks** — Captures fetch/XHR lifecycle plus page/runtime errors

### Event Normalization

Raw events from all three sources are normalized by the `DefaultEventNormalizer` into a consistent `WebBlackboxEvent` format. This unified representation enables downstream processing to be source-agnostic.

### Ring Buffer

Events are stored in a time-windowed ring buffer (default: 10 minutes). When the buffer exceeds its time window, the oldest events are automatically pruned. This keeps memory usage bounded while always preserving recent context.

### Action Span Tracking

User actions (clicks, form submissions, navigation) create "action spans" — time windows (default: 1500ms) that group related events. Network requests initiated during an action span are linked via `ref.act`, enabling cause-effect analysis in the player.

### Freeze Policy

The recorder evaluates freeze conditions on every event:

- **Error freeze** — Uncaught JavaScript exceptions or unhandled promise rejections
- **Network freeze** — Network request failure rate exceeds threshold
- **Performance freeze** — Long tasks exceeding 200ms
- **Manual freeze** — User-triggered markers (Ctrl+Shift+M)

When a freeze is triggered, the ring buffer contents are preserved, providing full context around the issue.

## Processing Architecture

### Chunking

Events are grouped into size-bounded chunks (default: 512KB). Each chunk is:

1. Serialized as NDJSON (newline-delimited JSON)
2. Encoded as NDJSON (`chunkCodec` currently resolves to `none`)
3. Hashed with SHA-256 for integrity
4. Stored with metadata (timestamps, event count, byte length)

### Indexing

Three indexes are built for efficient querying:

1. **Time Index** — Maps timestamp ranges to chunks for O(log n) time-based lookup
2. **Request Index** — Maps network request IDs to event IDs for request tracing
3. **Inverted Index** — Maps searchable terms to event IDs for full-text search

### Blob Storage

Binary content is stored as content-addressable blobs:

```
Event: screen.screenshot { shotId: "abc", ... }
  → Blob: sha256("...") = "7f83b1657ff1..."
  → Storage: blobs/sha256-7f83b1657ff1....webp
```

Blobs are deduplicated by hash and reference-counted. The `MemoryPipelineStorage` implementation uses Maps for the extension's offscreen document context.

### Archive Export

The export process creates a `.webblackbox` ZIP file:

1. All chunks are collected from storage
2. Indexes are finalized
3. Blobs are included
4. Manifest is generated with metadata and stats
5. Integrity hashes are computed for all files
6. Optional AES-GCM encryption is applied
7. Everything is packaged into a ZIP archive

## Playback Architecture

### Archive Loading

1. ZIP is extracted
2. Manifest is parsed and validated
3. If encrypted, encryption metadata is extracted
4. Chunks are decrypted (if needed) and decoded
5. Indexes are loaded
6. Blobs are kept in the archive for on-demand retrieval

### Query Engine

The Player SDK provides a flexible query API that filters events by:

- **Time range** — Monotonic timestamp start/end
- **Event types** — Array of specific types
- **Levels** — debug, info, warn, error
- **Text** — Full-text search using the inverted index
- **Request ID** — Network request correlation

### Analysis Capabilities

| Analysis           | Method                         | Description                            |
| ------------------ | ------------------------------ | -------------------------------------- |
| Network waterfall  | `getNetworkWaterfall()`        | Complete request/response timeline     |
| Realtime streams   | `getRealtimeNetworkTimeline()` | WebSocket and SSE analysis             |
| Storage operations | `getStorageTimeline()`         | All storage operations chronologically |
| DOM diffing        | `getDomDiffTimeline()`         | Changes between DOM snapshots          |
| Performance        | `getPerformanceArtifacts()`    | CPU profiles, heap snapshots, vitals   |
| Action spans       | `buildDerived()`               | User action analysis with stats        |
| Session comparison | `compareWith()`                | Diff two sessions                      |

### Code Generation

The Player SDK can generate executable code from captured data:

- **curl** — Replay any HTTP request from the command line
- **fetch** — Replay any request in JavaScript
- **HAR** — Standard HTTP Archive for tool interop
- **Playwright test** — Automated test script from user actions
- **Playwright mock** — Test script with captured response mocks
- **Bug report** — Markdown-formatted report with context
- **GitHub/Jira issues** — Pre-filled issue templates

## Extension Contexts

The Chrome extension operates across multiple execution contexts with strict message-passing boundaries:

```
Page World          Extension World         Background
┌──────────┐       ┌──────────────┐        ┌──────────────┐
│ Injected │       │   Content    │        │   Service    │
│  Script  │──────→│   Script     │───────→│   Worker     │
│          │       │              │        │              │
│ window.  │       │ chrome.      │        │ CDP Router   │
│ postMsg  │       │ runtime.     │        │ Recorder     │
│          │       │ connect/port │        │              │
└──────────┘       └──────────────┘        └──────┬───────┘
                                                  │
                                           ┌──────▼───────┐
                                           │  Offscreen   │
                                           │  Document    │
                                           │  (Pipeline)  │
                                           └──────────────┘
```

- **Page World** → Extension: `window.postMessage` (injected → content)
- **Extension** → Background: `chrome.runtime.connect` + `port.postMessage` (content → SW)
- **Background** → Offscreen: `chrome.runtime.connect` + `port.postMessage` (SW ↔ offscreen)
- **CDP**: `chrome.debugger.sendCommand/onEvent` (SW ↔ browser)

## Security Considerations

### Data Protection

- Sensitive headers are redacted before entering the pipeline
- Body content is pattern-matched and scrubbed
- DOM elements with sensitive selectors are masked
- Archives can be encrypted with AES-GCM

### Encryption Details

- **Algorithm**: AES-GCM (256-bit key)
- **Key Derivation**: PBKDF2 with SHA-256, 120,000 iterations
- **Salt**: Random 16-byte salt per archive
- **IV**: Random 12-byte IV per file within the archive
- **Scope**: Event chunks, indexes, and blobs; manifest remains readable

### Permission Model

- The extension requires `debugger` permission for CDP access
- `<all_urls>` host permission is needed for content script injection
- Users must explicitly grant permissions during installation
