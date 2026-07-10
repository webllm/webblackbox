import JSZip from "jszip";

import type {
  ChunkCodec,
  ChunkTimeIndexEntry,
  EventLevel,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent,
  WebBlackboxEventType
} from "@webblackbox/protocol";
import {
  assertArchiveChunk,
  assertArchiveEventIndexes,
  assertArchiveLayout,
  extractRequestId,
  inferBlobMime,
  parseArchivedEvent,
  parseExportManifest,
  parseHashesManifest,
  parseInvertedIndex,
  parsePrivacyManifest,
  parseRequestIndex,
  parseTimeIndex
} from "@webblackbox/protocol";

import {
  ArchiveDecodeBudget,
  ArchiveResourceLimitError,
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits,
  type ArchiveResourceLimits
} from "./archive-resource-limits.js";
import { ArchiveDecodeTimeoutError, readBoundedReadableStream } from "./bounded-stream-reader.js";
import { ArchiveEntryReadLimitError, BoundedZipReader } from "./bounded-zip-reader.js";

export {
  ArchiveResourceLimitError,
  DEFAULT_ARCHIVE_RESOURCE_LIMITS,
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits,
  type ArchiveResourceLimits
} from "./archive-resource-limits.js";
export { ArchiveDecodeTimeoutError } from "./bounded-stream-reader.js";
export { BoundedZipReader } from "./bounded-zip-reader.js";

/** Player lifecycle status. */
export type PlayerStatus = "idle" | "loaded";

/** Supported input payloads when opening an archive. */
export type PlayerOpenInput = ArrayBuffer | Uint8Array | Blob;

/** Optional archive open settings. */
export type PlayerOpenOptions = {
  passphrase?: string;
  range?: PlayerRange;
  resourceLimits?: Partial<ArchiveResourceLimits>;
};

/** Monotonic-time query range in milliseconds. */
export type PlayerRange = {
  monoStart?: number;
  monoEnd?: number;
};

/** Event query filter model. */
export type PlayerQuery = {
  range?: PlayerRange;
  types?: WebBlackboxEventType[];
  levels?: EventLevel[];
  text?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
};

/** Ranked full-text search hit for an event. */
export type PlayerSearchResult = {
  eventId: string;
  score: number;
  event: WebBlackboxEvent;
};

/** Aggregated user action span. */
export type ActionSpan = {
  actId: string;
  startMono: number;
  endMono: number;
  eventIds: string[];
  triggerEventId: string;
  requestCount: number;
  errorCount: number;
};

/** Action timeline row with network/error/screenshot context. */
export type ActionTimelineEntry = {
  actId: string;
  triggerEventId: string;
  triggerType: string | null;
  startMono: number;
  endMono: number;
  durationMs: number;
  eventCount: number;
  requestCount: number;
  errorCount: number;
  requests: Array<{
    reqId: string;
    method: string;
    url: string;
    status: number | null;
    failed: boolean;
    durationMs: number;
  }>;
  errors: Array<{
    eventId: string;
    type: string;
    mono: number;
    message: string | null;
  }>;
  screenshot: {
    eventId: string;
    mono: number;
    shotId: string | null;
    reason: string | null;
    format: string | null;
    size: number | null;
  } | null;
};

/** Replay confidence row that links action, request/response, error, and screenshot evidence. */
export type ReplayDiagnosticEntry = {
  actId: string;
  confidence: "high" | "medium" | "low";
  triggerEventId: string;
  triggerType: string | null;
  causeChain: string[];
  requestResponseDiffs: Array<{
    reqId: string;
    method: string;
    url: string;
    capturedStatus: number | null;
    failed: boolean;
    hasRequestBody: boolean;
    hasResponseBody: boolean;
    responseBodySize: number | null;
  }>;
  errorMessages: string[];
  screenshotEventId: string | null;
};

/** Concrete request/response comparison for replay confidence and debugging. */
export type RequestResponseDiff = {
  reqId: string;
  method: string;
  url: string;
  status: number | null;
  requestBodyBytes: number;
  responseBodyBytes: number;
  bodySizeDeltaBytes: number;
  requestHeaderNames: string[];
  responseHeaderNames: string[];
  missingReplayInputs: string[];
};

/** Cached derived analysis view. */
export type PlayerDerivedView = {
  actionSpans: ActionSpan[];
  totals: {
    events: number;
    errors: number;
    requests: number;
  };
};

/** Parsed archive metadata and indexes. */
export type PlayerArchive = {
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest | null;
};

/** Explainable privacy posture for export/share preflight review. */
export type PrivacyProtectionReport = {
  encrypted: boolean;
  redaction: {
    hashSensitiveValues: boolean;
    headers: string[];
    cookieNames: string[];
    bodyPatterns: string[];
    blockedSelectors: string[];
    strategy: string[];
  };
  detected: {
    redactedMarkers: number;
    hashedSensitiveValues: number;
    sensitiveKeyMentions: number;
  };
  scanner: {
    preEncryption: boolean;
    status: "passed" | "blocked" | "unknown";
    findingCount: number;
  };
};

/** Bounded sensitive-data preview for export/share review before publishing an archive. */
export type SensitiveDataPreview = {
  totalMatches: number;
  samples: Array<{
    eventId: string;
    type: WebBlackboxEventType;
    mono: number;
    reason: "redacted-marker" | "hashed-value" | "sensitive-pattern";
    snippet: string;
  }>;
};

/** Normalized request waterfall entry. */
export type NetworkWaterfallEntry = {
  reqId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  startMono: number;
  endMono: number;
  durationMs: number;
  startWallTime: number;
  endWallTime: number;
  failed: boolean;
  errorText?: string;
  actionId?: string;
  encodedDataLength?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyText?: string;
  responseBodyHash?: string;
  responseBodySize?: number;
  eventIds: string[];
};

/** Realtime network stream entry (WebSocket/SSE). */
export type RealtimeNetworkEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  protocol: "ws" | "sse";
  mono: number;
  t: number;
  streamId?: string;
  direction?: "sent" | "received" | "unknown";
  phase?: string;
  url?: string;
  opcode?: number;
  payloadLength?: number;
  payloadPreview?: string;
  snapshot?: unknown;
};

/** Storage event timeline entry. */
export type StorageTimelineEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  t: number;
  mono: number;
  kind: "cookie" | "local" | "session" | "idb" | "cache" | "sw" | "unknown";
  operation?: string;
  hash?: string;
  mode?: string;
  count?: number;
  reason?: string;
  snapshot?: unknown;
};

/** Performance artifact timeline entry. */
export type PerformanceArtifactEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  t: number;
  mono: number;
  kind: "trace" | "cpu" | "heap" | "longtask" | "vitals" | "other";
  hash?: string;
  size?: number;
  reason?: string;
  snapshot?: unknown;
};

/** Session-vs-session comparison summary. */
export type PlayerComparison = {
  leftSessionId: string;
  rightSessionId: string;
  /** @deprecated Use leftSessionId instead. */
  leftSid: string;
  /** @deprecated Use rightSessionId instead. */
  rightSid: string;
  eventDelta: number;
  errorDelta: number;
  requestDelta: number;
  durationDeltaMs: number;
  typeDeltas: Array<{
    type: string;
    left: number;
    right: number;
    delta: number;
  }>;
  endpointRegressions: Array<{
    endpoint: string;
    method: string;
    leftCount: number;
    rightCount: number;
    countDelta: number;
    leftFailed: number;
    rightFailed: number;
    failedDelta: number;
    leftFailureRate: number;
    rightFailureRate: number;
    failureRateDelta: number;
    leftP95DurationMs: number;
    rightP95DurationMs: number;
    p95DurationDeltaMs: number;
  }>;
};

/** Storage-only comparison summary. */
export type StorageComparison = {
  leftEvents: number;
  rightEvents: number;
  kindDeltas: Array<{
    kind: StorageTimelineEntry["kind"];
    left: number;
    right: number;
    delta: number;
  }>;
  hashOnlyLeft: string[];
  hashOnlyRight: string[];
};

/** Bug report generation options. */
export type BugReportOptions = {
  title?: string;
  range?: PlayerRange;
  maxItems?: number;
};

/** Playwright script generation options. */
export type PlaywrightScriptOptions = {
  name?: string;
  range?: PlayerRange;
  startUrl?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
};

/** Playwright mock script generation options. */
export type PlaywrightMockScriptOptions = PlaywrightScriptOptions & {
  maxMocks?: number;
};

/** Shared options for team issue template generation. */
export type TeamIssueTemplateOptions = {
  title?: string;
  range?: PlayerRange;
  maxItems?: number;
  labels?: string[];
  assignees?: string[];
  issueType?: string;
  projectKey?: string;
  priority?: string;
};

/** GitHub issue payload generated from a session. */
export type GitHubIssueTemplate = {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
};

/** Jira issue payload generated from a session. */
export type JiraIssueTemplate = {
  fields: {
    summary: string;
    description: string;
    issuetype: {
      name: string;
    };
    labels: string[];
    project?: {
      key: string;
    };
    priority?: {
      name: string;
    };
  };
};

/** DOM snapshot reference entry from the timeline. */
export type DomSnapshotRef = {
  eventId: string;
  mono: number;
  t: number;
  snapshotId?: string;
  contentHash?: string;
  source?: string;
  nodeCount?: number;
  reason?: string;
};

/** DOM diff timeline query options. */
export type DomDiffTimelineOptions = {
  range?: PlayerRange;
  limit?: number;
};

/** Result of diffing two DOM snapshots. */
export type DomDiffResult = {
  previous: DomSnapshotRef;
  current: DomSnapshotRef;
  addedPaths: string[];
  removedPaths: string[];
  changedPaths: string[];
  summary: {
    added: number;
    removed: number;
    changed: number;
  };
};

type BlobRef = {
  path: string;
  mime: string;
};

/** Decrypted or plaintext blob content resolved from an archive hash. */
export type PlayerBlob = {
  mime: string;
  bytes: Uint8Array;
};

type ArchiveEncryptedFileMeta = {
  ivBase64: string;
};

type NodeZlibLike = {
  createGunzip?: (options: { chunkSize: number }) => NodeJS.ReadWriteStream;
  createBrotliDecompress?: (options: { chunkSize: number }) => NodeJS.ReadWriteStream;
  createZstdDecompress?: (options: { chunkSize: number }) => NodeJS.ReadWriteStream;
};

type NodeStreamLike = {
  Readable?: {
    toWeb?: (stream: NodeJS.ReadableStream) => ReadableStream<Uint8Array>;
  };
};

const ACTION_TRIGGER_TYPES = new Set<WebBlackboxEventType>([
  "user.click",
  "user.dblclick",
  "user.keydown",
  "user.input",
  "user.submit",
  "user.marker",
  "nav.commit"
]);

const NETWORK_EVENT_TYPES = new Set<WebBlackboxEventType>([
  "network.request",
  "network.response",
  "network.finished",
  "network.failed",
  "network.redirect",
  "network.body"
]);

const STORAGE_EVENT_PREFIXES = [
  "storage.cookie.",
  "storage.local.",
  "storage.session.",
  "storage.idb.",
  "storage.cache.",
  "storage.sw."
] as const;

const DEFAULT_ACTION_WINDOW_MS = 1500;
const DEFAULT_TIMELINE_SCREENSHOT_LOOKAHEAD_MS = 2000;
const DEFAULT_TIMELINE_REQUEST_LIMIT = 5;
const DEFAULT_TIMELINE_ERROR_LIMIT = 5;
const DEFAULT_DECODED_CHUNK_CACHE_SIZE = 12;

type EventChunkSource = {
  chunkId: string;
  path: string;
  seq: number;
  monoStart: number;
  monoEnd: number;
  bytes: Uint8Array;
  events: WebBlackboxEvent[];
};

type EventChunkDescriptor = {
  chunkId: string;
  path: string;
  seq: number;
  monoStart: number;
  monoEnd: number;
  codec: ChunkCodec;
  index: ChunkTimeIndexEntry;
  selected: boolean;
};

type EventChunkReadResult = {
  chunks: EventChunkSource[];
  events: WebBlackboxEvent[];
};

/**
 * Main SDK entry for loading, querying, and exporting insights from `.webblackbox` archives.
 */
export class WebBlackboxPlayer {
  /** Current player status (always `loaded` for opened instances). */
  public readonly status: PlayerStatus = "loaded";

  /** Parsed archive metadata and indexes. */
  public readonly archive: PlayerArchive;

  private readonly zipReader: BoundedZipReader;

  private readonly eventChunks: EventChunkSource[];

  private readonly decodedChunkCache = new Map<string, WebBlackboxEvent[]>();

  private allEventsCache: WebBlackboxEvent[] | null = null;

  private allDerivedCache: PlayerDerivedView | null = null;

  private allNetworkWaterfallCache: NetworkWaterfallEntry[] | null = null;

  private allStorageTimelineCache: StorageTimelineEntry[] | null = null;

  private allPerformanceArtifactsCache: PerformanceArtifactEntry[] | null = null;

  private readonly requestToEventIds = new Map<string, string[]>();

  private readonly inverted = new Map<string, string[]>();

  private readonly blobsByHash = new Map<string, BlobRef>();

  private readonly blobReads = new Map<string, Promise<PlayerBlob>>();

  private readonly archiveKey: CryptoKey | null;

  private readonly encryptedFiles: Record<string, ArchiveEncryptedFileMeta>;

  private constructor(
    zip: JSZip,
    zipReader: BoundedZipReader,
    archive: PlayerArchive,
    eventChunks: EventChunkSource[],
    archiveKey: CryptoKey | null,
    encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
  ) {
    this.zipReader = zipReader;
    this.archive = archive;
    this.archiveKey = archiveKey;
    this.encryptedFiles = encryptedFiles;
    this.eventChunks = [...eventChunks].sort((left, right) => left.seq - right.seq);

    for (const entry of archive.requestIndex) {
      this.requestToEventIds.set(entry.reqId, [...entry.eventIds]);
    }

    for (const entry of archive.invertedIndex) {
      this.inverted.set(entry.term.toLowerCase(), [...entry.eventIds]);
    }

    for (const path of Object.keys(zip.files)) {
      const parsed = parseBlobPath(path);

      if (!parsed) {
        continue;
      }

      const blobRef: BlobRef = {
        path,
        mime: inferBlobMime(parsed.extension)
      };

      // Always register exact path lookups to avoid collisions across extensions.
      this.blobsByHash.set(path, blobRef);

      setBlobAliasIfAbsent(this.blobsByHash, parsed.hash, blobRef);
      setBlobAliasIfAbsent(this.blobsByHash, `sha256-${parsed.hash}`, blobRef);
    }
  }

