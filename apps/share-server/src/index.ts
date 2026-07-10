import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import JSZip from "jszip";
import {
  ArchiveDecodeTimeoutError,
  ArchiveResourceLimitError,
  BoundedZipReader,
  DEFAULT_ARCHIVE_RESOURCE_LIMITS,
  WebBlackboxPlayer,
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits
} from "@webblackbox/player-sdk";
import { exportManifestSchema, type ExportManifest } from "@webblackbox/protocol";

import { parseShareApiCredentials, type ShareApiScope } from "./auth-config.js";

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
  manifest?: {
    mode: ExportManifest["mode"];
    chunkCodec: ExportManifest["chunkCodec"];
    recordedAt: string;
  };
  totals?: {
    events: number;
    blobs: number;
    durationMs: number;
  };
  encryptedPrivatePathsComplete: boolean;
  missingEncryptedPaths: string[];
  encryptedPrivatePathsConfidential: boolean;
  plaintextEncryptedPaths: string[];
  analysisError?: string;
};

type ShareActionTriggerSummary = {
  triggerType: string;
  count: number;
  errorRate: number;
};

type SharePrivacySummary = {
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

type ShareSummary = {
  schemaVersion: 2;
  source: "client-unverified" | "server" | "unavailable";
  analyzed: boolean;
  encrypted: boolean;
  trust: {
    archiveEnvelope: "server-inspected";
    privateContent: "server-analyzed" | "client-claim-unverified" | "not-analyzed";
    archiveDigestMatched?: true;
  };
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
    errors?: number;
    requests?: number;
    actions?: number;
    durationMs: number;
  };
  topActionTriggers?: ShareActionTriggerSummary[];
  privacy?: SharePrivacySummary;
  clientClaim?: {
    totals?: {
      privacyViolations?: number;
      errors?: number;
      requests?: number;
      actions?: number;
    };
    topActionTriggers?: ShareActionTriggerSummary[];
    privacy?: SharePrivacySummary;
  };
};

type ClientShareClaim = Omit<ShareSummary, "source" | "analyzed" | "trust" | "analysisError"> & {
  source: "client";
  analyzed: true;
  archiveSha256: string;
};

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_UPLOAD_BYTES = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES, 250 * 1024 * 1024),
  DEFAULT_ARCHIVE_RESOURCE_LIMITS.maxInputBytes
);
const SHARE_ARCHIVE_RESOURCE_LIMITS = resolveArchiveResourceLimits({
  maxInputBytes: MAX_UPLOAD_BYTES
});
const MAX_CONCURRENT_UPLOAD_INSPECTIONS = parsePositiveInteger(
  process.env.WEBBLACKBOX_SHARE_MAX_CONCURRENT_INSPECTIONS,
  1
);
const UPLOAD_IDLE_TIMEOUT_MS = parsePositiveInteger(
  process.env.WEBBLACKBOX_SHARE_UPLOAD_IDLE_TIMEOUT_MS,
  15_000
);
const UPLOAD_TOTAL_TIMEOUT_MS = parsePositiveInteger(
  process.env.WEBBLACKBOX_SHARE_UPLOAD_TOTAL_TIMEOUT_MS,
  120_000
);
const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const DATA_ROOT = resolve(process.env.WEBBLACKBOX_SHARE_DATA_DIR ?? ".webblackbox-share-data");
const ARCHIVES_DIR = join(DATA_ROOT, "archives");
const RECORDS_DIR = join(DATA_ROOT, "records");
const AUDIT_DIR = join(DATA_ROOT, "audit");
const SHARE_AUDIT_LOG_PATH = join(AUDIT_DIR, "share-access.jsonl");
const SHARE_AUDIT_ROTATED_LOG_PATH = join(AUDIT_DIR, "share-access.1.jsonl");
const SHARE_API_KEY = readOptionalSecret(process.env.WEBBLACKBOX_SHARE_API_KEY);
const SHARE_API_CREDENTIALS = parseShareApiCredentials(
  process.env.WEBBLACKBOX_SHARE_API_KEYS,
  SHARE_API_KEY
);
const SHARE_ALLOWED_ORIGIN = normalizeAllowedOrigin(process.env.WEBBLACKBOX_SHARE_ALLOWED_ORIGIN);
const TRUST_X_FORWARDED_FOR = parseBooleanFlag(process.env.WEBBLACKBOX_TRUST_X_FORWARDED_FOR);
const TRUSTED_PROXY_ADDRESSES = parseTrustedProxyAddresses(
  process.env.WEBBLACKBOX_TRUSTED_PROXY_IPS
);
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
const LEGACY_CLIENT_ASSURANCE_HEADERS = [
  "x-webblackbox-encryption",
  "x-webblackbox-policy-eligible",
  "x-webblackbox-redaction-summary"
] as const;
const MAX_SHARE_SUMMARY_HEADER_BYTES = 16 * 1024;
const AES_GCM_IV_BYTES = 12;
const SHARE_READ_SESSION_COOKIE = "webblackbox_share_read";
const SHARE_READ_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SHARE_RECORD_BYTES = 256 * 1024;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SHARE_RECORDS = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_MAX_RECORDS, 10_000),
  10_000
);
const MAX_SHARE_RECORD_DIRECTORY_ENTRIES = 20_000;
const DEFAULT_SHARE_LIST_LIMIT = 100;
const MAX_SHARE_LIST_LIMIT = 200;
const MAX_SHARE_AUDIT_LOG_BYTES = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES, 16 * 1024 * 1024),
  64 * 1024 * 1024
);
const MAX_SHARE_READ_SESSIONS = 4096;
const RATE_LIMIT_CLEANUP_INTERVAL = 64;
const MAX_TRACKED_RATE_BUCKETS = 4096;
const uploadRateWindows = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();
const shareReadSessions = new Map<string, ShareReadSession>();
let rateLimitCleanupCounter = 0;
let activeUploadInspections = 0;
let sharePublicOrigin = DEFAULT_BASE_URL;
let auditWriteQueue = Promise.resolve();

void startShareServer().catch((error) => {
  console.error("[share-server] startup failed", error);
  process.exitCode = 1;
});

