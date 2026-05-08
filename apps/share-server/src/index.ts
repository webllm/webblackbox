import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

type ShareRecord = {
  id: string;
  createdAt: number;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  shareUrl: string;
  summary: ShareSummary;
};

type ShareSummary = {
  schemaVersion: 1;
  source: "client" | "server" | "unavailable";
  analyzed: boolean;
  encrypted: boolean;
  analysisError?: string;
  manifest?: {
    mode: string;
    chunkCodec: string;
    recordedAt: string;
  };
  totals?: {
    events: number;
    blobs?: number;
    privacyViolations?: number;
    errors: number;
    requests: number;
    actions: number;
    durationMs: number;
  };
  topActionTriggers?: Array<{
    triggerType: string;
    count: number;
    errorRate: number;
  }>;
  privacy?: {
    redaction: {
      hashSensitiveValues: boolean;
      headerRuleCount: number;
      cookieRuleCount: number;
      bodyPatternCount: number;
      blockedSelectorCount: number;
    };
    detected: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["detected"];
    scanner: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["scanner"];
    categories?: Array<{
      category: string;
      events: number;
      low: number;
      medium: number;
      high: number;
      redacted: number;
      unredacted: number;
    }>;
  };
};

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_UPLOAD_BYTES = parsePositiveInteger(
  process.env.WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES,
  250 * 1024 * 1024
);
const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const DATA_ROOT = resolve(process.env.WEBBLACKBOX_SHARE_DATA_DIR ?? ".webblackbox-share-data");
const ARCHIVES_DIR = join(DATA_ROOT, "archives");
const RECORDS_DIR = join(DATA_ROOT, "records");
const SHARE_API_KEY = readOptionalSecret(process.env.WEBBLACKBOX_SHARE_API_KEY);
const SHARE_ALLOWED_ORIGIN = normalizeAllowedOrigin(process.env.WEBBLACKBOX_SHARE_ALLOWED_ORIGIN);
const TRUST_X_FORWARDED_FOR = parseBooleanFlag(process.env.WEBBLACKBOX_TRUST_X_FORWARDED_FOR);
const ALLOW_PLAINTEXT_SHARE_UPLOADS = parseBooleanFlag(
  process.env.WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS
);
const UPLOAD_RATE_LIMIT_MAX = parseRateLimitCount(
  process.env.WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX,
  10
);
const UPLOAD_RATE_LIMIT_WINDOW_MS = parseRateLimitWindowMs(
  process.env.WEBBLACKBOX_UPLOAD_RATE_LIMIT_WINDOW_MS,
  60_000
);
const SHARE_SUMMARY_HEADER = "x-webblackbox-share-summary";
const MAX_SHARE_SUMMARY_HEADER_BYTES = 16 * 1024;
const RATE_LIMIT_CLEANUP_INTERVAL = 64;
const MAX_TRACKED_RATE_BUCKETS = 4096;
const uploadRateWindows = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();
let rateLimitCleanupCounter = 0;

void startShareServer().catch((error) => {
  console.error("[share-server] startup failed", error);
  process.exitCode = 1;
});

