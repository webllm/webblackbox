import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import JSZip from "jszip";
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

type ShareRecord = {
  id: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  shareUrl: string;
  summary: ShareSummary;
};

type ShareAuditAction = "upload" | "list" | "metadata" | "download" | "page" | "revoke";
type ShareAuditOutcome = "ok" | "not-found" | "expired" | "revoked" | "blocked" | "error";
type ShareApiScope = "upload" | "read" | "list" | "revoke" | "admin";

type ShareApiCredential = {
  secret: string;
  scopes: Set<ShareApiScope>;
};
type ShareAuthorizationSource = "loopback" | "token" | "query" | "read-session";
type ShareAuthorizationResult = {
  authorized: boolean;
  source?: ShareAuthorizationSource;
};
type ShareReadSession = {
  shareId: string;
  expiresAt: number;
};

type ArchiveEnvelopeSummary = {
  encrypted: boolean;
  encryptedPrivatePathsComplete: boolean;
  missingEncryptedPaths: string[];
  encryptedPrivatePathsConfidential: boolean;
  plaintextEncryptedPaths: string[];
  analysisError?: string;
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
const AUDIT_DIR = join(DATA_ROOT, "audit");
const SHARE_AUDIT_LOG_PATH = join(AUDIT_DIR, "share-access.jsonl");
const SHARE_API_KEY = readOptionalSecret(process.env.WEBBLACKBOX_SHARE_API_KEY);
const SHARE_API_CREDENTIALS = parseShareApiCredentials(
  process.env.WEBBLACKBOX_SHARE_API_KEYS,
  SHARE_API_KEY
);
const SHARE_ALLOWED_ORIGIN = normalizeAllowedOrigin(process.env.WEBBLACKBOX_SHARE_ALLOWED_ORIGIN);
const TRUST_X_FORWARDED_FOR = parseBooleanFlag(process.env.WEBBLACKBOX_TRUST_X_FORWARDED_FOR);
const ALLOW_QUERY_API_KEY = parseBooleanFlag(process.env.WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY);
const ALLOW_PLAINTEXT_SHARE_UPLOADS = parseBooleanFlag(
  process.env.WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS
);
const SHARE_DEFAULT_TTL_MS = parseDurationMs(
  process.env.WEBBLACKBOX_SHARE_DEFAULT_TTL_MS,
  7 * 24 * 60 * 60 * 1000
);
const SHARE_MAX_TTL_MS = parseDurationMs(
  process.env.WEBBLACKBOX_SHARE_MAX_TTL_MS,
  30 * 24 * 60 * 60 * 1000
);
const SHARE_RETAIN_EXPIRED_MS = parseDurationMs(
  process.env.WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS,
  30 * 24 * 60 * 60 * 1000
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
const AES_GCM_IV_BYTES = 12;
const SHARE_READ_SESSION_COOKIE = "webblackbox_share_read";
const SHARE_READ_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SHARE_READ_SESSIONS = 4096;
const RATE_LIMIT_CLEANUP_INTERVAL = 64;
const MAX_TRACKED_RATE_BUCKETS = 4096;
const uploadRateWindows = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();
const shareReadSessions = new Map<string, ShareReadSession>();
let rateLimitCleanupCounter = 0;

void startShareServer().catch((error) => {
  console.error("[share-server] startup failed", error);
  process.exitCode = 1;
});

async function startShareServer(): Promise<void> {
  await ensureStorageLayout();
  await pruneExpiredShareRecords(Date.now());

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

  const requiredScope = resolveRequiredShareScope(method, pathname);

  if (requiredScope) {
    const authorization = authorizeRequest(request, requestUrl, method, pathname, requiredScope);
    if (!authorization.authorized) {
      if (pathname.startsWith("/share/")) {
        respondHtml(response, 401, "<h1>Unauthorized</h1><p>Provide a valid share API key.</p>");
        return;
      }
      respondJson(response, 401, {
        error: "Unauthorized."
      });
      return;
    }

    const readShareId = requiredScope === "read" ? extractReadShareId(pathname) : null;
    if (readShareId && authorization.source === "query") {
      issueShareReadSessionCookie(response, readShareId);
      redirectToUrlWithoutQueryKey(response, requestUrl);
      return;
    }

    if (
      readShareId &&
      method === "GET" &&
      /^\/share\/[a-zA-Z0-9_-]+$/.test(pathname) &&
      authorization.source !== "read-session"
    ) {
      issueShareReadSessionCookie(response, readShareId);
    }
  }

  if (method === "POST" && pathname === "/api/share/upload") {
    await handleUpload(request, response, requestUrl);
    return;
  }

  if (method === "GET" && pathname === "/api/share/list") {
    await handleList(request, response);
    return;
  }

  const metadataMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/meta$/.exec(pathname);

  if (method === "GET" && metadataMatch?.[1]) {
    await handleGetMetadata(request, response, metadataMatch[1]);
    return;
  }

  const archiveMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/archive$/.exec(pathname);

  if (method === "GET" && archiveMatch?.[1]) {
    await handleDownloadArchive(request, response, archiveMatch[1]);
    return;
  }

  const revokeMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/revoke$/.exec(pathname);

  if (method === "POST" && revokeMatch?.[1]) {
    await handleRevokeShare(request, response, revokeMatch[1]);
    return;
  }

  const sharePageMatch = /^\/share\/([a-zA-Z0-9_-]+)$/.exec(pathname);

  if (method === "GET" && sharePageMatch?.[1]) {
    await handleSharePage(request, response, sharePageMatch[1]);
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

  const archiveEnvelope = await inspectArchiveEnvelope(bytes);
  const archiveEnvelopeSummary = await buildShareSummary(bytes, archiveEnvelope);
  const summary = clientSummary
    ? applyArchiveEnvelopeToClientSummary(clientSummary, archiveEnvelopeSummary)
    : archiveEnvelopeSummary;

  if (archiveEnvelope.encrypted && !archiveEnvelope.encryptedPrivatePathsComplete) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 400, {
      error: "Encrypted WebBlackbox archive is missing encrypted file metadata.",
      missingEncryptedPaths: archiveEnvelope.missingEncryptedPaths.slice(0, 12)
    });
    return;
  }

  if (archiveEnvelope.encrypted && !archiveEnvelope.encryptedPrivatePathsConfidential) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 400, {
      error: "Encrypted WebBlackbox archive contains plaintext private files.",
      plaintextEncryptedPaths: archiveEnvelope.plaintextEncryptedPaths.slice(0, 12)
    });
    return;
  }

  if (summary.analyzed && summary.privacy?.scanner.status === "blocked") {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 422, {
      error: "Share upload blocked by privacy scanner.",
      scanner: summary.privacy.scanner
    });
    return;
  }

  if (archiveEnvelope.encrypted && !clientSummary) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 422, {
      error: "Encrypted public share uploads require a passed client privacy preflight summary."
    });
    return;
  }

  if (
    archiveEnvelope.encrypted &&
    clientSummary &&
    !hasPassedClientPrivacyPreflight(clientSummary)
  ) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 422, {
      error: "Encrypted public share uploads require a passed client privacy preflight summary.",
      scanner: clientSummary.privacy?.scanner
    });
    return;
  }

  if (!summary.encrypted && !ALLOW_PLAINTEXT_SHARE_UPLOADS) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, summary.analyzed ? 422 : 400, {
      error: summary.analyzed
        ? "Public share uploads require encrypted WebBlackbox archives."
        : "Upload is not a valid encrypted WebBlackbox archive."
    });
    return;
  }

  const createdAt = Date.now();
  const ttlMs = resolveShareTtlMs(request);
  const shareUrl = `${requestOrigin(request, requestUrl)}/share/${id}`;
  const record: ShareRecord = {
    id,
    createdAt,
    expiresAt: createdAt + ttlMs,
    fileName,
    sizeBytes: bytes.byteLength,
    checksumSha256,
    shareUrl,
    summary
  };

  await writeFile(archivePath, bytes);
  await writeRecord(record);
  await writeShareAuditEvent(request, {
    action: "upload",
    shareId: id,
    outcome: "ok",
    details: {
      sizeBytes: bytes.byteLength,
      ttlMs
    }
  });

  respondJson(response, 201, {
    shareId: id,
    shareUrl,
    expiresAt: record.expiresAt,
    fileName,
    sizeBytes: bytes.byteLength,
    summary
  });
}