  /** Returns all events in the current loaded range. */
  public get events(): WebBlackboxEvent[] {
    return this.query();
  }

  /** Opens a WebBlackbox archive from bytes, buffer, or Blob input. */
  public static async open(
    input: PlayerOpenInput,
    options: PlayerOpenOptions = {}
  ): Promise<WebBlackboxPlayer> {
    const resourceLimits = resolveArchiveResourceLimits(options.resourceLimits);
    const bytes = await normalizeOpenInput(input, resourceLimits);
    const zip = await JSZip.loadAsync(bytes);
    assertLoadedArchiveResourceLimits(zip, resourceLimits);
    const zipReader = new BoundedZipReader(zip, resourceLimits, true);
    const decodeBudget = new ArchiveDecodeBudget(resourceLimits);

    const integrity = parseHashesManifest(await readJsonValue(zipReader, "integrity/hashes.json"));
    assertArchiveFileSet(zip, integrity);
    await assertManifestIntegrity(zipReader, integrity);
    const manifest = parseExportManifest(await readJsonValue(zipReader, "manifest.json"));
    const archiveKey = await resolveArchiveReadKey(manifest, options.passphrase);
    const encryptedFiles = manifest.encryption?.files ?? {};
    const timeIndex = parseTimeIndex(
      await readIntegrityArchiveJsonValue(
        zipReader,
        integrity,
        "index/time.json",
        archiveKey,
        encryptedFiles
      )
    );
    decodeBudget.commitIndex("index/time.json", timeIndex.length, 0);
    const requestIndex = parseRequestIndex(
      await readIntegrityArchiveJsonValue(
        zipReader,
        integrity,
        "index/req.json",
        archiveKey,
        encryptedFiles
      )
    );
    decodeBudget.commitIndex(
      "index/req.json",
      requestIndex.length,
      countIndexEventReferences(requestIndex)
    );
    const invertedIndex = parseInvertedIndex(
      await readIntegrityArchiveJsonValue(
        zipReader,
        integrity,
        "index/inv.json",
        archiveKey,
        encryptedFiles
      )
    );
    decodeBudget.commitIndex(
      "index/inv.json",
      invertedIndex.length,
      countIndexEventReferences(invertedIndex)
    );
    const privacyValue = await readOptionalIntegrityArchiveJsonValue(
      zipReader,
      integrity,
      "privacy/manifest.json",
      archiveKey,
      encryptedFiles
    );
    const privacyManifest = privacyValue === null ? null : parsePrivacyManifest(privacyValue);

    assertArchiveLayout({
      paths: archiveFilePaths(zip),
      manifest,
      timeIndex,
      requestIndex,
      invertedIndex,
      privacyManifest
    });

    const eventChunkResult = await readEventChunkSources(
      zipReader,
      archiveKey,
      encryptedFiles,
      {
        range: options.range,
        timeIndex
      },
      integrity,
      decodeBudget
    );

    assertArchiveEventIndexes(manifest, eventChunkResult.events, requestIndex, invertedIndex);

    return new WebBlackboxPlayer(
      zip,
      zipReader,
      {
        manifest,
        timeIndex,
        requestIndex,
        invertedIndex,
        integrity,
        privacyManifest
      },
      eventChunkResult.chunks,
      archiveKey,
      encryptedFiles
    );
  }

  /** Queries events using range/type/level/text/request filters. */
  public query(query: PlayerQuery = {}): WebBlackboxEvent[] {
    if (
      query.range?.monoStart !== undefined &&
      query.range?.monoEnd !== undefined &&
      query.range.monoStart > query.range.monoEnd
    ) {
      return [];
    }

    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, query.limit ?? Number.POSITIVE_INFINITY);
    const types = query.types ? new Set(query.types) : null;
    const levels = query.levels ? new Set(query.levels) : null;
    const text = query.text?.trim().toLowerCase();
    const indexedRequestIds = query.requestId ? this.requestToEventIds.get(query.requestId) : null;
    const requestedIds = query.requestId && indexedRequestIds ? new Set(indexedRequestIds) : null;
    const textCandidateIds = text ? collectInvertedCandidateIds(this.inverted, text) : null;
    const candidateIds = intersectCandidateIds(requestedIds, textCandidateIds);
    const sourceEvents = isRangeUnbounded(query.range) ? this.getAllEvents() : null;
    const isUnfilteredFullQuery =
      sourceEvents !== null &&
      offset === 0 &&
      !Number.isFinite(limit) &&
      !query.requestId &&
      !types &&
      !levels &&
      !text;

    if (isUnfilteredFullQuery) {
      return sourceEvents;
    }

    if (candidateIds && candidateIds.size === 0) {
      return [];
    }

    const matched: WebBlackboxEvent[] = [];
    let skipped = 0;

    const collectMatch = (event: WebBlackboxEvent): boolean => {
      if (candidateIds && !candidateIds.has(event.id)) {
        return false;
      }

      if (query.requestId && extractRequestId(event) !== query.requestId) {
        return false;
      }

      if (!withinRange(event, query.range)) {
        return false;
      }

      if (types && !types.has(event.type)) {
        return false;
      }

      if (levels && (!event.lvl || !levels.has(event.lvl))) {
        return false;
      }

      if (text && !matchesText(event, text)) {
        return false;
      }

      if (skipped < offset) {
        skipped += 1;
        return false;
      }

      matched.push(event);
      return matched.length >= limit;
    };

    if (sourceEvents) {
      for (const event of sourceEvents) {
        if (collectMatch(event)) {
          return matched;
        }
      }

      return matched;
    }

    for (const chunk of this.getChunksForRange(query.range)) {
      const chunkEvents = this.getChunkEvents(chunk);

      for (const event of chunkEvents) {
        if (collectMatch(event)) {
          return matched;
        }
      }
    }

