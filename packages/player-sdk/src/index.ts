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

type BlobRef = {
  path: string;
  mime: string;
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

  private constructor(zip: JSZip, archive: PlayerArchive, events: WebBlackboxEvent[]) {
    this.zip = zip;
    this.archive = archive;
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

    for (const path of Object.keys(zip.files)) {
      if (!path.startsWith("blobs/sha256-")) {
        continue;
      }

      const match = /^blobs\/sha256-([^.]+)\.(.+)$/.exec(path);

      if (!match) {
        continue;
      }

      const hash = match[1];
      const extension = match[2];

      if (!hash || !extension) {
        continue;
      }
      this.blobsByHash.set(hash, {
        path,
        mime: inferMime(extension)
      });
    }
  }

  public static async open(input: PlayerOpenInput): Promise<WebBlackboxPlayer> {
    const bytes = await normalizeOpenInput(input);
    const zip = await JSZip.loadAsync(bytes);

    const manifest = await readJson<ExportManifest>(zip, "manifest.json");
    const timeIndex = await readOptionalJson<ChunkTimeIndexEntry[]>(zip, "index/time.json", []);
    const requestIndex = await readOptionalJson<RequestIndexEntry[]>(zip, "index/req.json", []);
    const invertedIndex = await readOptionalJson<InvertedIndexEntry[]>(zip, "index/inv.json", []);
    const integrity = await readOptionalJson<HashesManifest | null>(
      zip,
      "integrity/hashes.json",
      null
    );
    const events = await readEvents(zip);

    return new WebBlackboxPlayer(
      zip,
      {
        manifest,
        timeIndex,
        requestIndex,
        invertedIndex,
        integrity
      },
      events
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
    const blob = this.blobsByHash.get(hash);

    if (!blob) {
      return null;
    }

    const file = this.zip.file(blob.path);

    if (!file) {
      return null;
    }

    const bytes = await file.async("uint8array");

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
}

export function getDefaultPlayerStatus(): PlayerStatus {
  return "idle";
}

async function readEvents(zip: JSZip): Promise<WebBlackboxEvent[]> {
  const eventPaths = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();

  const events: WebBlackboxEvent[] = [];

  for (const path of eventPaths) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const content = await file.async("string");
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      events.push(JSON.parse(line) as WebBlackboxEvent);
    }
  }

  return events;
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

async function readOptionalJson<TValue>(
  zip: JSZip,
  path: string,
  fallback: TValue
): Promise<TValue> {
  const file = zip.file(path);

  if (!file) {
    return fallback;
  }

  const content = await file.async("string");
  return JSON.parse(content) as TValue;
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
