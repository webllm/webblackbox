<p align="center">
  <img src="logo.png" alt="WebBlackbox" width="128" height="128" />
</p>

<h1 align="center">WebBlackbox</h1>

<p align="center">
  <strong>A flight recorder and time-travel debugger for web applications.</strong>
  <br />
  <sub>Always recording. So when something goes wrong, you know exactly what happened — and why.</sub>
</p>

<p align="center">
  <a href="https://github.com/webllm/webblackbox/actions/workflows/ci.yml"><img src="https://github.com/webllm/webblackbox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/webblackbox"><img src="https://img.shields.io/npm/v/webblackbox.svg?color=f97316" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/webblackbox?color=374151" alt="License" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-≥22-339933?logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

---

WebBlackbox is a Chrome extension that continuously captures comprehensive session data — user interactions, network traffic, DOM mutations, console logs, storage operations, performance metrics, and screenshots — then exports encrypted, portable `.webblackbox` archives for offline playback and analysis.

Think of it as a **black box for your web app**: always recording in the background, so when something goes wrong, you have the full context to debug, reproduce, and fix it.

<br />

## Highlights

<table>
<tr>
<td width="50%">

**57 Event Types**
Captures user interactions, network requests/responses, WebSocket & SSE streams, DOM mutations, console logs, storage operations, performance metrics, and more — organized across 13 categories.

</td>
<td width="50%">

**Two Capture Modes**
`lite` for minimal page-thread overhead in production monitoring. `full` for comprehensive debugging with CDP-driven capture, DOM snapshots, and response body sampling.

</td>
</tr>
<tr>
<td>

**Privacy-First Redaction**
Built-in header, cookie, and body pattern masking with configurable CSS selector blocking. Optional hash-based anonymization preserves correlation analysis without exposing raw values.

</td>
<td>

**Encrypted Archives**
AES-GCM encryption with PBKDF2 key derivation (120K iterations). Per-file IVs, SHA-256 integrity checksums, and content-addressable blob deduplication.

</td>
</tr>
<tr>
<td>

**Rich Playback UI**
React-based player with interactive timeline, network waterfall, console panel, storage inspector, DOM diff viewer, screenshot trail with pointer overlay, and performance dashboard.

</td>
<td>

**Code Generation**
Export to HAR, Playwright test scripts, curl/fetch commands, markdown bug reports, and GitHub/Jira issue templates — all derived from captured session data.

</td>
</tr>
<tr>
<td>

**Ring Buffer**
Configurable circular buffer (default 10 min) keeps memory usage bounded while preserving recent context. Auto-freeze on errors, network failures, or long task spikes.

</td>
<td>

**MCP Integration**
Model Context Protocol server for AI-assisted session analysis — triage errors, query events, generate reports, compare sessions, and find root cause candidates.

</td>
</tr>
</table>

<br />

## Architecture

WebBlackbox is a TypeScript monorepo organized into three tiers — **Recording**, **Processing**, and **Playback** — with optional cloud collaboration:

```
                    ┌─────────────────────────────────────────────────┐
                    │              Chrome Extension                   │
                    │                                                 │
                    │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
                    │  │ Injected │→ │ Content  │→ │   Service    │  │
                    │  │  Script  │  │  Script  │  │   Worker     │  │
                    │  └──────────┘  └──────────┘  └──────┬───────┘  │
                    │       console, storage    user, DOM  │  CDP     │
                    │                                      ↓          │
                    │                               ┌──────────────┐  │
                    │                               │  Offscreen   │  │
                    │                               │  (Pipeline)  │  │
                    │                               └──────┬───────┘  │
                    └──────────────────────────────────────┼──────────┘
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
3. **Service Worker** normalizes events through the recorder, routes to the pipeline
4. **Offscreen Document** runs the pipeline: chunking, indexing, compression, and storage
5. **Export** generates a `.webblackbox` ZIP archive with manifest, events (NDJSON), indexes, and blobs

### Playback Data Flow

1. User opens a `.webblackbox` archive in the Player
2. Player SDK decrypts (if encrypted), decompresses, and loads events/indexes
3. React UI queries the SDK for timeline events, network waterfalls, console entries, screenshots, and performance data
4. Interactive panels render the session for analysis

<br />

## Project Structure

```
webblackbox/
├── apps/
│   ├── extension/          # Chrome extension (Manifest V3)
│   ├── player/             # React-based session playback UI
│   ├── mcp-server/         # Model Context Protocol server
│   └── share-server/       # Optional cloud share and metadata index service
├── packages/
│   ├── protocol/           # Event types, schemas, validation (Zod)
│   ├── recorder/           # Event recording, normalization, ring buffer
│   ├── pipeline/           # Chunking, indexing, export
│   ├── web-sdk/            # Browser lite capture SDK (published as `webblackbox`)
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
               ├──→ webblackbox ─┬──→ recorder ───→ protocol
               │                 ├──→ pipeline ───→ protocol
               │                 └──→ protocol
               └──→ protocol