    return matched;
  }

  /** Full-text search over indexed terms and event payloads. */
  public search(term: string, limit = 100): PlayerSearchResult[] {
    const normalizedTerm = term.trim().toLowerCase();

    if (!normalizedTerm) {
      return [];
    }

    const eventIds = this.inverted.get(normalizedTerm);
    const ranked = new Map<string, number>();
    const candidateIds = collectInvertedCandidateIds(this.inverted, normalizedTerm);
    const eventsById = new Map<string, WebBlackboxEvent>();

    if (eventIds) {
      for (const eventId of eventIds) {
        ranked.set(eventId, 10);
      }
    }

    for (const event of this.getAllEvents()) {
      if (candidateIds && !candidateIds.has(event.id)) {
        continue;
      }

      const score = computeTextScore(event, normalizedTerm);

      if (score <= 0 && !ranked.has(event.id)) {
        continue;
      }

      const previous = ranked.get(event.id) ?? 0;
      ranked.set(event.id, Math.max(previous, score));
      eventsById.set(event.id, event);
    }

    return [...ranked.entries()]
      .map(([eventId, score]) => ({ eventId, score, event: eventsById.get(eventId) }))
      .filter((entry): entry is { eventId: string; score: number; event: WebBlackboxEvent } =>
        Boolean(entry.event)
      )
      .sort((left, right) => right.score - left.score || left.event.mono - right.event.mono)
      .slice(0, Math.max(1, limit));
  }

  private getChunksForRange(range?: PlayerRange): EventChunkSource[] {
    if (!range) {
      return this.eventChunks;
    }

    return this.eventChunks.filter((chunk) => chunkSourceIntersectsRange(chunk, range));
  }

  private getAllEvents(): WebBlackboxEvent[] {
    if (this.allEventsCache) {
      return this.allEventsCache;
    }

    const events: WebBlackboxEvent[] = [];

    for (const chunk of this.eventChunks) {
      events.push(...this.getChunkEvents(chunk));
    }

    this.allEventsCache = events;
    return events;
  }

  private getChunkEvents(chunk: EventChunkSource): WebBlackboxEvent[] {
    const cached = this.decodedChunkCache.get(chunk.chunkId);

    if (cached) {
      this.decodedChunkCache.delete(chunk.chunkId);
      this.decodedChunkCache.set(chunk.chunkId, cached);
      return cached;
    }

    const parsed = chunk.events;
    this.decodedChunkCache.set(chunk.chunkId, parsed);

    while (this.decodedChunkCache.size > DEFAULT_DECODED_CHUNK_CACHE_SIZE) {
      const oldest = this.decodedChunkCache.keys().next().value;

      if (!oldest) {
        break;
      }

      this.decodedChunkCache.delete(oldest);
    }

    return parsed;
  }

  private findEventById(eventId: string): WebBlackboxEvent | null {
    if (!eventId.trim()) {
      return null;
    }

    if (this.allEventsCache) {
      return this.allEventsCache.find((entry) => entry.id === eventId) ?? null;
    }

    for (const chunk of this.eventChunks) {
      const event = this.getChunkEvents(chunk).find((entry) => entry.id === eventId);

      if (event) {
        return event;
      }
    }

    return null;
  }

  /** Resolves a stored blob by hash or blob path alias. */
  public async getBlob(hash: string): Promise<PlayerBlob | null> {
    const blob = resolveBlobByKey(this.blobsByHash, hash);

    if (!blob) {
      return null;
    }

    if (!this.zipReader.has(blob.path)) {
      return null;
    }

    const cached = this.blobReads.get(blob.path);
    if (cached) {
      return clonePlayerBlob(await cached);
    }

    const pending = readTransientZipEntry(this.zipReader, blob.path, async (rawBytes) => {
      await assertArchiveFileIntegrity(this.archive.integrity, blob.path, rawBytes);
      const bytes = await this.decryptArchiveFile(blob.path, rawBytes);

      return {
        mime: blob.mime,
        bytes
      };
    });
    this.blobReads.set(blob.path, pending);
    return clonePlayerBlob(await pending);
  }

  /** Builds action-span aggregates and total counters for the selected range. */
  public buildDerived(range?: PlayerRange): PlayerDerivedView {
    if (isRangeUnbounded(range) && this.allDerivedCache) {
      return this.allDerivedCache;
    }

    const scoped = this.query({ range });
    const explicitSpans = new Map<string, ActionSpan>();
    const derivedSpans: ActionSpan[] = [];
    let openDerivedSpan: ActionSpan | null = null;

    for (const event of scoped) {
      if (event.ref?.act) {
        const current =
          explicitSpans.get(event.ref.act) ?? createActionSpan(event.ref.act, event.id, event.mono);
        current.endMono = Math.max(current.endMono, event.mono);
        current.eventIds.push(event.id);
        updateActionStats(current, event);
        explicitSpans.set(event.ref.act, current);
        continue;
      }

      if (ACTION_TRIGGER_TYPES.has(event.type)) {
        if (openDerivedSpan) {
          derivedSpans.push(openDerivedSpan);
        }

        openDerivedSpan = createActionSpan(`derived:${event.id}`, event.id, event.mono);
        openDerivedSpan.eventIds.push(event.id);
        updateActionStats(openDerivedSpan, event);
        continue;
      }

      if (!openDerivedSpan) {
        continue;
      }

      if (event.mono - openDerivedSpan.startMono > DEFAULT_ACTION_WINDOW_MS) {
        derivedSpans.push(openDerivedSpan);
        openDerivedSpan = null;
        continue;
      }

      openDerivedSpan.eventIds.push(event.id);
      openDerivedSpan.endMono = event.mono;
      updateActionStats(openDerivedSpan, event);
    }

    if (openDerivedSpan) {
      derivedSpans.push(openDerivedSpan);
    }

    const actionSpans = [...explicitSpans.values(), ...derivedSpans].sort(
      (left, right) => left.startMono - right.startMono
    );

    const totals = {
      events: scoped.length,
      errors: scoped.filter(isErrorEvent).length,
      requests: scoped.filter((event) => event.type === "network.request").length
    };

    const derived = {
      actionSpans,
      totals
    };

    if (isRangeUnbounded(range)) {
      this.allDerivedCache = derived;
    }

    return derived;
  }

  /** Builds a privacy/export preflight report that explains configured redaction and detected evidence. */
  public getPrivacyProtectionReport(range?: PlayerRange): PrivacyProtectionReport {
    const profile = this.archive.manifest.redactionProfile;
    const events = this.query({ range });
    const counters = countPrivacySignals(events, profile.redactBodyPatterns);

    return {
      encrypted: Boolean(this.archive.manifest.encryption),
      redaction: {
        hashSensitiveValues: profile.hashSensitiveValues,
        headers: [...profile.redactHeaders].sort(),
        cookieNames: [...profile.redactCookieNames].sort(),
        bodyPatterns: [...profile.redactBodyPatterns].sort(),
        blockedSelectors: [...profile.blockedSelectors].sort(),
        strategy: describeRedactionStrategy(profile)
      },
      detected: counters,
      scanner: this.archive.privacyManifest
        ? {
            preEncryption: this.archive.privacyManifest.scanner.preEncryption,
            status: this.archive.privacyManifest.scanner.status,
            findingCount: this.archive.privacyManifest.scanner.findings.length
          }
        : {
            preEncryption: false,
            status: "unknown",
            findingCount: 0
          }
    };
  }

  /** Returns bounded redaction evidence samples so users can review sensitive data before export/share. */
  public getSensitiveDataPreview(
    options: {
      range?: PlayerRange;
      limit?: number;
    } = {}
  ): SensitiveDataPreview {
    const limit = Math.max(1, options.limit ?? 25);
    const patterns = this.archive.manifest.redactionProfile.redactBodyPatterns;
    const samples: SensitiveDataPreview["samples"] = [];
    let totalMatches = 0;

    for (const event of this.query({ range: options.range })) {
      const matches = collectSensitivePreviewMatches(event, patterns);
      totalMatches += matches.length;

      for (const match of matches) {
        if (samples.length >= limit) {
          continue;
        }

        samples.push(match);
      }
    }

    return {
      totalMatches,
      samples
    };
  }

  /** Builds per-action timeline rows with related requests/errors/screenshots. */
  public getActionTimeline(
    options: {
      range?: PlayerRange;
      limit?: number;
      screenshotLookaheadMs?: number;
      requestLimit?: number;
      errorLimit?: number;
      derived?: PlayerDerivedView;
    } = {}
  ): ActionTimelineEntry[] {
    const { range } = options;
    const limit = Math.max(1, options.limit ?? Number.POSITIVE_INFINITY);
    const screenshotLookaheadMs = Math.max(
      0,
      options.screenshotLookaheadMs ?? DEFAULT_TIMELINE_SCREENSHOT_LOOKAHEAD_MS
    );
    const requestLimit = Math.max(1, options.requestLimit ?? DEFAULT_TIMELINE_REQUEST_LIMIT);
    const errorLimit = Math.max(1, options.errorLimit ?? DEFAULT_TIMELINE_ERROR_LIMIT);
    const derived = options.derived ?? this.buildDerived(range);
    const scopedEvents = this.query({ range });
    const scopedById = new Map(scopedEvents.map((event) => [event.id, event]));
    const requestById = new Map(
      this.getNetworkWaterfall(range).map((entry) => [entry.reqId, entry])
    );
    const screenshots = this.query({
      range,
      types: ["screen.screenshot"]
    }).sort(compareEventsByMono);
    const errorEvents = scopedEvents.filter(isErrorEvent).sort(compareEventsByMono);

    return derived.actionSpans.slice(0, limit).map((span) => {
      const spanEvents = span.eventIds
        .map((eventId) => scopedById.get(eventId))
        .filter((event): event is WebBlackboxEvent => Boolean(event));
      const requestIds = [
        ...new Set(spanEvents.map((event) => extractRequestId(event)).filter(isNonEmptyString))
      ];
      const requests = requestIds
        .map((reqId) => requestById.get(reqId))
        .filter((entry): entry is NetworkWaterfallEntry => Boolean(entry))
        .sort((left, right) => left.startMono - right.startMono)
        .slice(0, requestLimit)
        .map((entry) => ({
          reqId: entry.reqId,
          method: entry.method,
          url: entry.url,
          status: typeof entry.status === "number" ? entry.status : null,
          failed: entry.failed,
          durationMs: roundTo(entry.durationMs, 2)
        }));
      const errors = findActionErrors(span, errorEvents, screenshotLookaheadMs, errorLimit);
      const triggerEvent = scopedById.get(span.triggerEventId);
      const screenshot = findActionScreenshot(span, screenshots, screenshotLookaheadMs);

      return {
        actId: span.actId,
        triggerEventId: span.triggerEventId,
        triggerType: triggerEvent?.type ?? null,
        startMono: span.startMono,
        endMono: span.endMono,
        durationMs: roundTo(span.endMono - span.startMono, 2),
        eventCount: span.eventIds.length,
        requestCount: span.requestCount,
        errorCount: span.errorCount,
        requests,
        errors,
        screenshot
      };
    });
  }

  /** Builds trusted-replay diagnostics by joining actions with network, errors, and screenshot evidence. */
  public getReplayDiagnostics(
    options: {
      range?: PlayerRange;
      limit?: number;
      actions?: ActionTimelineEntry[];
      waterfall?: NetworkWaterfallEntry[];
    } = {}
  ): ReplayDiagnosticEntry[] {
    const limit = Math.max(1, options.limit ?? Number.POSITIVE_INFINITY);
    const actions = (
      options.actions ??
      this.getActionTimeline({
        range: options.range,
        limit
      })
    ).slice(0, limit);
    const waterfall = options.waterfall ?? this.getNetworkWaterfall(options.range);
    const requestById = new Map(waterfall.map((entry) => [entry.reqId, entry]));

    return actions.map((action) => {
      const requestResponseDiffs = action.requests.map((request) => {
        const full = requestById.get(request.reqId);

        return {
          reqId: request.reqId,
          method: request.method,
          url: request.url,
          capturedStatus: request.status,
          failed: request.failed,
          hasRequestBody: Boolean(full?.requestBodyText),
          hasResponseBody: Boolean(full?.responseBodyHash),
          responseBodySize: full?.responseBodySize ?? null
        };
      });
      const errorMessages = action.errors
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message));
      const causeChain = buildReplayCauseChain(action, requestResponseDiffs, errorMessages);

      return {
        actId: action.actId,
        confidence: resolveReplayConfidence(action, requestResponseDiffs),
        triggerEventId: action.triggerEventId,
        triggerType: action.triggerType,
        causeChain,
        requestResponseDiffs,
        errorMessages,
        screenshotEventId: action.screenshot?.eventId ?? null
      };
    });
  }

  /** Returns normalized network waterfall entries sorted by start time. */
  public getNetworkWaterfall(range?: PlayerRange): NetworkWaterfallEntry[] {
    if (isRangeUnbounded(range) && this.allNetworkWaterfallCache) {
      return this.allNetworkWaterfallCache;
    }

    const scoped = this.query({ range }).filter((event) => NETWORK_EVENT_TYPES.has(event.type));
    const buckets = collectNetworkBuckets(scoped);

    const waterfall = buckets
      .map((bucket) => toNetworkEntry(bucket))
      .sort(
        (left, right) => left.startMono - right.startMono || left.reqId.localeCompare(right.reqId)
      );

    if (isRangeUnbounded(range)) {
      this.allNetworkWaterfallCache = waterfall;
    }

    return waterfall;
  }

  /** Returns all events that reference a specific request id. */
  public getRequestEvents(reqId: string): WebBlackboxEvent[] {
    return this.query({ requestId: reqId }).sort((left, right) => left.mono - right.mono);
  }

  /** Builds a concrete request/response diff including body sizes and missing replay inputs. */
  public async getRequestResponseDiff(reqId: string): Promise<RequestResponseDiff | null> {
    const entry = this.getNetworkWaterfall().find((item) => item.reqId === reqId);

    if (!entry) {
      return null;
    }

    const responseBody = entry.responseBodyHash ? await this.getBlob(entry.responseBodyHash) : null;
    const requestBodyBytes = byteLengthUtf8(entry.requestBodyText ?? "");
    const responseBodyBytes = responseBody?.bytes.byteLength ?? 0;
    const missingReplayInputs = [];

    if (!entry.requestBodyText && !["GET", "HEAD"].includes(entry.method.toUpperCase())) {
      missingReplayInputs.push("request-body");
    }

    if (!entry.responseBodyHash) {
      missingReplayInputs.push("response-body");
    }

    return {
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: entry.status ?? null,
      requestBodyBytes,
      responseBodyBytes,
      bodySizeDeltaBytes: responseBodyBytes - requestBodyBytes,
      requestHeaderNames: Object.keys(entry.requestHeaders).sort(),
      responseHeaderNames: Object.keys(entry.responseHeaders).sort(),
      missingReplayInputs
    };
  }

  /** Returns realtime network stream entries (WebSocket/SSE). */
  public getRealtimeNetworkTimeline(range?: PlayerRange): RealtimeNetworkEntry[] {
    return this.query({ range })
      .filter(
        (event) => event.type.startsWith("network.ws.") || event.type === "network.sse.message"
      )
      .map((event) => {
        const payload = asRecord(event.data);
        const frame = asRecord(payload?.frame);
        const protocol: RealtimeNetworkEntry["protocol"] = event.type.startsWith("network.ws.")
          ? "ws"
          : "sse";

        return {
          eventId: event.id,
          eventType: event.type,
          protocol,
          mono: event.mono,
          t: event.t,
          streamId:
            asString(payload?.requestId) ?? asString(payload?.reqId) ?? asString(payload?.streamId),
          direction: readRealtimeDirection(payload),
          phase: asString(payload?.phase),
          url: asString(payload?.url),
          opcode: asNumber(frame?.opcode) ?? asNumber(asRecord(payload?.response)?.opcode),
          payloadLength: asNumber(frame?.payloadLength),
          payloadPreview:
            asString(frame?.payloadPreview) ??
            asString(payload?.data) ??
            asString(asRecord(payload?.response)?.payloadData),
          snapshot: payload
        };
      })
      .sort((left, right) => left.mono - right.mono);
  }

  /** Returns storage timeline entries (cookie/local/session/idb/cache/sw). */
  public getStorageTimeline(range?: PlayerRange): StorageTimelineEntry[] {
    if (isRangeUnbounded(range) && this.allStorageTimelineCache) {
      return this.allStorageTimelineCache;
    }

    const timeline = this.query({ range })
      .filter((event) => STORAGE_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix)))
      .map((event) => {
        const payload = asRecord(event.data);

        return {
          eventId: event.id,
          eventType: event.type,
          t: event.t,
          mono: event.mono,
          kind: detectStorageKind(event.type),
          operation: asString(payload?.op),
          hash: asString(payload?.hash) ?? asString(payload?.schemaHash),
          mode: asString(payload?.mode),
          count: asNumber(payload?.count),
          reason: asString(payload?.reason),
          snapshot: payload
        };
      })
      .sort((left, right) => left.mono - right.mono);

    if (isRangeUnbounded(range)) {
      this.allStorageTimelineCache = timeline;
    }

    return timeline;
  }

  /** Returns collected performance artifacts (trace/cpu/heap/vitals/longtask). */
  public getPerformanceArtifacts(range?: PlayerRange): PerformanceArtifactEntry[] {
    if (isRangeUnbounded(range) && this.allPerformanceArtifactsCache) {
      return this.allPerformanceArtifactsCache;
    }

    const artifacts = this.query({ range })
      .filter((event) => event.type.startsWith("perf."))
      .map((event) => {
        const payload = asRecord(event.data);

        return {
          eventId: event.id,
          eventType: event.type,
          t: event.t,
          mono: event.mono,
          kind: detectPerformanceKind(event.type),
          hash:
            asString(payload?.traceHash) ??
            asString(payload?.profileHash) ??
            asString(payload?.snapshotHash) ??
            asString(payload?.contentHash),
          size: asNumber(payload?.size) ?? asNumber(payload?.sampledSize),
          reason: asString(payload?.reason),
          snapshot: payload
        };
      })
      .sort((left, right) => left.mono - right.mono);

    if (isRangeUnbounded(range)) {
      this.allPerformanceArtifactsCache = artifacts;
    }

    return artifacts;
  }

  /** Returns DOM snapshot references ordered by monotonic time. */
  public getDomSnapshots(range?: PlayerRange): DomSnapshotRef[] {
    return this.query({ range })
      .filter((event) => event.type === "dom.snapshot")
      .map((event) => {
        const payload = asRecord(event.data);

        return {
          eventId: event.id,
          mono: event.mono,
          t: event.t,
          snapshotId: asString(payload?.snapshotId),
          contentHash: asString(payload?.contentHash),
          source: asString(payload?.source),
          nodeCount: asNumber(payload?.nodeCount),
          reason: asString(payload?.reason)
        };
      })
      .sort((left, right) => left.mono - right.mono);
  }

  /** Computes sequential diffs across the DOM snapshot timeline. */
  public async getDomDiffTimeline(options: DomDiffTimelineOptions = {}): Promise<DomDiffResult[]> {
    const snapshots = this.getDomSnapshots(options.range);

    if (snapshots.length < 2) {
      return [];
    }

    const start = Math.max(1, snapshots.length - Math.max(1, options.limit ?? snapshots.length));
    const diffs: DomDiffResult[] = [];

    for (let index = start; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];

      if (!previous || !current) {
        continue;
      }

      const diff = await this.compareDomSnapshots(previous.eventId, current.eventId);

      if (diff) {
        diffs.push(diff);
      }
    }

    return diffs;
  }

  /** Compares two snapshots from this player by event id. */
  public async compareDomSnapshots(
    previousEventId: string,
    currentEventId: string
  ): Promise<DomDiffResult | null> {
    const previous = this.getDomSnapshots().find((entry) => entry.eventId === previousEventId);
    const current = this.getDomSnapshots().find((entry) => entry.eventId === currentEventId);

    if (!previous || !current) {
      return null;
    }

    const previousPaths = await this.loadDomPaths(previous);
    const currentPaths = await this.loadDomPaths(current);

    return buildDomDiff(previous, current, previousPaths, currentPaths);
  }

  /** Compares latest DOM snapshots across two players. */
  public async compareLatestDomSnapshotWith(
    other: WebBlackboxPlayer
  ): Promise<DomDiffResult | null> {
    const left = this.getDomSnapshots();
    const right = other.getDomSnapshots();
    const previous = left[left.length - 1];
    const current = right[right.length - 1];

    if (!previous || !current) {
      return null;
    }

    const previousPaths = await this.loadDomPaths(previous);
    const currentPaths = await other.loadDomPaths(current);

    return buildDomDiff(previous, current, previousPaths, currentPaths);
  }

  /** Compares two sessions by event/request/error deltas and endpoint regressions. */
  public compareWith(other: WebBlackboxPlayer): PlayerComparison {
    const leftEvents = this.events;
    const rightEvents = other.events;
    const leftCounts = buildTypeCounts(leftEvents);
    const rightCounts = buildTypeCounts(rightEvents);
    const types = new Set([...leftCounts.keys(), ...rightCounts.keys()]);

    const typeDeltas = [...types]
      .map((type) => {
        const left = leftCounts.get(type) ?? 0;
        const right = rightCounts.get(type) ?? 0;

        return {
          type,
          left,
          right,
          delta: right - left
        };
      })
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
    const endpointRegressions = buildEndpointRegressions(
      this.getNetworkWaterfall(),
      other.getNetworkWaterfall()
    );

    const leftSessionId = leftEvents[0]?.sid ?? this.archive.manifest.site.origin;
    const rightSessionId = rightEvents[0]?.sid ?? other.archive.manifest.site.origin;

    return {
      leftSessionId,
      rightSessionId,
      leftSid: leftSessionId,
      rightSid: rightSessionId,
      eventDelta: rightEvents.length - leftEvents.length,
      errorDelta: rightEvents.filter(isErrorEvent).length - leftEvents.filter(isErrorEvent).length,
      requestDelta:
        rightEvents.filter((event) => event.type === "network.request").length -
        leftEvents.filter((event) => event.type === "network.request").length,
      durationDeltaMs: computeDuration(rightEvents) - computeDuration(leftEvents),
      typeDeltas,
      endpointRegressions
    };
  }

  /** Compares storage timelines across two sessions. */
  public compareStorageWith(other: WebBlackboxPlayer): StorageComparison {
    const left = this.getStorageTimeline();
    const right = other.getStorageTimeline();

    const kinds: Array<StorageTimelineEntry["kind"]> = [
      "cookie",
      "local",
      "session",
      "idb",
      "cache",
      "sw",
      "unknown"
    ];

    const kindDeltas = kinds.map((kind) => {
      const leftCount = left.filter((entry) => entry.kind === kind).length;
      const rightCount = right.filter((entry) => entry.kind === kind).length;

      return {
        kind,
        left: leftCount,
        right: rightCount,
        delta: rightCount - leftCount
      };
    });

    const leftHashes = new Set(
      left.map((entry) => entry.hash).filter((value): value is string => Boolean(value))
    );
    const rightHashes = new Set(
      right.map((entry) => entry.hash).filter((value): value is string => Boolean(value))
    );

    const hashOnlyLeft = [...leftHashes].filter((hash) => !rightHashes.has(hash)).sort();
    const hashOnlyRight = [...rightHashes].filter((hash) => !leftHashes.has(hash)).sort();

    return {
      leftEvents: left.length,
      rightEvents: right.length,
      kindDeltas,
      hashOnlyLeft,
      hashOnlyRight
    };
  }

  /** Generates a curl replay command for a recorded network request. */
  public generateCurl(reqId: string): string | null {
    const entry = this.getNetworkWaterfall().find((item) => item.reqId === reqId);

    if (!entry) {
      return null;
    }

    const lines = [
      `curl ${shellQuote(entry.url)} \\`,
      `  -X ${shellQuote(entry.method.toUpperCase())} \\`
    ];

    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
    }

    if (entry.requestBodyText) {
      lines.push(`  --data-raw ${shellQuote(entry.requestBodyText)} \\`);
    }

    lines.push("  --compressed");

    return lines.join("\n");
  }

  /** Generates a fetch replay snippet for a recorded network request. */
  public generateFetch(reqId: string): string | null {
    const entry = this.getNetworkWaterfall().find((item) => item.reqId === reqId);

    if (!entry) {
      return null;
    }

    const options: Record<string, unknown> = {
      method: entry.method.toUpperCase(),
      headers: entry.requestHeaders
    };

    if (entry.requestBodyText) {
      options.body = entry.requestBodyText;
    }

    return `await fetch(${JSON.stringify(entry.url)}, ${JSON.stringify(options, null, 2)});`;
  }

  /** Exports a HAR 1.2 document, including captured response bodies, from network events. */
  public async exportHar(range?: PlayerRange): Promise<string> {
    const entries = await Promise.all(
      this.getNetworkWaterfall(range).map(async (entry) => {
        const responseBody = entry.responseBodyHash
          ? await this.getBlob(entry.responseBodyHash)
          : null;
        return toHarEntry(entry, responseBody ?? undefined);
      })
    );
    const started = new Date(this.events[0]?.t ?? Date.now()).toISOString();

    const har = {
      log: {
        version: "1.2",
        creator: {
          name: "WebBlackbox",
          version: "1.0.0"
        },
        pages: [
          {
            startedDateTime: started,
            id: "page_1",
            title: this.archive.manifest.site.title ?? this.archive.manifest.site.origin,
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1
            }
          }
        ],
        entries
      }
    };

    return JSON.stringify(har, null, 2);
  }

  /** Generates a Markdown bug report for the selected range. */
  public generateBugReport(options: BugReportOptions = {}): string {
    const maxItems = Math.max(5, options.maxItems ?? 20);
    const scoped = this.query({ range: options.range });
    const errors = scoped.filter(isErrorEvent).slice(0, maxItems);
    const markers = scoped.filter((event) => event.type === "user.marker").slice(0, maxItems);
    const failedRequests = this.getNetworkWaterfall(options.range)
      .filter((entry) => entry.failed || (entry.status !== undefined && entry.status >= 400))
      .slice(0, maxItems);
    const slowRequests = this.getNetworkWaterfall(options.range)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, maxItems);
    const replayDiagnostics = this.getReplayDiagnostics({
      range: options.range,
      limit: Math.min(maxItems, 10)
    });

    const heading = options.title ?? "WebBlackbox Bug Report";
    const derived = this.buildDerived(options.range);

    return [
      `# ${heading}`,
      "",
      "## Session",
      `- Origin: ${this.archive.manifest.site.origin}`,
      `- Mode: ${this.archive.manifest.mode}`,
      `- Visible Events: ${scoped.length}`,
      `- Action Spans: ${derived.actionSpans.length}`,
      `- Errors: ${derived.totals.errors}`,
      `- Requests: ${derived.totals.requests}`,
      "",
      "## Markers",
      markers.length === 0
        ? "- None"
        : markers
            .map((event) => `- ${event.id} @ ${event.mono.toFixed(2)}ms ${compactEventText(event)}`)
            .join("\n"),
      "",
      "## Errors",
      errors.length === 0
        ? "- None"
        : errors
            .map((event) => `- ${event.id} @ ${event.mono.toFixed(2)}ms ${compactEventText(event)}`)
            .join("\n"),
      "",
      "## Failed Requests",
      failedRequests.length === 0
        ? "- None"
        : failedRequests
            .map(
              (entry) =>
                `- ${entry.method} ${entry.url} -> ${entry.status ?? "FAILED"} (${entry.durationMs.toFixed(1)}ms)`
            )
            .join("\n"),
      "",
      "## Slow Requests",
      slowRequests.length === 0
        ? "- None"
        : slowRequests
            .map(
              (entry) =>
                `- ${entry.method} ${entry.url} (${entry.durationMs.toFixed(1)}ms${entry.actionId ? `, act=${entry.actionId}` : ""})`
            )
            .join("\n"),
      "",
      "## Replay Diagnostics",
      replayDiagnostics.length === 0
        ? "- None"
        : replayDiagnostics
            .map(
              (entry) =>
                `- ${entry.actId} confidence=${entry.confidence} chain=${entry.causeChain.join(" -> ")}`
            )
            .join("\n")
    ].join("\n");
  }

  /** Generates a GitHub issue template payload from session evidence. */
  public generateGitHubIssueTemplate(options: TeamIssueTemplateOptions = {}): GitHubIssueTemplate {
    const title = options.title ?? `Bug: ${this.archive.manifest.site.origin} regression`;
    const body = this.generateBugReport({
      title: `${title} - WebBlackbox Evidence`,
      range: options.range,
      maxItems: options.maxItems
    });

    return {
      title,
      body,
      labels: options.labels ?? ["bug", "webblackbox"],
      assignees: options.assignees ?? []
    };
  }

  /** Generates a Jira issue payload from session evidence. */
  public generateJiraIssueTemplate(options: TeamIssueTemplateOptions = {}): JiraIssueTemplate {
    const summary = options.title ?? `WebBlackbox: ${this.archive.manifest.site.origin} issue`;
    const description = this.generateBugReport({
      title: `${summary} - WebBlackbox Evidence`,
      range: options.range,
      maxItems: options.maxItems
    });

    return {
      fields: {
        summary,
        description,
        issuetype: {
          name: options.issueType ?? "Bug"
        },
        labels: options.labels ?? ["webblackbox", "flight-recorder"],
        project: options.projectKey
          ? {
              key: options.projectKey
            }
          : undefined,
        priority: options.priority
          ? {
              name: options.priority
            }
          : undefined
      }
    };
  }

  /** Generates a Playwright script from captured navigation and user actions. */
  public generatePlaywrightScript(options: PlaywrightScriptOptions = {}): string {
    const name = options.name ?? "replay-from-webblackbox";
    const maxActions = Math.max(1, options.maxActions ?? 40);
    const includeHarReplay = options.includeHarReplay ?? true;
    const actions = this.query({ range: options.range })
      .filter(
        (event) =>
          event.type.startsWith("user.") || event.type === "nav.commit" || event.type === "nav.hash"
      )
      .slice(0, maxActions);

    const lines = [
      "import { test } from '@playwright/test';",
      "",
      `test(${toJavaScriptStringLiteral(name)}, async ({ browser }) => {`,
      "  const context = await browser.newContext();",
      includeHarReplay
        ? "  await context.routeFromHAR('./session.har', { notFound: 'fallback' });"
        : "  // HAR replay disabled.",
      "  const page = await context.newPage();",
      `  await page.goto(${JSON.stringify(options.startUrl ?? this.archive.manifest.site.origin)});`
    ];

    for (const action of actions) {
      lines.push(...toPlaywrightLines(action));
    }

    lines.push("  await context.close();", "});");

    return lines.join("\n");
  }

  /** Generates a Playwright script with mocked network responses. */
  public async generatePlaywrightMockScript(
    options: PlaywrightMockScriptOptions = {}
  ): Promise<string> {
    const name = options.name ?? "replay-with-mocks";
    const maxActions = Math.max(1, options.maxActions ?? 40);
    const maxMocks = Math.max(1, options.maxMocks ?? 25);
    const actions = this.query({ range: options.range })
      .filter(
        (event) =>
          event.type.startsWith("user.") || event.type === "nav.commit" || event.type === "nav.hash"
      )
      .slice(0, maxActions);

    const mockEntries = this.getNetworkWaterfall(options.range)
      .filter((entry) => Boolean(entry.responseBodyHash) && typeof entry.status === "number")
      .slice(0, maxMocks);

    const lines = [
      "import { test } from '@playwright/test';",
      "",
      `test(${toJavaScriptStringLiteral(name)}, async ({ browser }) => {`,
      "  const context = await browser.newContext();"
    ];

    for (const entry of mockEntries) {
      const body = await this.readMockResponseBody(entry.responseBodyHash);

      if (!body) {
        continue;
      }

      lines.push(
        `  await context.route(${JSON.stringify(entry.url)}, async route => route.fulfill(${JSON.stringify(
          {
            status: entry.status,
            headers: sanitizeMockHeaders(entry.responseHeaders),
            body
          },
          null,
          2
        )}));`
      );
    }

    lines.push(
      "  const page = await context.newPage();",
      `  await page.goto(${JSON.stringify(options.startUrl ?? this.archive.manifest.site.origin)});`
    );

    for (const action of actions) {
      lines.push(...toPlaywrightLines(action));
    }

    lines.push("  await context.close();", "});");

    return lines.join("\n");
  }

  /** @internal */
  public async exportHarWithLimits(
    range: PlayerRange | undefined,
    limits: HarExportLimits
  ): Promise<string> {
    const resolvedLimits = resolveHarExportLimits(limits);
    const networkBuckets = this.getNetworkBucketsWithLimit(range, resolvedLimits.maxEntries);

    const started = new Date(this.eventChunks[0]?.events[0]?.t ?? Date.now()).toISOString();
    const title = this.archive.manifest.site.title ?? this.archive.manifest.site.origin;
    const titleBytes = utf8ByteLengthAtMost(title, resolvedLimits.maxEntryMetadataBytes);
    if (titleBytes > resolvedLimits.maxEntryMetadataBytes) {
      throw new HarExportResourceLimitError(
        "maxEntryMetadataBytes",
        resolvedLimits.maxEntryMetadataBytes,
        titleBytes,
        0,
        0
      );
    }

    const writer = new BoundedHarJsonWriter(resolvedLimits);
    writer.append(
      `{"log":{"version":"1.2","creator":{"name":"WebBlackbox","version":"1.0.0"},"pages":[${JSON.stringify(
        {
          startedDateTime: started,
          id: "page_1",
          title,
          pageTimings: {
            onContentLoad: -1,
            onLoad: -1
          }
        }
      )}],"entries":[`,
      0,
      0
    );

    let completedEntries = 0;
    let totalBodyBytes = 0;

    for (const bucket of networkBuckets) {
      const entry = toNetworkEntry(bucket);
      assertHarEntryMetadataBudget(entry, resolvedLimits, completedEntries, totalBodyBytes);
      assertHarEntryFieldBudget(entry, resolvedLimits, completedEntries, totalBodyBytes);

      let responseBody: PlayerBlob | null = null;
      if (entry.responseBodyHash) {
        const remainingBodyBytes = resolvedLimits.maxTotalBodyBytes - totalBodyBytes;
        if (remainingBodyBytes <= 0) {
          throw new HarExportResourceLimitError(
            "maxTotalBodyBytes",
            resolvedLimits.maxTotalBodyBytes,
            totalBodyBytes + 1,
            completedEntries,
            totalBodyBytes
          );
        }

        const bodyLimit = Math.min(resolvedLimits.maxBodyBytes, remainingBodyBytes);
        try {
          responseBody = await this.readHarResponseBody(entry.responseBodyHash, bodyLimit);
        } catch (error) {
          if (!(error instanceof ArchiveEntryReadLimitError)) {
            throw error;
          }

          const resource =
            bodyLimit < resolvedLimits.maxBodyBytes ? "maxTotalBodyBytes" : "maxBodyBytes";
          const actual =
            resource === "maxTotalBodyBytes" ? totalBodyBytes + error.actual : error.actual;
          throw new HarExportResourceLimitError(
            resource,
            resolvedLimits[resource],
            actual,
            completedEntries,
            totalBodyBytes + Math.min(error.actual, bodyLimit)
          );
        }

        if (responseBody) {
          totalBodyBytes += responseBody.bytes.byteLength;
        }
      }

      const serializedEntry = JSON.stringify(toHarEntry(entry, responseBody ?? undefined));
      writer.append(
        `${completedEntries === 0 ? "" : ","}${serializedEntry}`,
        completedEntries,
        totalBodyBytes
      );
      completedEntries += 1;
    }

    writer.append("]}}", completedEntries, totalBodyBytes);
    return writer.finish();
  }

  private async loadDomPaths(snapshot: DomSnapshotRef): Promise<Set<string>> {
    if (snapshot.contentHash) {
      const blob = await this.getBlob(snapshot.contentHash);

      if (blob) {
        const text = new TextDecoder().decode(blob.bytes);

        if (blob.mime === "application/json") {
          try {
            const parsed = JSON.parse(text) as unknown;
            const fromCdp = extractCdpDomPaths(parsed);

            if (fromCdp.size > 0) {
              return fromCdp;
            }
          } catch {
            return new Set();
          }
        }

        if (blob.mime === "text/html" || snapshot.source === "html") {
          return extractHtmlPaths(text);
        }
      }
    }

    const event = this.findEventById(snapshot.eventId);
    const payload = asRecord(event?.data);
    const htmlSnippet = asString(payload?.htmlSnippet);

    if (!htmlSnippet) {
      return new Set();
    }

    return extractHtmlPaths(htmlSnippet);
  }

  private async readMockResponseBody(hash?: string): Promise<string | null> {
    if (!hash) {
      return null;
    }

    const blob = await this.getBlob(hash);

    if (!blob) {
      return null;
    }

    const text = new TextDecoder().decode(blob.bytes);

    if (text.trim().length === 0) {
      return null;
    }

    return text;
  }

  private async decryptArchiveFile(path: string, bytes: Uint8Array): Promise<Uint8Array> {
    const encryptedFile = this.encryptedFiles[path];

    if (!encryptedFile) {
      return bytes;
    }

    if (!this.archiveKey) {
      throw new Error("Archive is encrypted. Missing decryption key.");
    }

    try {
      return decryptBytes(bytes, this.archiveKey, fromBase64(encryptedFile.ivBase64));
    } catch {
      throw new Error("Unable to decrypt archive content. The passphrase may be invalid.");
    }
  }

  private async readHarResponseBody(hash: string, maxBytes: number): Promise<PlayerBlob | null> {
    const blob = resolveBlobByKey(this.blobsByHash, hash);
    if (!blob || !this.zipReader.has(blob.path)) {
      return null;
    }

    const encryptionOverhead = this.encryptedFiles[blob.path] ? 16 : 0;
    const storedByteLimit = addSafeInteger(maxBytes, encryptionOverhead);
    let rawBytes: Uint8Array;

    try {
      rawBytes = await this.zipReader.readBounded(blob.path, storedByteLimit);
    } catch (error) {
      if (error instanceof ArchiveEntryReadLimitError) {
        throw new ArchiveEntryReadLimitError(
          blob.path,
          maxBytes,
          Math.max(0, error.actual - encryptionOverhead)
        );
      }
      throw error;
    }

    await assertArchiveFileIntegrity(this.archive.integrity, blob.path, rawBytes);
    const bytes = await this.decryptArchiveFile(blob.path, rawBytes);
    if (bytes.byteLength > maxBytes) {
      throw new ArchiveEntryReadLimitError(blob.path, maxBytes, bytes.byteLength);
    }

    return {
      mime: blob.mime,
      bytes
    };
  }

  private getNetworkBucketsWithLimit(
    range: PlayerRange | undefined,
    maxEntries: number
  ): MutableNetworkBucket[] {
    const buckets = new Map<string, MutableNetworkBucket>();

    for (const chunk of this.getChunksForRange(range)) {
      for (const event of this.getChunkEvents(chunk)) {
        if (!withinRange(event, range) || !NETWORK_EVENT_TYPES.has(event.type)) {
          continue;
        }

        const reqId = extractRequestId(event);
        if (!reqId) {
          continue;
        }
        if (!buckets.has(reqId) && buckets.size >= maxEntries) {
          throw new HarExportResourceLimitError("maxEntries", maxEntries, maxEntries + 1, 0, 0);
        }

        addNetworkEventToBuckets(buckets, event, reqId, false);
      }
    }

    return [...buckets.values()].sort(
      (left, right) => left.startMono - right.startMono || left.reqId.localeCompare(right.reqId)
    );
  }
}

