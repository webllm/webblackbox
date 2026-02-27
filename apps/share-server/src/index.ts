import { createHash, randomUUID } from "node:crypto";
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
  analyzed: boolean;
  encrypted: boolean;
  analysisError?: string;
  manifest?: {
    origin: string;
    mode: string;
    chunkCodec: string;
    recordedAt: string;
  };
  totals?: {
    events: number;
    errors: number;
    requests: number;
    actions: number;
    durationMs: number;
  };
  topEndpoints?: Array<{
    endpoint: string;
    method: string;
    count: number;
    failedRate: number;
    p95DurationMs: number;
  }>;
  topErrorFingerprints?: Array<{
    fingerprint: string;
    count: number;
  }>;
  topActionTriggers?: Array<{
    triggerType: string;
    count: number;
    errorRate: number;
  }>;
};

const DEFAULT_PORT = 8787;
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const DEFAULT_BASE_URL = `http://localhost:${DEFAULT_PORT}`;
const DATA_ROOT = resolve(process.env.WEBBLACKBOX_SHARE_DATA_DIR ?? ".webblackbox-share-data");
const ARCHIVES_DIR = join(DATA_ROOT, "archives");
const RECORDS_DIR = join(DATA_ROOT, "records");

void startShareServer().catch((error) => {
  console.error("[share-server] startup failed", error);
  process.exitCode = 1;
});

async function startShareServer(): Promise<void> {
  await ensureStorageLayout();

  const port = parsePort(process.env.PORT);
  const server = createServer((request, response) => {
    void routeRequest(request, response).catch((error) => {
      console.warn("[share-server] request failed", error);
      respondJson(response, 500, {
        error: "Internal server error."
      });
    });
  });

  server.listen(port, () => {
    console.info(`[share-server] listening on http://localhost:${port}`);
    console.info(`[share-server] data root: ${DATA_ROOT}`);
  });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", requestBaseUrl(request));
  const method = request.method ?? "GET";
  const pathname = requestUrl.pathname;

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
    await handleSharePage(response, sharePageMatch[1]);
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
  const bytes = await readRequestBody(request, MAX_UPLOAD_BYTES);

  if (bytes.byteLength === 0) {
    respondJson(response, 400, {
      error: "Upload payload is empty."
    });
    return;
  }

  const id = randomUUID().replaceAll("-", "");
  const filenameHeader = request.headers["x-webblackbox-filename"];
  const passphraseHeader = request.headers["x-webblackbox-passphrase"];
  const fileName = normalizeFileName(
    typeof filenameHeader === "string" ? filenameHeader : `session-${id}.webblackbox`
  );
  const passphrase =
    typeof passphraseHeader === "string" && passphraseHeader.trim().length > 0
      ? passphraseHeader.trim()
      : undefined;
  const archivePath = archivePathForId(id);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const summary = await buildShareSummary(bytes, passphrase);
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
    .map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      shareUrl: record.shareUrl,
      summary: record.summary
    }));

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

  respondJson(response, 200, record);
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

async function handleSharePage(response: ServerResponse, id: string): Promise<void> {
  const record = await readRecord(id);

  if (!record) {
    respondHtml(
      response,
      404,
      "<h1>Share Not Found</h1><p>The requested WebBlackbox share does not exist.</p>"
    );
    return;
  }

  const metadataPretty = escapeHtml(JSON.stringify(record.summary, null, 2));
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
        record.fileName
      )}</code> · Size: ${formatSize(record.sizeBytes)}</p>
      <div class="actions">
        <a class="btn" href="/api/share/${encodeURIComponent(record.id)}/archive">Download Archive</a>
        <a class="btn secondary" href="/api/share/${encodeURIComponent(record.id)}/meta">View Metadata JSON</a>
      </div>
      <pre>${metadataPretty}</pre>
    </main>
  </body>
