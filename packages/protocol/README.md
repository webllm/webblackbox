# @webblackbox/protocol

The foundational protocol package for WebBlackbox. Defines all event types, message formats, configuration schemas, and validation logic shared across the entire system.

## Overview

This package provides:

- **Constants** — Event types, message types, capture modes, codecs, freeze reasons
- **TypeScript Types** — All data structures used across the system
- **Zod Schemas** — Runtime validation for events, messages, configs, and archive manifests
- **ID Generators** — Deterministic and random ID creation for sessions, events, actions, and chunks
- **Default Configuration** — Recommended recorder defaults

## Installation

```bash
pnpm add @webblackbox/protocol
```

## Event Types

WebBlackbox currently defines 57 event types, organized by category:

### Meta Events

- `meta.session.start` — Session initialization with URL, title, viewport, and permissions
- `meta.session.end` — Session termination
- `meta.config` — Configuration snapshot

### System Events

- `sys.debugger.attach` / `sys.debugger.detach` — CDP debugger lifecycle
- `sys.notice` — Internal system notices

### Navigation Events

- `nav.commit` — Page navigation committed
- `nav.history.push` / `nav.history.replace` — History API calls
- `nav.hash` — Hash change
- `nav.reload` — Page reload

### User Interaction Events

- `user.click` / `user.dblclick` — Click events with target info
- `user.keydown` — Keyboard events
- `user.input` — Form input changes
- `user.submit` — Form submissions
- `user.scroll` — Scroll position changes (sampled)
- `user.mousemove` — Mouse position (sampled)
- `user.focus` / `user.blur` — Focus changes
- `user.marker` — User-defined markers (Ctrl+Shift+M)
- `user.visibility` — Page visibility changes
- `user.resize` — Viewport resize

### Console Events

- `console.entry` — Console log/info/warn/error/debug with args, stack traces, and source info

### Error Events

- `error.exception` — Uncaught exceptions with stack traces
- `error.unhandledrejection` — Unhandled promise rejections
- `error.resource` — Resource loading errors
- `error.assert` — Console assertion failures

### Network Events

- `network.request` — HTTP request initiated (URL, method, headers, initiator)
- `network.response` — HTTP response received (status, headers, timing)
- `network.finished` — Request completed (encoded data length)
- `network.failed` — Request failed (error text)
- `network.redirect` — Request redirected
- `network.body` — Captured request/response body (hash reference)
- `network.ws.open` / `network.ws.frame` / `network.ws.close` — WebSocket lifecycle
- `network.sse.message` — Server-Sent Event messages

### DOM Events

- `dom.mutation.batch` — Batched DOM mutations
- `dom.snapshot` — Full DOM snapshot (content-addressable blob)
- `dom.diff` — DOM diff between snapshots
- `dom.rrweb.event` — rrweb-compatible events (currently emitted as lite mutation summaries)

### Screen Events

- `screen.screenshot` — Page screenshot with pointer position
- `screen.viewport` — Viewport dimension changes

### Storage Events

- `storage.cookie.snapshot` / `storage.local.snapshot` — Full storage snapshots
- `storage.local.op` / `storage.session.op` — localStorage/sessionStorage operations
- `storage.idb.op` / `storage.idb.snapshot` — IndexedDB operations and snapshots
- `storage.cache.op` — Cache API operations
- `storage.sw.lifecycle` — Service Worker lifecycle events

### Performance Events

- `perf.vitals` — Web Vitals and related runtime metrics
- `perf.longtask` — Long task detection (>50ms)
- `perf.trace` — Performance trace data
- `perf.cpu.profile` — CPU profile snapshots
- `perf.heap.snapshot` — Heap snapshots

## Core Types

### WebBlackboxEvent

```typescript
type WebBlackboxEvent<TData = unknown> = {
  v: 1; // Protocol version
  sid: string; // Session ID (S-{timestamp}-{token})
  tab: number; // Browser tab ID
  nav?: string; // Navigation ID
  frame?: string; // Frame ID (for iframes)
  tgt?: string; // Target ID
  cdp?: string; // CDP session ID
  t: number; // Wall-clock timestamp (ms since epoch)
  mono: number; // Monotonic timestamp (ms)
  dt?: number; // Duration (ms)
  type: WebBlackboxEventType; // Event type string
  id: string; // Unique event ID (E-{sequence})
  lvl?: EventLevel; // "debug" | "info" | "warn" | "error"
  ref?: EventReference; // Cross-references
  data: TData; // Event-specific payload
};
```