/** Returns the default pre-open player status. */
export function getDefaultPlayerStatus(): PlayerStatus {
  return "idle";
}

type MutableNetworkBucket = {
  reqId: string;
  events: WebBlackboxEvent[];
  request?: WebBlackboxEvent;
  response?: WebBlackboxEvent;
  finished?: WebBlackboxEvent;
  failed?: WebBlackboxEvent;
  body?: WebBlackboxEvent;
  startMono: number;
  endMono: number;
  startWallTime: number;
  endWallTime: number;
  actionId?: string;
};

function collectNetworkBuckets(events: WebBlackboxEvent[]): MutableNetworkBucket[] {
  const buckets = new Map<string, MutableNetworkBucket>();

  for (const event of events) {
    const reqId = extractRequestId(event);

    if (!reqId) {
      continue;
    }

    addNetworkEventToBuckets(buckets, event, reqId);
  }

  return [...buckets.values()];
}

function addNetworkEventToBuckets(
  buckets: Map<string, MutableNetworkBucket>,
  event: WebBlackboxEvent,
  reqId: string,
  includeEventId = true
): void {
  const bucket = buckets.get(reqId) ?? {
    reqId,
    events: [],
    startMono: event.mono,
    endMono: event.mono,
    startWallTime: event.t,
    endWallTime: event.t
  };

  if (includeEventId) {
    bucket.events.push(event);
  }
  bucket.startMono = Math.min(bucket.startMono, event.mono);
  bucket.endMono = Math.max(bucket.endMono, event.mono);
  bucket.startWallTime = Math.min(bucket.startWallTime, event.t);
  bucket.endWallTime = Math.max(bucket.endWallTime, event.t);

  if (!bucket.actionId && event.ref?.act) {
    bucket.actionId = event.ref.act;
  }

  if (event.type === "network.request" && !bucket.request) {
    bucket.request = event;
  }

  if (event.type === "network.response") {
    bucket.response = event;
  }

  if (event.type === "network.finished") {
    bucket.finished = event;
  }

  if (event.type === "network.failed") {
    bucket.failed = event;
  }

  if (event.type === "network.body") {
    bucket.body = event;
  }

  buckets.set(reqId, bucket);
}