async function startShareServer(): Promise<void> {
  await ensureStorageLayout();

  const port = parsePort(process.env.PORT);
  const host = parseBindHost(process.env.WEBBLACKBOX_SHARE_BIND_HOST);
  const server = createServer((request, response) => {
    void routeRequest(request, response).catch((error) => {
      console.warn("[share-server] request failed", error);
      respondJson(response, 500, {
        error: "Internal server error."
      });
    });
  });

  server.listen(port, host, () => {
    console.info(`[share-server] listening on http://${host}:${port}`);
    console.info(`[share-server] data root: ${DATA_ROOT}`);
  });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", requestBaseUrl(request));
  applyCorsHeaders(response, request, requestUrl);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const method = request.method ?? "GET";
  const pathname = requestUrl.pathname;

  if (isProtectedShareRoute(pathname) && !isAuthorizedRequest(request, requestUrl)) {
    if (pathname.startsWith("/share/")) {
      respondHtml(response, 401, "<h1>Unauthorized</h1><p>Provide a valid share API key.</p>");
      return;
    }
    respondJson(response, 401, {
      error: "Unauthorized."
    });
    return;
  }

  if (method === "POST" && pathname === "/api/share/upload") {
    await handleUpload(request, response, requestUrl);
    return;
  }

  if (method === "GET" && pathname === "/api/share/list") {
    await handleList(response);
    return;
  }

  const metadataMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/meta$/.exec(pathname);

  if (method === "GET" && metadataMatch?.[1]) {
    await handleGetMetadata(response, metadataMatch[1]);
    return;
  }

  const archiveMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/archive$/.exec(pathname);

  if (method === "GET" && archiveMatch?.[1]) {
    await handleDownloadArchive(response, archiveMatch[1]);
    return;
  }

  const sharePageMatch = /^\/share\/([a-zA-Z0-9_-]+)$/.exec(pathname);

  if (method === "GET" && sharePageMatch?.[1]) {
    await handleSharePage(response, sharePageMatch[1], requestUrl);
    return;
  }

  respondJson(response, 404, {
    error: "Not found."
  });
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const rateLimited = consumeUploadRateLimitToken(resolveClientKey(request));

  if (!rateLimited.ok) {
    respondJson(response, 429, {
      error: `Upload rate limit exceeded. Retry in ${rateLimited.retryAfterSec}s.`
    });
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      respondJson(response, 413, {
        error: `Upload payload exceeds ${error.maxBytes} bytes.`
      });
      return;
    }

    throw error;
  }

  if (bytes.byteLength === 0) {
    respondJson(response, 400, {
      error: "Upload payload is empty."
    });
    return;
  }

  const id = randomUUID().replaceAll("-", "");
  const filenameHeader = request.headers["x-webblackbox-filename"];
  const fileName = publicArchiveFileName(
    id,
    typeof filenameHeader === "string" ? filenameHeader : undefined
  );
  const archivePath = archivePathForId(id);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  let clientSummary: ShareSummary | null;

  try {
    clientSummary = readClientShareSummary(request);
  } catch (error) {
    if (error instanceof ShareSummaryHeaderError) {
      respondJson(response, 400, {
        error: error.message
      });
      return;
    }

    throw error;
  }

  const archiveEnvelopeSummary = await buildShareSummary(bytes);
  const summary = clientSummary
    ? applyArchiveEnvelopeToClientSummary(clientSummary, archiveEnvelopeSummary)
    : archiveEnvelopeSummary;

  if (summary.analyzed && summary.privacy?.scanner.status === "blocked") {
    respondJson(response, 422, {
      error: "Share upload blocked by privacy scanner.",
      scanner: summary.privacy.scanner
    });
    return;
  }

  if (!summary.encrypted && !ALLOW_PLAINTEXT_SHARE_UPLOADS) {
    respondJson(response, summary.analyzed ? 422 : 400, {
      error: summary.analyzed
        ? "Public share uploads require encrypted WebBlackbox archives."
        : "Upload is not a valid encrypted WebBlackbox archive."
    });
    return;
  }

  const shareUrl = `${requestOrigin(request, requestUrl)}/share/${id}`;
  const record: ShareRecord = {
    id,
    createdAt: Date.now(),
    fileName,
    sizeBytes: bytes.byteLength,
    checksumSha256,
    shareUrl,
    summary
  };

  await writeFile(archivePath, bytes);
  await writeRecord(record);

  respondJson(response, 201, {
    shareId: id,
    shareUrl,
    fileName,
    sizeBytes: bytes.byteLength,
    summary
  });
}

async function handleList(response: ServerResponse): Promise<void> {
  const records = await loadAllRecords();
  const items = records
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((record) => buildPublicShareMetadata(record));

  respondJson(response, 200, {
    items
  });
}

async function handleGetMetadata(response: ServerResponse, id: string): Promise<void> {
  const record = await readRecord(id);

  if (!record) {
    respondJson(response, 404, {
      error: "Share not found."
    });
    return;
  }

  respondJson(response, 200, buildPublicShareMetadata(record));
}

async function handleDownloadArchive(response: ServerResponse, id: string): Promise<void> {
  const record = await readRecord(id);

  if (!record) {
    respondJson(response, 404, {
      error: "Share not found."
    });
    return;
  }

  try {
    const bytes = await readFile(archivePathForId(id));
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${record.fileName}"`
    });
    response.end(bytes);
  } catch {
    respondJson(response, 404, {
      error: "Archive file not found."
    });
  }
}

