# WebBlackbox

**A flight recorder and time-travel debugger for web applications.** WebBlackbox is a Chrome extension that continuously captures comprehensive session data — user interactions, network traffic, DOM mutations, console logs, storage operations, performance metrics, and screenshots — then exports encrypted, portable archives for offline playback and analysis.

Think of it as a "black box" for your web app: always recording in the background, so when something goes wrong, you have the full context to understand what happened and why.

## Key Features

- **Continuous Recording** — Runs silently as a Chrome extension, capturing events via the Chrome DevTools Protocol (CDP) and content script injection
- **57 Event Types (current)** — User interactions, network requests/responses, WebSocket/SSE streams, DOM mutations, console logs, storage operations, performance metrics, and more
- **Two Capture Modes** — `lite` for minimal overhead, `full` for comprehensive debugging
- **Ring Buffer** — Configurable circular buffer (default 10 minutes) keeps memory usage bounded while preserving recent context
- **Privacy-First Redaction** — Built-in header, cookie, and body pattern masking with configurable CSS selector blocking
- **Encrypted Archives** — AES-GCM encryption with PBKDF2 key derivation for secure sharing
- **Rich Playback** — React-based player with timeline, network waterfall, console panel, storage inspector, and DOM diff analysis
- **Export Capabilities** — Generate bug reports, HAR files, Playwright test scripts, curl/fetch commands, and GitHub/Jira issue templates
- **MCP Integration** — Model Context Protocol server for AI-assisted session analysis
- **Extensible Plugin System** — Custom recorder plugins with hooks for event processing

## Architecture

WebBlackbox is a TypeScript monorepo organized into three tiers:

```
                    ┌──────────────────────────────────────────────────┐
                    │              Chrome Extension                    │
                    │                                                  │
                    │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
                    │  │ Injected │→ │ Content  │→ │   Service    │  │
                    │  │  Script  │  │  Script  │  │   Worker     │  │
                    │  └──────────┘  └──────────┘  └──────┬───────┘  │
                    │       console, storage    user, DOM   │  CDP     │
                    │                                      ↓          │
                    │                              ┌──────────────┐   │
                    │                              │  Offscreen   │   │
                    │                              │  (Pipeline)  │   │
                    │                              └──────┬───────┘   │
                    └─────────────────────────────────────┼───────────┘
                                                         │
                                                         ↓
                                                  .webblackbox
                                                   ZIP archive
                                                         │
                                                         ↓
                    ┌──────────────────────────────────────────────────┐
                    │              Player (React UI)                   │
                    │                                                  │
                    │  ┌──────────────┐  ┌────────────────────────┐   │
                    │  │  Player SDK  │  │  Timeline │ Network    │   │
                    │  │  (analysis)  │→ │  Console  │ Storage    │   │
                    │  └──────────────┘  │  DOM Diff │ Perf       │   │
                    │                    └────────────────────────┘   │
                    └──────────────────────────────────────────────────┘
```

### Recording Data Flow

1. **Injected Script** captures console logs, storage operations via `postMessage`
2. **Content Script** receives injected events + captures user interactions and DOM events
3. **Service Worker** receives all events, normalizes them through the recorder, routes to the pipeline
4. **Offscreen Document** runs the pipeline: chunking, compression, indexing, and storage
5. **Export** generates a `.webblackbox` ZIP archive with manifest, events (NDJSON), indexes, and blobs

### Playback Data Flow

1. User opens a `.webblackbox` archive in the Player
2. Player SDK decrypts (if encrypted), decompresses, and loads events/indexes
3. React UI queries the SDK for timeline events, network waterfalls, console entries, screenshots, and performance data
4. Interactive panels render the session for analysis

## Project Structure

```
webblackbox/
├── apps/
│   ├── extension/          # Chrome extension (Manifest V3)
│   ├── player/             # React-based session playback UI
│   └── mcp-server/         # Model Context Protocol server
├── packages/
│   ├── protocol/           # Event types, schemas, validation (Zod)
│   ├── recorder/           # Event recording, normalization, ring buffer
│   ├── pipeline/           # Chunking, compression, indexing, export
│   ├── player-sdk/         # Playback, querying, analysis APIs
│   ├── cdp-router/         # Chrome DevTools Protocol routing
│   ├── mcp-core/           # MCP utility functions
│   └── config-typescript/  # Shared TypeScript configuration
├── turbo.json              # Turbo monorepo orchestration
├── pnpm-workspace.yaml     # pnpm workspace config
└── package.json            # Root dependencies & scripts
```