player ────────┬──→ player-sdk ──→ protocol
               └──→ protocol

mcp-server ────→ mcp-core

share-server ──→ player-sdk ──→ protocol
```

<br />

## Getting Started

### Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** 10.28.1

### Installation

```bash
git clone https://github.com/webllm/webblackbox.git
cd webblackbox
pnpm install
pnpm build
```

### Loading the Chrome Extension

1. Build the extension:
   ```bash
   cd apps/extension && pnpm build
   ```
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select `apps/extension/build`

### Using the Extension

| Step       | Action                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| **Record** | Click the WebBlackbox icon in the toolbar to start a session                         |
| **Browse** | Navigate your app normally — events are captured in the background via a ring buffer |
| **Mark**   | Press `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac) to create user markers at key moments    |
| **Export** | Click the icon again and export to download a `.webblackbox` archive                 |
| **Replay** | Open the archive in the Player app for full session analysis                         |

### Development

```bash
pnpm dev            # Watch mode for all packages
pnpm test           # Run all tests
pnpm typecheck      # TypeScript type checking
pnpm lint           # ESLint checks
pnpm format         # Format with Prettier
```

<br />

## Event Types

57 event types organized across 13 categories:

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

### Core Event Structure

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
  type: string; // Event type
  id: string; // Unique event ID
  lvl?: string; // debug | info | warn | error
  ref?: object; // Cross-references (action, request, etc.)
  data: TData; // Event-type-specific payload
};
```

<br />

## Packages

### `@webblackbox/protocol`

The foundational package defining all data types, Zod validation schemas, constants, and message formats shared across the entire system.

### `@webblackbox/recorder`

Collects and normalizes raw events from multiple sources (CDP, content scripts, system) into the unified `WebBlackboxEvent` format.

- **WebBlackboxRecorder** — Main class with `ingest()`, ring buffer management, and plugin support
- **EventRingBuffer** — Time-windowed circular buffer with configurable duration
- **DefaultEventNormalizer** — Maps CDP and content script events to normalized payloads
- **ActionSpanTracker** — Tracks user action spans and links related events within time windows
- **FreezePolicy** — Evaluates freeze conditions (errors, network failures, long tasks, manual markers)
- **Redaction** — Recursive payload redaction with header, cookie, body pattern matching
- **Plugin System** — Extensible via `RecorderPlugin` with `onRawEvent` and `onEvent` hooks

### `@webblackbox/pipeline`

Processes recorded events into portable, indexed archives.

- **FlightRecorderPipeline** — Orchestrator: ingestion, chunking, blob storage, index building, and archive export
- **EventChunker** — Groups events into size-bounded chunks with configurable codecs
- **EventIndexer** — Builds time-based, request-based, and inverted text search indexes
- **Codec** — Encode/decode with chunk codecs (`none`, `gzip`, `br`, `zst`)
- **Archive Export** — Creates `.webblackbox` ZIP archives with optional AES-GCM encryption
- **SHA-256** — Content-addressable blob deduplication

### `webblackbox` (Web SDK)

Browser-side lite capture SDK published as the `webblackbox` npm package.

- **WebBlackboxLiteSdk** — Start/stop/flush/export `.webblackbox` archives directly in-page
- **LiteCaptureAgent** — Reusable capture agent for DOM/input/screenshot/storage collection
- **installInjectedLiteCaptureHooks** — Runtime hooks for console/network/storage/error capture

### `@webblackbox/player-sdk`

Client-side SDK for opening, querying, and analyzing recorded sessions.

- **WebBlackboxPlayer** — Main class with `open()` static method for loading archives
- **Event Querying** — Rich query API with time range, type, level, text search, and request ID filtering
- **Network Waterfall** — Reconstruct complete request/response timings with headers and bodies
- **Realtime Network Timeline** — WebSocket and SSE stream analysis
- **Storage Timeline** — Track cookie, localStorage, sessionStorage, IndexedDB, and cache operations
- **DOM Diff** — Compare DOM snapshots to find added, removed, and changed elements
- **Session Comparison** — Compare two sessions by event counts, error rates, request patterns

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

- **CdpRouter** — Interface for attaching/detaching debugger targets, sending CDP commands, receiving events
- **DefaultCdpRouter** — Full implementation with target tracking (tabs, iframes, workers, service workers)
- **Transport Layer** — Abstraction over `chrome.debugger` API
- **Auto-Attach** — Automatic attachment to child targets (iframes, workers)

### `@webblackbox/mcp-core`

Utility functions for the Model Context Protocol server.

<br />

## Apps

### Chrome Extension

Manifest V3 Chrome extension with:

- **Service Worker** — Background event coordination and CDP management
- **Content Script** — Injects at `document_start` for user/DOM event capture
- **Injected Script** — Web-accessible script for console and storage interception
- **Offscreen Document** — Runs the pipeline in an offscreen context for processing
- **Popup** — Quick controls for starting/stopping recording
- **Options Page** — Configuration UI for capture modes, redaction, and site policies
- **Sessions Page** — Browse and manage recorded sessions

### Player

React 19 application for session playback with:

- Interactive event timeline
- Network waterfall panel
- Console log viewer
- Storage operations inspector
- DOM snapshot diff viewer
- Performance metrics dashboard
- Screenshot trail with pointer position overlay

### MCP Server

Model Context Protocol server exposing tools for AI-assisted analysis:

`list_archives` · `session_summary` · `query_events` · `network_issues` · `generate_bug_report` · `compare_sessions`

### Share Server

Optional HTTP server for cloud collaboration — accepts encrypted archive uploads, generates read-only share links with redacted server-side metadata.

<br />

## Archive Format

Sessions are exported as `.webblackbox` files (ZIP archives):

```
session.webblackbox (ZIP)
├── manifest.json           # Export metadata, stats, encryption info
├── events/
│   ├── C-000001.ndjson     # Event chunk (NDJSON)
│   ├── C-000002.ndjson
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