async function handleSharePage(
  response: ServerResponse,
  id: string,
  requestUrl: URL
): Promise<void> {
  const record = await readRecord(id);

  if (!record) {
    respondHtml(
      response,
      404,
      "<h1>Share Not Found</h1><p>The requested WebBlackbox share does not exist.</p>"
    );
    return;
  }

  const authQuerySuffix = buildAuthQuerySuffix(requestUrl);
  const publicMetadata = buildPublicShareMetadata(record);
  const metadataPretty = escapeHtml(JSON.stringify(publicMetadata.summary, null, 2));
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebBlackbox Share ${escapeHtml(record.id)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; color: #202124; background: #f8fafc; }
      main { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      .meta { margin: 0 0 14px; color: #5f6368; font-size: 14px; }
      .actions { display: flex; gap: 8px; margin: 14px 0 18px; }
      a.btn { display: inline-block; text-decoration: none; background: #1a73e8; color: #fff; border-radius: 6px; padding: 8px 12px; font-weight: 600; }
      a.btn.secondary { background: #3c4043; }
      pre { background: #0b1020; color: #e6edf3; padding: 14px; border-radius: 8px; overflow: auto; font-size: 12px; line-height: 1.4; }
    </style>
  </head>
  <body>
    <main>
      <h1>WebBlackbox Share</h1>
      <p class="meta">ID: <code>${escapeHtml(record.id)}</code> · File: <code>${escapeHtml(
        publicMetadata.fileName
      )}</code> · Size: ${formatSize(record.sizeBytes)}</p>
      <div class="actions">
        <a class="btn" href="/api/share/${encodeURIComponent(record.id)}/archive${authQuerySuffix}">Download Archive</a>
        <a class="btn secondary" href="/api/share/${encodeURIComponent(record.id)}/meta${authQuerySuffix}">View Metadata JSON</a>
      </div>
      <pre>${metadataPretty}</pre>
    </main>
  </body>
</html>`;

  respondHtml(response, 200, page);
}

async function buildShareSummary(bytes: Uint8Array): Promise<ShareSummary> {
  try {
    const player = await WebBlackboxPlayer.open(bytes);
    const manifest = player.archive.manifest;
    const derived = player.buildDerived();
    const actions = player.getActionTimeline();
    const privacyReport = player.getPrivacyProtectionReport();

    return {
      schemaVersion: 1,
      source: "server",
      analyzed: true,
      encrypted: Boolean(manifest.encryption),
      manifest: {
        mode: manifest.mode,
        chunkCodec: manifest.chunkCodec,
        recordedAt: manifest.createdAt
      },
      totals: {
        events: derived.totals.events,
        blobs: player.archive.privacyManifest?.totals.blobs,
        privacyViolations: player.archive.privacyManifest?.totals.privacyViolations,
        errors: derived.totals.errors,
        requests: derived.totals.requests,
        actions: derived.actionSpans.length,
        durationMs: Math.round(manifest.stats.durationMs)
      },
      topActionTriggers: collectTopActionTriggers(actions),
      privacy: {
        redaction: {
          hashSensitiveValues: privacyReport.redaction.hashSensitiveValues,
          headerRuleCount: privacyReport.redaction.headers.length,
          cookieRuleCount: privacyReport.redaction.cookieNames.length,
          bodyPatternCount: privacyReport.redaction.bodyPatterns.length,
          blockedSelectorCount: privacyReport.redaction.blockedSelectors.length
        },
        detected: privacyReport.detected,
        scanner: privacyReport.scanner,
        categories: player.archive.privacyManifest?.categories.map((category) => ({ ...category }))
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      source: "unavailable",
      analyzed: false,
      encrypted: message.toLowerCase().includes("encrypted"),
      analysisError: redactText(message, 240)
    };
  }
}

function readClientShareSummary(request: IncomingMessage): ShareSummary | null {
  const rawHeader = request.headers[SHARE_SUMMARY_HEADER];

  if (rawHeader === undefined) {
    return null;
  }

  if (typeof rawHeader !== "string") {
    throw new ShareSummaryHeaderError("Share summary header must be a single string value.");
  }

  const raw = rawHeader.trim();

  if (raw.length === 0) {
    return null;
  }

  if (Buffer.byteLength(raw, "utf8") > MAX_SHARE_SUMMARY_HEADER_BYTES) {
    throw new ShareSummaryHeaderError("Share summary header is too large.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new ShareSummaryHeaderError("Share summary header is not valid encoded JSON.");
  }

  return normalizeClientShareSummary(parsed);
}

function normalizeClientShareSummary(value: unknown): ShareSummary {
  const record = asRecord(value);
  const manifest = asRecord(record.manifest);
  const totals = asRecord(record.totals);
  const privacy = asRecord(record.privacy);

  return {
    schemaVersion: 1,
    source: "client",
    analyzed: readBoolean(record.analyzed, true),
    encrypted: readBoolean(record.encrypted, true),
    manifest: {
      mode: readString(manifest.mode, "unknown", 32),
      chunkCodec: readString(manifest.chunkCodec, "unknown", 32),
      recordedAt: readString(manifest.recordedAt, "", 64)
    },
    totals: {
      events: readNonNegativeInteger(totals.events, 0),
      blobs: readOptionalNonNegativeInteger(totals.blobs),
      privacyViolations: readOptionalNonNegativeInteger(totals.privacyViolations),
      errors: readNonNegativeInteger(totals.errors, 0),
      requests: readNonNegativeInteger(totals.requests, 0),
      actions: readNonNegativeInteger(totals.actions, 0),
      durationMs: readNonNegativeInteger(totals.durationMs, 0)
    },
    topActionTriggers: normalizeActionTriggerSummaries(record.topActionTriggers),
    privacy: normalizeSharePrivacySummary(privacy)
  };
}

function applyArchiveEnvelopeToClientSummary(
  clientSummary: ShareSummary,
  archiveEnvelopeSummary: ShareSummary
): ShareSummary {
  return {
    ...clientSummary,
    encrypted: archiveEnvelopeSummary.encrypted,
    analysisError: archiveEnvelopeSummary.encrypted
      ? undefined
      : archiveEnvelopeSummary.analysisError
  };
}

function normalizeSharePrivacySummary(value: Record<string, unknown>): ShareSummary["privacy"] {
  const redaction = asRecord(value.redaction);
  const detected = asRecord(value.detected);
  const scanner = asRecord(value.scanner);

  return {
    redaction: {
      hashSensitiveValues: readBoolean(redaction.hashSensitiveValues, true),
      headerRuleCount: readNonNegativeInteger(redaction.headerRuleCount, 0),
      cookieRuleCount: readNonNegativeInteger(redaction.cookieRuleCount, 0),
      bodyPatternCount: readNonNegativeInteger(redaction.bodyPatternCount, 0),
      blockedSelectorCount: readNonNegativeInteger(redaction.blockedSelectorCount, 0)
    },
    detected: {
      redactedMarkers: readNonNegativeInteger(detected.redactedMarkers, 0),
      hashedSensitiveValues: readNonNegativeInteger(detected.hashedSensitiveValues, 0),
      sensitiveKeyMentions: readNonNegativeInteger(detected.sensitiveKeyMentions, 0)
    },
    scanner: {
      preEncryption: readBoolean(scanner.preEncryption, false),
      status: readScannerStatus(scanner.status),
      findingCount: readNonNegativeInteger(scanner.findingCount, 0)
    },
    categories: normalizeCategorySummaries(value.categories)
  };
}

function normalizeActionTriggerSummaries(value: unknown): ShareSummary["topActionTriggers"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 10).map((entry) => {
    const record = asRecord(entry);
    return {
      triggerType: readString(record.triggerType, "unknown", 64),
      count: readNonNegativeInteger(record.count, 0),
      errorRate: readBoundedNumber(record.errorRate, 0, 0, 1)
    };
  });
}

function normalizeCategorySummaries(
  value: unknown
): NonNullable<ShareSummary["privacy"]>["categories"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 24).map((entry) => {
    const record = asRecord(entry);
    return {
      category: readString(record.category, "unknown", 32),
      events: readNonNegativeInteger(record.events, 0),
      low: readNonNegativeInteger(record.low, 0),
      medium: readNonNegativeInteger(record.medium, 0),
      high: readNonNegativeInteger(record.high, 0),
      redacted: readNonNegativeInteger(record.redacted, 0),
      unredacted: readNonNegativeInteger(record.unredacted, 0)
    };
  });
}

function collectTopActionTriggers(
  actions: ReturnType<WebBlackboxPlayer["getActionTimeline"]>
): ShareSummary["topActionTriggers"] {
  const counts = new Map<
    string,
    {
      triggerType: string;
      count: number;
      actionsWithErrors: number;
    }
  >();

  for (const action of actions) {
    const triggerType = action.triggerType ?? "unknown";
    const current = counts.get(triggerType) ?? {
      triggerType,
      count: 0,
      actionsWithErrors: 0
    };
    current.count += 1;
    if (action.errorCount > 0) {
      current.actionsWithErrors += 1;
    }
    counts.set(triggerType, current);
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)
    .map((entry) => ({
      triggerType: entry.triggerType,
      count: entry.count,
      errorRate: roundTo(entry.count > 0 ? entry.actionsWithErrors / entry.count : 0, 4)
    }));
}

function redactText(input: string, maxLength = 120): string {
  const compact = input.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/([?&](?:token|auth|password|secret|api[_-]?key)=)[^&]+/gi, "$1[redacted]")
    .replaceAll(/\b((?:token|auth|password|secret|api[_-]?key)\s*=\s*)[^\s,&;]+/gi, "$1[redacted]")
    .replaceAll(/\b((?:token|auth|password|secret|api[_-]?key)\s*:\s*)[^\s,;]+/gi, "$1[redacted]")
    .replaceAll(
      /("?(?:token|auth|password|secret|api[_-]?key)"?\s*:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/gi,
      '$1"[redacted]"'
    )
    .replaceAll(/[A-Fa-f0-9]{32,}/g, "[redacted-hex]")
    .replaceAll(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted-base64]");

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** Math.max(0, digits);
  return Math.round(value * factor) / factor;
}

async function ensureStorageLayout(): Promise<void> {
  await mkdir(ARCHIVES_DIR, {
    recursive: true
  });
  await mkdir(RECORDS_DIR, {
    recursive: true
  });
}

async function readRecord(id: string): Promise<ShareRecord | null> {
  try {
    const raw = await readFile(recordPathForId(id), "utf8");
    return JSON.parse(raw) as ShareRecord;
  } catch {
    return null;
  }
}

async function loadAllRecords(): Promise<ShareRecord[]> {
  const fileNames = await readdir(RECORDS_DIR);
  const records = await Promise.all(
    fileNames
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const id = name.slice(0, -".json".length);
        return readRecord(id);
      })
  );

  return records.filter((record): record is ShareRecord => Boolean(record));
}

async function writeRecord(record: ShareRecord): Promise<void> {
  await writeFile(recordPathForId(record.id), JSON.stringify(record, null, 2));
}

function buildPublicShareMetadata(record: ShareRecord): {
  id: string;
  createdAt: number;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  shareUrl: string;
  summary: ShareSummary;
} {
  return {
    id: record.id,
    createdAt: record.createdAt,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    shareUrl: record.shareUrl,
    summary: record.summary
  };
}

function recordPathForId(id: string): string {
  return join(RECORDS_DIR, `${id}.json`);
}

function archivePathForId(id: string): string {
  return join(ARCHIVES_DIR, `${id}.webblackbox`);
}

function parsePort(rawValue: string | undefined): number {
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PORT;
  }

  return Math.floor(parsed);
}

function parseBindHost(rawValue: string | undefined): string {
  if (typeof rawValue !== "string") {
    return DEFAULT_HOST;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_HOST;
}

function normalizeAllowedOrigin(rawValue: string | undefined): string {
  const resolved = (rawValue ?? "same-origin").trim();

  if (resolved.length === 0) {
    return "same-origin";
  }

  return resolved.toLowerCase() === "same-origin" ? "same-origin" : resolved;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (!(chunk instanceof Buffer)) {
      continue;
    }

    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }

    chunks.push(chunk);
  }

  const merged = Buffer.concat(chunks);
  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
}

class PayloadTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes.`);
  }
}

class ShareSummaryHeaderError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return redactText(value, maxLength);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function readScannerStatus(value: unknown): "passed" | "blocked" | "unknown" {
  return value === "passed" || value === "blocked" || value === "unknown" ? value : "unknown";
}

function requestBaseUrl(request: IncomingMessage): string {
  const host = request.headers.host;
  return host && host.length > 0 ? `http://${host}` : DEFAULT_BASE_URL;
}

function requestOrigin(request: IncomingMessage, requestUrl: URL): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string" && forwardedProto.length > 0
      ? forwardedProto
      : requestUrl.protocol.replace(":", "");
  const host = request.headers.host ?? requestUrl.host;
  return `${protocol}://${host}`;
}

function publicArchiveFileName(id: string, rawName: string | undefined): string {
  const trimmed = rawName?.trim().toLowerCase() ?? "";
  const extension = trimmed.endsWith(".zip") ? ".zip" : ".webblackbox";
  return `webblackbox-share-${id.slice(0, 12)}${extension}`;
}

function applyCorsHeaders(
  response: ServerResponse,
  request: IncomingMessage,
  requestUrl: URL
): void {
  const requestOrigin = request.headers.origin;
  const allowOrigin = resolveAllowedOrigin(
    requestOrigin,
    requestOriginFromUrl(request, requestUrl)
  );

  if (allowOrigin) {
    response.setHeader("access-control-allow-origin", allowOrigin);
    response.setHeader("vary", "origin");
  }

  response.setHeader(
    "access-control-allow-headers",
    `content-type,authorization,x-webblackbox-api-key,x-webblackbox-filename,${SHARE_SUMMARY_HEADER}`
  );
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function respondHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8"
  });
  response.end(html);
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }

  return `${(mb / 1024).toFixed(2)} GB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveAllowedOrigin(
  originHeader: string | string[] | undefined,
  expectedOrigin: string
): string | null {
  if (SHARE_ALLOWED_ORIGIN === "*") {
    return "*";
  }

  if (typeof originHeader !== "string" || originHeader.trim().length === 0) {
    return null;
  }

  if (SHARE_ALLOWED_ORIGIN === "same-origin") {
    return originHeader === expectedOrigin ? expectedOrigin : null;
  }

  return originHeader === SHARE_ALLOWED_ORIGIN ? SHARE_ALLOWED_ORIGIN : null;
}

function buildAuthQuerySuffix(requestUrl: URL): string {
  const key = requestUrl.searchParams.get("key");
  if (!key) {
    return "";
  }

  return `?key=${encodeURIComponent(key)}`;
}

function isProtectedShareRoute(pathname: string): boolean {
  return pathname.startsWith("/api/share/") || pathname.startsWith("/share/");
}

function isAuthorizedRequest(request: IncomingMessage, requestUrl: URL): boolean {
  if (!SHARE_API_KEY) {
    return isLoopbackRequest(request);
  }

  const headerToken = readAuthTokenFromRequest(request);
  if (headerToken && equalsSecret(headerToken, SHARE_API_KEY)) {
    return true;
  }

  const queryToken = requestUrl.searchParams.get("key");
  if (queryToken && equalsSecret(queryToken, SHARE_API_KEY)) {
    return true;
  }

  return false;
}

function requestOriginFromUrl(request: IncomingMessage, requestUrl: URL): string {
  return requestOrigin(request, requestUrl);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = resolveClientAddress(request);
  return Boolean(address && isLoopbackAddress(address));
}

function resolveClientAddress(request: IncomingMessage): string | null {
  if (TRUST_X_FORWARDED_FOR) {
    const forwardedFor = request.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
      const first = forwardedFor.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
  }

  const socketAddress = request.socket.remoteAddress;
  return typeof socketAddress === "string" && socketAddress.length > 0 ? socketAddress : null;
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function readAuthTokenFromRequest(request: IncomingMessage): string | null {
  const apiKeyHeader = request.headers["x-webblackbox-api-key"];

  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function equalsSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readOptionalSecret(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRateLimitCount(value: string | undefined, fallback: number): number {
  return parsePositiveInteger(value, fallback);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseRateLimitWindowMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1_000, Math.floor(parsed));
}

function resolveClientKey(request: IncomingMessage): string {
  const address = resolveClientAddress(request);
  return address ? `ip:${address}` : "ip:unknown";
}

function consumeUploadRateLimitToken(
  clientKey: string
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  maybeCleanupUploadRateWindows(now);
  const bucket = uploadRateWindows.get(clientKey);

  if (!bucket || bucket.resetAt <= now) {
    uploadRateWindows.set(clientKey, {
      count: 1,
      resetAt: now + UPLOAD_RATE_LIMIT_WINDOW_MS,
      lastSeenAt: now
    });
    return {
      ok: true
    };
  }

  if (bucket.count >= UPLOAD_RATE_LIMIT_MAX) {
    bucket.lastSeenAt = now;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  bucket.count += 1;
  bucket.lastSeenAt = now;
  return {
    ok: true
  };
}

function maybeCleanupUploadRateWindows(now: number): void {
  rateLimitCleanupCounter += 1;
  if (
    rateLimitCleanupCounter % RATE_LIMIT_CLEANUP_INTERVAL !== 0 &&
    uploadRateWindows.size < MAX_TRACKED_RATE_BUCKETS
  ) {
    return;
  }

  for (const [clientKey, bucket] of uploadRateWindows) {
    if (bucket.resetAt <= now) {
      uploadRateWindows.delete(clientKey);
    }
  }

  if (uploadRateWindows.size <= MAX_TRACKED_RATE_BUCKETS) {
    return;
  }

  const overflow = uploadRateWindows.size - MAX_TRACKED_RATE_BUCKETS;
  const oldestBuckets = [...uploadRateWindows.entries()]
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, overflow);

  for (const [clientKey] of oldestBuckets) {
    uploadRateWindows.delete(clientKey);
  }
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