### Package Dependency Graph

```
extension ─────┬──→ cdp-router ──→ protocol
               ├──→ recorder ────→ protocol
               ├──→ pipeline ────→ protocol
               └──→ protocol

player ────────┬──→ player-sdk ──→ protocol
               └──→ protocol

mcp-server ────→ mcp-core
```

## Packages

### `@webblackbox/protocol`

The foundational package defining all data types, Zod validation schemas, constants, and message formats shared across the entire system.

**Event Types** — 57 event types organized by category:

| Category        | Events                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meta**        | `meta.session.start`, `meta.session.end`, `meta.config`                                                                                                                                 |
| **System**      | `sys.debugger.attach`, `sys.debugger.detach`, `sys.notice`                                                                                                                              |
| **Navigation**  | `nav.commit`, `nav.history.push`, `nav.history.replace`, `nav.hash`, `nav.reload`                                                                                                       |
| **User**        | `user.click`, `user.dblclick`, `user.keydown`, `user.input`, `user.submit`, `user.scroll`, `user.mousemove`, `user.focus`, `user.blur`, `user.marker`, `user.visibility`, `user.resize` |
| **Console**     | `console.entry`                                                                                                                                                                         |
| **Errors**      | `error.exception`, `error.unhandledrejection`, `error.resource`, `error.assert`                                                                                                         |
| **Network**     | `network.request`, `network.response`, `network.finished`, `network.failed`, `network.redirect`, `network.body`                                                                         |
| **WebSocket**   | `network.ws.open`, `network.ws.frame`, `network.ws.close`                                                                                                                               |
| **SSE**         | `network.sse.message`                                                                                                                                                                   |
| **DOM**         | `dom.mutation.batch`, `dom.snapshot`, `dom.diff`, `dom.rrweb.event`                                                                                                                     |
| **Screen**      | `screen.screenshot`, `screen.viewport`                                                                                                                                                  |
| **Storage**     | `storage.cookie.snapshot`, `storage.local.snapshot`, `storage.local.op`, `storage.session.op`, `storage.idb.op`, `storage.idb.snapshot`, `storage.cache.op`, `storage.sw.lifecycle`     |
| **Performance** | `perf.vitals`, `perf.longtask`, `perf.trace`, `perf.cpu.profile`, `perf.heap.snapshot`                                                                                                  |

**Core Event Structure:**

```typescript
type WebBlackboxEvent<TData = unknown> = {
  v: 1; // Protocol version
  sid: string; // Session ID
  tab: number; // Tab ID
  nav?: string; // Navigation ID
  frame?: string; // Frame ID
  t: number; // Wall-clock timestamp (ms)
  mono: number; // Monotonic timestamp (ms)
  dt?: number; // Duration (ms)
  type: WebBlackboxEventType; // Event type
  id: string; // Unique event ID
  lvl?: EventLevel; // debug | info | warn | error
  ref?: EventReference; // Cross-references (action, request, etc.)
  data: TData; // Event-type-specific payload
};
```

### `@webblackbox/recorder`

Collects and normalizes raw events from multiple sources (CDP, content scripts, system) into the unified `WebBlackboxEvent` format.

- **WebBlackboxRecorder** — Main recorder class with `ingest()`, ring buffer management, and plugin support
- **EventRingBuffer** — Time-windowed circular buffer with configurable duration
- **DefaultEventNormalizer** — Maps CDP and content script events to normalized payloads
- **ActionSpanTracker** — Tracks user action spans (click, submit, nav) and links related events within time windows
- **FreezePolicy** — Evaluates freeze conditions (errors, network failures, long tasks, manual markers)
- **Redaction** — Recursive payload redaction with header, cookie, body pattern matching and optional hash-based masking
- **Plugin System** — Extensible via `RecorderPlugin` interface with `onRawEvent` and `onEvent` hooks
  - `createRouteContextPlugin()` — Track route context per stream
  - `createErrorFingerprintPlugin()` — Generate error fingerprints
  - `createAiRootCausePlugin()` — Analyze error root causes