function toNetworkEntry(bucket: MutableNetworkBucket): NetworkWaterfallEntry {
  const requestPayload = asRecord(bucket.request?.data);
  const responsePayload = asRecord(bucket.response?.data);
  const finishedPayload = asRecord(bucket.finished?.data);
  const failedPayload = asRecord(bucket.failed?.data);
  const bodyPayload = asRecord(bucket.body?.data);

  const requestObject = asRecord(requestPayload?.request);
  const responseObject = asRecord(responsePayload?.response);

  const method =
    asString(requestObject?.method) ??
    asString(requestPayload?.method) ??
    asString(responsePayload?.method) ??
    "GET";
  const url =
    asString(requestObject?.url) ??
    asString(requestPayload?.url) ??
    asString(responseObject?.url) ??
    asString(responsePayload?.url) ??
    "unknown://request";

  const status = asNumber(responseObject?.status) ?? asNumber(responsePayload?.status);
  const statusText = asString(responseObject?.statusText) ?? asString(responsePayload?.statusText);
  const mimeType = asString(responseObject?.mimeType) ?? asString(responsePayload?.mimeType);
  const encodedDataLength =
    asNumber(responseObject?.encodedDataLength) ??
    asNumber(responsePayload?.encodedDataLength) ??
    asNumber(finishedPayload?.encodedDataLength);

  const requestHeaders = normalizeHeaders(requestObject?.headers ?? requestPayload?.headers);
  const responseHeaders = normalizeHeaders(responseObject?.headers ?? responsePayload?.headers);

  const requestBodyText =
    asString(requestObject?.postData) ??
    asString(requestPayload?.postData) ??
    asString(requestPayload?.body) ??
    undefined;

  const durationFromPayload =
    asNumber(responsePayload?.duration) ??
    asNumber(finishedPayload?.duration) ??
    asNumber(failedPayload?.duration);

  const durationMs = Math.max(0, durationFromPayload ?? bucket.endMono - bucket.startMono);

  return {
    reqId: bucket.reqId,
    url,
    method,
    status,
    statusText,
    mimeType,
    startMono: bucket.startMono,
    endMono: bucket.endMono,
    durationMs,
    startWallTime: bucket.startWallTime,
    endWallTime: bucket.endWallTime,
    failed: Boolean(bucket.failed),
    errorText: asString(failedPayload?.errorText) ?? asString(failedPayload?.message),
    actionId: bucket.actionId,
    encodedDataLength,
    requestHeaders,
    responseHeaders,
    requestBodyText,
    responseBodyHash: asString(bodyPayload?.contentHash),
    responseBodySize: asNumber(bodyPayload?.size) ?? asNumber(bodyPayload?.sampledSize),
    eventIds: bucket.events.map((event) => event.id)
  };
}

function detectStorageKind(type: WebBlackboxEventType): StorageTimelineEntry["kind"] {
  if (type.startsWith("storage.cookie.")) {
    return "cookie";
  }

  if (type.startsWith("storage.local.")) {
    return "local";
  }

  if (type.startsWith("storage.session.")) {
    return "session";
  }

  if (type.startsWith("storage.idb.")) {
    return "idb";
  }

  if (type.startsWith("storage.cache.")) {
    return "cache";
  }

  if (type.startsWith("storage.sw.")) {
    return "sw";
  }

  return "unknown";
}

function detectPerformanceKind(type: WebBlackboxEventType): PerformanceArtifactEntry["kind"] {
  if (type === "perf.trace") {
    return "trace";
  }

  if (type === "perf.cpu.profile") {
    return "cpu";
  }

  if (type === "perf.heap.snapshot") {
    return "heap";
  }

  if (type === "perf.longtask") {
    return "longtask";
  }

  if (type === "perf.vitals") {
    return "vitals";
  }

  return "other";
}

function readRealtimeDirection(
  payload: Record<string, unknown> | null
): RealtimeNetworkEntry["direction"] {
  const explicitDirection = asString(payload?.direction);

  if (explicitDirection === "sent" || explicitDirection === "received") {
    return explicitDirection;
  }

  return explicitDirection ? "unknown" : undefined;
}

function buildTypeCounts(events: WebBlackboxEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  return counts;
}

function computeDuration(events: WebBlackboxEvent[]): number {
  if (events.length === 0) {
    return 0;
  }

  const sorted = [...events].sort((left, right) => left.mono - right.mono);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (!first || !last) {
    return 0;
  }

  return Math.max(0, last.mono - first.mono);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readEventMessage(event: WebBlackboxEvent): string | null {
  const payload = asRecord(event.data);
  const message =
    asString(payload?.message) ??
    asString(payload?.text) ??
    asString(payload?.errorText) ??
    asString(payload?.reason);

  return message ? compactText(message, 300) : null;
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function compareEventsByMono(left: WebBlackboxEvent, right: WebBlackboxEvent): number {
  return left.mono - right.mono || left.id.localeCompare(right.id);
}

function isErrorEvent(event: WebBlackboxEvent): boolean {
  return event.type.startsWith("error.") || event.lvl === "error";
}

function findActionErrors(
  span: ActionSpan,
  errorEvents: WebBlackboxEvent[],
  lookaheadMs: number,
  limit: number
): ActionTimelineEntry["errors"] {
  const errors: ActionTimelineEntry["errors"] = [];
  const endMono = span.endMono + lookaheadMs;

  for (
    let index = lowerBoundEventMono(errorEvents, span.startMono);
    index < errorEvents.length;
    index += 1
  ) {
    const event = errorEvents[index];

    if (!event) {
      continue;
    }

    if (event.mono > endMono || errors.length >= limit) {
      break;
    }

    errors.push({
      eventId: event.id,
      type: event.type,
      mono: event.mono,
      message: readEventMessage(event)
    });
  }

  return errors;
}

function findActionScreenshot(
  span: ActionSpan,
  screenshots: WebBlackboxEvent[],
  lookaheadMs: number
): ActionTimelineEntry["screenshot"] {
  const firstInSpan = lowerBoundEventMono(screenshots, span.startMono);
  const firstAfterSpan = upperBoundEventMono(screenshots, span.endMono);
  const inSpan = firstAfterSpan > firstInSpan ? screenshots[firstAfterSpan - 1] : undefined;
  const afterSpan = screenshots[firstAfterSpan];
  const chosen =
    inSpan ?? (afterSpan && afterSpan.mono <= span.endMono + lookaheadMs ? afterSpan : undefined);

  if (!chosen) {
    return null;
  }

  const payload = asRecord(chosen.data);
  return {
    eventId: chosen.id,
    mono: chosen.mono,
    shotId: asString(payload?.shotId) ?? null,
    reason: asString(payload?.reason) ?? null,
    format: asString(payload?.format) ?? null,
    size: asNumber(payload?.size) ?? null
  };
}

function lowerBoundEventMono(events: WebBlackboxEvent[], mono: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if ((events[mid]?.mono ?? Number.POSITIVE_INFINITY) < mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function upperBoundEventMono(events: WebBlackboxEvent[], mono: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if ((events[mid]?.mono ?? Number.POSITIVE_INFINITY) <= mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function buildEndpointRegressions(
  leftEntries: NetworkWaterfallEntry[],
  rightEntries: NetworkWaterfallEntry[]
): PlayerComparison["endpointRegressions"] {
  const leftStats = buildEndpointStats(leftEntries);
  const rightStats = buildEndpointStats(rightEntries);
  const keys = new Set([...leftStats.keys(), ...rightStats.keys()]);
  const regressions: PlayerComparison["endpointRegressions"] = [];

  for (const key of keys) {
    const left = leftStats.get(key) ?? emptyEndpointStatFromKey(key);
    const right = rightStats.get(key) ?? emptyEndpointStatFromKey(key);
    const leftFailureRate = roundTo(left.count > 0 ? left.failed / left.count : 0, 4);
    const rightFailureRate = roundTo(right.count > 0 ? right.failed / right.count : 0, 4);
    const leftP95DurationMs = roundTo(percentile(left.durations, 95), 2);
    const rightP95DurationMs = roundTo(percentile(right.durations, 95), 2);
    const countDelta = right.count - left.count;
    const failedDelta = right.failed - left.failed;
    const failureRateDelta = roundTo(rightFailureRate - leftFailureRate, 4);
    const p95DurationDeltaMs = roundTo(rightP95DurationMs - leftP95DurationMs, 2);

    if (
      countDelta === 0 &&
      failedDelta === 0 &&
      failureRateDelta === 0 &&
      p95DurationDeltaMs === 0
    ) {
      continue;
    }

    regressions.push({
      endpoint: left.endpoint,
      method: left.method,
      leftCount: left.count,
      rightCount: right.count,
      countDelta,
      leftFailed: left.failed,
      rightFailed: right.failed,
      failedDelta,
      leftFailureRate,
      rightFailureRate,
      failureRateDelta,
      leftP95DurationMs,
      rightP95DurationMs,
      p95DurationDeltaMs
    });
  }

  return regressions.sort(
    (left, right) =>
      Math.abs(right.failureRateDelta) - Math.abs(left.failureRateDelta) ||
      Math.abs(right.p95DurationDeltaMs) - Math.abs(left.p95DurationDeltaMs) ||
      Math.abs(right.countDelta) - Math.abs(left.countDelta) ||
      left.method.localeCompare(right.method) ||
      left.endpoint.localeCompare(right.endpoint)
  );
}

type EndpointStat = {
  endpoint: string;
  method: string;
  count: number;
  failed: number;
  durations: number[];
};

function buildEndpointStats(entries: NetworkWaterfallEntry[]): Map<string, EndpointStat> {
  const stats = new Map<string, EndpointStat>();

  for (const entry of entries) {
    const key = toEndpointKey(entry.method, entry.url);
    const current = stats.get(key);

    if (!current) {
      stats.set(key, {
        endpoint: normalizeEndpoint(entry.url),
        method: entry.method.toUpperCase(),
        count: 1,
        failed: isFailedNetworkEntry(entry) ? 1 : 0,
        durations: [entry.durationMs]
      });
      continue;
    }

    current.count += 1;
    current.failed += isFailedNetworkEntry(entry) ? 1 : 0;
    current.durations.push(entry.durationMs);
  }

  return stats;
}

function emptyEndpointStatFromKey(key: string): EndpointStat {
  const [method = "GET", ...rest] = key.split(" ");
  return {
    endpoint: rest.join(" "),
    method,
    count: 0,
    failed: 0,
    durations: []
  };
}

function toEndpointKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeEndpoint(url)}`;
}

function normalizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  }
}

function isFailedNetworkEntry(entry: { failed: boolean; status?: number }): boolean {
  return entry.failed || (typeof entry.status === "number" && entry.status >= 400);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function compactEventText(event: WebBlackboxEvent): string {
  const payload = asRecord(event.data);
  const message =
    asString(payload?.message) ??
    asString(payload?.text) ??
    asString(payload?.url) ??
    asString(payload?.reason) ??
    asString(payload?.op);

  if (message) {
    return message;
  }

  const text = JSON.stringify(event.data);
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function toPlaywrightLines(event: WebBlackboxEvent): string[] {
  if (event.type === "nav.commit") {
    const payload = asRecord(event.data);
    const url = asString(payload?.url);
    return url ? [`  await page.goto(${JSON.stringify(url)});`] : [];
  }

  if (event.type === "nav.hash") {
    const payload = asRecord(event.data);
    const url = asString(payload?.url);
    return url ? [`  await page.goto(${JSON.stringify(url)});`] : [];
  }

  if (event.type === "user.click" || event.type === "user.dblclick") {
    const selector = readSelector(event);

    if (!selector) {
      return [`  // ${event.type} skipped (no selector)`];
    }

    const method = event.type === "user.dblclick" ? "dblclick" : "click";
    return [`  await page.${method}(${JSON.stringify(selector)});`];
  }

  if (event.type === "user.input") {
    const selector = readSelector(event);
    const payload = asRecord(event.data);
    const value = asString(payload?.value);

    if (!selector) {
      return [`  // input skipped (no selector)`];
    }

    if (!value || value === "[MASKED]") {
      return [`  // input on ${toSingleLineCommentText(selector)} was masked in capture`];
    }

    return [`  await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)});`];
  }

  if (event.type === "user.scroll") {
    const payload = asRecord(event.data);
    const x = asNumber(payload?.scrollX) ?? 0;
    const y = asNumber(payload?.scrollY) ?? 0;

    return [`  await page.evaluate(([x, y]) => window.scrollTo(x, y), [${x}, ${y}] as const);`];
  }

  if (event.type === "user.keydown") {
    const payload = asRecord(event.data);
    const key = asString(payload?.key);

    if (!key) {
      return [];
    }

    return [`  await page.keyboard.press(${JSON.stringify(key)});`];
  }

  if (event.type === "user.marker") {
    return ["  // Marker captured during session"];
  }

  return [];
}

function toJavaScriptStringLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function toSingleLineCommentText(value: string): string {
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint < 32 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029)
        ? " "
        : character;
    })
    .join("");
  const sanitized = withoutControls.replace(/\s+/g, " ").trim().slice(0, 240);

  return sanitized || "[redacted selector]";
}

