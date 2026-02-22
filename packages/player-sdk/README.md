# @webblackbox/player-sdk

The session playback and analysis SDK for WebBlackbox. Opens `.webblackbox` archives and provides rich querying, analysis, and code generation capabilities.

## Overview

- **WebBlackboxPlayer** — Main player class for loading and analyzing sessions
- **Event Querying** — Filter events by type, level, time range, text, and request ID
- **Network Analysis** — Waterfall visualization, realtime stream timeline, request detail extraction
- **Storage Analysis** — Timeline of cookie, localStorage, IndexedDB, and cache operations
- **DOM Analysis** — Snapshot diffing to track added, removed, and changed elements
- **Performance Analysis** — Web Vitals, long tasks, CPU profiles, heap snapshots, traces
- **Session Comparison** — Compare two sessions by event counts, error rates, and request patterns
- **Code Generation** — Generate curl, fetch, HAR, Playwright scripts, bug reports, and issue templates
- **Legacy Archive Compatibility** — Handles older `indexes/*` / `integrity.json` layouts and legacy blob paths

## Installation

```bash
pnpm add @webblackbox/player-sdk
```

## Usage

### Opening an Archive

```typescript
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

// From ArrayBuffer, Uint8Array, or Blob
const player = await WebBlackboxPlayer.open(archiveBytes);

// With encryption passphrase
const player = await WebBlackboxPlayer.open(archiveBytes, {
  passphrase: "my-secret"
});

console.log(player.status); // "loaded"
console.log(player.archive.manifest); // ExportManifest
console.log(player.events.length); // Total event count
```

### Querying Events

```typescript
// Get all events
const allEvents = player.query();

// Filter by type
const networkEvents = player.query({
  types: ["network.request", "network.response"]
});

// Filter by level
const errors = player.query({
  levels: ["error"]
});

// Filter by time range (monotonic timestamps)
const firstMinute = player.query({
  range: { monoStart: 0, monoEnd: 60000 }
});

// Text search within events
const matches = player.query({
  text: "TypeError"
});

// Filter by request ID
const requestEvents = player.query({
  requestId: "R-12345"
});

// Combine filters with pagination
const page = player.query({
  types: ["error.exception"],
  levels: ["error"],
  range: { monoStart: 0, monoEnd: 120000 },
  limit: 50,
  offset: 0
});
```

### Full-Text Search

```typescript
const results = player.search("login failed", 100);
// Returns: PlayerSearchResult[]
// { eventId, score, event }
```

### Blob Retrieval

```typescript
// Get binary blob by hash (screenshots, DOM snapshots, response bodies)
const blob = await player.getBlob("abc123...");
if (blob) {
  console.log(blob.mime); // "image/webp"
  console.log(blob.bytes); // Uint8Array
}
```

## Analysis APIs

### Network Waterfall

```typescript
const waterfall = player.getNetworkWaterfall();

for (const entry of waterfall) {
  console.log(entry.url);
  console.log(entry.method); // "GET", "POST", etc.
  console.log(entry.status); // 200, 404, etc.
  console.log(entry.durationMs); // Request duration
  console.log(entry.mimeType); // Response MIME type
  console.log(entry.failed); // Whether request failed
  console.log(entry.requestHeaders); // Request headers
  console.log(entry.responseHeaders); // Response headers
}

// Filter by time range
const recentNetwork = player.getNetworkWaterfall({
  monoStart: 5000,
  monoEnd: 30000
});
```

### Realtime Network Timeline (WebSocket / SSE)

```typescript
const timeline = player.getRealtimeNetworkTimeline();

for (const entry of timeline) {
  console.log(entry.protocol); // "ws" | "sse"
  console.log(entry.direction); // "sent" | "received" | "unknown"
  console.log(entry.url);
  console.log(entry.payloadPreview);
  console.log(entry.payloadLength);
}
```

### Request Detail

```typescript
// Get all events for a specific request
const reqEvents = player.getRequestEvents("R-12345");
// Returns network.request, network.response, network.finished, etc.
```

### Storage Timeline

```typescript
const storage = player.getStorageTimeline();

for (const entry of storage) {
  console.log(entry.kind); // "cookie" | "local" | "session" | "idb" | "cache" | "sw"
  console.log(entry.operation); // set, delete, clear, etc.
  console.log(entry.eventType); // Full event type
}
```

### DOM Analysis

