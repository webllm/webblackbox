import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { z } from "zod";

const ARCHIVE_EXTENSIONS = new Set([".webblackbox", ".zip"]);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_TOP_N = 10;
const MAX_TOP_N = 50;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_DATA_PREVIEW_CHARS = 2_000;
const MAX_DATA_PREVIEW_CHARS = 10_000;

export const listArchivesInput = {
  dir: z.string().min(1).optional().describe("Directory to scan. Defaults to current working dir."),
  recursive: z.boolean().optional().describe("Recursively scan subdirectories. Defaults to true."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(`Maximum archives to return (1-${MAX_LIST_LIMIT}).`)
};

export type ListArchivesArgs = {
  dir?: string;
  recursive?: boolean;
  limit?: number;
};

export const sessionSummaryInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  slowRequestMs: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe("Slow request threshold in milliseconds. Defaults to 1000."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_N)
    .optional()
    .describe(`Maximum rows to return in top-lists (1-${MAX_TOP_N}).`)
};

export type SessionSummaryArgs = {
  path: string;
  passphrase?: string;
  slowRequestMs?: number;
  topN?: number;
};

export const queryEventsInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  text: z.string().min(1).max(512).optional().describe("Free-text query."),
  types: z.array(z.string().min(1).max(128)).max(100).optional().describe("Filter by event types."),
  levels: z
    .array(z.string().min(1).max(32))
    .max(8)
    .optional()
    .describe("Filter by levels (debug/info/warn/error)."),
  requestId: z.string().min(1).max(512).optional().describe("Filter by request ID."),
  monoStart: z.number().finite().optional().describe("Range start (mono)."),
  monoEnd: z.number().finite().optional().describe("Range end (mono)."),
  offset: z.number().int().min(0).max(1_000_000).optional().describe("Offset for pagination."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Maximum events to return (1-${MAX_QUERY_LIMIT}).`),
  includeData: z
    .boolean()
    .optional()
    .describe("Include serialized event payload preview. Defaults to false."),
  maxDataChars: z
    .number()
    .int()
    .min(128)
    .max(MAX_DATA_PREVIEW_CHARS)
    .optional()
    .describe(`Max payload preview chars when includeData=true (128-${MAX_DATA_PREVIEW_CHARS}).`)
};

export type QueryEventsArgs = {
  path: string;
  passphrase?: string;
  text?: string;
  types?: string[];
  levels?: string[];
  requestId?: string;
  monoStart?: number;
  monoEnd?: number;
  offset?: number;
  limit?: number;
  includeData?: boolean;
  maxDataChars?: number;
};

export const networkIssuesInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  minDurationMs: z
    .number()
    .finite()
    .min(1)
    .max(600_000)
    .optional()
    .describe("Duration threshold for slow requests (ms). Defaults to 1000."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Maximum issue rows to return (1-${MAX_QUERY_LIMIT}).`)
};

export type NetworkIssuesArgs = {
  path: string;
  passphrase?: string;
  minDurationMs?: number;
  limit?: number;
};