### EventReference

Links events across different dimensions:

```typescript
type EventReference = {
  act?: string; // Action span ID
  req?: string; // Network request ID
  mut?: string; // Mutation batch ID
  shot?: string; // Screenshot ID
  err?: string; // Error ID
  task?: string; // Long task ID
  prev?: string; // Previous event ID
};
```

### RecorderConfig

```typescript
type RecorderConfig = {
  mode: CaptureMode; // "lite" | "full"
  ringBufferMinutes: number; // Ring buffer window
  freezeOnError: boolean; // Freeze on uncaught errors
  freezeOnNetworkFailure: boolean; // Freeze on network failures
  freezeOnLongTaskSpike: boolean; // Freeze on long tasks
  sampling: SamplingProfile; // Sampling rates
  redaction: RedactionProfile; // Privacy redaction rules
  sitePolicies: SiteCapturePolicy[]; // Per-origin overrides
};
```

### ExportManifest

```typescript
type ExportManifest = {
  protocolVersion: 1;
  createdAt: string; // ISO 8601 datetime
  mode: CaptureMode;
  site: { origin: string; title?: string };
  chunkCodec: ChunkCodec; // "none" | "br" | "zst" | "gzip"
  redactionProfile: RedactionProfile;
  stats: ExportStats;
  encryption?: ExportEncryption; // AES-GCM encryption metadata
};
```

## Validation

All types have corresponding Zod schemas for runtime validation:

```typescript
import {
  validateEvent,
  validateEventData,
  validateMessage,
  eventEnvelopeSchema,
  recorderConfigSchema,
  exportManifestSchema,
  getEventPayloadSchema
} from "@webblackbox/protocol";

// Validate a full event (envelope + payload)
const result = validateEvent(unknownEvent);
if (result.success) {
  console.log("Valid event:", result.data);
}

// Validate just the payload for a known type
const payloadResult = validateEventData("network.request", payload);

// Get the schema for a specific event type
const schema = getEventPayloadSchema("error.exception");
```

## ID Generation

```typescript
import {
  createSessionId,
  createActionId,
  createChunkId,
  EventIdFactory
} from "@webblackbox/protocol";

const sid = createSessionId(); // "S-1706000000000-a1b2c3d4e5"
const actId = createActionId(1); // "A-000001"
const chunkId = createChunkId(1); // "C-000001"

const idFactory = new EventIdFactory();
const eid1 = idFactory.next(); // "E-00000001"
const eid2 = idFactory.next(); // "E-00000002"
```

## Default Configuration

```typescript
import { DEFAULT_EXPORT_POLICY, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

// Defaults:
// - mode: "lite"
// - ringBufferMinutes: 10
// - freezeOnError: true
// - mousemoveHz: 20, scrollHz: 15
// - screenshotIdleMs: 8000
// - bodyCaptureMaxBytes: 262144 (256 KiB base profile)
// - Redacts: authorization, cookie, set-cookie headers
// - Blocks: .secret, [data-sensitive], input[type='password']
//
// Export policy defaults:
// - includeScreenshots: true
// - maxArchiveBytes: 100 * 1024 * 1024
// - recentWindowMs: 20 * 60 * 1000
```

`DEFAULT_RECORDER_CONFIG` is a shared baseline. Runtime products may apply product-specific
overrides for sampling or freeze policies, but should document those overrides explicitly.

## Message Types

Inter-component communication uses typed messages:

| Message              | Direction          | Purpose                  |
| -------------------- | ------------------ | ------------------------ |
| `CTRL.START_SESSION` | SW → Pipeline      | Start recording session  |
| `CTRL.STOP_SESSION`  | SW → Pipeline      | Stop recording session   |
| `CTRL.FREEZE`        | Recorder → SW      | Freeze notification      |
| `CTRL.EXPORT`        | UI → SW            | Export request           |
| `EVT.BATCH`          | SW → Pipeline      | Batch of recorded events |
| `PIPE.BLOB_PUT`      | Pipeline → Storage | Store binary blob        |
| `PIPE.CHUNK_PUT`     | Pipeline → Storage | Store event chunk        |
| `PIPE.BUILD_INDEX`   | Pipeline → Indexer | Build search indexes     |
| `PIPE.EXPORT_DONE`   | Pipeline → SW      | Export complete          |
