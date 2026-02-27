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
const DEFAULT_COMPARE_TOP = 15;
const MAX_COMPARE_TOP = 100;

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

export const generateBugReportInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  title: z.string().min(1).max(512).optional().describe("Optional report title."),
  maxItems: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Max rows in report sections (1-${MAX_QUERY_LIMIT}).`),
  monoStart: z.number().finite().optional().describe("Optional mono range start."),
  monoEnd: z.number().finite().optional().describe("Optional mono range end."),
  labels: z.array(z.string().min(1).max(64)).max(25).optional().describe("GitHub/Jira labels."),
  assignees: z.array(z.string().min(1).max(64)).max(20).optional().describe("GitHub assignees."),
  issueType: z.string().min(1).max(64).optional().describe("Jira issue type."),
  projectKey: z.string().min(1).max(32).optional().describe("Jira project key."),
  priority: z.string().min(1).max(64).optional().describe("Jira priority.")
};

export type GenerateBugReportArgs = {
  path: string;
  passphrase?: string;
  title?: string;
  maxItems?: number;
  monoStart?: number;
  monoEnd?: number;
  labels?: string[];
  assignees?: string[];
  issueType?: string;
  projectKey?: string;
  priority?: string;
};

export const exportHarInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  monoStart: z.number().finite().optional().describe("Optional mono range start."),
  monoEnd: z.number().finite().optional().describe("Optional mono range end.")
};

export type ExportHarArgs = {
  path: string;
  passphrase?: string;
  monoStart?: number;
  monoEnd?: number;
};

export const summarizeActionsInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  monoStart: z.number().finite().optional().describe("Optional mono range start."),
  monoEnd: z.number().finite().optional().describe("Optional mono range end."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Maximum action spans to return (1-${MAX_QUERY_LIMIT}).`)
};

export type SummarizeActionsArgs = {
  path: string;
  passphrase?: string;
  monoStart?: number;
  monoEnd?: number;
  limit?: number;
};