### `@webblackbox/pipeline`

Processes recorded events into portable, indexed archives.

- **FlightRecorderPipeline** — Main pipeline orchestrator: ingestion, chunking, blob storage, index building, and archive export
- **EventChunker** — Groups events into size-bounded chunks with configurable codecs
- **EventIndexer** — Builds time-based, request-based, and inverted text search indexes
- **Codec** — Encode/decode events as NDJSON with compression support (brotli, zstd, gzip)
- **Archive Export** — Creates `.webblackbox` ZIP archives with optional AES-GCM encryption
- **PipelineStorage** — Abstract storage interface with `MemoryPipelineStorage` implementation
- **SHA-256** — Content-addressable blob deduplication

### `@webblackbox/player-sdk`

Client-side SDK for opening, querying, and analyzing recorded sessions.

- **WebBlackboxPlayer** — Main player class with `open()` static method for loading archives
- **Event Querying** — Rich query API with time range, event type, level, text search, and request ID filtering
- **Network Waterfall** — Reconstruct complete request/response timings with headers and bodies
- **Realtime Network Timeline** — WebSocket and SSE stream analysis
- **Storage Timeline** — Track cookie, localStorage, sessionStorage, IndexedDB, and cache operations
- **DOM Diff** — Compare DOM snapshots to find added, removed, and changed elements
- **Session Comparison** — Compare two sessions by event counts, error rates, request patterns
- **Action Span Analysis** — Derived views with action spans and aggregate statistics
- **Performance Artifacts** — CPU profiles, heap snapshots, traces, Web Vitals, long tasks

**Code Generation:**

| Method                                   | Output                                         |
| ---------------------------------------- | ---------------------------------------------- |
| `generateCurl(reqId)`                    | curl command for a captured request            |
| `generateFetch(reqId)`                   | fetch() call for a captured request            |
| `exportHar(range?)`                      | HAR (HTTP Archive) format export               |
| `generateBugReport(options?)`            | Markdown bug report                            |
| `generatePlaywrightScript(options?)`     | Playwright test script                         |
| `generatePlaywrightMockScript(options?)` | Playwright mock script with captured responses |
| `generateGitHubIssueTemplate(options?)`  | GitHub issue template                          |
| `generateJiraIssueTemplate(options?)`    | Jira issue template                            |

### `@webblackbox/cdp-router`

Manages Chrome DevTools Protocol connections for the extension.

- **CdpRouter** — Interface for attaching/detaching debugger targets, sending CDP commands, and receiving events
- **DefaultCdpRouter** — Full implementation with target tracking (tabs, iframes, workers, service workers)
- **Transport Layer** — Abstraction over `chrome.debugger` API with `createChromeDebuggerTransport()`
- **Baseline Domains** — Auto-enables Network, Runtime, Log, and Page domains
- **Auto-Attach** — Automatic attachment to child targets (iframes, workers)

### `@webblackbox/mcp-core`

Utility functions for the Model Context Protocol server.

### Apps

#### Chrome Extension (`apps/extension`)

Manifest V3 Chrome extension with:

- **Service Worker** — Background event coordination and CDP management
- **Content Script** — Injects at `document_start` on all pages for user/DOM event capture
- **Injected Script** — Web-accessible script for console and storage interception
- **Offscreen Document** — Runs the pipeline in an offscreen context for processing
- **Popup** — Quick controls for starting/stopping recording
- **Options Page** — Configuration UI
- **Sessions Page** — Browse and manage recorded sessions
- **Keyboard Shortcut** — `Ctrl+Shift+M` / `Cmd+Shift+M` to create user markers

#### Player (`apps/player`)

React 19 application for session playback with:

- Interactive event timeline
- Network waterfall panel
- Console log viewer
- Storage operations inspector
- DOM snapshot diff viewer
- Performance metrics dashboard
- Screenshot trail with pointer position overlay

#### MCP Server (`apps/mcp-server`)