```typescript
// Get all DOM snapshots
const snapshots = player.getDomSnapshots();

// Compute diff timeline across all snapshots
const diffs = await player.getDomDiffTimeline();

for (const diff of diffs) {
  console.log(diff.summary.added); // Number of added DOM paths
  console.log(diff.summary.removed); // Number of removed DOM paths
  console.log(diff.summary.changed); // Number of changed DOM paths
  console.log(diff.addedPaths); // string[]
  console.log(diff.removedPaths); // string[]
  console.log(diff.changedPaths); // string[]
}

// Compare two specific snapshots
const diff = await player.compareDomSnapshots(prevId, currId);
```

### Performance Artifacts

```typescript
const artifacts = player.getPerformanceArtifacts();

for (const artifact of artifacts) {
  console.log(artifact.kind); // "trace" | "cpu" | "heap" | "longtask" | "vitals"
  console.log(artifact.hash); // Blob hash (if applicable)
  console.log(artifact.size); // Size in bytes
}
```

### Action Span Analysis

```typescript
const derived = player.buildDerived();

for (const span of derived.actionSpans) {
  console.log(span.actId); // Action span ID
  console.log(span.startMono); // Start time
  console.log(span.endMono); // End time
  console.log(span.eventIds); // Related event IDs
  console.log(span.triggerEventId); // Trigger event
  console.log(span.requestCount); // Network requests in span
  console.log(span.errorCount); // Errors in span
}

console.log(derived.totals.events); // Total event count
console.log(derived.totals.errors); // Total error count
console.log(derived.totals.requests); // Total request count
```

## Code Generation

### curl / fetch

```typescript
const curl = player.generateCurl("R-12345");
// curl -X POST 'https://api.example.com/data' -H 'Content-Type: application/json' ...

const fetch = player.generateFetch("R-12345");
// fetch('https://api.example.com/data', { method: 'POST', headers: {...}, body: '...' })
```

### HAR Export

```typescript
const harJson = player.exportHar();
// Standard HTTP Archive 1.2 format
// Compatible with Chrome DevTools, Charles Proxy, etc.

// Export specific time range
const harPartial = player.exportHar({ monoStart: 0, monoEnd: 30000 });
```

### Bug Report

```typescript
const report = player.generateBugReport({
  title: "Login fails with 500 error",
  description: "Steps to reproduce..."
});
// Returns markdown-formatted bug report with session context
```

### Playwright Scripts

```typescript
// Generate test script from recorded user actions
const testScript = player.generatePlaywrightScript({
  baseUrl: "https://example.com"
});

// Generate mock script with captured network responses
const mockScript = await player.generatePlaywrightMockScript({
  baseUrl: "https://example.com"
});
```

### Issue Templates

```typescript
// GitHub issue template
const github = player.generateGitHubIssueTemplate({
  title: "Bug title"
});
// { title, body, labels, assignees }

// Jira issue template
const jira = player.generateJiraIssueTemplate({
  title: "Bug title"
});
// { fields: { summary, description, issuetype, labels, project?, priority? } }
```

## Session Comparison

```typescript
const other = await WebBlackboxPlayer.open(otherArchiveBytes);

const comparison = player.compareWith(other);
console.log(comparison.eventDelta); // Event count difference
console.log(comparison.errorDelta); // Error count difference
console.log(comparison.requestDelta); // Request count difference
console.log(comparison.durationDeltaMs); // Duration difference

for (const td of comparison.typeDeltas) {
  console.log(`${td.type}: ${td.left} vs ${td.right} (${td.delta})`);
}

// Storage comparison
const storageDiff = player.compareStorageWith(other);

// DOM comparison (latest snapshots)
const domDiff = await player.compareLatestDomSnapshotWith(other);
```

## Types

```typescript
type PlayerStatus = "idle" | "loaded";

type PlayerOpenInput = ArrayBuffer | Uint8Array | Blob;

type PlayerOpenOptions = {
  passphrase?: string;
};

type PlayerQuery = {
  range?: PlayerRange;
  types?: WebBlackboxEventType[];
  levels?: EventLevel[];
  text?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
};

type PlayerRange = {
  monoStart?: number;
  monoEnd?: number;
};

type PlayerSearchResult = {
  eventId: string;
  score: number;
  event: WebBlackboxEvent;
};

type PlayerArchive = {
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest;
};
```