function readSelector(event: WebBlackboxEvent): string | null {
  const payload = asRecord(event.data);
  const target = asRecord(payload?.target);
  const selector = asString(target?.selector);

  if (!selector || selector === "unknown") {
    return null;
  }

  return selector;
}

function toHarEntry(
  entry: NetworkWaterfallEntry,
  responseBody?: { mime: string; bytes: Uint8Array }
): Record<string, unknown> {
  const queryString = parseQueryString(entry.url);
  const requestCookies = parseCookieHeader(entry.requestHeaders.cookie);
  const responseCookies = parseSetCookieHeader(entry.responseHeaders["set-cookie"]);

  const postData = entry.requestBodyText
    ? {
        mimeType: entry.requestHeaders["content-type"] ?? "application/octet-stream",
        text: entry.requestBodyText
      }
    : undefined;

  return {
    pageref: "page_1",
    startedDateTime: new Date(entry.startWallTime).toISOString(),
    time: entry.durationMs,
    request: {
      method: entry.method.toUpperCase(),
      url: entry.url,
      httpVersion: "HTTP/1.1",
      cookies: requestCookies,
      headers: headersToHarArray(entry.requestHeaders),
      queryString,
      postData,
      headersSize: -1,
      bodySize: entry.requestBodyText?.length ?? -1
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? "",
      httpVersion: "HTTP/1.1",
      cookies: responseCookies,
      headers: headersToHarArray(entry.responseHeaders),
      content: buildHarResponseContent(entry, responseBody),
      redirectURL: entry.responseHeaders.location ?? "",
      headersSize: -1,
      bodySize: entry.responseBodySize ?? -1
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: entry.durationMs,
      receive: 0
    }
  };
}

function buildHarResponseContent(
  entry: NetworkWaterfallEntry,
  responseBody?: { mime: string; bytes: Uint8Array }
): Record<string, unknown> {
  const mimeType = responseBody?.mime ?? entry.mimeType ?? "application/octet-stream";
  const content: Record<string, unknown> = {
    size: responseBody?.bytes.byteLength ?? entry.responseBodySize ?? entry.encodedDataLength ?? 0,
    mimeType
  };

  if (!responseBody) {
    return content;
  }

  if (isTextualHarMimeType(mimeType)) {
    content.text = new TextDecoder("utf-8", { fatal: false }).decode(responseBody.bytes);
  } else {
    content.text = encodeBase64(responseBody.bytes);
    content.encoding = "base64";
  }

  return content;
}

function isTextualHarMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += alphabet[(combined >> 18) & 63] ?? "";
    output += alphabet[(combined >> 12) & 63] ?? "";
    output += second === undefined ? "=" : (alphabet[(combined >> 6) & 63] ?? "");
    output += third === undefined ? "=" : (alphabet[combined & 63] ?? "");
  }

  return output;
}

function buildDomDiff(
  previous: DomSnapshotRef,
  current: DomSnapshotRef,
  previousPaths: Set<string>,
  currentPaths: Set<string>
): DomDiffResult {
  const addedPaths = [...currentPaths].filter((path) => !previousPaths.has(path)).sort();
  const removedPaths = [...previousPaths].filter((path) => !currentPaths.has(path)).sort();
  const changedPaths = deriveChangedPaths(addedPaths, removedPaths);

  return {
    previous,
    current,
    addedPaths,
    removedPaths,
    changedPaths,
    summary: {
      added: addedPaths.length,
      removed: removedPaths.length,
      changed: changedPaths.length
    }
  };
}

function deriveChangedPaths(addedPaths: string[], removedPaths: string[]): string[] {
  const removedParents = new Set(removedPaths.map((path) => parentPath(path)).filter(Boolean));

  return addedPaths
    .filter((path) => {
      const parent = parentPath(path);
      return Boolean(parent) && removedParents.has(parent);
    })
    .sort();
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");

  if (index <= 0) {
    return null;
  }

  return path.slice(0, index);
}

function extractCdpDomPaths(snapshot: unknown): Set<string> {
  const root = asRecord(snapshot);
  const strings = Array.isArray(root?.strings) ? root.strings : [];
  const documents = Array.isArray(root?.documents) ? root.documents : [];
  const firstDocument = asRecord(documents[0]);
  const nodes = asRecord(firstDocument?.nodes);
  const parentIndex = Array.isArray(nodes?.parentIndex) ? nodes.parentIndex : [];
  const nodeName = Array.isArray(nodes?.nodeName) ? nodes.nodeName : [];

  if (parentIndex.length === 0 || nodeName.length === 0) {
    return new Set();
  }

  const names = nodeName.map((nameIndex) => {
    if (typeof nameIndex !== "number" || !Number.isInteger(nameIndex)) {
      return "UNKNOWN";
    }

    return normalizeNodeName(strings[nameIndex]);
  });

  const childrenByParent = new Map<number, number[]>();

  for (let index = 0; index < parentIndex.length; index += 1) {
    const parent = parentIndex[index];

    if (typeof parent !== "number" || parent < 0) {
      continue;
    }

    const children = childrenByParent.get(parent) ?? [];
    children.push(index);
    childrenByParent.set(parent, children);
  }

  const paths = new Set<string>();
  const roots = parentIndex
    .map((parent, index) => ({ parent, index }))
    .filter((item) => typeof item.parent !== "number" || item.parent < 0)
    .map((item) => item.index);

  const stack: Array<{ index: number; path: string }> = [];

  for (const rootIndex of roots) {
    const rootName = names[rootIndex] ?? "UNKNOWN";

    if (rootName === "#DOCUMENT") {
      const children = childrenByParent.get(rootIndex) ?? [];

      for (const child of children) {
        stack.push({
          index: child,
          path: `/${names[child] ?? "UNKNOWN"}[1]`
        });
      }
      continue;
    }

    stack.push({
      index: rootIndex,
      path: `/${rootName}[1]`
    });
  }

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    paths.add(current.path);
    const children = childrenByParent.get(current.index) ?? [];
    const siblingCounts = new Map<string, number>();

    for (const childIndex of children) {
      const childName = names[childIndex] ?? "UNKNOWN";
      const nextCount = (siblingCounts.get(childName) ?? 0) + 1;
      siblingCounts.set(childName, nextCount);
      stack.push({
        index: childIndex,
        path: `${current.path}/${childName}[${nextCount}]`
      });
    }
  }

  return paths;
}

function extractHtmlPaths(htmlSnippet: string): Set<string> {
  const tokenRegex = /<\/?([a-zA-Z0-9:-]+)(?:\s[^>]*)?>/g;
  const stack: string[] = [];
  const siblingCounts: number[] = [];
  const paths = new Set<string>();
  let match = tokenRegex.exec(htmlSnippet);

  while (match) {
    const rawTag = match[0] ?? "";
    const tag = normalizeNodeName(match[1]);
    const isClosing = rawTag.startsWith("</");
    const isSelfClosing = rawTag.endsWith("/>");

    if (isClosing) {
      stack.pop();
      siblingCounts.pop();
      match = tokenRegex.exec(htmlSnippet);
      continue;
    }

    const parentIndex = siblingCounts.length - 1;
    const nextIndex = parentIndex >= 0 ? (siblingCounts[parentIndex] ?? 0) + 1 : 1;

    if (parentIndex >= 0) {
      siblingCounts[parentIndex] = nextIndex;
    }

    const path = `${stack.join("")}/${tag}[${nextIndex}]`;
    paths.add(path);

    if (!isSelfClosing) {
      stack.push(`/${tag}[${nextIndex}]`);
      siblingCounts.push(0);
    }

    match = tokenRegex.exec(htmlSnippet);
  }

  return paths;
}

function normalizeNodeName(value: unknown): string {
  const raw = asString(value)?.trim();

  if (!raw) {
    return "UNKNOWN";
  }

  if (raw.startsWith("#")) {
    return raw.toUpperCase();
  }

  return raw.toUpperCase();
}

function headersToHarArray(
  headers: Record<string, string>
): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function parseQueryString(urlValue: string): Array<{ name: string; value: string }> {
  try {
    const url = new URL(urlValue);
    return [...url.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function parseCookieHeader(
  headerValue: string | undefined
): Array<{ name: string; value: string }> {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...rest] = part.split("=");
      return {
        name: name?.trim() ?? "",
        value: rest.join("=").trim()
      };
    })
    .filter((cookie) => cookie.name.length > 0);
}