export async function listArchives(args: ListArchivesArgs = {}): Promise<{
  dir: string;
  recursive: boolean;
  count: number;
  archives: Array<{
    path: string;
    sizeBytes: number;
    modifiedAt: string;
  }>;
}> {
  const dir = resolveArchivePath(args.dir ?? process.cwd());
  const recursive = args.recursive ?? true;
  const limit = clampInt(args.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const archives = await collectArchiveFiles(dir, recursive, limit);

  return {
    dir,
    recursive,
    count: archives.length,
    archives
  };
}

export async function summarizeSession(args: SessionSummaryArgs): Promise<{
  archive: {
    path: string;
    sizeBytes: number;
    encrypted: boolean;
  };
  manifest: unknown;
  runtime: unknown;
  topEventTypes: Array<{ type: string; count: number }>;
  topErrorFingerprints: Array<{ fingerprint: string; count: number }>;
  topSlowRequests: Array<{
    reqId: string;
    method: string;
    url: string;
    status: number | null;
    failed: boolean;
    durationMs: number;
  }>;
  failedRequests: Array<{
    reqId: string;
    method: string;
    url: string;
    status: number | null;
    failed: boolean;
    durationMs: number;
    errorText: string | null;
  }>;
}> {
  const archivePath = resolveArchivePath(args.path);
  const archiveStat = await stat(archivePath);
  const player = await openArchivePlayer(archivePath, args.passphrase);
  const events = player.events;
  const derived = player.buildDerived();
  const waterfall = player.getNetworkWaterfall();
  const topN = clampInt(args.topN ?? DEFAULT_TOP_N, 1, MAX_TOP_N);
  const slowRequestMs = Math.max(1, Math.round(args.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS));
  const typeCounts = new Map<string, number>();
  const errorFingerprints = new Map<string, number>();

  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);

    if (event.type.startsWith("error.") || event.lvl === "error") {
      const fingerprint = buildErrorFingerprint(event);
      errorFingerprints.set(fingerprint, (errorFingerprints.get(fingerprint) ?? 0) + 1);
    }
  }

  const topEventTypes = mapToSortedEntries(typeCounts, topN).map(([type, count]) => ({
    type,
    count
  }));

  const topErrorFingerprints = mapToSortedEntries(errorFingerprints, topN).map(
    ([fingerprint, count]) => ({
      fingerprint,
      count
    })
  );

  const failedRequests = waterfall
    .filter((entry) => isFailedRequest(entry))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, topN)
    .map((entry) => ({
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: typeof entry.status === "number" ? entry.status : null,
      failed: entry.failed,
      durationMs: Number(entry.durationMs.toFixed(2)),
      errorText: typeof entry.errorText === "string" ? entry.errorText : null
    }));

  const topSlowRequests = waterfall
    .filter((entry) => entry.durationMs >= slowRequestMs)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, topN)
    .map((entry) => ({
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: typeof entry.status === "number" ? entry.status : null,
      failed: entry.failed,
      durationMs: Number(entry.durationMs.toFixed(2))
    }));

  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const manifest = player.archive.manifest;

  return {
    archive: {
      path: archivePath,
      sizeBytes: archiveStat.size,
      encrypted: Boolean(manifest.encryption)
    },
    manifest: {
      protocolVersion: manifest.protocolVersion,
      createdAt: manifest.createdAt,
      mode: manifest.mode,
      chunkCodec: manifest.chunkCodec,
      site: manifest.site,
      stats: manifest.stats
    },
    runtime: {
      totals: {
        events: derived.totals.events,
        errors: derived.totals.errors,
        requests: derived.totals.requests,
        actionSpans: derived.actionSpans.length,
        failedRequests: waterfall.filter((entry) => isFailedRequest(entry)).length,
        slowRequests: waterfall.filter((entry) => entry.durationMs >= slowRequestMs).length
      },
      range: {
        monoStart: firstEvent?.mono ?? null,
        monoEnd: lastEvent?.mono ?? null,
        wallStart: firstEvent?.t ?? null,
        wallEnd: lastEvent?.t ?? null
      },
      slowRequestThresholdMs: slowRequestMs
    },
    topEventTypes,
    topErrorFingerprints,
    topSlowRequests,
    failedRequests
  };
}

export async function queryEvents(args: QueryEventsArgs): Promise<{
  archive: string;
  returned: number;
  offset: number;
  limit: number;
  events: Array<Record<string, unknown>>;
}> {
  const archivePath = resolveArchivePath(args.path);
  const player = await openArchivePlayer(archivePath, args.passphrase);
  const limit = clampInt(args.limit ?? DEFAULT_QUERY_LIMIT, 1, MAX_QUERY_LIMIT);
  const offset = clampInt(args.offset ?? 0, 0, 1_000_000);
  const includeData = args.includeData === true;
  const maxDataChars = clampInt(
    args.maxDataChars ?? DEFAULT_DATA_PREVIEW_CHARS,
    128,
    MAX_DATA_PREVIEW_CHARS
  );
  const query: Parameters<WebBlackboxPlayer["query"]>[0] = {
    text: normalizeOptionalString(args.text),
    types: sanitizeStringArray(args.types) as never,
    levels: sanitizeStringArray(args.levels) as never,
    requestId: normalizeOptionalString(args.requestId),
    limit,
    offset
  };

  if (typeof args.monoStart === "number" || typeof args.monoEnd === "number") {
    query.range = {
      monoStart: typeof args.monoStart === "number" ? args.monoStart : undefined,
      monoEnd: typeof args.monoEnd === "number" ? args.monoEnd : undefined
    };
  }

  const events = player.query(query).map((event) => {
    const row: Record<string, unknown> = {
      id: event.id,
      type: event.type,
      lvl: event.lvl ?? null,
      mono: event.mono,
      t: event.t,
      tab: event.tab,
      nav: event.nav ?? null,
      frame: event.frame ?? null,
      ref: event.ref ?? null
    };

    if (includeData) {
      row.data = toJsonPreview(event.data, maxDataChars);
    }

    return row;
  });

  return {
    archive: archivePath,
    returned: events.length,
    offset,
    limit,
    events
  };
}