async function handleList(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await pruneExpiredShareRecords(Date.now());
  const records = await loadAllRecords();
  const items = records
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((record) => buildPublicShareMetadata(record));

  await writeShareAuditEvent(request, {
    action: "list",
    outcome: "ok"
  });
  respondJson(response, 200, {
    items
  });
}

async function handleGetMetadata(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const record = await readAvailableShareRecord(request, response, id, "metadata");

  if (!record) {
    return;
  }

  respondJson(response, 200, buildPublicShareMetadata(record));
  await writeShareAuditEvent(request, {
    action: "metadata",
    shareId: id,
    outcome: "ok"
  });
}

async function handleDownloadArchive(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const record = await readAvailableShareRecord(request, response, id, "download");

  if (!record) {
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
    await writeShareAuditEvent(request, {
      action: "download",
      shareId: id,
      outcome: "ok"
    });
  } catch {
    respondJson(response, 404, {
      error: "Archive file not found."
    });
    await writeShareAuditEvent(request, {
      action: "download",
      shareId: id,
      outcome: "not-found"
    });
  }
}

async function handleSharePage(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const record = await readAvailableShareRecord(request, response, id, "page");

  if (!record) {
    return;
  }

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
        <a class="btn" href="/api/share/${encodeURIComponent(record.id)}/archive">Download Archive</a>
        <a class="btn secondary" href="/api/share/${encodeURIComponent(record.id)}/meta">View Metadata JSON</a>
      </div>
      <pre>${metadataPretty}</pre>
    </main>
  </body>
</html>`;

  respondHtml(response, 200, page);
  await writeShareAuditEvent(request, {
    action: "page",
    shareId: id,
    outcome: "ok"
  });
}

async function handleRevokeShare(
  request: IncomingMessage,
  response: ServerResponse,
  id: string
): Promise<void> {
  const record = await readAvailableShareRecord(request, response, id, "revoke", true);

  if (!record) {
    return;
  }

  const revokedAt = Date.now();
  const revokedRecord: ShareRecord = {
    ...record,
    revokedAt
  };

  await writeRecord(revokedRecord);
  await writeShareAuditEvent(request, {
    action: "revoke",
    shareId: id,
    outcome: "ok"
  });
  respondJson(response, 200, {
    shareId: id,
    revokedAt
  });
}

async function readAvailableShareRecord(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  action: ShareAuditAction,
  allowRevoked = false
): Promise<ShareRecord | null> {
  const record = await readRecord(id);

  if (!record) {
    respondShareUnavailable(response, action, "not-found");
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "not-found"
    });
    return null;
  }

  if (isShareExpired(record, Date.now())) {
    respondShareUnavailable(response, action, "expired");
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "expired"
    });
    return null;
  }

  if (!allowRevoked && record.revokedAt) {
    respondShareUnavailable(response, action, "revoked");
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "revoked"
    });
    return null;
  }

  return record;
}

function respondShareUnavailable(
  response: ServerResponse,
  action: ShareAuditAction,
  outcome: "not-found" | "expired" | "revoked"
): void {
  if (action === "page") {
    const title =
      outcome === "not-found"
        ? "Share Not Found"
        : outcome === "expired"
          ? "Share Expired"
          : "Share Revoked";
    const description =
      outcome === "not-found"
        ? "The requested WebBlackbox share does not exist."
        : outcome === "expired"
          ? "The requested WebBlackbox share has expired."
          : "The requested WebBlackbox share has been revoked.";

    respondHtml(
      response,
      outcome === "not-found" ? 404 : 410,
      `<h1>${title}</h1><p>${description}</p>`
    );
    return;
  }

  respondJson(response, outcome === "not-found" ? 404 : 410, {
    error:
      outcome === "not-found"
        ? "Share not found."
        : outcome === "expired"
          ? "Share has expired."
          : "Share has been revoked."
  });
}

async function buildShareSummary(
  bytes: Uint8Array,
  envelope: ArchiveEnvelopeSummary
): Promise<ShareSummary> {
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
      encrypted: envelope.encrypted || Boolean(manifest.encryption),
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
      encrypted: envelope.encrypted,
      analysisError: redactText(message, 240)
    };
  }
}

async function inspectArchiveEnvelope(bytes: Uint8Array): Promise<ArchiveEnvelopeSummary> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const manifest = asRecord(JSON.parse(await readZipText(zip, "manifest.json")));
    const encryption = asRecord(manifest.encryption);
    const encrypted = Object.keys(encryption).length > 0;
    const encryptedFiles = asRecord(encryption.files);
    const privatePaths = collectArchivePrivatePaths(zip);
    const missingEncryptedPaths = encrypted
      ? privatePaths.filter((path) => !isEncryptedFileMeta(encryptedFiles[path]))
      : [];
    const plaintextEncryptedPaths = encrypted
      ? await collectPlaintextEncryptedPrivatePaths(zip, privatePaths, encryptedFiles)
      : [];

    return {
      encrypted,
      encryptedPrivatePathsComplete: encrypted && missingEncryptedPaths.length === 0,
      missingEncryptedPaths,
      encryptedPrivatePathsConfidential: encrypted && plaintextEncryptedPaths.length === 0,
      plaintextEncryptedPaths
    };
  } catch (error) {
    return {
      encrypted: false,
      encryptedPrivatePathsComplete: false,
      missingEncryptedPaths: [],
      encryptedPrivatePathsConfidential: false,
      plaintextEncryptedPaths: [],
      analysisError: redactText(error instanceof Error ? error.message : String(error), 240)
    };
  }
}

function collectArchivePrivatePaths(zip: JSZip): string[] {
  return Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path)
    .filter(isArchivePrivatePath)
    .sort();
}

function isArchivePrivatePath(path: string): boolean {
  return (
    path.startsWith("events/") ||
    path.startsWith("blobs/") ||
    path === "index/time.json" ||
    path === "index/req.json" ||
    path === "index/inv.json" ||
    path === "privacy/manifest.json"
  );
}

function isEncryptedFileMeta(value: unknown): boolean {
  const record = asRecord(value);
  if (typeof record.ivBase64 !== "string") {
    return false;
  }

  const iv = decodeBase64Strict(record.ivBase64.trim());
  return iv !== null && iv.byteLength === AES_GCM_IV_BYTES;
}

async function collectPlaintextEncryptedPrivatePaths(
  zip: JSZip,
  privatePaths: string[],
  encryptedFiles: Record<string, unknown>
): Promise<string[]> {
  const plaintextPaths: string[] = [];

  for (const path of privatePaths) {
    if (!isEncryptedFileMeta(encryptedFiles[path])) {
      continue;
    }

    const file = zip.file(path);
    if (!file) {
      continue;
    }

    const bytes = await file.async("uint8array");
    if (looksLikePlaintextPrivateArchiveFile(path, bytes)) {
      plaintextPaths.push(path);
    }
  }

  return plaintextPaths;
}

function looksLikePlaintextPrivateArchiveFile(path: string, bytes: Uint8Array): boolean {
  if (path === "index/time.json" || path === "index/req.json" || path === "index/inv.json") {
    return isPlainJsonBytes(bytes);
  }

  if (path === "privacy/manifest.json") {
    return isPlainJsonBytes(bytes);
  }

  if (path.startsWith("events/") && path.endsWith(".ndjson")) {
    return isPlainNdjsonBytes(bytes);
  }

  if (path.startsWith("blobs/")) {
    return looksLikePlaintextBlobFile(path, bytes);
  }

  return false;
}

function looksLikePlaintextBlobFile(path: string, bytes: Uint8Array): boolean {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath.endsWith(".json")) {
    return isPlainJsonBytes(bytes);
  }

  if (normalizedPath.endsWith(".html")) {
    return isPlainHtmlBytes(bytes);
  }

  if (normalizedPath.endsWith(".png")) {
    return hasPngSignature(bytes);
  }

  if (normalizedPath.endsWith(".webp")) {
    return hasWebpSignature(bytes);
  }

  return isPlainJsonBytes(bytes) || isPlainHtmlBytes(bytes) || isPlainTextBytes(bytes);
}

function isPlainJsonBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isPlainNdjsonBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }

  try {
    for (const line of lines.slice(0, 32)) {
      JSON.parse(line);
    }
    return true;
  } catch {
    return false;
  }
}

function isPlainHtmlBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<script") ||
    trimmed.includes("<body")
  );
}

function isPlainTextBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  let printable = 0;

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);

    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      printable += 1;
    }
  }

  return printable / trimmed.length >= 0.9;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeBase64Strict(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedOutput = decoded.toString("base64").replace(/=+$/, "");

  return normalizedInput === normalizedOutput ? decoded : null;
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  return file.async("string");
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

function hasPassedClientPrivacyPreflight(summary: ShareSummary): boolean {
  const scanner = summary.privacy?.scanner;
  return summary.analyzed && scanner?.preEncryption === true && scanner.status === "passed";
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
  await mkdir(AUDIT_DIR, {
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
  expiresAt: number;
  revokedAt?: number;
  status: "active" | "expired" | "revoked";
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  shareUrl: string;
  summary: ShareSummary;
} {
  return {
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: resolveShareExpiresAt(record),
    revokedAt: record.revokedAt,
    status: resolveShareStatus(record, Date.now()),
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    shareUrl: record.shareUrl,
    summary: record.summary
  };
}

function resolveShareStatus(record: ShareRecord, now: number): "active" | "expired" | "revoked" {
  if (record.revokedAt) {
    return "revoked";
  }

  return isShareExpired(record, now) ? "expired" : "active";
}

function isShareExpired(record: ShareRecord, now: number): boolean {
  return resolveShareExpiresAt(record) <= now;
}

function resolveShareExpiresAt(record: ShareRecord): number {
  return Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : record.createdAt + SHARE_DEFAULT_TTL_MS;
}

function resolveShareTtlMs(request: IncomingMessage): number {
  const ttlHeader = request.headers["x-webblackbox-share-ttl-ms"];
  const requestedTtl =
    typeof ttlHeader === "string"
      ? parseDurationMs(ttlHeader, SHARE_DEFAULT_TTL_MS)
      : SHARE_DEFAULT_TTL_MS;
  return Math.min(SHARE_MAX_TTL_MS, Math.max(1_000, requestedTtl));
}

async function pruneExpiredShareRecords(now: number): Promise<void> {
  const records = await loadAllRecords();
  const retentionMs = Math.max(0, SHARE_RETAIN_EXPIRED_MS);

  await Promise.all(
    records.map(async (record) => {
      const retentionDeadline = resolveShareExpiresAt(record) + retentionMs;

      if (retentionDeadline > now) {
        return;
      }

      await Promise.all([
        rm(recordPathForId(record.id), { force: true }),
        rm(archivePathForId(record.id), { force: true })
      ]);
    })
  );
}

async function writeShareAuditEvent(
  request: IncomingMessage,
  input: {
    action: ShareAuditAction;
    outcome: ShareAuditOutcome;
    shareId?: string;
    details?: Record<string, number | string | boolean>;
  }
): Promise<void> {
  const event = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    action: input.action,
    outcome: input.outcome,
    shareId: input.shareId,
    clientHash: hashAuditValue(resolveClientKey(request)),
    details: input.details
  };

  await appendFile(SHARE_AUDIT_LOG_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(`webblackbox-share-audit:${value}`).digest("hex");
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
    `content-type,authorization,x-webblackbox-api-key,x-webblackbox-filename,${SHARE_SUMMARY_HEADER},x-webblackbox-share-ttl-ms`
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
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer"
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

function resolveRequiredShareScope(method: string, pathname: string): ShareApiScope | null {
  if (method === "POST" && pathname === "/api/share/upload") {
    return "upload";
  }

  if (method === "GET" && pathname === "/api/share/list") {
    return "list";
  }

  if (method === "GET" && /^\/api\/share\/[a-zA-Z0-9_-]+\/meta$/.test(pathname)) {
    return "read";
  }

  if (method === "GET" && /^\/api\/share\/[a-zA-Z0-9_-]+\/archive$/.test(pathname)) {
    return "read";
  }

  if (method === "GET" && /^\/share\/[a-zA-Z0-9_-]+$/.test(pathname)) {
    return "read";
  }

  if (method === "POST" && /^\/api\/share\/[a-zA-Z0-9_-]+\/revoke$/.test(pathname)) {
    return "revoke";
  }

  return null;
}

function authorizeRequest(
  request: IncomingMessage,
  requestUrl: URL,
  method: string,
  pathname: string,
  requiredScope: ShareApiScope
): ShareAuthorizationResult {
  if (SHARE_API_CREDENTIALS.length === 0) {
    return isLoopbackRequest(request)
      ? {
          authorized: true,
          source: "loopback"
        }
      : {
          authorized: false
        };
  }

  const headerToken = readAuthTokenFromRequest(request);
  if (headerToken && isAuthorizedToken(headerToken, requiredScope)) {
    return {
      authorized: true,
      source: "token"
    };
  }

  if (requiredScope === "read" && isAuthorizedShareReadSession(request, pathname)) {
    return {
      authorized: true,
      source: "read-session"
    };
  }

  if (ALLOW_QUERY_API_KEY && isQueryApiKeyAllowedRoute(method, pathname)) {
    const queryToken = requestUrl.searchParams.get("key");
    if (queryToken && isAuthorizedToken(queryToken, requiredScope)) {
      return {
        authorized: true,
        source: "query"
      };
    }
  }

  return {
    authorized: false
  };
}

function isAuthorizedToken(token: string, requiredScope: ShareApiScope): boolean {
  return SHARE_API_CREDENTIALS.some((credential) => {
    if (!equalsSecret(token, credential.secret)) {
      return false;
    }

    return credential.scopes.has("admin") || credential.scopes.has(requiredScope);
  });
}

function isQueryApiKeyAllowedRoute(method: string, pathname: string): boolean {
  return method === "GET" && /^\/share\/[a-zA-Z0-9_-]+$/.test(pathname);
}

function extractReadShareId(pathname: string): string | null {
  const pageMatch = /^\/share\/([a-zA-Z0-9_-]+)$/.exec(pathname);
  if (pageMatch?.[1]) {
    return pageMatch[1];
  }

  const apiMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/(?:meta|archive)$/.exec(pathname);
  return apiMatch?.[1] ?? null;
}

function isAuthorizedShareReadSession(request: IncomingMessage, pathname: string): boolean {
  const shareId = extractReadShareId(pathname);
  if (!shareId) {
    return false;
  }

  const token = readCookie(request, SHARE_READ_SESSION_COOKIE);
  if (!token) {
    return false;
  }

  const session = shareReadSessions.get(token);
  if (!session) {
    return false;
  }

  if (session.expiresAt <= Date.now()) {
    shareReadSessions.delete(token);
    return false;
  }

  return session.shareId === shareId;
}

function issueShareReadSessionCookie(response: ServerResponse, shareId: string): void {
  pruneShareReadSessions(Date.now());

  const token = randomUUID().replaceAll("-", "");
  const maxAgeSeconds = Math.max(1, Math.floor(SHARE_READ_SESSION_TTL_MS / 1000));
  shareReadSessions.set(token, {
    shareId,
    expiresAt: Date.now() + SHARE_READ_SESSION_TTL_MS
  });

  response.setHeader(
    "set-cookie",
    `${SHARE_READ_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );
}