Model Context Protocol server for AI-assisted session analysis.

## Technology Stack

| Component       | Technology                       |
| --------------- | -------------------------------- |
| Language        | TypeScript 5.9                   |
| Runtime         | Node.js 22+                      |
| Package Manager | pnpm 10.28                       |
| Monorepo        | Turborepo                        |
| Bundler         | tsup (esbuild)                   |
| Testing         | Vitest 4.0                       |
| Validation      | Zod 4.1                          |
| UI Framework    | React 19                         |
| Linting         | ESLint 9, Prettier 3.6           |
| Git Hooks       | Husky, lint-staged               |
| Versioning      | Changesets                       |
| Archive Format  | JSZip                            |
| Screenshots     | html2canvas-pro                  |
| Encryption      | Web Crypto API (AES-GCM, PBKDF2) |

## Getting Started

### Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** 10.28.1

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd webblackbox

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Development

```bash
# Run all packages in development mode (parallel watch)
pnpm dev

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Lint
pnpm lint

# Format code
pnpm format
```

### Loading the Chrome Extension

1. Build the extension:
   ```bash
   cd apps/extension
   pnpm build
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked** and select the `apps/extension/build` directory
5. The WebBlackbox icon will appear in your browser toolbar

### Using the Extension

1. **Start Recording** — Click the WebBlackbox extension icon and start a session
2. **Browse Normally** — The extension records events in the background using a ring buffer
3. **Mark Events** — Press `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac) to create user markers at key moments
4. **Export** — Click the extension icon and export to download a `.webblackbox` archive
5. **Playback** — Open the archive in the Player app for analysis

## Archive Format

WebBlackbox exports sessions as `.webblackbox` files (ZIP archives) with the following structure:

```
session.webblackbox (ZIP)
├── manifest.json           # Export metadata, stats, encryption info
├── events/
│   ├── C-000001.ndjson     # Event chunk 1 (NDJSON, optionally compressed)
│   ├── C-000002.ndjson     # Event chunk 2
│   └── ...
├── index/
│   ├── time.json           # Time-based chunk index
│   ├── req.json            # Request ID → event ID mapping
│   └── inv.json            # Full-text search index
├── blobs/
│   ├── sha256-<hash>.webp  # Screenshots
│   ├── sha256-<hash>.json  # DOM snapshots, network bodies
│   └── ...
└── integrity/
    └── hashes.json         # SHA-256 hashes for all files
```

### Encryption

Archives can be encrypted with AES-GCM:

- **Key Derivation**: PBKDF2 with SHA-256, 120,000 iterations
- **Encryption**: AES-GCM with per-file initialization vectors
- **Scope**: Event chunks, indexes, and blobs are encrypted; manifest and integrity remain readable

## Configuration

### Recorder Configuration

```typescript
const config: RecorderConfig = {
  mode: "lite", // "lite" | "full"
  ringBufferMinutes: 10, // Ring buffer duration
  freezeOnError: true, // Auto-freeze on uncaught errors
  freezeOnNetworkFailure: true, // Auto-freeze on network failures
  freezeOnLongTaskSpike: true, // Auto-freeze on long task spikes

  sampling: {
    mousemoveHz: 20, // Mouse move capture frequency
    scrollHz: 15, // Scroll capture frequency
    domFlushMs: 100, // DOM mutation flush interval
    screenshotIdleMs: 8000, // Screenshot capture on idle
    snapshotIntervalMs: 20000, // DOM snapshot interval
    actionWindowMs: 1500, // Action span window
    bodyCaptureMaxBytes: 262144 // Max request/response body size (256KB)
  },

  redaction: {
    redactHeaders: [
      // Headers to redact
      "authorization",
      "cookie",
      "set-cookie"
    ],
    redactCookieNames: [
      // Cookie names to redact
      "token",
      "session",
      "auth"
    ],
    redactBodyPatterns: [
      // Body patterns to redact
      "password",
      "token",
      "secret",
      "otp"
    ],
    blockedSelectors: [
      // CSS selectors to mask in DOM
      ".secret",
      "[data-sensitive]",
      "input[type='password']"
    ],
    hashSensitiveValues: true // Hash instead of replacing with [REDACTED]
  },

  sitePolicies: [] // Per-origin capture policies
};
```