function parseSetCookieHeader(
  headerValue: string | undefined
): Array<{ name: string; value: string }> {
  if (!headerValue) {
    return [];
  }

  const first = headerValue.split(";")[0];

  if (!first) {
    return [];
  }

  const [name, ...rest] = first.split("=");

  if (!name) {
    return [];
  }

  return [
    {
      name: name.trim(),
      value: rest.join("=").trim()
    }
  ];
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const entries: Array<[string, string]> = [];

    for (const item of raw) {
      const row = asRecord(item);
      const name = asString(row?.name);
      const value = asString(row?.value);

      if (!name || value === undefined) {
        continue;
      }

      entries.push([name.toLowerCase(), value]);
    }

    return Object.fromEntries(entries);
  }

  const record = asRecord(raw);

  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .map(([name, value]) => [name.toLowerCase(), asString(value)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function sanitizeMockHeaders(headers: Record<string, string>): Record<string, string> {
  const excluded = new Set([
    "set-cookie",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection"
  ]);

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase()))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function describeRedactionStrategy(profile: ExportManifest["redactionProfile"]): string[] {
  const strategy = [
    `Redacts ${profile.redactHeaders.length} sensitive HTTP header names before archive export.`,
    `Masks ${profile.redactCookieNames.length} configured cookie names in cookie headers and snapshots.`,
    `Scans payload keys/text for ${profile.redactBodyPatterns.length} sensitive body patterns.`,
    `Blocks ${profile.blockedSelectors.length} configured DOM selectors from captured text/value payloads.`
  ];

  strategy.push(
    profile.hashSensitiveValues
      ? "Hashes sensitive string values so correlation remains possible without exposing raw secrets."
      : "Replaces sensitive values with fixed redaction markers."
  );

  return strategy;
}

function countPrivacySignals(
  events: WebBlackboxEvent[],
  sensitivePatterns: string[]
): PrivacyProtectionReport["detected"] {
  let redactedMarkers = 0;
  let hashedSensitiveValues = 0;
  let sensitiveKeyMentions = 0;
  const normalizedPatterns = sensitivePatterns
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean);

  for (const event of events) {
    const serialized = safeStringify(event.data);
    redactedMarkers += countMatches(serialized, /\[(?:REDACTED|redacted(?:-[a-z]+)?)\]/g);
    hashedSensitiveValues += countMatches(serialized, /\b[a-f0-9]{64}\b/g);
    const lowered = serialized.toLowerCase();

    for (const pattern of normalizedPatterns) {
      if (lowered.includes(pattern)) {
        sensitiveKeyMentions += 1;
      }
    }
  }

  return {
    redactedMarkers,
    hashedSensitiveValues,
    sensitiveKeyMentions
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function collectSensitivePreviewMatches(
  event: WebBlackboxEvent,
  sensitivePatterns: string[]
): SensitiveDataPreview["samples"] {
  const serialized = safeStringify(event.data);
  const matches: SensitiveDataPreview["samples"] = [];
  const addMatch = (reason: SensitiveDataPreview["samples"][number]["reason"], snippet: string) => {
    matches.push({
      eventId: event.id,
      type: event.type,
      mono: event.mono,
      reason,
      snippet: compactSensitiveSnippet(snippet)
    });
  };

  for (const match of serialized.matchAll(/\[(?:REDACTED|redacted(?:-[a-z]+)?)\]/g)) {
    addMatch("redacted-marker", match[0]);
  }

  for (const match of serialized.matchAll(/\b[a-f0-9]{64}\b/g)) {
    addMatch("hashed-value", match[0]);
  }

  const lowered = serialized.toLowerCase();
  for (const pattern of sensitivePatterns) {
    const normalized = pattern.trim().toLowerCase();
    if (normalized && lowered.includes(normalized)) {
      addMatch("sensitive-pattern", normalized);
    }
  }

  return matches;
}

function compactSensitiveSnippet(value: string): string {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return `${value.slice(0, 8)}…${value.slice(-6)}`;
  }

  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

function buildReplayCauseChain(
  action: ActionTimelineEntry,
  diffs: ReplayDiagnosticEntry["requestResponseDiffs"],
  errorMessages: string[]
): string[] {
  const chain = [`trigger:${action.triggerType ?? "unknown"}:${action.triggerEventId}`];

  for (const diff of diffs) {
    const status = diff.failed ? "failed" : (diff.capturedStatus ?? "pending");
    const bodyState = diff.hasResponseBody ? "response-body" : "no-response-body";
    chain.push(`request:${diff.method}:${status}:${bodyState}:${diff.reqId}`);
  }

  for (const message of errorMessages.slice(0, 3)) {
    chain.push(`error:${message}`);
  }

  if (action.screenshot) {
    chain.push(`screenshot:${action.screenshot.eventId}`);
  }

  return chain;
}

function resolveReplayConfidence(
  action: ActionTimelineEntry,
  diffs: ReplayDiagnosticEntry["requestResponseDiffs"]
): ReplayDiagnosticEntry["confidence"] {
  const hasEvidence = diffs.length > 0 || action.errors.length > 0 || Boolean(action.screenshot);
  const hasRichNetwork = diffs.some((diff) => diff.hasResponseBody || diff.hasRequestBody);

  if (action.screenshot && (hasRichNetwork || action.errors.length > 0)) {
    return "high";
  }

  if (hasEvidence) {
    return "medium";
  }

  return "low";
}

async function resolveArchiveReadKey(
  manifest: ExportManifest,
  passphrase?: string
): Promise<CryptoKey | null> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return null;
  }

  if (!passphrase) {
    throw new Error("Archive is encrypted. Provide a passphrase to open it.");
  }

  return deriveArchiveKey(
    passphrase,
    fromBase64(encryption.kdf.saltBase64),
    encryption.kdf.iterations
  );
}

async function readEventChunkSources(
  zipReader: BoundedZipReader,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>,
  options: {
    range?: PlayerRange;
    timeIndex?: ChunkTimeIndexEntry[];
  },
  integrity: HashesManifest,
  decodeBudget: ArchiveDecodeBudget
): Promise<EventChunkReadResult> {
  const descriptors = buildEventChunkDescriptors(options);
  const chunks: EventChunkSource[] = [];
  const events: WebBlackboxEvent[] = [];

  for (const descriptor of descriptors) {
    const { path } = descriptor;
    const decrypted = await readTransientZipEntry(zipReader, path, async (rawBytes) => {
      await assertArchiveFileIntegrity(integrity, path, rawBytes);
      return decryptArchiveBytes(path, rawBytes, archiveKey, encryptedFiles);
    });
    const bytes = await decodeChunkBytes(decrypted, descriptor.codec, path, decodeBudget);
    const chunk: EventChunkSource = {
      chunkId: descriptor.chunkId,
      path,
      seq: descriptor.seq,
      monoStart: descriptor.monoStart,
      monoEnd: descriptor.monoEnd,
      bytes,
      events: []
    };
    const chunkEvents = parseChunkEvents(chunk, decodeBudget);
    if (descriptor.selected) {
      chunk.events = chunkEvents;
    }

    assertArchiveChunk({
      path,
      index: descriptor.index,
      encodedByteLength: decrypted.byteLength,
      encodedSha256: await sha256Hex(decrypted),
      events: chunkEvents
    });
    chunk.bytes = new Uint8Array(0);

    if (descriptor.selected) {
      chunks.push(chunk);
    }

    for (const event of chunkEvents) {
      events.push(event);
    }
  }

  return {
    chunks: chunks.sort((left, right) => left.seq - right.seq),
    events
  };
}

function buildEventChunkDescriptors(options: {
  range?: PlayerRange;
  timeIndex?: ChunkTimeIndexEntry[];
}): EventChunkDescriptor[] {
  const { range, timeIndex } = options;
  return (timeIndex ?? [])
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => ({
      chunkId: entry.chunkId,
      path: `events/${entry.chunkId}.ndjson`,
      seq: entry.seq,
      monoStart: entry.monoStart,
      monoEnd: entry.monoEnd,
      codec: entry.codec,
      index: entry,
      selected: !range || chunkIntersectsRange(entry, range)
    }));
}

function parseChunkEvents(
  chunk: EventChunkSource,
  decodeBudget: ArchiveDecodeBudget
): WebBlackboxEvent[] {
  const content = new TextDecoder().decode(chunk.bytes);
  const events: WebBlackboxEvent[] = [];
  let lineStart = 0;
  let lineNumber = 0;

  for (let cursor = 0; cursor <= content.length; cursor += 1) {
    if (cursor < content.length && content.charCodeAt(cursor) !== 10) {
      continue;
    }

    lineNumber += 1;
    const lineEnd = cursor;
    if (!hasNonWhitespace(content, lineStart, lineEnd)) {
      lineStart = cursor + 1;
      continue;
    }

    decodeBudget.commitEvents(chunk.path, 1);
    const line = content.slice(lineStart, lineEnd);
    try {
      events.push(parseArchivedEvent(JSON.parse(line) as unknown, chunk.path, lineNumber));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid WebBlackbox archive: '${chunk.path}' contains malformed JSON at event line ${lineNumber}.`
        );
      }

      throw error;
    }

    lineStart = cursor + 1;
  }

  return events;
}

function hasNonWhitespace(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) {
      return true;
    }
  }

  return false;
}

function chunkSourceIntersectsRange(chunk: EventChunkSource, range: PlayerRange): boolean {
  if (
    Number.isFinite(chunk.monoEnd) &&
    range.monoStart !== undefined &&
    chunk.monoEnd < range.monoStart
  ) {
    return false;
  }

  if (
    Number.isFinite(chunk.monoStart) &&
    range.monoEnd !== undefined &&
    chunk.monoStart > range.monoEnd
  ) {
    return false;
  }

  return true;
}

function chunkIntersectsRange(entry: ChunkTimeIndexEntry, range: PlayerRange): boolean {
  if (range.monoStart !== undefined && entry.monoEnd < range.monoStart) {
    return false;
  }

  if (range.monoEnd !== undefined && entry.monoStart > range.monoEnd) {
    return false;
  }

  return true;
}

async function decryptArchiveBytes(
  path: string,
  bytes: Uint8Array,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<Uint8Array> {
  const encryptedFile = encryptedFiles[path];

  if (!encryptedFile) {
    if (Object.keys(encryptedFiles).length === 0) {
      return bytes;
    }

    throw new Error(
      `Invalid WebBlackbox archive: encrypted archive is missing file metadata for '${path}'.`
    );
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  try {
    return await decryptBytes(bytes, archiveKey, fromBase64(encryptedFile.ivBase64));
  } catch {
    throw new Error("Unable to decrypt archive content. The passphrase may be invalid.");
  }
}

async function decodeChunkBytes(
  bytes: Uint8Array,
  codec: ChunkCodec,
  path: string,
  decodeBudget: ArchiveDecodeBudget
): Promise<Uint8Array> {
  if (codec === "none") {
    decodeBudget.commitDecoded(path, bytes.byteLength, bytes.byteLength);
    return bytes;
  }

  const fromStreams = await tryDecodeChunkWithStreams(bytes, codec, path, decodeBudget);

  if (fromStreams) {
    decodeBudget.commitDecoded(path, bytes.byteLength, fromStreams.byteLength);
    return fromStreams;
  }

  const fromNodeZlib = await tryDecodeChunkWithNodeZlib(bytes, codec, path, decodeBudget);

  if (fromNodeZlib) {
    decodeBudget.commitDecoded(path, bytes.byteLength, fromNodeZlib.byteLength);
    return fromNodeZlib;
  }

  throw new Error(`Archive chunk codec '${codec}' is not supported in this runtime.`);
}

async function tryDecodeChunkWithStreams(
  bytes: Uint8Array,
  codec: ChunkCodec,
  path: string,
  decodeBudget: ArchiveDecodeBudget
): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined" || typeof Blob === "undefined") {
    return null;
  }

  for (const format of codecFormats(codec)) {
    try {
      const decompressor = new DecompressionStream(format as CompressionFormat);
      const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(decompressor);
      return await readBoundedReadableStream(stream, {
        timeoutMs: decodeBudget.limits.decodeTimeoutMs,
        detail: `${path}, codec '${codec}', format '${format}'`,
        maxBytes: decodeBudget.limits.maxChunkDecodedBytes,
        validateTotalBytes(totalBytes) {
          decodeBudget.assertDecodedSize(path, bytes.byteLength, totalBytes);
        }
      });
    } catch (error) {
      if (
        error instanceof ArchiveResourceLimitError ||
        error instanceof ArchiveDecodeTimeoutError
      ) {
        throw error;
      }

      continue;
    }
  }

  return null;
}

async function tryDecodeChunkWithNodeZlib(
  bytes: Uint8Array,
  codec: ChunkCodec,
  path: string,
  decodeBudget: ArchiveDecodeBudget
): Promise<Uint8Array | null> {
  const [zlib, nodeStream] = await Promise.all([loadNodeZlib(), loadNodeStream()]);

  if (!zlib || !nodeStream?.Readable?.toWeb) {
    return null;
  }

  const options = { chunkSize: 16 * 1024 };
  let codecStream: NodeJS.ReadWriteStream | null = null;

  try {
    if (codec === "gzip" && typeof zlib.createGunzip === "function") {
      codecStream = zlib.createGunzip(options);
    }

    if (codec === "br" && typeof zlib.createBrotliDecompress === "function") {
      codecStream = zlib.createBrotliDecompress(options);
    }

    if (codec === "zst" && typeof zlib.createZstdDecompress === "function") {
      codecStream = zlib.createZstdDecompress(options);
    }
  } catch {
    return null;
  }

  if (!codecStream) {
    return null;
  }

  const stream = nodeStream.Readable.toWeb(codecStream);
  codecStream.end(bytes);

  try {
    return await readBoundedReadableStream(stream, {
      timeoutMs: decodeBudget.limits.decodeTimeoutMs,
      detail: `${path}, Node codec '${codec}'`,
      maxBytes: decodeBudget.limits.maxChunkDecodedBytes,
      validateTotalBytes(totalBytes) {
        decodeBudget.assertDecodedSize(path, bytes.byteLength, totalBytes);
      }
    });
  } catch (error) {
    if (error instanceof ArchiveResourceLimitError || error instanceof ArchiveDecodeTimeoutError) {
      throw error;
    }

    return null;
  }
}

async function loadNodeZlib(): Promise<NodeZlibLike | null> {
  if (
    typeof process === "undefined" ||
    typeof process.versions !== "object" ||
    typeof process.versions?.node !== "string"
  ) {
    return null;
  }

  try {
    const module = await import("node:zlib");
    return module as unknown as NodeZlibLike;
  } catch {
    return null;
  }
}

async function loadNodeStream(): Promise<NodeStreamLike | null> {
  if (
    typeof process === "undefined" ||
    typeof process.versions !== "object" ||
    typeof process.versions?.node !== "string"
  ) {
    return null;
  }

  try {
    const module = await import("node:stream");
    return module as unknown as NodeStreamLike;
  } catch {
    return null;
  }
}

function codecFormats(codec: ChunkCodec): string[] {
  if (codec === "gzip") {
    return ["gzip"];
  }

  if (codec === "br") {
    return ["brotli", "br"];
  }

  if (codec === "zst") {
    return ["zstd", "zst"];
  }

  return [];
}

function withinRange(event: WebBlackboxEvent, range?: PlayerRange): boolean {
  if (!range) {
    return true;
  }

  if (range.monoStart !== undefined && event.mono < range.monoStart) {
    return false;
  }

  if (range.monoEnd !== undefined && event.mono > range.monoEnd) {
    return false;
  }

  return true;
}

function isRangeUnbounded(range?: PlayerRange): boolean {
  return !range || (range.monoStart === undefined && range.monoEnd === undefined);
}

function matchesText(event: WebBlackboxEvent, term: string): boolean {
  if (event.type.toLowerCase().includes(term)) {
    return true;
  }

  if (event.id.toLowerCase().includes(term)) {
    return true;
  }

  return JSON.stringify(event.data).toLowerCase().includes(term);
}

function collectInvertedCandidateIds(
  inverted: Map<string, string[]>,
  query: string
): Set<string> | null {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  const tokens = normalized
    .split(/[^a-zA-Z0-9_:.\-/]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const keys = new Set<string>([normalized, ...tokens]);
  const output = new Set<string>();

  for (const key of keys) {
    const eventIds = inverted.get(key);

    if (!eventIds) {
      continue;
    }

    for (const eventId of eventIds) {
      output.add(eventId);
    }
  }

  return output.size > 0 ? output : null;
}

function intersectCandidateIds(
  left: Set<string> | null,
  right: Set<string> | null
): Set<string> | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  const intersection = new Set<string>();

  for (const value of smaller) {
    if (larger.has(value)) {
      intersection.add(value);
    }
  }

  return intersection;
}

function computeTextScore(event: WebBlackboxEvent, term: string): number {
  let score = 0;

  if (event.type.toLowerCase().includes(term)) {
    score += 6;
  }

  if (event.id.toLowerCase().includes(term)) {
    score += 4;
  }

  const payload = JSON.stringify(event.data).toLowerCase();

  if (payload.includes(term)) {
    score += 2;
  }

  return score;
}

function createActionSpan(actId: string, triggerEventId: string, mono: number): ActionSpan {
  return {
    actId,
    startMono: mono,
    endMono: mono,
    eventIds: [],
    triggerEventId,
    requestCount: 0,
    errorCount: 0
  };
}

function updateActionStats(span: ActionSpan, event: WebBlackboxEvent): void {
  if (event.type === "network.request") {
    span.requestCount += 1;
  }

  if (isErrorEvent(event)) {
    span.errorCount += 1;
  }
}

function countIndexEventReferences(entries: Array<{ eventIds: string[] }>): number {
  let total = 0;

  for (const entry of entries) {
    total += entry.eventIds.length;
    if (!Number.isSafeInteger(total)) {
      return Number.POSITIVE_INFINITY;
    }
  }

  return total;
}

function clonePlayerBlob(blob: PlayerBlob): PlayerBlob {
  return {
    mime: blob.mime,
    bytes: blob.bytes.slice()
  };
}

async function readJsonValue(zipReader: BoundedZipReader, path: string): Promise<unknown> {
  return readTransientZipEntry(zipReader, path, (bytes) => {
    const content = new TextDecoder().decode(bytes);
    return parseArchiveJson(content, path);
  });
}

async function readIntegrityArchiveJsonValue(
  zipReader: BoundedZipReader,
  integrity: HashesManifest,
  path: string,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<unknown> {
  return readTransientZipEntry(zipReader, path, async (rawBytes) => {
    await assertArchiveFileIntegrity(integrity, path, rawBytes);
    const bytes = await decryptArchiveBytes(path, rawBytes, archiveKey, encryptedFiles);
    return parseArchiveJson(new TextDecoder().decode(bytes), path);
  });
}

async function readTransientZipEntry<T>(
  zipReader: BoundedZipReader,
  path: string,
  consume: (bytes: Uint8Array) => T | Promise<T>
): Promise<T> {
  try {
    return await consume(await zipReader.read(path));
  } finally {
    zipReader.release(path);
  }
}

async function readOptionalIntegrityArchiveJsonValue(
  zipReader: BoundedZipReader,
  integrity: HashesManifest,
  path: string,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<unknown | null> {
  if (!zipReader.has(path)) {
    return null;
  }

  return readIntegrityArchiveJsonValue(zipReader, integrity, path, archiveKey, encryptedFiles);
}

function parseArchiveJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Invalid WebBlackbox archive: '${path}' contains malformed JSON.`);
  }
}