**Encryption** — Archives can be encrypted with AES-GCM. Key derivation uses PBKDF2 with SHA-256 and 120,000 iterations. Event chunks, indexes, and blobs are encrypted; manifest and integrity remain readable.

<br />

## Configuration

### Recorder Configuration

```typescript
const config: RecorderConfig = {
  mode: "lite", // 'lite' | 'full'
  ringBufferMinutes: 10, // Ring buffer duration
  freezeOnError: true, // Auto-freeze on uncaught errors
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true,

  sampling: {
    mousemoveHz: 20, // Mouse move capture frequency
    scrollHz: 15, // Scroll capture frequency
    domFlushMs: 100, // DOM mutation flush interval
    screenshotIdleMs: 8000, // Screenshot capture on idle
    snapshotIntervalMs: 20000, // DOM snapshot interval
    actionWindowMs: 1500, // Action span window
    bodyCaptureMaxBytes: 262144 // Max body size (256KB)
  },

  redaction: {
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    redactCookieNames: ["token", "session", "auth"],
    redactBodyPatterns: ["password", "token", "secret", "otp"],
    blockedSelectors: [".secret", "[data-sensitive]", "input[type='password']"],
    hashSensitiveValues: true // Hash instead of [REDACTED]
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

<br />

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

// Performance
const artifacts = player.getPerformanceArtifacts();

// Code generation
const curl = player.generateCurl("request-id");
const har = player.exportHar();
const bugReport = player.generateBugReport();
const playwright = player.generatePlaywrightScript();

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

recorder.ingest(rawEvent);
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
for (const event of events) await pipeline.ingest(event);
await pipeline.flush();

const indexes = await pipeline.finalizeIndexes();
const { fileName, bytes } = await pipeline.exportBundle({
  passphrase: "optional-password"
});
```

<br />

## Security & Privacy

| Layer                   | Protection                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **Redaction**           | Authorization headers, session cookies, and password fields are automatically redacted |
| **Custom Masking**      | Add custom patterns and CSS selectors for sensitive data                               |
| **Hash Masking**        | Optionally hash sensitive values instead of `[REDACTED]` for correlation analysis      |
| **Archive Encryption**  | AES-GCM with PBKDF2 key derivation (120,000 iterations)                                |
| **Cache Encryption**    | Pipeline storage can encrypt chunk/blob bytes at rest (e.g., IndexedDB)                |
| **Integrity**           | SHA-256 checksums for all archive files                                                |
| **Minimal Permissions** | Extension requests only permissions necessary for CDP access and event capture         |

<br />

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
| Screenshots     | @zumer/snapdom                   |
| Encryption      | Web Crypto API (AES-GCM, PBKDF2) |

<br />

## Scripts

| Command                 | Description                             |
| ----------------------- | --------------------------------------- |
| `pnpm dev`              | Start all packages in watch mode        |
| `pnpm build`            | Build all packages (dependency-ordered) |
| `pnpm test`             | Run all tests                           |
| `pnpm bench`            | Run recorder + pipeline benchmarks      |
| `pnpm bundle:size`      | Check bundle size budgets               |
| `pnpm typecheck`        | TypeScript type checking                |
| `pnpm lint`             | ESLint checks                           |
| `pnpm format`           | Format code with Prettier               |
| `pnpm changeset`        | Create a changeset for versioning       |
| `pnpm version-packages` | Apply changesets to bump versions       |
| `pnpm release`          | Publish packages                        |

<br />

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Performance Benchmarks](docs/PERFORMANCE.md)
- [Player SDK API Docs](docs/api/player-sdk/index.html)
- [Contributing](docs/CONTRIBUTING.md)

<br />

## License

[MIT](./LICENSE) © Web LLM