async function startShareServer(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const host = parseBindHost(process.env.WEBBLACKBOX_SHARE_BIND_HOST);
  sharePublicOrigin = resolvePublicOrigin(process.env.WEBBLACKBOX_SHARE_PUBLIC_ORIGIN, host, port);
  if (SHARE_API_CREDENTIALS.length === 0 && !isLoopbackHost(new URL(sharePublicOrigin).hostname)) {
    throw new Error(
      "A scoped WEBBLACKBOX_SHARE_API_KEY or WEBBLACKBOX_SHARE_API_KEYS credential is required for a non-loopback public origin."
    );
  }
  await ensureStorageLayout();
  await reconcileStorageLayout();
  await pruneExpiredShareRecords(Date.now());

  const server = createServer((request, response) => {
    void routeRequest(request, response).catch(async (error) => {
      console.warn("[share-server] request failed", error);

      const auditContext = resolveShareAuditRequest(request);
      if (auditContext) {
        await writeShareAuditEvent(request, {
          ...auditContext,
          outcome: "error",
          details: {
            reason: "request-failed"
          }
        });
      }

      if (response.headersSent || response.writableEnded) {
        if (!response.writableEnded) {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }

      respondJson(response, 500, {
        error: "Internal server error."
      });
    });
  });

  server.listen(port, host, () => {
    console.info(`[share-server] listening on http://${host}:${port}`);
    console.info(`[share-server] public origin: ${sharePublicOrigin}`);
    console.info(`[share-server] data root: ${DATA_ROOT}`);
  });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", sharePublicOrigin);
  applyCorsHeaders(response, request);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const method = request.method ?? "GET";
  const pathname = requestUrl.pathname;

  const requiredScope = resolveRequiredShareScope(method, pathname);
  const auditContext = resolveShareAuditContext(method, pathname);

  if (requiredScope) {
    const authorization = authorizeRequest(request, requestUrl, method, pathname, requiredScope);
    if (!authorization.authorized) {
      if (auditContext) {
        await writeShareAuditEvent(request, {
          ...auditContext,
          outcome: "blocked",
          details: {
            reason: "unauthorized"
          }
        });
      }

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
      await writeShareAuditEvent(request, {
        action: "page",
        shareId: readShareId,
        outcome: "ok",
        details: {
          authorization: "query-bootstrap"
        }
      });
      redirectToUrlWithoutQueryKey(response, requestUrl);
      return;
    }

    if (
      readShareId &&
      method === "GET" &&
      /^\/share\/[a-zA-Z0-9_-]{1,128}$/.test(pathname) &&
      authorization.source !== "read-session"
    ) {
      issueShareReadSessionCookie(response, readShareId);
    }
  }

  if (method === "POST" && pathname === "/api/share/upload") {
    await handleUpload(request, response);
    return;
  }

  if (method === "GET" && pathname === "/api/share/list") {
    await handleList(request, response, requestUrl);
    return;
  }

  const metadataMatch = /^\/api\/share\/([a-zA-Z0-9_-]{1,128})\/meta$/.exec(pathname);

  if (method === "GET" && metadataMatch?.[1]) {
    await handleGetMetadata(request, response, metadataMatch[1]);
    return;
  }

  const archiveMatch = /^\/api\/share\/([a-zA-Z0-9_-]{1,128})\/archive$/.exec(pathname);

  if (method === "GET" && archiveMatch?.[1]) {
    await handleDownloadArchive(request, response, archiveMatch[1]);
    return;
  }

  const revokeMatch = /^\/api\/share\/([a-zA-Z0-9_-]{1,128})\/revoke$/.exec(pathname);

  if (method === "POST" && revokeMatch?.[1]) {
    await handleRevokeShare(request, response, revokeMatch[1]);
    return;
  }

  const sharePageMatch = /^\/share\/([a-zA-Z0-9_-]{1,128})$/.exec(pathname);

  if (method === "GET" && sharePageMatch?.[1]) {
    await handleSharePage(request, response, sharePageMatch[1]);
    return;
  }

  respondJson(response, 404, {
    error: "Not found."
  });
}

async function handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rateLimited = consumeUploadRateLimitToken(resolveClientKey(request));

  if (!rateLimited.ok) {
    closeRequestAfterResponse(request, response);
    await writeShareAuditEvent(request, {
      action: "upload",
      outcome: "blocked",
      details: {
        reason: "rate-limit",
        retryAfterSec: rateLimited.retryAfterSec
      }
    });
    respondJson(response, 429, {
      error: `Upload rate limit exceeded. Retry in ${rateLimited.retryAfterSec}s.`
    });
    return;
  }

  if (!tryAcquireUploadInspectionSlot()) {
    closeRequestAfterResponse(request, response);
    response.setHeader("retry-after", "1");
    await writeShareAuditEvent(request, {
      action: "upload",
      outcome: "blocked",
      details: {
        reason: "inspection-capacity"
      }
    });
    respondJson(response, 503, {
      error: "Archive inspection capacity is temporarily exhausted."
    });
    return;
  }

  try {
    if (!(await hasShareRecordCapacity())) {
      closeRequestAfterResponse(request, response);
      await writeShareAuditEvent(request, {
        action: "upload",
        outcome: "blocked",
        details: {
          reason: "record-capacity",
          limit: MAX_SHARE_RECORDS
        }
      });
      respondJson(response, 507, {
        error: `Share record capacity is exhausted (${MAX_SHARE_RECORDS}). Revoke or expire retained shares before uploading.`
      });
      return;
    }

    await handleUploadWithinInspectionSlot(request, response);
  } finally {
    activeUploadInspections -= 1;
  }
}

async function handleUploadWithinInspectionSlot(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const id = randomUUID().replaceAll("-", "");
  const upload = {
    id,
    tempPath: join(ARCHIVES_DIR, `.${id}.upload`),
    archivePath: archivePathForId(id),
    committed: false
  };

  try {
    await processUploadWithinInspectionSlot(request, response, upload);
  } finally {
    if (!upload.committed) {
      await Promise.all([
        rm(upload.tempPath, { force: true }),
        rm(upload.archivePath, { force: true })
      ]);
    }
  }
}

