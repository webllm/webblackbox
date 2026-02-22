import JSZip from "jszip";

import type {
  ChunkTimeIndexEntry,
  EventLevel,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  WebBlackboxEvent,
  WebBlackboxEventType
} from "@webblackbox/protocol";

export type PlayerStatus = "idle" | "loaded";

export type PlayerOpenInput = ArrayBuffer | Uint8Array | Blob;

export type PlayerOpenOptions = {
  passphrase?: string;
};

export type PlayerRange = {
  monoStart?: number;
  monoEnd?: number;
};

export type PlayerQuery = {
  range?: PlayerRange;
  types?: WebBlackboxEventType[];
  levels?: EventLevel[];
  text?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
};

export type PlayerSearchResult = {
  eventId: string;
  score: number;
  event: WebBlackboxEvent;
};

export type ActionSpan = {
  actId: string;
  startMono: number;
  endMono: number;
  eventIds: string[];
  triggerEventId: string;
  requestCount: number;
  errorCount: number;
};

export type PlayerDerivedView = {
  actionSpans: ActionSpan[];
  totals: {
    events: number;
    errors: number;
    requests: number;
  };
};

export type PlayerArchive = {
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest | null;
};

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

export type PlayerComparison = {
  leftSid: string;
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
};

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

export type BugReportOptions = {
  title?: string;
  range?: PlayerRange;
  maxItems?: number;
};

export type PlaywrightScriptOptions = {
  name?: string;
  range?: PlayerRange;
  startUrl?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
};

export type PlaywrightMockScriptOptions = PlaywrightScriptOptions & {
  maxMocks?: number;
};

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

export type GitHubIssueTemplate = {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
};

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

export type DomDiffTimelineOptions = {
  range?: PlayerRange;
  limit?: number;
};

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