function archiveFilePaths(zip: JSZip): string[] {
  return Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path);
}

async function assertManifestIntegrity(
  zipReader: BoundedZipReader,
  integrity: HashesManifest
): Promise<void> {
  const actual = await sha256Hex(await zipReader.read("manifest.json"));

  if (actual !== integrity.manifestSha256) {
    throw new Error("Archive integrity mismatch for manifest.json");
  }
}

function assertArchiveFileSet(zip: JSZip, integrity: HashesManifest): void {
  const actualPaths = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path)
    .filter((path) => path !== "integrity/hashes.json")
    .sort();
  const expectedPaths = Object.keys(integrity.files).sort();

  if (actualPaths.length !== expectedPaths.length) {
    throw new Error("Archive integrity manifest does not match archive contents.");
  }

  for (let index = 0; index < actualPaths.length; index += 1) {
    if (actualPaths[index] !== expectedPaths[index]) {
      throw new Error("Archive integrity manifest does not match archive contents.");
    }
  }
}

async function assertArchiveFileIntegrity(
  integrity: HashesManifest,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const expected = integrity.files[path];

  if (!expected) {
    throw new Error(`Archive integrity manifest is missing hash for ${path}`);
  }

  const actual = await sha256Hex(bytes);

  if (actual !== expected) {
    throw new Error(`Archive integrity mismatch for ${path}`);
  }
}

function parseBlobPath(path: string): { hash: string; extension: string } | null {
  const prefixed = /^blobs\/sha256-([^.]+)\.(.+)$/.exec(path);

  if (!prefixed) {
    return null;
  }

  const hash = prefixed[1];
  const extension = prefixed[2];

  if (!hash || !extension) {
    return null;
  }

  return { hash, extension };
}

function setBlobAliasIfAbsent(
  blobsByHash: Map<string, BlobRef>,
  alias: string,
  blob: BlobRef
): void {
  if (!blobsByHash.has(alias)) {
    blobsByHash.set(alias, blob);
  }
}

function resolveBlobByKey(blobsByHash: Map<string, BlobRef>, input: string): BlobRef | null {
  const candidate = normalizeBlobHashCandidate(input);

  if (!candidate) {
    return null;
  }

  return blobsByHash.get(candidate) ?? null;
}

function normalizeBlobHashCandidate(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("blobs/")) {
    return trimmed;
  }

  return trimmed.startsWith("sha256-") ? trimmed.slice("sha256-".length) : trimmed;
}

async function deriveArchiveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
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
    ["decrypt"]
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  if (subtle) {
    const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
    const output = new Uint8Array(digest);
    let hex = "";

    for (const value of output) {
      hex += value.toString(16).padStart(2, "0");
    }

    return hex;
  }

  const fromNode = await sha256HexWithNodeCrypto(bytes);

  if (fromNode) {
    return fromNode;
  }

  throw new Error("Web Crypto API or Node crypto is required for SHA-256 hashing.");
}

async function decryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const decrypted = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(bytes)
  );

  return new Uint8Array(decrypted);
}

function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required to open encrypted archives.");
}

let nodeCryptoPromise: Promise<typeof import("node:crypto") | null> | null = null;

async function sha256HexWithNodeCrypto(bytes: Uint8Array): Promise<string | null> {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      versions?: {
        node?: string;
      };
    };
  };

  if (!runtime.process?.versions?.node) {
    return null;
  }

  nodeCryptoPromise ??= import("node:crypto").catch(() => null);
  const nodeCrypto = await nodeCryptoPromise;

  if (!nodeCrypto) {
    return null;
  }

  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  throw new Error("Base64 decoding is unavailable in this environment.");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }

    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function normalizeOpenInput(
  input: PlayerOpenInput,
  resourceLimits: Readonly<ArchiveResourceLimits>
): Promise<Uint8Array> {
  let bytes: Uint8Array;

  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > resourceLimits.maxInputBytes) {
      throw new ArchiveResourceLimitError(
        "maxInputBytes",
        resourceLimits.maxInputBytes,
        input.size,
        "Blob size"
      );
    }

    bytes = new Uint8Array(await input.arrayBuffer());
  } else {
    throw new Error("Unsupported archive input type.");
  }

  assertArchiveInputResourceLimits(bytes, resourceLimits);
  return bytes;
}

/** @internal */
type HarExportLimits = {
  maxEntries: number;
  maxBodyBytes: number;
  maxTotalBodyBytes: number;
  maxEntryMetadataBytes: number;
  maxHeaderFields: number;
  maxDerivedFields: number;
  maxHarBytes: number;
  maxEncodedBytes: number;
};

/** @internal */
type HarExportResourceName = keyof HarExportLimits;

/** @internal */
class HarExportResourceLimitError extends Error {
  public override readonly name = "HarExportResourceLimitError";

  public constructor(
    public readonly resource: HarExportResourceName,
    public readonly limit: number,
    public readonly actual: number,
    public readonly completedEntries: number,
    public readonly bodyBytesRead: number
  ) {
    super(
      `HAR limit ${resource} exceeded (${actual} > ${limit}; ` +
        `entries=${completedEntries}; bodyBytes=${bodyBytesRead}).`
    );
  }
}

class BoundedHarJsonWriter {
  private readonly chunks: string[] = [];

  private rawBytes = 0;

  // JSON.stringify(harText) contributes surrounding quotes in addition to escaped contents.
  private encodedBytes = 2;

  public constructor(private readonly limits: Readonly<HarExportLimits>) {}

  public append(chunk: string, completedEntries: number, bodyBytesRead: number): void {
    const rawChunkBytes = utf8ByteLengthAtMost(
      chunk,
      Math.max(0, this.limits.maxHarBytes - this.rawBytes)
    );
    const nextRawBytes = addSafeInteger(this.rawBytes, rawChunkBytes);
    if (nextRawBytes > this.limits.maxHarBytes) {
      throw new HarExportResourceLimitError(
        "maxHarBytes",
        this.limits.maxHarBytes,
        nextRawBytes,
        completedEntries,
        bodyBytesRead
      );
    }

    const encodedChunkBytes = jsonStringContentByteLengthAtMost(
      chunk,
      Math.max(0, this.limits.maxEncodedBytes - this.encodedBytes)
    );
    const nextEncodedBytes = addSafeInteger(this.encodedBytes, encodedChunkBytes);
    if (nextEncodedBytes > this.limits.maxEncodedBytes) {
      throw new HarExportResourceLimitError(
        "maxEncodedBytes",
        this.limits.maxEncodedBytes,
        nextEncodedBytes,
        completedEntries,
        bodyBytesRead
      );
    }

    this.rawBytes = nextRawBytes;
    this.encodedBytes = nextEncodedBytes;
    this.chunks.push(chunk);
  }

  public finish(): string {
    return this.chunks.join("");
  }
}

function resolveHarExportLimits(limits: HarExportLimits): HarExportLimits {
  if (!limits || typeof limits !== "object") {
    throw new TypeError("HAR export limits are required.");
  }

  const values = [
    limits.maxEntries,
    limits.maxBodyBytes,
    limits.maxTotalBodyBytes,
    limits.maxEntryMetadataBytes,
    limits.maxHeaderFields,
    limits.maxDerivedFields,
    limits.maxHarBytes,
    limits.maxEncodedBytes
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("HAR export limits must be positive safe integers.");
  }

  return { ...limits };
}

function assertHarEntryMetadataBudget(
  entry: NetworkWaterfallEntry,
  limits: Readonly<HarExportLimits>,
  completedEntries: number,
  bodyBytesRead: number
): void {
  let metadataBytes = 0;

  const addString = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }

    const addedBytes = utf8ByteLengthAtMost(
      value,
      Math.max(0, limits.maxEntryMetadataBytes - metadataBytes)
    );
    metadataBytes = addSafeInteger(metadataBytes, addedBytes);
    if (metadataBytes > limits.maxEntryMetadataBytes) {
      throw new HarExportResourceLimitError(
        "maxEntryMetadataBytes",
        limits.maxEntryMetadataBytes,
        metadataBytes,
        completedEntries,
        bodyBytesRead
      );
    }
  };

  const addHeaders = (headers: Record<string, string>): void => {
    for (const [name, value] of Object.entries(headers)) {
      addString(name);
      addString(value);
    }
  };

  addString(entry.method);
  addString(entry.url);
  addString(entry.statusText);
  addString(entry.mimeType);
  addString(entry.requestBodyText);
  addHeaders(entry.requestHeaders);
  addHeaders(entry.responseHeaders);
}

function assertHarEntryFieldBudget(
  entry: NetworkWaterfallEntry,
  limits: Readonly<HarExportLimits>,
  completedEntries: number,
  bodyBytesRead: number
): void {
  const headerFields =
    Object.keys(entry.requestHeaders).length + Object.keys(entry.responseHeaders).length;
  if (headerFields > limits.maxHeaderFields) {
    throw new HarExportResourceLimitError(
      "maxHeaderFields",
      limits.maxHeaderFields,
      headerFields,
      completedEntries,
      bodyBytesRead
    );
  }

  const queryStart = entry.url.indexOf("?");
  const queryEnd = entry.url.indexOf("#", queryStart + 1);
  const derivedFields =
    (queryStart < 0 ? 0 : countDelimitedFields(entry.url, "&", queryStart + 1, queryEnd)) +
    countDelimitedFields(entry.requestHeaders.cookie ?? "", ";") +
    countDelimitedFields(entry.responseHeaders["set-cookie"] ?? "", ";");
  if (derivedFields > limits.maxDerivedFields) {
    throw new HarExportResourceLimitError(
      "maxDerivedFields",
      limits.maxDerivedFields,
      derivedFields,
      completedEntries,
      bodyBytesRead
    );
  }
}

function countDelimitedFields(
  value: string,
  delimiter: string,
  start = 0,
  end = value.length
): number {
  if (start < 0 || start >= value.length || start === end) {
    return 0;
  }

  let fields = 1;
  const stop = end < 0 ? value.length : end;
  for (let index = start; index < stop; index += 1) {
    if (value[index] === delimiter) {
      fields += 1;
    }
  }
  return fields;
}

function utf8ByteLengthAtMost(value: string, maxBytes: number): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }

    if (bytes > maxBytes) {
      return bytes;
    }
  }

  return bytes;
}

function jsonStringContentByteLengthAtMost(value: string, maxBytes: number): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }

    if (bytes > maxBytes) {
      return bytes;
    }
  }

  return bytes;
}

function addSafeInteger(left: number, right: number): number {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}