export async function summarizeNetworkIssues(args: NetworkIssuesArgs): Promise<{
  archive: string;
  thresholds: {
    slowMs: number;
  };
  totals: {
    requests: number;
    failed: number;
    slow: number;
  };
  issues: Array<{
    reqId: string;
    method: string;
    url: string;
    status: number | null;
    failed: boolean;
    durationMs: number;
    errorText: string | null;
    encodedDataLength: number | null;
  }>;
}> {
  const archivePath = resolveArchivePath(args.path);
  const player = await openArchivePlayer(archivePath, args.passphrase);
  const slowMs = Math.max(1, Math.round(args.minDurationMs ?? DEFAULT_SLOW_REQUEST_MS));
  const limit = clampInt(args.limit ?? DEFAULT_QUERY_LIMIT, 1, MAX_QUERY_LIMIT);
  const waterfall = player.getNetworkWaterfall();
  const issuesByReqId = new Map<
    string,
    {
      reqId: string;
      method: string;
      url: string;
      status: number | null;
      failed: boolean;
      durationMs: number;
      errorText: string | null;
      encodedDataLength: number | null;
    }
  >();

  for (const entry of waterfall) {
    if (!isFailedRequest(entry) && entry.durationMs < slowMs) {
      continue;
    }

    issuesByReqId.set(entry.reqId, {
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: typeof entry.status === "number" ? entry.status : null,
      failed: entry.failed,
      durationMs: Number(entry.durationMs.toFixed(2)),
      errorText: typeof entry.errorText === "string" ? entry.errorText : null,
      encodedDataLength:
        typeof entry.encodedDataLength === "number" ? entry.encodedDataLength : null
    });
  }

  const issues = [...issuesByReqId.values()]
    .sort(
      (left, right) =>
        Number(right.failed) - Number(left.failed) || right.durationMs - left.durationMs
    )
    .slice(0, limit);

  return {
    archive: archivePath,
    thresholds: {
      slowMs
    },
    totals: {
      requests: waterfall.length,
      failed: waterfall.filter((entry) => isFailedRequest(entry)).length,
      slow: waterfall.filter((entry) => entry.durationMs >= slowMs).length
    },
    issues
  };
}

async function openArchivePlayer(path: string, passphrase?: string): Promise<WebBlackboxPlayer> {
  try {
    const bytes = await readFile(path);
    return await WebBlackboxPlayer.open(new Uint8Array(bytes), {
      passphrase
    });
  } catch (error) {
    throw new Error(
      `Failed to open archive '${path}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveArchivePath(pathLike: string): string {
  return resolve(process.cwd(), pathLike);
}

async function collectArchiveFiles(
  rootDir: string,
  recursive: boolean,
  limit: number
): Promise<
  Array<{
    path: string;
    sizeBytes: number;
    modifiedAt: string;
  }>
> {
  const directories = [rootDir];
  const rows: Array<{
    path: string;
    sizeBytes: number;
    modifiedAt: string;
  }> = [];

  while (directories.length > 0 && rows.length < limit) {
    const currentDir = directories.shift();

    if (!currentDir) {
      break;
    }

    const entries = await readdir(currentDir, {
      withFileTypes: true
    });

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (recursive) {
          directories.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !isArchiveFile(fullPath)) {
        continue;
      }

      const fileStat = await stat(fullPath);
      rows.push({
        path: fullPath,
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString()
      });

      if (rows.length >= limit) {
        break;
      }
    }
  }

  return rows
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
    .slice(0, limit);
}

function isArchiveFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(extension);
}

function clampInt(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(input)));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function mapToSortedEntries(source: Map<string, number>, limit: number): Array<[string, number]> {
  return [...source.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function buildErrorFingerprint(event: { type: string; data: unknown }): string {
  const payload = asRecord(event.data);
  const message =
    asString(payload?.message) ??
    asString(payload?.errorText) ??
    asString(payload?.text) ??
    asString(payload?.name);

  return message ? `${event.type}:${compactText(message, 200)}` : event.type;
}

function isFailedRequest(entry: { failed: boolean; status?: number }): boolean {
  return entry.failed || (typeof entry.status === "number" && entry.status >= 400);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function toJsonPreview(value: unknown, maxChars: number): string {
  try {
    const serialized = JSON.stringify(value);

    if (typeof serialized !== "string") {
      return String(value);
    }

    if (serialized.length <= maxChars) {
      return serialized;
    }

    const omitted = serialized.length - maxChars;
    return `${serialized.slice(0, maxChars)}...(truncated ${omitted} chars)`;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}