type ArchiveEncryptedFileMeta = {
  ivBase64: string;
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

export class WebBlackboxPlayer {
  public readonly status: PlayerStatus = "loaded";

  public readonly archive: PlayerArchive;

  public readonly events: WebBlackboxEvent[];

  private readonly zip: JSZip;

  private readonly eventsById = new Map<string, WebBlackboxEvent>();

  private readonly requestToEventIds = new Map<string, string[]>();

  private readonly inverted = new Map<string, string[]>();

  private readonly blobsByHash = new Map<string, BlobRef>();

  private readonly archiveKey: CryptoKey | null;

  private readonly encryptedFiles: Record<string, ArchiveEncryptedFileMeta>;

  private constructor(
    zip: JSZip,
    archive: PlayerArchive,
    events: WebBlackboxEvent[],
    archiveKey: CryptoKey | null,
    encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
  ) {
    this.zip = zip;
    this.archive = archive;
    this.archiveKey = archiveKey;
    this.encryptedFiles = encryptedFiles;
    this.events = [...events].sort((left, right) => left.mono - right.mono || left.t - right.t);

    for (const event of this.events) {
      this.eventsById.set(event.id, event);

      if (event.ref?.req) {
        const current = this.requestToEventIds.get(event.ref.req) ?? [];
        current.push(event.id);
        this.requestToEventIds.set(event.ref.req, current);
      }
    }

    for (const entry of archive.requestIndex) {
      this.requestToEventIds.set(entry.reqId, [...entry.eventIds]);
    }

    for (const entry of archive.invertedIndex) {
      this.inverted.set(entry.term.toLowerCase(), [...entry.eventIds]);
    }

    const legacyAliases = new Map<string, BlobRef | null>();

    for (const path of Object.keys(zip.files)) {
      const parsed = parseBlobPath(path);

      if (!parsed) {
        continue;
      }

      const blobRef: BlobRef = {
        path,
        mime: inferMime(parsed.extension)
      };

      // Always register exact path lookups to avoid collisions across extensions.
      this.blobsByHash.set(path, blobRef);

      if (parsed.kind === "prefixed") {
        setBlobAliasIfAbsent(this.blobsByHash, parsed.hash, blobRef);
        setBlobAliasIfAbsent(this.blobsByHash, `sha256-${parsed.hash}`, blobRef);
        continue;
      }

      registerLegacyBlobAlias(legacyAliases, parsed.hash, blobRef);
      registerLegacyBlobAlias(legacyAliases, `sha256-${parsed.hash}`, blobRef);
    }

    for (const [alias, blobRef] of legacyAliases) {
      if (!blobRef) {
        continue;
      }

      setBlobAliasIfAbsent(this.blobsByHash, alias, blobRef);
    }
  }

  public static async open(
    input: PlayerOpenInput,
    options: PlayerOpenOptions = {}
  ): Promise<WebBlackboxPlayer> {
    const bytes = await normalizeOpenInput(input);
    const zip = await JSZip.loadAsync(bytes);

    const manifest = await readJson<ExportManifest>(zip, "manifest.json");
    const archiveKey = await resolveArchiveReadKey(manifest, options.passphrase);
    const encryptedFiles = manifest.encryption?.files ?? {};
    const timeIndex = await readOptionalJsonFromPaths<ChunkTimeIndexEntry[]>(
      zip,
      ["index/time.json", "indexes/time.json"],
      []
    );
    const requestIndex = await readOptionalJsonFromPaths<RequestIndexEntry[]>(
      zip,
      ["index/req.json", "indexes/requests.json"],
      []
    );
    const invertedIndex = await readOptionalJsonFromPaths<InvertedIndexEntry[]>(
      zip,
      ["index/inv.json", "indexes/inverted.json"],
      []
    );
    const integrity = await readOptionalJsonFromPaths<HashesManifest | null>(
      zip,
      ["integrity/hashes.json", "integrity.json"],
      null
    );
    const events = await readEvents(zip, archiveKey, encryptedFiles);

    return new WebBlackboxPlayer(
      zip,
      {
        manifest,
        timeIndex,
        requestIndex,
        invertedIndex,
        integrity
      },
      events,
      archiveKey,
      encryptedFiles
    );
  }

  public query(query: PlayerQuery = {}): WebBlackboxEvent[] {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, query.limit ?? Number.POSITIVE_INFINITY);
    const types = query.types ? new Set(query.types) : null;
    const levels = query.levels ? new Set(query.levels) : null;
    const text = query.text?.trim().toLowerCase();
    const requestedIds = query.requestId
      ? new Set(this.requestToEventIds.get(query.requestId) ?? [])
      : null;

    const matched: WebBlackboxEvent[] = [];

    for (const event of this.events) {
      if (!withinRange(event, query.range)) {
        continue;
      }

      if (types && !types.has(event.type)) {
        continue;
      }

      if (levels && (!event.lvl || !levels.has(event.lvl))) {
        continue;
      }

      if (requestedIds && !requestedIds.has(event.id)) {
        continue;
      }

      if (text && !matchesText(event, text)) {
        continue;
      }

      matched.push(event);
    }

    return matched.slice(offset, offset + limit);
  }

  public search(term: string, limit = 100): PlayerSearchResult[] {
    const normalizedTerm = term.trim().toLowerCase();

    if (!normalizedTerm) {
      return [];
    }

    const eventIds = this.inverted.get(normalizedTerm);
    const ranked = new Map<string, number>();

    if (eventIds) {
      for (const eventId of eventIds) {
        ranked.set(eventId, 10);
      }
    }

    for (const event of this.events) {
      const score = computeTextScore(event, normalizedTerm);

      if (score <= 0) {
        continue;
      }

      const previous = ranked.get(event.id) ?? 0;
      ranked.set(event.id, Math.max(previous, score));
    }

    return [...ranked.entries()]
      .map(([eventId, score]) => ({ eventId, score, event: this.eventsById.get(eventId) }))
      .filter((entry): entry is { eventId: string; score: number; event: WebBlackboxEvent } =>
        Boolean(entry.event)
      )
      .sort((left, right) => right.score - left.score || left.event.mono - right.event.mono)
      .slice(0, Math.max(1, limit));
  }

  public async getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
    const blob = resolveBlobByKey(this.blobsByHash, hash);

    if (!blob) {
      return null;
    }

    const file = this.zip.file(blob.path);

    if (!file) {
      return null;
    }

    const rawBytes = await file.async("uint8array");
    const bytes = await this.decryptArchiveFile(blob.path, rawBytes);

    return {
      mime: blob.mime,
      bytes
    };
  }

  public buildDerived(range?: PlayerRange): PlayerDerivedView {
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
      errors: scoped.filter((event) => event.type.startsWith("error.")).length,
      requests: scoped.filter((event) => event.type === "network.request").length
    };

    return {
      actionSpans,
      totals
    };
  }

  public getNetworkWaterfall(range?: PlayerRange): NetworkWaterfallEntry[] {
    const scoped = this.query({ range }).filter((event) => NETWORK_EVENT_TYPES.has(event.type));
    const buckets = collectNetworkBuckets(scoped);

    return buckets
      .map((bucket) => toNetworkEntry(bucket))
      .sort(
        (left, right) => left.startMono - right.startMono || left.reqId.localeCompare(right.reqId)
      );
  }

  public getRequestEvents(reqId: string): WebBlackboxEvent[] {
    return this.query({ requestId: reqId }).sort((left, right) => left.mono - right.mono);
  }

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

  public getStorageTimeline(range?: PlayerRange): StorageTimelineEntry[] {
    return this.query({ range })
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
  }

  public getPerformanceArtifacts(range?: PlayerRange): PerformanceArtifactEntry[] {
    return this.query({ range })
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
  }

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

  public compareWith(other: WebBlackboxPlayer): PlayerComparison {
    const leftCounts = buildTypeCounts(this.events);
    const rightCounts = buildTypeCounts(other.events);
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

    return {
      leftSid: this.archive.manifest.site.origin,
      rightSid: other.archive.manifest.site.origin,
      eventDelta: other.events.length - this.events.length,
      errorDelta:
        other.events.filter((event) => event.type.startsWith("error.")).length -
        this.events.filter((event) => event.type.startsWith("error.")).length,
      requestDelta:
        other.events.filter((event) => event.type === "network.request").length -
        this.events.filter((event) => event.type === "network.request").length,
      durationDeltaMs: computeDuration(other.events) - computeDuration(this.events),
      typeDeltas
    };
  }

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

  public generateCurl(reqId: string): string | null {
    const entry = this.getNetworkWaterfall().find((item) => item.reqId === reqId);

    if (!entry) {
      return null;
    }

    const lines = [`curl ${shellQuote(entry.url)} \\`, `  -X ${entry.method.toUpperCase()} \\`];

    for (const [name, value] of Object.entries(entry.requestHeaders)) {
      lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
    }

    if (entry.requestBodyText) {
      lines.push(`  --data-raw ${shellQuote(entry.requestBodyText)} \\`);
    }

    lines.push("  --compressed");

    return lines.join("\n");
  }

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

  public exportHar(range?: PlayerRange): string {
    const entries = this.getNetworkWaterfall(range).map((entry) => toHarEntry(entry));
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

  public generateBugReport(options: BugReportOptions = {}): string {
    const maxItems = Math.max(5, options.maxItems ?? 20);
    const scoped = this.query({ range: options.range });
    const errors = scoped.filter((event) => event.type.startsWith("error.")).slice(0, maxItems);
    const markers = scoped.filter((event) => event.type === "user.marker").slice(0, maxItems);
    const failedRequests = this.getNetworkWaterfall(options.range)
      .filter((entry) => entry.failed || (entry.status !== undefined && entry.status >= 400))
      .slice(0, maxItems);
    const slowRequests = this.getNetworkWaterfall(options.range)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, maxItems);

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
            .join("\n")
    ].join("\n");
  }

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
      `test('${name}', async ({ browser }) => {`,
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
      `test('${name}', async ({ browser }) => {`,
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

  private async loadDomPaths(snapshot: DomSnapshotRef): Promise<Set<string>> {
    if (snapshot.contentHash) {
      const blob = await this.getBlob(snapshot.contentHash);

      if (blob && blob.mime === "application/json") {
        const text = new TextDecoder().decode(blob.bytes);

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
    }

    const event = this.eventsById.get(snapshot.eventId);
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
}

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
    const reqId = extractReqId(event);

    if (!reqId) {
      continue;
    }

    const bucket = buckets.get(reqId) ?? {
      reqId,
      events: [],
      startMono: event.mono,
      endMono: event.mono,
      startWallTime: event.t,
      endWallTime: event.t
    };

    bucket.events.push(event);
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

  return [...buckets.values()];
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

function extractReqId(event: WebBlackboxEvent): string | null {
  if (event.ref?.req) {
    return event.ref.req;
  }

  const payload = asRecord(event.data);

  return (
    asString(payload?.reqId) ??
    asString(payload?.requestId) ??
    asString(asRecord(payload?.request)?.requestId) ??
    null
  );
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
      return [`  // input on ${selector} was masked in capture`];
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

function readSelector(event: WebBlackboxEvent): string | null {
  const payload = asRecord(event.data);
  const target = asRecord(payload?.target);
  const selector = asString(target?.selector);

  if (!selector || selector === "unknown") {
    return null;
  }

  return selector;
}

function toHarEntry(entry: NetworkWaterfallEntry): Record<string, unknown> {
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
      content: {
        size: entry.responseBodySize ?? entry.encodedDataLength ?? 0,
        mimeType: entry.mimeType ?? "application/octet-stream"
      },
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

async function readEvents(
  zip: JSZip,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<WebBlackboxEvent[]> {
  const eventPaths = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();

  const events: WebBlackboxEvent[] = [];

  for (const path of eventPaths) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const rawBytes = await file.async("uint8array");
    const bytes = await decryptArchiveBytes(path, rawBytes, archiveKey, encryptedFiles);
    const content = new TextDecoder().decode(bytes);
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      events.push(JSON.parse(line) as WebBlackboxEvent);
    }
  }

  return events;
}

async function decryptArchiveBytes(
  path: string,
  bytes: Uint8Array,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<Uint8Array> {
  const encryptedFile = encryptedFiles[path];

  if (!encryptedFile) {
    return bytes;
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  return decryptBytes(bytes, archiveKey, fromBase64(encryptedFile.ivBase64));
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

function matchesText(event: WebBlackboxEvent, term: string): boolean {
  if (event.type.toLowerCase().includes(term)) {
    return true;
  }

  if (event.id.toLowerCase().includes(term)) {
    return true;
  }

  return JSON.stringify(event.data).toLowerCase().includes(term);
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

  if (event.type.startsWith("error.")) {
    span.errorCount += 1;
  }
}

async function readJson<TValue>(zip: JSZip, path: string): Promise<TValue> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  const content = await file.async("string");
  return JSON.parse(content) as TValue;
}

async function readOptionalJsonFromPaths<TValue>(
  zip: JSZip,
  paths: string[],
  fallback: TValue
): Promise<TValue> {
  for (const path of paths) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const content = await file.async("string");
    return JSON.parse(content) as TValue;
  }

  return fallback;
}

function parseBlobPath(
  path: string
): { hash: string; extension: string; kind: "prefixed" | "legacy" } | null {
  const prefixed = /^blobs\/sha256-([^.]+)\.(.+)$/.exec(path);

  if (prefixed) {
    const hash = prefixed[1];
    const extension = prefixed[2];
    return hash && extension ? { hash, extension, kind: "prefixed" } : null;
  }

  const legacy = /^blobs\/([^./]+)\.(.+)$/.exec(path);

  if (!legacy) {
    return null;
  }

  const hash = legacy[1];
  const extension = legacy[2];

  if (!hash || !extension) {
    return null;
  }

  return {
    hash: hash.startsWith("sha256-") ? hash.slice("sha256-".length) : hash,
    extension,
    kind: "legacy"
  };
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

function registerLegacyBlobAlias(
  aliases: Map<string, BlobRef | null>,
  alias: string,
  blob: BlobRef
): void {
  const previous = aliases.get(alias);

  if (previous === undefined) {
    aliases.set(alias, blob);
    return;
  }

  if (previous && previous.path !== blob.path) {
    aliases.set(alias, null);
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

function inferMime(extension: string): string {
  if (extension === "png") {
    return "image/png";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  if (extension === "json") {
    return "application/json";
  }

  return "application/octet-stream";
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
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function normalizeOpenInput(input: PlayerOpenInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }

  throw new Error("Unsupported archive input type.");
}