async function processUploadWithinInspectionSlot(
  request: IncomingMessage,
  response: ServerResponse,
  upload: { id: string; tempPath: string; archivePath: string; committed: boolean }
): Promise<void> {
  const { id, tempPath, archivePath } = upload;
  let bytes: Uint8Array;
  let checksumSha256: string;
  try {
    const stored = await readRequestBodyToTempFile(request, tempPath, MAX_UPLOAD_BYTES);
    bytes = stored.bytes;
    checksumSha256 = stored.checksumSha256;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      closeRequestAfterResponse(request, response);
      await writeShareAuditEvent(request, {
        action: "upload",
        shareId: id,
        outcome: "blocked",
        details: {
          reason: "payload-too-large",
          limit: error.maxBytes
        }
      });
      respondJson(response, 413, {
        error: `Upload payload exceeds ${error.maxBytes} bytes.`
      });
      return;
    }
    if (error instanceof UploadTimeoutError || request.aborted) {
      await writeShareAuditEvent(request, {
        action: "upload",
        shareId: id,
        outcome: "error",
        details: {
          reason: error instanceof UploadTimeoutError ? `upload-${error.kind}-timeout` : "aborted"
        }
      });
      return;
    }

    throw error;
  }

  if (bytes.byteLength === 0) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked",
      details: {
        reason: "empty-payload"
      }
    });
    respondJson(response, 400, {
      error: "Upload payload is empty."
    });
    return;
  }

  const filenameHeader = request.headers["x-webblackbox-filename"];
  const fileName = publicArchiveFileName(
    id,
    typeof filenameHeader === "string" ? filenameHeader : undefined
  );
  let clientSummary: ClientShareClaim | null;

  try {
    clientSummary = readClientShareSummary(request, checksumSha256);
  } catch (error) {
    if (error instanceof ShareSummaryHeaderError) {
      await writeShareAuditEvent(request, {
        action: "upload",
        shareId: id,
        outcome: "blocked",
        details: {
          reason: "invalid-client-claim"
        }
      });
      respondJson(response, 400, {
        error: error.message
      });
      return;
    }

    throw error;
  }

  let archiveEnvelope: ArchiveEnvelopeSummary;
  let archiveEnvelopeSummary: ShareSummary;

  try {
    archiveEnvelope = await inspectArchiveEnvelope(bytes);
    if (archiveEnvelope.analysisError) {
      await writeShareAuditEvent(request, {
        action: "upload",
        shareId: id,
        outcome: "blocked"
      });
      respondJson(response, 400, {
        error: "Upload is not a valid WebBlackbox archive."
      });
      return;
    }
    archiveEnvelopeSummary = await buildShareSummary(bytes, archiveEnvelope);
  } catch (error) {
    if (
      !(error instanceof ArchiveResourceLimitError) &&
      !(error instanceof ArchiveDecodeTimeoutError)
    ) {
      throw error;
    }

    const resource =
      error instanceof ArchiveResourceLimitError ? error.resource : "decodeTimeoutMs";
    const limit = error instanceof ArchiveResourceLimitError ? error.limit : error.timeoutMs;

    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked",
      details: {
        resource,
        ...(error instanceof ArchiveResourceLimitError ? { actual: error.actual } : {}),
        limit
      }
    });
    respondJson(response, error instanceof ArchiveResourceLimitError ? 413 : 422, {
      error: error.message,
      resource,
      limit
    });
    return;
  }

  if (!archiveEnvelope.encrypted && !archiveEnvelopeSummary.analyzed) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 400, {
      error: "Upload is not a valid WebBlackbox archive."
    });
    return;
  }

  if (clientSummary) {
    try {
      assertClientShareClaimMatchesArchive(clientSummary, archiveEnvelope);
    } catch (error) {
      if (error instanceof ShareSummaryHeaderError) {
        await writeShareAuditEvent(request, {
          action: "upload",
          shareId: id,
          outcome: "blocked",
          details: {
            reason: "client-claim-conflict"
          }
        });
        respondJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
  }

  const sizeBytes = bytes.byteLength;
  bytes = new Uint8Array(0);
  const summary =
    archiveEnvelope.encrypted && clientSummary
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

  if (
    summary.source === "server" &&
    summary.analyzed &&
    summary.privacy?.scanner.status === "blocked"
  ) {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 422, {
      error: "Share upload blocked by the server privacy scanner.",
      scanner: summary.privacy.scanner
    });
    return;
  }

  if (clientSummary?.privacy?.scanner.status === "blocked") {
    await writeShareAuditEvent(request, {
      action: "upload",
      shareId: id,
      outcome: "blocked"
    });
    respondJson(response, 422, {
      error: "Share upload blocked by the client's privacy scanner claim.",
      scanner: clientSummary.privacy.scanner
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
  const shareUrl = `${sharePublicOrigin}/share/${id}`;
  const record: ShareRecord = {
    id,
    createdAt,
    expiresAt: createdAt + ttlMs,
    fileName,
    sizeBytes,
    checksumSha256,
    shareUrl,
    summary
  };

  await rename(tempPath, archivePath);
  await syncDirectoryBestEffort(ARCHIVES_DIR);
  await writeRecord(record);
  upload.committed = true;
  await writeShareAuditEvent(request, {
    action: "upload",
    shareId: id,
    outcome: "ok",
    details: {
      sizeBytes,
      ttlMs
    }
  });

  respondJson(response, 201, {
    shareId: id,
    shareUrl,
    expiresAt: record.expiresAt,
    fileName,
    sizeBytes,
    summary
  });
}

async function handleList(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const pagination = parseShareListPagination(requestUrl);
  if (!pagination) {
    await writeShareAuditEvent(request, {
      action: "list",
      outcome: "blocked",
      details: {
        reason: "invalid-pagination"
      }
    });
    respondJson(response, 400, {
      error: `List pagination requires integer offset >= 0 and limit between 1 and ${MAX_SHARE_LIST_LIMIT}.`
    });
    return;
  }

  await pruneExpiredShareRecords(Date.now());
  const records = (await loadAllRecords()).sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
  );
  const endOffset = Math.min(records.length, pagination.offset + pagination.limit);
  const items = records
    .slice(pagination.offset, endOffset)
    .map((record) => buildPublicShareMetadata(record));

  await writeShareAuditEvent(request, {
    action: "list",
    outcome: "ok"
  });
  respondJson(response, 200, {
    items,
    total: records.length,
    offset: pagination.offset,
    limit: pagination.limit,
    nextOffset: endOffset < records.length ? endOffset : null
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

  const archivePath = archivePathForId(id);

  try {
    const archiveStat = await stat(archivePath);
    if (!archiveStat.isFile()) {
      throw new ArchiveFileNotFoundError();
    }

    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(archiveStat.size),
      "content-disposition": `attachment; filename="${record.fileName}"`
    });

    await streamArchiveDownload(request, response, archivePath);
    await writeShareAuditEvent(request, {
      action: "download",
      shareId: id,
      outcome: "ok"
    });
  } catch (error) {
    const clientAborted = error instanceof ClientAbortedDownloadError;

    if (!clientAborted && !response.headersSent && !response.writableEnded) {
      respondJson(response, 404, {
        error: "Archive file not found."
      });
    } else if (!clientAborted && !response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined);
    }

    await writeShareAuditEvent(request, {
      action: "download",
      shareId: id,
      outcome: clientAborted ? "error" : "not-found"
    });
  }
}

async function streamArchiveDownload(
  request: IncomingMessage,
  response: ServerResponse,
  archivePath: string
): Promise<void> {
  const source = createReadStream(archivePath);
  const abortError = new ClientAbortedDownloadError();
  const abort = () => {
    if (!source.destroyed) {
      source.destroy(abortError);
    }
  };
  const close = () => {
    if (!response.writableFinished) {
      abort();
    }
  };

  request.once("aborted", abort);
  response.once("close", close);

  try {
    await pipeline(source, response);
  } catch (error) {
    if (request.aborted || abortError === error || !response.writableFinished) {
      throw abortError;
    }
    throw error;
  } finally {
    request.off("aborted", abort);
    response.off("close", close);
  }
}

class ClientAbortedDownloadError extends Error {
  public constructor() {
    super("Archive download was aborted by the client.");
  }
}

class ArchiveFileNotFoundError extends Error {}

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
    const player = await WebBlackboxPlayer.open(bytes, {
      resourceLimits: SHARE_ARCHIVE_RESOURCE_LIMITS
    });
    const manifest = player.archive.manifest;
    const derived = player.buildDerived();
    const actions = player.getActionTimeline();
    const privacyReport = player.getPrivacyProtectionReport();

    return {
      schemaVersion: 2,
      source: "server",
      analyzed: true,
      encrypted: envelope.encrypted || Boolean(manifest.encryption),
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "server-analyzed"
      },
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
    if (error instanceof ArchiveResourceLimitError || error instanceof ArchiveDecodeTimeoutError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 2,
      source: "unavailable",
      analyzed: false,
      encrypted: envelope.encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "not-analyzed"
      },
      manifest: envelope.manifest,
      totals:
        envelope.totals === undefined
          ? undefined
          : {
              events: envelope.totals.events,
              blobs: envelope.totals.blobs,
              durationMs: envelope.totals.durationMs
            },
      analysisError: envelope.encrypted
        ? "Encrypted private content was not analyzed because the share server has no passphrase."
        : redactText(message, 240)
    };
  }
}

