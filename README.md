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
  <a href="https://github.com/webllm/webblackbox/releases"><img src="https://img.shields.io/github/v/release/webllm/webblackbox.svg" alt="Release" /></a>
  <a href="https://github.com/webllm/webblackbox/releases"><img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" /></a>
  <a href="https://webllm.github.io/webblackbox/"><img src="https://img.shields.io/badge/Hosted-Player-f97316" alt="Hosted Player" /></a>
  <img src="https://img.shields.io/badge/TypeScript-first-blue" alt="TypeScript">
</p>

---

WebBlackbox is a Chrome extension that continuously captures comprehensive session data — user interactions, network traffic, DOM mutations, console logs, storage operations, performance metrics, and screenshots — then exports encrypted, portable `.webblackbox` archives for offline playback and analysis.

Think of it as a **black box for your web app**: always recording in the background, so when something goes wrong, you have the full context to debug, reproduce, and fix it.

The hosted Player is available at: https://webllm.github.io/webblackbox/

### Why WebBlackbox?

- 📊 **Record everything** — 57 event types across 13 categories, captured silently via CDP and content scripts
- ⚡ **Two modes** — `lite` for production monitoring with minimal overhead; `full` for comprehensive debugging
- 🔒 **Privacy by default** — Automatic redaction of auth headers, cookies, passwords, and configurable patterns
- 🔐 **Encrypted & portable** — AES-GCM encrypted `.webblackbox` ZIP archives with SHA-256 integrity checks
- 🖥️ **Replay & analyze** — React player with timeline, network waterfall, console, storage inspector, DOM diffs, and screenshots
- 🛠️ **Generate artifacts** — Export to HAR, Playwright tests, curl/fetch commands, bug reports, and GitHub/Jira issue templates
- 🤖 **AI-ready** — MCP server for session analysis with Claude, ChatGPT, or any MCP-compatible assistant
- 📦 **Use anywhere** — Chrome extension for full capture, or `npm install webblackbox` for in-page lite capture

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
| **Replay** | Open the archive in the hosted Player: https://webllm.github.io/webblackbox/         |

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

## Highlights

<table>
<tr>
<td width="50%">

### 🎥 Continuous Recording

Runs silently as a Chrome extension, capturing events via the Chrome DevTools Protocol (CDP) and content script injection. Zero manual setup — install and forget.

- Automatic session lifecycle management
- Background recording across all tabs
- Keyboard shortcut `Ctrl+Shift+M` to mark key moments

</td>
<td width="50%">

### 📊 57 Event Types × 13 Categories

The most comprehensive web session capture available — user interactions, network traffic, WebSocket & SSE streams, DOM mutations, console logs, storage operations, performance metrics, screenshots, and more.

- Full request/response bodies with MIME-aware capture
- DOM snapshot diffs for visual regression analysis
- Web Vitals, long tasks, CPU profiles, heap snapshots

</td>
</tr>
<tr>
<td>

### ⚡ Two Capture Modes

**`lite`** — Minimal page-thread overhead for production monitoring. Defers heavy work to offscreen documents, keeps the main thread snappy.

**`full`** — Comprehensive debugging with CDP-driven capture, DOM snapshots, response body sampling, and detailed performance tracing.

- Per-origin site policies to mix modes across domains
- Configurable sampling rates for mouse, scroll, and DOM events

</td>
<td>

### 🔄 Ring Buffer with Auto-Freeze

Configurable circular buffer (default 10 min) keeps memory usage bounded while always preserving recent context.

- **Auto-freeze on errors** — Uncaught exceptions & unhandled rejections
- **Auto-freeze on network failures** — 5xx responses, timeouts, CORS errors
- **Auto-freeze on long task spikes** — Jank detection via PerformanceObserver
- **Manual freeze** — User markers for intentional snapshots

</td>
</tr>
<tr>
<td>

### 🔒 Privacy-First Redaction

Sensitive data is automatically masked before it's ever written to disk. Defense-in-depth with multiple redaction layers.

- Header & cookie name pattern matching (`authorization`, `session`, `token`)
- Request/response body pattern scanning (`password`, `secret`, `otp`)
- CSS selector blocking for DOM masking (`.secret`, `input[type='password']`)
- Optional SHA-256 hash masking for correlation without exposure