function pruneShareReadSessions(now: number): void {
  for (const [token, session] of shareReadSessions) {
    if (session.expiresAt <= now || shareReadSessions.size > MAX_SHARE_READ_SESSIONS) {
      shareReadSessions.delete(token);
    }
  }
}

function redirectToUrlWithoutQueryKey(response: ServerResponse, requestUrl: URL): void {
  const cleanUrl = new URL(requestUrl.toString());
  cleanUrl.searchParams.delete("key");
  const location = `${cleanUrl.pathname}${cleanUrl.search}`;

  response.writeHead(303, {
    location,
    "cache-control": "no-store"
  });
  response.end();
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) {
    return null;
  }

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      const value = rawValue.join("=");
      try {
        return value ? decodeURIComponent(value) : null;
      } catch {
        return null;
      }
    }
  }

  return null;
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

function parseShareApiCredentials(
  rawValue: string | undefined,
  legacyAdminKey: string | null
): ShareApiCredential[] {
  const credentials: ShareApiCredential[] = [];

  if (legacyAdminKey) {
    credentials.push({
      secret: legacyAdminKey,
      scopes: new Set(["admin"])
    });
  }

  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return credentials;
  }

  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    const secret = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
    const rawScopes = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : "admin";

    if (!secret) {
      continue;
    }

    const scopes = new Set<ShareApiScope>();

    for (const scope of rawScopes.split(",")) {
      const normalized = normalizeShareApiScope(scope);

      if (normalized) {
        scopes.add(normalized);
      }
    }

    if (scopes.size === 0) {
      scopes.add("admin");
    }

    credentials.push({
      secret,
      scopes
    });
  }

  return credentials;
}

function normalizeShareApiScope(value: string): ShareApiScope | null {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "upload" ||
    normalized === "read" ||
    normalized === "list" ||
    normalized === "revoke" ||
    normalized === "admin"
  ) {
    return normalized;
  }

  return null;
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

function parseDurationMs(value: string | undefined, fallback: number): number {
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