async function inspectArchiveEnvelope(bytes: Uint8Array): Promise<ArchiveEnvelopeSummary> {
  try {
    assertArchiveInputResourceLimits(bytes, SHARE_ARCHIVE_RESOURCE_LIMITS);
    const zip = await JSZip.loadAsync(bytes);
    assertLoadedArchiveResourceLimits(zip, SHARE_ARCHIVE_RESOURCE_LIMITS);
    const zipReader = new BoundedZipReader(zip, SHARE_ARCHIVE_RESOURCE_LIMITS, false);
    const rawManifest = JSON.parse(await readZipText(zipReader, "manifest.json")) as unknown;
    const manifestRecord = asRecord(rawManifest);
    const encryption = asRecord(manifestRecord.encryption);
    const encrypted = Object.keys(encryption).length > 0;
    const encryptedFiles = asRecord(encryption.files);
    const privatePaths = collectArchivePrivatePaths(zip);
    const missingEncryptedPaths = encrypted
      ? privatePaths.filter((path) => !isEncryptedFileMeta(encryptedFiles[path]))
      : [];
    const plaintextEncryptedPaths = await inspectActualArchiveEntries(
      zip,
      zipReader,
      encrypted,
      new Set(privatePaths),
      encryptedFiles
    );
    const manifest = exportManifestSchema.parse(rawManifest);

    return {
      encrypted,
      manifest: {
        mode: manifest.mode,
        chunkCodec: manifest.chunkCodec,
        recordedAt: manifest.createdAt
      },
      totals: {
        events: manifest.stats.eventCount,
        blobs: manifest.stats.blobCount,
        durationMs: Math.round(manifest.stats.durationMs)
      },
      encryptedPrivatePathsComplete: encrypted && missingEncryptedPaths.length === 0,
      missingEncryptedPaths,
      encryptedPrivatePathsConfidential: encrypted && plaintextEncryptedPaths.length === 0,
      plaintextEncryptedPaths
    };
  } catch (error) {
    if (error instanceof ArchiveResourceLimitError || error instanceof ArchiveDecodeTimeoutError) {
      throw error;
    }

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

function tryAcquireUploadInspectionSlot(): boolean {
  if (activeUploadInspections >= MAX_CONCURRENT_UPLOAD_INSPECTIONS) {
    return false;
  }

  activeUploadInspections += 1;
  return true;
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

async function inspectActualArchiveEntries(
  zip: JSZip,
  zipReader: BoundedZipReader,
  encrypted: boolean,
  privatePaths: Set<string>,
  encryptedFiles: Record<string, unknown>
): Promise<string[]> {
  const plaintextPaths: string[] = [];

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || path === "manifest.json") {
      continue;
    }

    const bytes = await zipReader.read(path);
    if (
      encrypted &&
      privatePaths.has(path) &&
      isEncryptedFileMeta(encryptedFiles[path]) &&
      looksLikePlaintextPrivateArchiveFile(path, bytes)
    ) {
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
    return hasPngSignature(bytes, firstNonWhitespaceByte(bytes));
  }

  if (normalizedPath.endsWith(".webp")) {
    return hasWebpSignature(bytes, firstNonWhitespaceByte(bytes));
  }

  return isPlainTextBytes(bytes);
}

function isPlainJsonBytes(bytes: Uint8Array): boolean {
  const start = firstNonWhitespaceByte(bytes);
  return (
    start < bytes.byteLength &&
    (bytes[start] === 0x7b || bytes[start] === 0x5b) &&
    isMostlyPrintableUtf8Bytes(bytes)
  );
}

function isPlainNdjsonBytes(bytes: Uint8Array): boolean {
  const start = firstNonWhitespaceByte(bytes);
  return start < bytes.byteLength && bytes[start] === 0x7b && isMostlyPrintableUtf8Bytes(bytes);
}

function isPlainHtmlBytes(bytes: Uint8Array): boolean {
  const start = firstNonWhitespaceByte(bytes);
  return (
    isMostlyPrintableUtf8Bytes(bytes) &&
    (startsWithAsciiCaseInsensitive(bytes, start, "<!doctype html") ||
      startsWithAsciiCaseInsensitive(bytes, start, "<html") ||
      includesAsciiCaseInsensitive(bytes, "<script") ||
      includesAsciiCaseInsensitive(bytes, "<body"))
  );
}

function isPlainTextBytes(bytes: Uint8Array): boolean {
  return firstNonWhitespaceByte(bytes) < bytes.byteLength && isMostlyPrintableUtf8Bytes(bytes);
}

function isMostlyPrintableUtf8Bytes(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunkBytes = 64 * 1024;
  let characters = 0;
  let printable = 0;

  try {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const text = decoder.decode(bytes.subarray(offset, offset + chunkBytes), { stream: true });
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        characters += 1;
        if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
          printable += 1;
        }
      }
    }

    const trailing = decoder.decode();
    for (let index = 0; index < trailing.length; index += 1) {
      const code = trailing.charCodeAt(index);
      characters += 1;
      if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
        printable += 1;
      }
    }
  } catch {
    return false;
  }

  return characters > 0 && printable / characters >= 0.9;
}

function firstNonWhitespaceByte(bytes: Uint8Array): number {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const byte = bytes[offset];
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
      break;
    }
    offset += 1;
  }
  return offset;
}