### Site Capture Policies

Override capture behavior per origin:

```typescript
const policy: SiteCapturePolicy = {
  originPattern: "https://api.example.com",
  mode: "full",
  enabled: true,
  allowBodyCapture: true,
  bodyMimeAllowlist: ["application/json"],
  pathAllowlist: ["/api/v1/*"],
  pathDenylist: ["/api/v1/auth/*"]
};
```

## API Reference

### Player SDK

```typescript
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

// Open an archive
const player = await WebBlackboxPlayer.open(archiveBytes, {
  passphrase: "optional-password"
});

// Query events
const errors = player.query({
  types: ["error.exception", "error.unhandledrejection"],
  levels: ["error"],
  range: { monoStart: 0, monoEnd: 60000 }
});

// Search events by text
const results = player.search("TypeError", 50);

// Network analysis
const waterfall = player.getNetworkWaterfall();
const wsEvents = player.getRealtimeNetworkTimeline();

// Storage analysis
const storageOps = player.getStorageTimeline();

// DOM analysis
const snapshots = player.getDomSnapshots();
const diffs = await player.getDomDiffTimeline();

// Performance analysis
const artifacts = player.getPerformanceArtifacts();

// Code generation
const curl = player.generateCurl("request-id");
const har = player.exportHar();
const bugReport = player.generateBugReport();
const playwrightTest = player.generatePlaywrightScript();

// Session comparison
const comparison = player.compareWith(otherPlayer);
```

### Recorder

```typescript
import { WebBlackboxRecorder } from "@webblackbox/recorder";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

const recorder = new WebBlackboxRecorder(DEFAULT_RECORDER_CONFIG, {
  onEvent: (event) => console.log("Recorded:", event.type),
  onFreeze: (reason, event) => console.log("Frozen:", reason)
});

// Ingest raw events
const result = recorder.ingest(rawEvent);

// Snapshot the ring buffer
const events = recorder.snapshotRingBuffer();
```

### Pipeline

```typescript
import { FlightRecorderPipeline, MemoryPipelineStorage } from "@webblackbox/pipeline";

const pipeline = new FlightRecorderPipeline({
  session: metadata,
  storage: new MemoryPipelineStorage(),
  maxChunkBytes: 512 * 1024,
  chunkCodec: "none"
});

await pipeline.start();

// Ingest events
for (const event of events) {
  await pipeline.ingest(event);
}

// Flush and export
await pipeline.flush();
const indexes = await pipeline.finalizeIndexes();
const { fileName, bytes } = await pipeline.exportBundle({
  passphrase: "optional-password"
});
```

## Protocol Versioning

All WebBlackbox data uses protocol version `1`. The version is embedded in every event (`v: 1`) and archive manifest (`protocolVersion: 1`), enabling future backwards-compatible evolution.

## Security & Privacy

- **Redaction by default** — Authorization headers, session cookies, and password fields are automatically redacted
- **Configurable masking** — Add custom patterns and CSS selectors for sensitive data
- **Hash-based masking** — Optionally hash sensitive values instead of replacing with `[REDACTED]` for correlation analysis without exposing raw values
- **Archive encryption** — AES-GCM with PBKDF2 key derivation (120,000 iterations) for secure sharing
- **Integrity verification** — SHA-256 checksums for all archive files
- **Minimal permissions** — Extension requests only the permissions necessary for CDP access and event capture

## Scripts

| Command                 | Description                             |
| ----------------------- | --------------------------------------- |
| `pnpm dev`              | Start all packages in watch mode        |
| `pnpm build`            | Build all packages (dependency-ordered) |
| `pnpm test`             | Run all tests                           |
| `pnpm typecheck`        | TypeScript type checking                |
| `pnpm lint`             | ESLint checks                           |
| `pnpm format`           | Format code with Prettier               |
| `pnpm format:check`     | Check code formatting                   |
| `pnpm changeset`        | Create a changeset for versioning       |
| `pnpm version-packages` | Apply changesets to bump versions       |
| `pnpm release`          | Publish packages                        |

## License

Private