</td>
<td>

### 🔐 Encrypted & Portable Archives

`.webblackbox` ZIP archives with enterprise-grade encryption for secure sharing and compliance.

- **AES-GCM** encryption with per-file initialization vectors
- **PBKDF2** key derivation (SHA-256, 120K iterations)
- **SHA-256** integrity checksums for tamper detection
- Content-addressable blob deduplication for efficient storage
- Compression: gzip, brotli, or zstandard codecs

</td>
</tr>
<tr>
<td>

### 🖥️ Rich Playback UI

React 19 player application for deep session analysis with multiple synchronized panels.

- **Timeline** — Scrub through events with filtering by type and level
- **Network Waterfall** — Request/response timings, headers, and bodies
- **Console** — Log viewer with level filtering and source linking
- **Storage Inspector** — Cookie, localStorage, sessionStorage, IndexedDB ops
- **DOM Diff** — Visual comparison of DOM snapshots over time
- **Screenshots** — Frame trail with pointer position overlay

</td>
<td>

### 🛠️ Code Generation & Export

Turn captured sessions into actionable artifacts — no manual recreation needed.

- **curl / fetch** — Reproduce any captured network request
- **Playwright scripts** — Auto-generated E2E tests from user interactions
- **Playwright mocks** — Test scripts with captured response fixtures
- **HAR export** — HTTP Archive format for standard tooling
- **Bug reports** — Markdown reports with environment, steps, and errors
- **Issue templates** — GitHub and Jira issue templates ready to file

</td>
</tr>
<tr>
<td>

### 🤖 MCP Integration

Model Context Protocol server for AI-assisted session analysis — plug into Claude, ChatGPT, or any MCP-compatible assistant.

- `session_summary` — Triage metrics and top issues at a glance
- `query_events` — Search events with pagination and filtering
- `network_issues` — Identify failing requests, slow responses, CORS errors
- `find_root_cause_candidates` — Error causality analysis
- `compare_sessions` — Cross-session regression detection

</td>
<td>

### 🔌 Extensible Plugin System

Custom recorder plugins with hooks for event processing, filtering, and enrichment.

- `onRawEvent` — Transform events before normalization
- `onEvent` — Process events after normalization
- **Built-in plugins:**
  - `createRouteContextPlugin()` — Track SPA route context per stream
  - `createErrorFingerprintPlugin()` — Deduplicate errors by fingerprint
  - `createAiRootCausePlugin()` — AI-powered root cause analysis

</td>
</tr>
<tr>
<td>

### 📦 Web SDK (npm)

Published as `webblackbox` on npm — embed lite capture directly in your application without the Chrome extension.

```bash
npm install webblackbox
```

- `WebBlackboxLiteSdk` — Start/stop/flush/export archives in-page
- Framework-agnostic, works in any browser environment
- Same `.webblackbox` archive format, same Player compatibility

</td>
<td>

### ☁️ Cloud Share (Optional)

Optional share server for team collaboration — upload encrypted archives and generate read-only share links.

- Encrypted upload with server-side metadata indexing
- Rate limiting per IP for abuse prevention
- Redacted metadata — server never sees raw session data
- Self-hostable Node.js service

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
                    │  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
                    │  │ Injected │→ │ Content  │→ │    Service   │   │
                    │  │  Script  │  │  Script  │  │    Worker    │   │
                    │  └──────────┘  └──────────┘  └───────┬──────┘   │
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
                    ┌─────────────────────────────────────────────────┐
                    │              Player (React UI)                  │
                    │                                                 │
                    │  ┌──────────────┐  ┌────────────────────────┐   │
                    │  │  Player SDK  │  │  Timeline │ Network    │   │
                    │  │  (analysis)  │→ │  Console  │ Storage    │   │
                    │  └──────────────┘  │  DOM Diff │ Perf       │   │
                    │                    └────────────────────────┘   │
                    └─────────────────────────────────────────────────┘
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
│   ├── webblackbox/        # Browser lite capture SDK (published as `webblackbox`)
│   ├── player-sdk/         # Playback, querying, analysis APIs
│   ├── cdp-router/         # Chrome DevTools Protocol routing
│   └── mcp-core/           # MCP utility functions
├── config/
│   └── typescript/         # Shared TypeScript configuration
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