</html>`;

  respondHtml(response, 200, page);
}

async function buildShareSummary(bytes: Uint8Array, passphrase?: string): Promise<ShareSummary> {
  try {
    const player = await WebBlackboxPlayer.open(bytes, passphrase ? { passphrase } : undefined);
    const manifest = player.archive.manifest;
    const derived = player.buildDerived();
    const waterfall = player.getNetworkWaterfall();
    const actions = player.getActionTimeline();
    const allEvents = player.query();
    const errorEvents = allEvents.filter(
      (event) => event.type.startsWith("error.") || event.lvl === "error"
    );

    return {
      analyzed: true,
      encrypted: Boolean(manifest.encryption),
      manifest: {
        origin: redactText(manifest.site.origin),
        mode: manifest.mode,
        chunkCodec: manifest.chunkCodec,
        recordedAt: manifest.createdAt
      },
      totals: {
        events: derived.totals.events,
        errors: derived.totals.errors,
        requests: derived.totals.requests,
        actions: derived.actionSpans.length,
        durationMs: Math.round(manifest.stats.durationMs)
      },
      topEndpoints: collectTopEndpoints(waterfall),
      topErrorFingerprints: collectTopErrorFingerprints(actions, errorEvents),
      topActionTriggers: collectTopActionTriggers(actions)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      analyzed: false,
      encrypted: message.toLowerCase().includes("encrypted"),
      analysisError: redactText(message, 240)
    };
  }
}

function collectTopEndpoints(
  entries: ReturnType<WebBlackboxPlayer["getNetworkWaterfall"]>
): ShareSummary["topEndpoints"] {
  const endpointStats = new Map<
    string,
    {
      endpoint: string;
      method: string;
      count: number;
      failed: number;
      durations: number[];
    }
  >();

  for (const entry of entries) {
    const endpoint = normalizeEndpoint(entry.url);
    const method = entry.method.toUpperCase();
    const key = `${method} ${endpoint}`;
    const current = endpointStats.get(key) ?? {
      endpoint,
      method,
      count: 0,
      failed: 0,
      durations: []
    };

    current.count += 1;
    if (entry.failed || (typeof entry.status === "number" && entry.status >= 400)) {
      current.failed += 1;
    }
    if (Number.isFinite(entry.durationMs)) {
      current.durations.push(Math.max(0, entry.durationMs));
    }

    endpointStats.set(key, current);
  }

  return [...endpointStats.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)
    .map((entry) => ({
      endpoint: entry.endpoint,
      method: entry.method,
      count: entry.count,
      failedRate: roundTo(entry.count > 0 ? entry.failed / entry.count : 0, 4),
      p95DurationMs: roundTo(percentile(entry.durations, 0.95), 1)
    }));
}

function collectTopErrorFingerprints(
  actions: ReturnType<WebBlackboxPlayer["getActionTimeline"]>,
  errorEvents: ReturnType<WebBlackboxPlayer["query"]>
): ShareSummary["topErrorFingerprints"] {
  const counts = new Map<string, number>();

  for (const action of actions) {
    for (const error of action.errors) {
      const key = fingerprintError(error.type, error.message);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    for (const event of errorEvents) {
      const key = fingerprintError(event.type, stringifyPayload(event.data));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([fingerprint, count]) => ({
      fingerprint,
      count
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);
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

function fingerprintError(type: string, message: string | null | undefined): string {
  return redactText(`${type}:${message ?? ""}`, 180);
}

function normalizeEndpoint(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const noQuery = rawUrl.split("?")[0] ?? rawUrl;
    return redactText(noQuery, 140);
  }
}

function redactText(input: string, maxLength = 120): string {
  const compact = input.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/([?&](?:token|auth|password|secret|api[_-]?key)=)[^&]+/gi, "$1[redacted]")
    .replaceAll(/[A-Fa-f0-9]{32,}/g, "[redacted-hex]")
    .replaceAll(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted-base64]");

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
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

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (!(chunk instanceof Buffer)) {
      continue;
    }

    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Payload exceeds ${maxBytes} bytes.`);
    }

    chunks.push(chunk);
  }

  const merged = Buffer.concat(chunks);
  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
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

function normalizeFileName(rawName: string): string {
  const compact = rawName.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  const safe = compact.length > 0 ? compact : "session.webblackbox";
  return safe.endsWith(".webblackbox") || safe.endsWith(".zip") ? safe : `${safe}.webblackbox`;
}

function applyCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader(
    "access-control-allow-headers",
    "content-type,x-webblackbox-filename,x-webblackbox-passphrase"
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