function startsWithAsciiCaseInsensitive(
  bytes: Uint8Array,
  offset: number,
  expected: string
): boolean {
  if (offset + expected.length > bytes.byteLength) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (toLowerAscii(bytes[offset + index] ?? -1) !== expected.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function includesAsciiCaseInsensitive(bytes: Uint8Array, expected: string): boolean {
  for (let offset = 0; offset <= bytes.byteLength - expected.length; offset += 1) {
    if (startsWithAsciiCaseInsensitive(bytes, offset, expected)) {
      return true;
    }
  }
  return false;
}

function toLowerAscii(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function hasPngSignature(bytes: Uint8Array, offset = 0): boolean {
  return (
    bytes.length - offset >= 8 &&
    bytes[offset] === 0x89 &&
    bytes[offset + 1] === 0x50 &&
    bytes[offset + 2] === 0x4e &&
    bytes[offset + 3] === 0x47 &&
    bytes[offset + 4] === 0x0d &&
    bytes[offset + 5] === 0x0a &&
    bytes[offset + 6] === 0x1a &&
    bytes[offset + 7] === 0x0a
  );
}

function hasWebpSignature(bytes: Uint8Array, offset = 0): boolean {
  return (
    bytes.length - offset >= 12 &&
    bytes[offset] === 0x52 &&
    bytes[offset + 1] === 0x49 &&
    bytes[offset + 2] === 0x46 &&
    bytes[offset + 3] === 0x46 &&
    bytes[offset + 8] === 0x57 &&
    bytes[offset + 9] === 0x45 &&
    bytes[offset + 10] === 0x42 &&
    bytes[offset + 11] === 0x50
  );
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

async function readZipText(zipReader: BoundedZipReader, path: string): Promise<string> {
  return new TextDecoder().decode(await zipReader.read(path));
}

function readClientShareSummary(
  request: IncomingMessage,
  archiveSha256: string
): ClientShareClaim | null {
  if (LEGACY_CLIENT_ASSURANCE_HEADERS.some((name) => request.headers[name] !== undefined)) {
    throw new ShareSummaryHeaderError(
      "Legacy client assurance headers are not accepted. Use an archive-bound share summary."
    );
  }

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

  return normalizeClientShareSummary(parsed, archiveSha256);
}

function normalizeClientShareSummary(
  value: unknown,
  expectedArchiveSha256: string
): ClientShareClaim {
  const record = asRecord(value);
  if (record.schemaVersion !== 2 || record.source !== "client") {
    throw new ShareSummaryHeaderError(
      "Share summary must use schemaVersion 2 with source 'client'."
    );
  }
  if (record.analyzed !== true || typeof record.encrypted !== "boolean") {
    throw new ShareSummaryHeaderError(
      "Share summary must declare a completed client analysis and encryption state."
    );
  }

  const archiveSha256 = readArchiveSha256(record.archiveSha256);
  if (!sha256HexMatches(archiveSha256, expectedArchiveSha256)) {
    throw new ShareSummaryHeaderError("Share summary archive digest does not match the upload.");
  }

  const manifest = asRecord(record.manifest);
  const totals = asRecord(record.totals);
  const privacy = asRecord(record.privacy);

  return {
    schemaVersion: 2,
    source: "client",
    archiveSha256,
    analyzed: true,
    encrypted: record.encrypted,
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
  clientSummary: ClientShareClaim,
  archiveEnvelopeSummary: ShareSummary
): ShareSummary {
  if (!clientSummary.totals || !archiveEnvelopeSummary.totals) {
    throw new Error("Archive-bound client summary is missing inspected totals.");
  }

  return {
    schemaVersion: 2,
    source: "client-unverified",
    analyzed: false,
    encrypted: archiveEnvelopeSummary.encrypted,
    trust: {
      archiveEnvelope: "server-inspected",
      privateContent: "client-claim-unverified",
      archiveDigestMatched: true
    },
    manifest: archiveEnvelopeSummary.manifest,
    totals: archiveEnvelopeSummary.totals,
    clientClaim: {
      totals: {
        privacyViolations: clientSummary.totals.privacyViolations,
        errors: clientSummary.totals.errors,
        requests: clientSummary.totals.requests,
        actions: clientSummary.totals.actions
      },
      topActionTriggers: clientSummary.topActionTriggers,
      privacy: clientSummary.privacy
    },
    analysisError:
      "Encrypted private content was not analyzed by the share server; privacy fields are unverified client claims."
  };
}

function assertClientShareClaimMatchesArchive(
  summary: ClientShareClaim,
  envelope: ArchiveEnvelopeSummary
): void {
  if (!envelope.manifest || !envelope.totals) {
    throw new Error("Archive envelope facts are unavailable after successful inspection.");
  }

  const manifestMatches =
    summary.manifest?.mode === envelope.manifest.mode &&
    summary.manifest.chunkCodec === envelope.manifest.chunkCodec &&
    summary.manifest.recordedAt === envelope.manifest.recordedAt;
  const totalsMatch =
    summary.totals?.events === envelope.totals.events &&
    summary.totals.durationMs === envelope.totals.durationMs &&
    (summary.totals.blobs === undefined || summary.totals.blobs === envelope.totals.blobs);

  if (summary.encrypted !== envelope.encrypted || !manifestMatches || !totalsMatch) {
    throw new ShareSummaryHeaderError(
      "Share summary conflicts with server-inspected archive envelope facts."
    );
  }
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
  await mkdir(DATA_ROOT, {
    recursive: true,
    mode: 0o700
  });
  await mkdir(ARCHIVES_DIR, {
    recursive: true,
    mode: 0o700
  });
  await mkdir(RECORDS_DIR, {
    recursive: true,
    mode: 0o700
  });
  await mkdir(AUDIT_DIR, {
    recursive: true,
    mode: 0o700
  });
}

async function reconcileStorageLayout(): Promise<void> {
  const archiveIds = await collectStoredIds(ARCHIVES_DIR, ".webblackbox", ".upload");
  const recordIds = await collectStoredIds(RECORDS_DIR, ".json", ".record");

  for (const id of recordIds) {
    if (archiveIds.has(id) && (await readRecord(id))) {
      continue;
    }

    await Promise.all([
      rm(recordPathForId(id), { force: true }),
      rm(archivePathForId(id), { force: true })
    ]);
    archiveIds.delete(id);
  }

  for (const id of archiveIds) {
    if (!recordIds.has(id)) {
      await rm(archivePathForId(id), { force: true });
    }
  }
}

async function collectStoredIds(
  directoryPath: string,
  committedSuffix: string,
  temporarySuffix: string
): Promise<Set<string>> {
  const directory = await opendir(directoryPath);
  const ids = new Set<string>();
  let directoryEntries = 0;

  for await (const entry of directory) {
    directoryEntries += 1;
    assertShareRecordDirectoryEntryBudget(directoryEntries);
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.startsWith(".") && entry.name.endsWith(temporarySuffix)) {
      await rm(join(directoryPath, entry.name), { force: true });
      continue;
    }

    if (!entry.name.endsWith(committedSuffix)) {
      continue;
    }

    const id = entry.name.slice(0, -committedSuffix.length);
    if (SHARE_ID_PATTERN.test(id)) {
      ids.add(id);
    }
  }

  return ids;
}

async function readRecord(id: string): Promise<ShareRecord | null> {
  if (!SHARE_ID_PATTERN.test(id)) {
    return null;
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(recordPathForId(id), "r");
    const recordStat = await handle.stat();
    if (
      !recordStat.isFile() ||
      !Number.isSafeInteger(recordStat.size) ||
      recordStat.size <= 0 ||
      recordStat.size > MAX_SHARE_RECORD_BYTES
    ) {
      return null;
    }

    const raw = await readFileHandleExactly(handle, recordStat.size);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    return normalizePersistedShareRecord(parsed, id);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function loadAllRecords(): Promise<ShareRecord[]> {
  const directory = await opendir(RECORDS_DIR);
  const records: ShareRecord[] = [];
  let directoryEntries = 0;
  let recordFiles = 0;

  for await (const entry of directory) {
    directoryEntries += 1;
    assertShareRecordDirectoryEntryBudget(directoryEntries);
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    recordFiles += 1;
    if (recordFiles > MAX_SHARE_RECORDS) {
      throw new Error(`Share record capacity exceeded (${MAX_SHARE_RECORDS}).`);
    }

    const id = entry.name.slice(0, -".json".length);
    const record = SHARE_ID_PATTERN.test(id) ? await readRecord(id) : null;
    if (record) {
      records.push(record);
    }
  }

  return records;
}

async function hasShareRecordCapacity(): Promise<boolean> {
  const initialCount = await countShareRecordFiles();
  if (initialCount < MAX_SHARE_RECORDS) {
    return true;
  }
  if (initialCount > MAX_SHARE_RECORDS) {
    return false;
  }

  await pruneExpiredShareRecords(Date.now());
  return (await countShareRecordFiles()) < MAX_SHARE_RECORDS;
}

async function countShareRecordFiles(): Promise<number> {
  const directory = await opendir(RECORDS_DIR);
  let directoryEntries = 0;
  let recordFiles = 0;

  for await (const entry of directory) {
    directoryEntries += 1;
    assertShareRecordDirectoryEntryBudget(directoryEntries);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      recordFiles += 1;
      if (recordFiles > MAX_SHARE_RECORDS) {
        return recordFiles;
      }
    }
  }

  return recordFiles;
}

function assertShareRecordDirectoryEntryBudget(entries: number): void {
  if (entries > MAX_SHARE_RECORD_DIRECTORY_ENTRIES) {
    throw new Error(
      `Share record directory entry limit exceeded (${MAX_SHARE_RECORD_DIRECTORY_ENTRIES}).`
    );
  }
}

async function writeRecord(record: ShareRecord): Promise<void> {
  const payload = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  if (payload.byteLength > MAX_SHARE_RECORD_BYTES) {
    throw new Error(`Share record exceeds ${MAX_SHARE_RECORD_BYTES} bytes.`);
  }

  const temporaryPath = join(
    RECORDS_DIR,
    `.${record.id}.${randomUUID().replaceAll("-", "")}.record`
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let committed = false;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await writeFileHandleFully(handle, payload);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, recordPathForId(record.id));
    committed = true;
    await syncDirectoryBestEffort(RECORDS_DIR);
  } finally {
    await handle?.close();
    if (!committed) {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch {
    // Some supported filesystems do not allow directory handles to be fsynced.
  } finally {
    await handle?.close();
  }
}

function normalizePersistedShareRecord(value: unknown, expectedId: string): ShareRecord | null {
  const record = asRecord(value);
  if (record.id !== expectedId || !SHARE_ID_PATTERN.test(expectedId)) {
    return null;
  }

  const createdAt = readSafeNonNegativeInteger(record.createdAt);
  const persistedExpiresAt = readSafeNonNegativeInteger(record.expiresAt);
  const defaultExpiresAt =
    createdAt === null ? null : addSafeIntegers(createdAt, SHARE_DEFAULT_TTL_MS);
  const expiresAt = persistedExpiresAt ?? defaultExpiresAt;
  const revokedAt =
    record.revokedAt === undefined ? undefined : readSafeNonNegativeInteger(record.revokedAt);
  const sizeBytes = readSafeNonNegativeInteger(record.sizeBytes);
  const checksumSha256 =
    typeof record.checksumSha256 === "string" && /^[a-f0-9]{64}$/i.test(record.checksumSha256)
      ? record.checksumSha256.toLowerCase()
      : null;

  if (
    createdAt === null ||
    expiresAt === null ||
    expiresAt < createdAt ||
    revokedAt === null ||
    (revokedAt !== undefined && revokedAt < createdAt) ||
    sizeBytes === null ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_UPLOAD_BYTES ||
    checksumSha256 === null
  ) {
    return null;
  }

  return {
    id: expectedId,
    createdAt,
    expiresAt,
    revokedAt,
    fileName: publicArchiveFileName(
      expectedId,
      typeof record.fileName === "string" ? record.fileName : undefined
    ),
    sizeBytes,
    checksumSha256,
    shareUrl: `${sharePublicOrigin}/share/${expectedId}`,
    summary: normalizePersistedShareSummary(record.summary)
  };
}

function readSafeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function addSafeIntegers(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
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
    summary: normalizePersistedShareSummary(record.summary)
  };
}

function normalizePersistedShareSummary(value: unknown): ShareSummary {
  const record = asRecord(value);
  const source = record.source;
  const trust = asRecord(record.trust);
  const currentTrustIsConsistent =
    (source === "server" &&
      record.analyzed === true &&
      trust.privateContent === "server-analyzed") ||
    (source === "client-unverified" &&
      record.analyzed === false &&
      trust.privateContent === "client-claim-unverified") ||
    (source === "unavailable" &&
      record.analyzed === false &&
      trust.privateContent === "not-analyzed");

  if (
    record.schemaVersion === 2 &&
    trust.archiveEnvelope === "server-inspected" &&
    currentTrustIsConsistent
  ) {
    return value as ShareSummary;
  }

  const legacy = value as Partial<ShareSummary> & {
    source?: string;
    archiveSha256?: unknown;
  };
  const legacyWithoutDigest = { ...legacy };
  delete legacyWithoutDigest.archiveSha256;
  const encrypted = legacy.encrypted === true;

  if (source === "client" || source === "client-unverified") {
    const legacyTotals = legacy.totals;

    return {
      schemaVersion: 2,
      source: "client-unverified",
      analyzed: false,
      encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "client-claim-unverified"
      },
      manifest: legacy.manifest,
      totals: legacyTotals
        ? {
            events: legacyTotals.events,
            blobs: legacyTotals.blobs,
            durationMs: legacyTotals.durationMs
          }
        : undefined,
      clientClaim: {
        totals: legacyTotals
          ? {
              privacyViolations: legacyTotals.privacyViolations,
              errors: legacyTotals.errors,
              requests: legacyTotals.requests,
              actions: legacyTotals.actions
            }
          : undefined,
        topActionTriggers: legacy.topActionTriggers,
        privacy: legacy.privacy
      },
      analysisError:
        "Legacy client privacy fields were not archive-digest-bound and remain unverified claims."
    };
  }

  if (source === "server" && legacy.analyzed === true) {
    return {
      ...legacyWithoutDigest,
      schemaVersion: 2,
      source: "server",
      analyzed: true,
      encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "server-analyzed"
      }
    } as ShareSummary;
  }

  return {
    schemaVersion: 2,
    source: "unavailable",
    analyzed: false,
    encrypted,
    trust: {
      archiveEnvelope: "server-inspected",
      privateContent: "not-analyzed"
    },
    analysisError: "Stored share analysis is unavailable or uses an unsupported legacy schema."
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

function parseShareListPagination(requestUrl: URL): { offset: number; limit: number } | null {
  const offset = parseBoundedQueryInteger(
    requestUrl.searchParams.get("offset"),
    0,
    0,
    MAX_SHARE_RECORDS
  );
  const limit = parseBoundedQueryInteger(
    requestUrl.searchParams.get("limit"),
    DEFAULT_SHARE_LIST_LIMIT,
    1,
    MAX_SHARE_LIST_LIMIT
  );
  return offset === null || limit === null ? null : { offset, limit };
}

function parseBoundedQueryInteger(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number | null {
  if (raw === null) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

async function pruneExpiredShareRecords(now: number): Promise<void> {
  const records = await loadAllRecords();
  const retentionMs = Math.max(0, SHARE_RETAIN_EXPIRED_MS);

  for (const record of records) {
    const retentionDeadline = resolveShareExpiresAt(record) + retentionMs;

    if (retentionDeadline > now) {
      continue;
    }

    await Promise.all([
      rm(recordPathForId(record.id), { force: true }),
      rm(archivePathForId(record.id), { force: true })
    ]);
  }
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
  const line = `${JSON.stringify(event)}\n`;
  const writeOperation = auditWriteQueue.then(() => appendShareAuditLine(line));
  auditWriteQueue = writeOperation.catch(() => undefined);

  try {
    await writeOperation;
  } catch (error) {
    console.warn("[share-server] audit append failed", {
      action: input.action,
      shareId: input.shareId,
      error: redactText(error instanceof Error ? error.message : String(error), 240)
    });
  }
}

async function appendShareAuditLine(line: string): Promise<void> {
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_SHARE_AUDIT_LOG_BYTES) {
    throw new Error("Share audit event exceeds the configured log size ceiling.");
  }

  let currentBytes = 0;
  try {
    const current = await stat(SHARE_AUDIT_LOG_PATH);
    currentBytes = current.isFile() ? current.size : 0;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  if (currentBytes > 0 && currentBytes + lineBytes > MAX_SHARE_AUDIT_LOG_BYTES) {
    await rm(SHARE_AUDIT_ROTATED_LOG_PATH, { force: true });
    try {
      await rename(SHARE_AUDIT_LOG_PATH, SHARE_AUDIT_ROTATED_LOG_PATH);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
  }

  await appendFile(SHARE_AUDIT_LOG_PATH, line, {
    encoding: "utf8",
    mode: 0o600
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(`webblackbox-share-audit:${value}`).digest("hex");
}

function recordPathForId(id: string): string {
  assertSafeShareId(id);
  return join(RECORDS_DIR, `${id}.json`);
}

function archivePathForId(id: string): string {
  assertSafeShareId(id);
  return join(ARCHIVES_DIR, `${id}.webblackbox`);
}

function assertSafeShareId(id: string): void {
  if (!SHARE_ID_PATTERN.test(id)) {
    throw new Error("Invalid share id.");
  }
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

function resolvePublicOrigin(rawValue: string | undefined, bindHost: string, port: number): string {
  const configured = rawValue?.trim();

  if (!configured) {
    if (!isLoopbackHost(bindHost)) {
      throw new Error(
        "WEBBLACKBOX_SHARE_PUBLIC_ORIGIN is required when the share server binds to a non-loopback host."
      );
    }

    return new URL(`http://${formatHostForUrl(bindHost)}:${port}`).origin;
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("WEBBLACKBOX_SHARE_PUBLIC_ORIGIN must be a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WEBBLACKBOX_SHARE_PUBLIC_ORIGIN must use HTTP or HTTPS.");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "WEBBLACKBOX_SHARE_PUBLIC_ORIGIN must contain only a scheme, host, and optional port."
    );
  }

  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("WEBBLACKBOX_SHARE_PUBLIC_ORIGIN must use HTTPS for non-loopback hosts.");
  }

  return parsed.origin;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function formatHostForUrl(host: string): string {
  const normalized = host.trim().replace(/^\[|\]$/g, "");
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function normalizeAllowedOrigin(rawValue: string | undefined): string {
  const resolved = (rawValue ?? "same-origin").trim();

  if (resolved.length === 0) {
    return "same-origin";
  }

  return resolved.toLowerCase() === "same-origin" ? "same-origin" : resolved;
}

async function readRequestBodyToTempFile(
  request: IncomingMessage,
  tempPath: string,
  maxBytes: number
): Promise<{ bytes: Uint8Array; checksumSha256: string }> {
  const declaredBytes = readDeclaredContentLength(request);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const handle = await open(tempPath, "wx+", 0o600);
  const checksum = createHash("sha256");
  let totalBytes = 0;
  let storedBytes: Buffer | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: UploadTimeoutError | null = null;
  const expire = (kind: "idle" | "total") => {
    timeoutError ??= new UploadTimeoutError(kind);
    request.destroy(timeoutError);
  };
  const armIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => expire("idle"), UPLOAD_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => expire("total"), UPLOAD_TOTAL_TIMEOUT_MS);
  const clearUploadTimers = () => {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  armIdleTimer();

  try {
    for await (const chunk of request) {
      armIdleTimer();
      const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);

      const nextTotalBytes = totalBytes + bytes.byteLength;
      if (nextTotalBytes > maxBytes) {
        throw new PayloadTooLargeError(maxBytes);
      }

      await writeFileHandleFully(handle, bytes);
      checksum.update(bytes);
      totalBytes = nextTotalBytes;
    }

    clearUploadTimers();
    if (timeoutError || request.aborted) {
      throw timeoutError ?? new Error("Upload request was aborted.");
    }

    await handle.sync();
    const storedStat = await handle.stat();
    if (storedStat.size !== totalBytes) {
      throw new Error("Upload temporary file size changed unexpectedly.");
    }
    storedBytes = await readFileHandleExactly(handle, totalBytes);
  } catch (error) {
    throw timeoutError ?? error;
  } finally {
    clearUploadTimers();
    await handle.close();
  }

  if (!storedBytes) {
    throw new Error("Upload temporary file was not read.");
  }
  const checksumSha256 = checksum.digest("hex");
  const storedChecksumSha256 = createHash("sha256").update(storedBytes).digest("hex");
  if (storedChecksumSha256 !== checksumSha256) {
    throw new Error("Upload temporary file contents changed unexpectedly.");
  }

  return {
    bytes: storedBytes,
    checksumSha256
  };
}

async function readFileHandleExactly(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;

  while (offset < expectedBytes) {
    const { bytesRead } = await handle.read(output, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) {
      throw new Error("Upload temporary file ended before its recorded size.");
    }
    offset += bytesRead;
  }

  const probe = Buffer.allocUnsafe(1);
  const { bytesRead: trailingBytes } = await handle.read(probe, 0, 1, expectedBytes);
  if (trailingBytes > 0) {
    throw new PayloadTooLargeError(MAX_UPLOAD_BYTES);
  }

  return output;
}

async function writeFileHandleFully(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer
): Promise<void> {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) {
      throw new Error("Upload temporary file write made no progress.");
    }
    offset += bytesWritten;
  }
}

function readDeclaredContentLength(request: IncomingMessage): number | null {
  const raw = request.headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

class PayloadTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes.`);
  }
}

class UploadTimeoutError extends Error {
  public constructor(public readonly kind: "idle" | "total") {
    super(`Upload ${kind} timeout exceeded.`);
  }
}

function closeRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("connection", "close");
  response.once("finish", () => request.destroy());
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

function readArchiveSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ShareSummaryHeaderError(
      "Share summary archiveSha256 must be a 64-character SHA-256 hex digest."
    );
  }

  return value.toLowerCase();
}

function sha256HexMatches(left: string, right: string): boolean {
  return equalsSecret(left.toLowerCase(), right.toLowerCase());
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

function publicArchiveFileName(id: string, rawName: string | undefined): string {
  const trimmed = rawName?.trim().toLowerCase() ?? "";
  const extension = trimmed.endsWith(".zip") ? ".zip" : ".webblackbox";
  return `webblackbox-share-${id.slice(0, 12)}${extension}`;
}

function applyCorsHeaders(response: ServerResponse, request: IncomingMessage): void {
  const requestOrigin = request.headers.origin;
  const allowOrigin = resolveAllowedOrigin(requestOrigin, sharePublicOrigin);

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

function resolveShareAuditRequest(
  request: IncomingMessage
): { action: ShareAuditAction; shareId?: string } | null {
  try {
    const requestUrl = new URL(request.url ?? "/", sharePublicOrigin);
    return resolveShareAuditContext(request.method ?? "GET", requestUrl.pathname);
  } catch {
    return null;
  }
}

function resolveShareAuditContext(
  method: string,
  pathname: string
): { action: ShareAuditAction; shareId?: string } | null {
  if (method === "POST" && pathname === "/api/share/upload") {
    return { action: "upload" };
  }
  if (method === "GET" && pathname === "/api/share/list") {
    return { action: "list" };
  }

  const route =
    /^\/(?:api\/share\/([a-zA-Z0-9_-]{1,128})\/(meta|archive|revoke)|share\/([a-zA-Z0-9_-]{1,128}))$/.exec(
      pathname
    );
  if (!route) {
    return null;
  }

  const shareId = route[1] ?? route[3];
  const routeKind = route[2] ?? "page";
  if (!shareId) {
    return null;
  }
  if (method === "GET" && routeKind === "meta") {
    return { action: "metadata", shareId };
  }
  if (method === "GET" && routeKind === "archive") {
    return { action: "download", shareId };
  }
  if (method === "GET" && routeKind === "page") {
    return { action: "page", shareId };
  }
  if (method === "POST" && routeKind === "revoke") {
    return { action: "revoke", shareId };
  }
  return null;
}

function resolveRequiredShareScope(method: string, pathname: string): ShareApiScope | null {
  if (method === "POST" && pathname === "/api/share/upload") {
    return "upload";
  }

  if (method === "GET" && pathname === "/api/share/list") {
    return "list";
  }

  if (method === "GET" && /^\/api\/share\/[a-zA-Z0-9_-]{1,128}\/meta$/.test(pathname)) {
    return "read";
  }

  if (method === "GET" && /^\/api\/share\/[a-zA-Z0-9_-]{1,128}\/archive$/.test(pathname)) {
    return "read";
  }

  if (method === "GET" && /^\/share\/[a-zA-Z0-9_-]{1,128}$/.test(pathname)) {
    return "read";
  }

  if (method === "POST" && /^\/api\/share\/[a-zA-Z0-9_-]{1,128}\/revoke$/.test(pathname)) {
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
  return method === "GET" && /^\/share\/[a-zA-Z0-9_-]{1,128}$/.test(pathname);
}

function extractReadShareId(pathname: string): string | null {
  const pageMatch = /^\/share\/([a-zA-Z0-9_-]{1,128})$/.exec(pathname);
  if (pageMatch?.[1]) {
    return pageMatch[1];
  }

  const apiMatch = /^\/api\/share\/([a-zA-Z0-9_-]{1,128})\/(?:meta|archive)$/.exec(pathname);
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
    `${SHARE_READ_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${sharePublicOrigin.startsWith("https:") ? "; Secure" : ""}`
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

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = resolvePeerAddress(request);
  return Boolean(address && isLoopbackAddress(address));
}

function resolveClientAddress(request: IncomingMessage): string | null {
  const peerAddress = resolvePeerAddress(request);
  if (!TRUST_X_FORWARDED_FOR || !peerAddress || !isTrustedProxyAddress(peerAddress)) {
    return peerAddress;
  }

  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor !== "string" || forwardedFor.length === 0) {
    return peerAddress;
  }

  const forwardedChain = forwardedFor.split(",").map(normalizeIpAddress);
  if (forwardedChain.some((address) => address === null)) {
    return peerAddress;
  }

  const chain = [...(forwardedChain as string[]), peerAddress];
  let index = chain.length - 1;
  while (index > 0 && isTrustedProxyAddress(chain[index] ?? "")) {
    index -= 1;
  }
  return chain[index] ?? peerAddress;
}

function resolvePeerAddress(request: IncomingMessage): string | null {
  return normalizeIpAddress(request.socket.remoteAddress ?? "");
}

function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const ipv4Mapped = trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
  return isIP(ipv4Mapped) > 0 ? ipv4Mapped : null;
}

function isTrustedProxyAddress(address: string): boolean {
  return isLoopbackAddress(address) || TRUSTED_PROXY_ADDRESSES.has(address);
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
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

function parseTrustedProxyAddresses(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) {
    return new Set();
  }

  const addresses = new Set<string>();
  for (const rawAddress of value.split(",")) {
    const address = normalizeIpAddress(rawAddress);
    if (!address) {
      throw new Error(`WEBBLACKBOX_TRUSTED_PROXY_IPS contains an invalid IP address.`);
    }
    addresses.add(address);
  }
  return addresses;
}