export const rootCauseCandidatesInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  monoStart: z.number().finite().optional().describe("Optional mono range start."),
  monoEnd: z.number().finite().optional().describe("Optional mono range end."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Maximum error candidates to return (1-${MAX_QUERY_LIMIT}).`),
  windowMs: z
    .number()
    .finite()
    .min(1)
    .max(120_000)
    .optional()
    .describe("Lookback window before each error (ms). Defaults to 10000.")
};

export type RootCauseCandidatesArgs = {
  path: string;
  passphrase?: string;
  monoStart?: number;
  monoEnd?: number;
  limit?: number;
  windowMs?: number;
};

export const generatePlaywrightInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  name: z.string().min(1).max(128).optional().describe("Playwright test name."),
  startUrl: z.string().min(1).max(2048).optional().describe("Optional navigation URL override."),
  maxActions: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUERY_LIMIT)
    .optional()
    .describe(`Maximum actions emitted into script (1-${MAX_QUERY_LIMIT}).`),
  includeHarReplay: z
    .boolean()
    .optional()
    .describe("Whether to include routeFromHAR wiring in generated script."),
  monoStart: z.number().finite().optional().describe("Optional mono range start."),
  monoEnd: z.number().finite().optional().describe("Optional mono range end.")
};

export type GeneratePlaywrightArgs = {
  path: string;
  passphrase?: string;
  name?: string;
  startUrl?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
  monoStart?: number;
  monoEnd?: number;
};

export const compareSessionsInput = {
  leftPath: z.string().min(1).describe("Baseline archive path."),
  rightPath: z.string().min(1).describe("Compared archive path."),
  leftPassphrase: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Passphrase for baseline archive (if encrypted)."),
  rightPassphrase: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Passphrase for compared archive (if encrypted)."),
  topTypeDeltas: z
    .number()
    .int()
    .min(1)
    .max(MAX_COMPARE_TOP)
    .optional()
    .describe(`Top N event-type deltas to return (1-${MAX_COMPARE_TOP}).`),
  topRequestDiffs: z
    .number()
    .int()
    .min(1)
    .max(MAX_COMPARE_TOP)
    .optional()
    .describe(`Top N slow/failed request diffs to return (1-${MAX_COMPARE_TOP}).`),
  includeStorageHashes: z
    .boolean()
    .optional()
    .describe("Include hash-only diff arrays for storage comparison.")
};

export type CompareSessionsArgs = {
  leftPath: string;
  rightPath: string;
  leftPassphrase?: string;
  rightPassphrase?: string;
  topTypeDeltas?: number;
  topRequestDiffs?: number;
  includeStorageHashes?: boolean;
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
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
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

  if (range) {
    query.range = {
      monoStart: range.monoStart,
      monoEnd: range.monoEnd
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

export async function generateBugReportBundle(args: GenerateBugReportArgs): Promise<{
  archive: string;
  range: {
    monoStart: number | null;
    monoEnd: number | null;
  };
  markdown: string;
  github: unknown;
  jira: unknown;
}> {
  const archivePath = resolveArchivePath(args.path);
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
  const maxItems = clampInt(args.maxItems ?? DEFAULT_QUERY_LIMIT, 1, MAX_QUERY_LIMIT);
  const labels = sanitizeStringArray(args.labels);
  const assignees = sanitizeStringArray(args.assignees);
  const title = normalizeOptionalString(args.title);
  const issueType = normalizeOptionalString(args.issueType);
  const projectKey = normalizeOptionalString(args.projectKey);
  const priority = normalizeOptionalString(args.priority);
  const markdown = player.generateBugReport({
    title,
    range: range ?? undefined,
    maxItems
  });
  const github = player.generateGitHubIssueTemplate({
    title,
    range: range ?? undefined,
    maxItems,
    labels,
    assignees
  });
  const jira = player.generateJiraIssueTemplate({
    title,
    range: range ?? undefined,
    maxItems,
    labels,
    issueType,
    projectKey,
    priority
  });

  return {
    archive: archivePath,
    range: {
      monoStart: range?.monoStart ?? null,
      monoEnd: range?.monoEnd ?? null
    },
    markdown,
    github,
    jira
  };
}

export async function exportHarFromArchive(args: ExportHarArgs): Promise<{
  archive: string;
  range: {
    monoStart: number | null;
    monoEnd: number | null;
  };
  har: string;
}> {
  const archivePath = resolveArchivePath(args.path);
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
  const har = player.exportHar(range ?? undefined);

  return {
    archive: archivePath,
    range: {
      monoStart: range?.monoStart ?? null,
      monoEnd: range?.monoEnd ?? null
    },
    har
  };
}

export async function generatePlaywrightFromArchive(args: GeneratePlaywrightArgs): Promise<{
  archive: string;
  range: {
    monoStart: number | null;
    monoEnd: number | null;
  };
  script: string;
}> {
  const archivePath = resolveArchivePath(args.path);
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
  const script = player.generatePlaywrightScript({
    name: normalizeOptionalString(args.name),
    range: range ?? undefined,
    startUrl: normalizeOptionalString(args.startUrl),
    maxActions:
      typeof args.maxActions === "number"
        ? clampInt(args.maxActions, 1, MAX_QUERY_LIMIT)
        : undefined,
    includeHarReplay: args.includeHarReplay === true
  });

  return {
    archive: archivePath,
    range: {
      monoStart: range?.monoStart ?? null,
      monoEnd: range?.monoEnd ?? null
    },
    script
  };
}

export async function summarizeActions(args: SummarizeActionsArgs): Promise<{
  archive: string;
  range: {
    monoStart: number | null;
    monoEnd: number | null;
  };
  totals: {
    actions: number;
    events: number;
    errors: number;
    requests: number;
  };
  actions: Array<{
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
  }>;
}> {
  const archivePath = resolveArchivePath(args.path);
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
  const derived = player.buildDerived(range ?? undefined);
  const limit = clampInt(args.limit ?? DEFAULT_QUERY_LIMIT, 1, MAX_QUERY_LIMIT);
  const actions = player.getActionTimeline({
    range: range ?? undefined,
    limit
  });

  return {
    archive: archivePath,
    range: {
      monoStart: range?.monoStart ?? null,
      monoEnd: range?.monoEnd ?? null
    },
    totals: {
      actions: derived.actionSpans.length,
      events: derived.totals.events,
      errors: derived.totals.errors,
      requests: derived.totals.requests
    },
    actions
  };
}

export async function findRootCauseCandidates(args: RootCauseCandidatesArgs): Promise<{
  archive: string;
  range: {
    monoStart: number | null;
    monoEnd: number | null;
  };
  windowMs: number;
  candidates: Array<{
    eventId: string;
    type: string;
    mono: number;
    message: string | null;
    aiRootCause: unknown;
    nearbyNetwork: Array<{
      reqId: string;
      method: string;
      url: string;
      status: number | null;
      failed: boolean;
      durationMs: number;
      deltaMs: number;
    }>;
    nearbyConsole: Array<{
      eventId: string;
      mono: number;
      level: string | null;
      text: string | null;
      deltaMs: number;
    }>;
  }>;
}> {
  const archivePath = resolveArchivePath(args.path);
  const range = buildRange(args.monoStart, args.monoEnd);
  const player = await openArchivePlayer(archivePath, args.passphrase, range ?? undefined);
  const limit = clampInt(args.limit ?? DEFAULT_TOP_N, 1, MAX_QUERY_LIMIT);
  const windowMs = Math.max(1, Math.min(120_000, Math.round(args.windowMs ?? 10_000)));
  const errors = player
    .query({
      range: range ?? undefined
    })
    .filter((event) => event.type.startsWith("error.") || event.lvl === "error")
    .sort((left, right) => right.mono - left.mono)
    .slice(0, limit);
  const waterfall = player.getNetworkWaterfall(range ?? undefined);
  const consoleEvents = player
    .query({
      range: range ?? undefined,
      types: ["console.entry"]
    })
    .map((event) => {
      const payload = asRecord(event.data);
      const level = typeof payload?.level === "string" ? payload.level.toLowerCase() : null;

      return {
        eventId: event.id,
        mono: event.mono,
        level,
        text: typeof payload?.text === "string" ? compactText(payload.text, 300) : null
      };
    })
    .filter((entry) => entry.level === "error" || entry.level === "warn");

  const candidates = errors.map((event) => {
    const payload = asRecord(event.data);
    const nearbyNetwork = waterfall
      .filter(
        (entry) =>
          (entry.failed || (typeof entry.status === "number" && entry.status >= 400)) &&
          entry.endMono <= event.mono &&
          entry.endMono >= event.mono - windowMs
      )
      .sort((left, right) => right.endMono - left.endMono)
      .slice(0, 5)
      .map((entry) => ({
        reqId: entry.reqId,
        method: entry.method,
        url: entry.url,
        status: typeof entry.status === "number" ? entry.status : null,
        failed: entry.failed,
        durationMs: Number(entry.durationMs.toFixed(2)),
        deltaMs: Number((event.mono - entry.endMono).toFixed(2))
      }));
    const nearbyConsole = consoleEvents
      .filter((consoleEvent) => {
        return consoleEvent.mono <= event.mono && consoleEvent.mono >= event.mono - windowMs;
      })
      .sort((left, right) => right.mono - left.mono)
      .slice(0, 5)
      .map((consoleEvent) => ({
        eventId: consoleEvent.eventId,
        mono: consoleEvent.mono,
        level: consoleEvent.level,
        text: consoleEvent.text,
        deltaMs: Number((event.mono - consoleEvent.mono).toFixed(2))
      }));

    return {
      eventId: event.id,
      type: event.type,
      mono: event.mono,
      message:
        typeof payload?.message === "string"
          ? compactText(payload.message, 300)
          : typeof payload?.text === "string"
            ? compactText(payload.text, 300)
            : null,
      aiRootCause: payload?.aiRootCause ?? null,
      nearbyNetwork,
      nearbyConsole
    };
  });

  return {
    archive: archivePath,
    range: {
      monoStart: range?.monoStart ?? null,
      monoEnd: range?.monoEnd ?? null
    },
    windowMs,
    candidates
  };
}

export async function compareSessions(args: CompareSessionsArgs): Promise<{
  left: {
    path: string;
    origin: string;
    mode: string;
    totals: {
      events: number;
      errors: number;
      requests: number;
      durationMs: number;
    };
    network: {
      total: number;
      failed: number;
      slowOver1000ms: number;
      p95DurationMs: number;
    };
  };
  right: {
    path: string;
    origin: string;
    mode: string;
    totals: {
      events: number;
      errors: number;
      requests: number;
      durationMs: number;
    };
    network: {
      total: number;
      failed: number;
      slowOver1000ms: number;
      p95DurationMs: number;
    };
  };
  summary: {
    eventDelta: number;
    errorDelta: number;
    requestDelta: number;
    durationDeltaMs: number;
  };
  topTypeDeltas: Array<{
    type: string;
    left: number;
    right: number;
    delta: number;
  }>;
  networkDiff: {
    failedDelta: number;
    slowDelta: number;
    p95DurationDeltaMs: number;
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
    topFailedRequests: Array<{
      side: "left" | "right";
      reqId: string;
      method: string;
      url: string;
      status: number | null;
      durationMs: number;
    }>;
    topSlowRequests: Array<{
      side: "left" | "right";
      reqId: string;
      method: string;
      url: string;
      status: number | null;
      durationMs: number;
    }>;
  };
  storageDiff: {
    leftEvents: number;
    rightEvents: number;
    kindDeltas: Array<{
      kind: string;
      left: number;
      right: number;
      delta: number;
    }>;
    hashOnlyLeft?: string[];
    hashOnlyRight?: string[];
  };
}> {
  const leftPath = resolveArchivePath(args.leftPath);
  const rightPath = resolveArchivePath(args.rightPath);
  const leftPlayer = await openArchivePlayer(leftPath, args.leftPassphrase);
  const rightPlayer = await openArchivePlayer(rightPath, args.rightPassphrase);
  const topTypeDeltas = clampInt(args.topTypeDeltas ?? DEFAULT_COMPARE_TOP, 1, MAX_COMPARE_TOP);
  const topRequestDiffs = clampInt(args.topRequestDiffs ?? DEFAULT_TOP_N, 1, MAX_COMPARE_TOP);
  const includeStorageHashes = args.includeStorageHashes === true;
  const comparison = leftPlayer.compareWith(rightPlayer);
  const storageComparison = leftPlayer.compareStorageWith(rightPlayer);
  const leftDerived = leftPlayer.buildDerived();
  const rightDerived = rightPlayer.buildDerived();
  const leftWaterfall = leftPlayer.getNetworkWaterfall();
  const rightWaterfall = rightPlayer.getNetworkWaterfall();
  const leftNet = summarizeNetworkMetrics(leftWaterfall, 1_000);
  const rightNet = summarizeNetworkMetrics(rightWaterfall, 1_000);
  const leftFailed = collectFailedRequests(leftWaterfall, "left", topRequestDiffs);
  const rightFailed = collectFailedRequests(rightWaterfall, "right", topRequestDiffs);
  const leftSlow = collectSlowRequests(leftWaterfall, "left", topRequestDiffs);
  const rightSlow = collectSlowRequests(rightWaterfall, "right", topRequestDiffs);
  const leftDuration = computeDurationMs(leftPlayer.events);
  const rightDuration = computeDurationMs(rightPlayer.events);

  return {
    left: {
      path: leftPath,
      origin: leftPlayer.archive.manifest.site.origin,
      mode: leftPlayer.archive.manifest.mode,
      totals: {
        events: leftDerived.totals.events,
        errors: leftDerived.totals.errors,
        requests: leftDerived.totals.requests,
        durationMs: leftDuration
      },
      network: leftNet
    },
    right: {
      path: rightPath,
      origin: rightPlayer.archive.manifest.site.origin,
      mode: rightPlayer.archive.manifest.mode,
      totals: {
        events: rightDerived.totals.events,
        errors: rightDerived.totals.errors,
        requests: rightDerived.totals.requests,
        durationMs: rightDuration
      },
      network: rightNet
    },
    summary: {
      eventDelta: comparison.eventDelta,
      errorDelta: comparison.errorDelta,
      requestDelta: comparison.requestDelta,
      durationDeltaMs: Number((rightDuration - leftDuration).toFixed(2))
    },
    topTypeDeltas: comparison.typeDeltas.slice(0, topTypeDeltas),
    networkDiff: {
      failedDelta: rightNet.failed - leftNet.failed,
      slowDelta: rightNet.slowOver1000ms - leftNet.slowOver1000ms,
      p95DurationDeltaMs: Number((rightNet.p95DurationMs - leftNet.p95DurationMs).toFixed(2)),
      endpointRegressions: comparison.endpointRegressions.slice(0, topRequestDiffs),
      topFailedRequests: [...leftFailed, ...rightFailed]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, topRequestDiffs),
      topSlowRequests: [...leftSlow, ...rightSlow]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, topRequestDiffs)
    },
    storageDiff: {
      leftEvents: storageComparison.leftEvents,
      rightEvents: storageComparison.rightEvents,
      kindDeltas: storageComparison.kindDeltas,
      ...(includeStorageHashes
        ? {
            hashOnlyLeft: storageComparison.hashOnlyLeft.slice(0, MAX_QUERY_LIMIT),
            hashOnlyRight: storageComparison.hashOnlyRight.slice(0, MAX_QUERY_LIMIT)
          }
        : {})
    }
  };
}

async function openArchivePlayer(
  path: string,
  passphrase?: string,
  range?: { monoStart?: number; monoEnd?: number }
): Promise<WebBlackboxPlayer> {
  try {
    const bytes = await readFile(path);
    return await WebBlackboxPlayer.open(new Uint8Array(bytes), {
      passphrase,
      range
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

function buildRange(
  monoStart: number | undefined,
  monoEnd: number | undefined
): {
  monoStart?: number;
  monoEnd?: number;
} | null {
  const hasStart = typeof monoStart === "number" && Number.isFinite(monoStart);
  const hasEnd = typeof monoEnd === "number" && Number.isFinite(monoEnd);

  if (!hasStart && !hasEnd) {
    return null;
  }

  return {
    monoStart: hasStart ? monoStart : undefined,
    monoEnd: hasEnd ? monoEnd : undefined
  };
}

function summarizeNetworkMetrics(
  entries: Array<{ failed: boolean; status?: number; durationMs: number }>,
  slowThresholdMs: number
): {
  total: number;
  failed: number;
  slowOver1000ms: number;
  p95DurationMs: number;
} {
  const durations = entries.map((entry) => entry.durationMs).sort((left, right) => left - right);
  const p95DurationMs = percentile(durations, 95);

  return {
    total: entries.length,
    failed: entries.filter((entry) => isFailedRequest(entry)).length,
    slowOver1000ms: entries.filter((entry) => entry.durationMs >= slowThresholdMs).length,
    p95DurationMs
  };
}

function collectFailedRequests(
  entries: Array<{
    reqId: string;
    method: string;
    url: string;
    status?: number;
    durationMs: number;
    failed: boolean;
  }>,
  side: "left" | "right",
  limit: number
): Array<{
  side: "left" | "right";
  reqId: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
}> {
  return entries
    .filter((entry) => isFailedRequest(entry))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, limit)
    .map((entry) => ({
      side,
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: typeof entry.status === "number" ? entry.status : null,
      durationMs: Number(entry.durationMs.toFixed(2))
    }));
}

function collectSlowRequests(
  entries: Array<{
    reqId: string;
    method: string;
    url: string;
    status?: number;
    durationMs: number;
  }>,
  side: "left" | "right",
  limit: number
): Array<{
  side: "left" | "right";
  reqId: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
}> {
  return entries
    .slice()
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, limit)
    .map((entry) => ({
      side,
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: typeof entry.status === "number" ? entry.status : null,
      durationMs: Number(entry.durationMs.toFixed(2))
    }));
}

function computeDurationMs(events: Array<{ mono: number }>): number {
  if (events.length < 2) {
    return 0;
  }

  return Number((events[events.length - 1]!.mono - events[0]!.mono).toFixed(2));
}

function percentile(sortedNumbers: number[], p: number): number {
  if (sortedNumbers.length === 0) {
    return 0;
  }

  const rank = Math.min(
    sortedNumbers.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedNumbers.length) - 1)
  );
  return Number((sortedNumbers[rank] ?? 0).toFixed(2));
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
