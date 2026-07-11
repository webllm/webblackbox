import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, SocketAddress } from "node:net";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import JSZip from "jszip";
import {
  buildPrivacyManifest,
  isPrivacyScannerTextMime,
  type PrivacyScanBlob
} from "@webblackbox/pipeline";
import {
  ArchiveEntryReadLimitError,
  ArchiveDecodeTimeoutError,
  ArchiveResourceLimitError,
  BoundedZipReader,
  DEFAULT_ARCHIVE_RESOURCE_LIMITS,
  WebBlackboxPlayer,
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits
} from "@webblackbox/player-sdk";
import {
  assertArchiveBlobPaths,
  assertArchiveFilePaths,
  exportManifestSchema,
  inferBlobMime,
  isCanonicalArchiveBlobPath,
  parseHashesManifest,
  type ExportManifest,
  type HashesManifest
} from "@webblackbox/protocol";

import { BoundedAuditWriter, type AuditWriteResult } from "./audit-writer.js";
import { parseShareApiCredentials, type ShareApiScope } from "./auth-config.js";
import { acquireShareDataRootLock, type ShareDataRootLock } from "./storage-lock.js";

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

type PendingShareUpload = {
  id: string;
  tempPath: string;
  archivePath: string;
  archiveDirectoryIdentity: BigIntStats;
  tempIdentity: BigIntStats | null;
  archiveIdentity: BigIntStats | null;
  committed: boolean;
};

type ShareRecordIndexEntry = Readonly<{
  id: string;
  createdAt: number;
  expiresAt: number;
  retentionDeadline: number;
}>;

type ShareListCursor = Pick<ShareRecordIndexEntry, "id" | "createdAt">;

type ShareListPagination =
  | {
      mode: "cursor";
      cursor: ShareListCursor;
      limit: number;
    }
  | {
      mode: "offset";
      offset: number;
      limit: number;
    };

type ShareAuditAction = "upload" | "list" | "metadata" | "download" | "page" | "revoke";
type ShareAuditOutcome = "ok" | "not-found" | "expired" | "revoked" | "blocked" | "error";
type ShareAuthorizationSource = "unauthenticated-loopback-dev" | "token" | "query" | "read-session";
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
  scanner: {
    preEncryption: boolean;
    status: "passed" | "blocked" | "unknown";
    findingCount: number;
    coverage?: {
      complete: boolean;
      scannedEventCount: number;
      scannedBlobCount: number;
      opaqueBlobCount: number;
      inspectedBytes: number;
      expectedEventCount: number;
      expectedBlobCount: number;
      incompleteReason?:
        | "deadline"
        | "decode-failed"
        | "finding-limit"
        | "target-byte-limit"
        | "total-byte-limit"
        | "opaque-content"
        | "coverage-mismatch";
    };
  };
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
    privateContent:
      | "server-analyzed"
      | "server-partially-analyzed"
      | "client-claim-unverified"
      | "not-analyzed";
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
const SHARE_PRIVACY_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SHARE_PRIVACY_SCAN_MAX_TARGET_BYTES = 2 * 1024 * 1024;
const SHARE_PRIVACY_SCAN_MAX_FINDINGS = 1;
const SHARE_PRIVACY_SCAN_DEADLINE_MS = 5_000;
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
const SHARE_AUDIT_HMAC_KEY_PATH = join(AUDIT_DIR, "client-hash.hmac.key");
const SHARE_AUDIT_HMAC_SECRET_ENV = "WEBBLACKBOX_SHARE_AUDIT_HMAC_SECRET";
const SHARE_AUDIT_HMAC_KEY_BYTES = 32;
const MAX_SHARE_AUDIT_HMAC_KEY_BYTES = 64;
const MIN_SHARE_AUDIT_HMAC_ESTIMATED_ENTROPY_BITS = 128;
const SHARE_AUDIT_CLIENT_HASH_ALGORITHM = "HMAC-SHA256-v1";
const SHARE_AUDIT_CLIENT_HASH_DOMAIN = "webblackbox-share-audit:v1\0";
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
const ALLOW_UNAUTHENTICATED_LOOPBACK = parseBooleanFlag(
  process.env.WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK
);
const ALLOW_QUERY_API_KEY = parseBooleanFlag(process.env.WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY);
const ALLOW_PLAINTEXT_SHARE_UPLOADS = parseBooleanFlag(
  process.env.WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS
);
const SHARE_DEFAULT_TTL_MS = parseConfiguredDurationMs(
  "WEBBLACKBOX_SHARE_DEFAULT_TTL_MS",
  process.env.WEBBLACKBOX_SHARE_DEFAULT_TTL_MS,
  7 * 24 * 60 * 60 * 1000,
  1_000
);
const SHARE_MAX_TTL_MS = parseConfiguredDurationMs(
  "WEBBLACKBOX_SHARE_MAX_TTL_MS",
  process.env.WEBBLACKBOX_SHARE_MAX_TTL_MS,
  30 * 24 * 60 * 60 * 1000,
  1_000
);
const SHARE_RETAIN_EXPIRED_MS = parseConfiguredDurationMs(
  "WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS",
  process.env.WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS,
  30 * 24 * 60 * 60 * 1000,
  0
);
validateShareDurationConfiguration(SHARE_DEFAULT_TTL_MS, SHARE_MAX_TTL_MS, SHARE_RETAIN_EXPIRED_MS);
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
const MAX_SHARE_RECORD_FILES = 10_000;
const SHARE_RECORD_ADMISSION_LIMIT = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_MAX_RECORDS, 10_000),
  MAX_SHARE_RECORD_FILES
);
const MAX_SHARE_RECORD_DIRECTORY_ENTRIES = 20_000;
const MAX_VERIFIED_ARCHIVE_CACHE_ENTRIES = 10_000;
const ARCHIVE_CHECKSUM_BUFFER_BYTES = 64 * 1024;
const DEFAULT_SHARE_LIST_LIMIT = 100;
const MAX_SHARE_LIST_LIMIT = 200;
const MAX_SHARE_LIST_CURSOR_BYTES = 256;
const MIN_SHARE_AUDIT_LOG_BYTES = 512;
const HARD_MAX_SHARE_AUDIT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_SHARE_AUDIT_LOG_BYTES = parseConfiguredInteger(
  "WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES",
  process.env.WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES,
  16 * 1024 * 1024,
  MIN_SHARE_AUDIT_LOG_BYTES,
  HARD_MAX_SHARE_AUDIT_LOG_BYTES
);
const MAX_SHARE_SHUTDOWN_TIMEOUT_MS = 60_000;
const SHARE_SHUTDOWN_TIMEOUT_MS = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_SHUTDOWN_TIMEOUT_MS, 10_000),
  MAX_SHARE_SHUTDOWN_TIMEOUT_MS
);
const MAX_SHARE_AUDIT_QUEUE_ENTRIES = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_MAX_AUDIT_QUEUE_ENTRIES, 128),
  1_024
);
const SHARE_AUDIT_QUEUE_TIMEOUT_MS = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_AUDIT_QUEUE_TIMEOUT_MS, 1_000),
  30_000
);
const SHARE_AUDIT_WRITE_TIMEOUT_MS = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_AUDIT_WRITE_TIMEOUT_MS, 2_000),
  30_000
);
const SHARE_AUDIT_RETRY_COOLDOWN_MS = Math.min(
  parsePositiveInteger(process.env.WEBBLACKBOX_SHARE_AUDIT_RETRY_COOLDOWN_MS, 5_000),
  300_000
);
const MAX_SHARE_READ_SESSIONS = 4096;
const RATE_LIMIT_CLEANUP_INTERVAL = 64;
const MAX_TRACKED_RATE_BUCKETS = 4096;
const AUDIT_DEGRADATION_WARNING_INTERVAL_MS = 5_000;
const uploadRateWindows = new Map<string, { count: number; resetAt: number; lastSeenAt: number }>();
const shareReadSessions = new Map<string, ShareReadSession>();
const verifiedArchiveCache = new Map<string, { checksumSha256: string; statFingerprint: string }>();
const storageDirectoryIdentities = new Map<string, BigIntStats>();
const shareRecordIndexById = new Map<string, ShareRecordIndexEntry>();
const shareRecordListOrder: ShareRecordIndexEntry[] = [];
const shareRecordExpiryOrder: ShareRecordIndexEntry[] = [];
let rateLimitCleanupCounter = 0;
let activeUploadInspections = 0;
let reservedShareRecordSlots = 0;
let sharePublicOrigin = DEFAULT_BASE_URL;
let shareRecordAdmissionQueue = Promise.resolve();
let lastAuditDegradationWarningAt = 0;
let suppressedAuditDegradationWarnings = 0;
let shareAuditHmacSecret: Buffer | null = null;
const auditWriter = new BoundedAuditWriter({
  append: appendShareAuditLine,
  maxQueuedEntries: MAX_SHARE_AUDIT_QUEUE_ENTRIES,
  queueWaitTimeoutMs: SHARE_AUDIT_QUEUE_TIMEOUT_MS,
  writeTimeoutMs: SHARE_AUDIT_WRITE_TIMEOUT_MS,
  retryCooldownMs: SHARE_AUDIT_RETRY_COOLDOWN_MS
});

void startShareServer().catch((error) => {
  console.error("[share-server] startup failed", error);
  process.exitCode = 1;
});

async function startShareServer(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const host = parseBindHost(process.env.WEBBLACKBOX_SHARE_BIND_HOST);
  const configuredAuditHmacSecret = parseAuditHmacEnvironmentSecret(
    process.env[SHARE_AUDIT_HMAC_SECRET_ENV]
  );
  sharePublicOrigin = resolvePublicOrigin(process.env.WEBBLACKBOX_SHARE_PUBLIC_ORIGIN, host, port);
  validateAuthorizationConfiguration(host, sharePublicOrigin);
  if (SHARE_API_CREDENTIALS.length === 0 && !isLoopbackHost(new URL(sharePublicOrigin).hostname)) {
    throw new Error(
      "A scoped WEBBLACKBOX_SHARE_API_KEY or WEBBLACKBOX_SHARE_API_KEYS credential is required for a non-loopback public origin."
    );
  }
  const dataRootIdentity = await initializeDataRoot();
  const dataRootLock = await acquireShareDataRootLock(DATA_ROOT, dataRootIdentity);
  let server: Server | null = null;

  try {
    await ensureStorageLayout(dataRootIdentity);
    await removeStaleAuditHmacSecretTemps();
    await migrateLegacyStoragePermissions();
    shareAuditHmacSecret =
      configuredAuditHmacSecret ?? (await loadOrCreatePersistedAuditHmacSecret());
    await migrateLegacyAuditLogs();
    await reconcileAuditLogLayout();
    const startupNow = Date.now();
    await reconcileStorageLayout(startupNow);
    await pruneExpiredShareRecords(Date.now());

    const activeRequests = new Set<Promise<void>>();
    let acceptingRequests = true;
    server = createServer((request, response) => {
      if (!acceptingRequests) {
        response.setHeader("connection", "close");
        respondJson(response, 503, {
          error: "Share server is shutting down."
        });
        return;
      }

      const requestTask = handleRequest(request, response);
      activeRequests.add(requestTask);
      void requestTask.then(
        () => activeRequests.delete(requestTask),
        () => activeRequests.delete(requestTask)
      );
    });
    await listenForShareRequests(server, port, host);
    const shutdownHandlers = installGracefulShutdownHandlers(
      server,
      activeRequests,
      () => {
        acceptingRequests = false;
      },
      dataRootLock
    );
    server.once("close", () => {
      shutdownHandlers.remove();
      if (!shutdownHandlers.hasStarted()) {
        void finalizeNormallyClosedShareServer(activeRequests, dataRootLock).catch((error) => {
          console.error("[share-server] normal close cleanup failed", error);
          process.exitCode = 1;
        });
      }
    });

    console.info(`[share-server] listening on http://${host}:${port}`);
    console.info(`[share-server] public origin: ${sharePublicOrigin}`);
    console.info(`[share-server] data root: ${DATA_ROOT}`);
    if (ALLOW_UNAUTHENTICATED_LOOPBACK) {
      console.warn(
        "[share-server] WARNING: unauthenticated loopback development access is enabled."
      );
    }
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await closeHttpServer(server);
    }
    await dataRootLock.release();
    throw error;
  }
}

function listenForShareRequests(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolvePromise();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    await routeRequest(request, response);
  } catch (error) {
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
  }
}

function installGracefulShutdownHandlers(
  server: Server,
  activeRequests: Set<Promise<void>>,
  stopAcceptingRequests: () => void,
  dataRootLock: ShareDataRootLock
): { remove: () => void; hasStarted: () => boolean } {
  let shutdownStarted = false;
  const handleSigterm = () => beginShutdown("SIGTERM");
  const handleSigint = () => beginShutdown("SIGINT");
  const removeHandlers = () => {
    process.off("SIGTERM", handleSigterm);
    process.off("SIGINT", handleSigint);
  };
  const beginShutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    stopAcceptingRequests();
    removeHandlers();
    void shutdownShareServer(server, activeRequests, signal, dataRootLock).then(
      (drained) => {
        if (drained) {
          process.exit(0);
        }

        process.kill(process.pid, "SIGKILL");
      },
      (error) => {
        console.error("[share-server] shutdown failed", error);
        process.exit(1);
      }
    );
  };

  process.once("SIGTERM", handleSigterm);
  process.once("SIGINT", handleSigint);
  return {
    remove: removeHandlers,
    hasStarted: () => shutdownStarted
  };
}

async function shutdownShareServer(
  server: Server,
  activeRequests: Set<Promise<void>>,
  signal: "SIGINT" | "SIGTERM",
  dataRootLock: ShareDataRootLock
): Promise<boolean> {
  console.info(`[share-server] received ${signal}; draining requests and audit events`);
  const closePromise = closeHttpServer(server);
  const drainPromise = (async () => {
    await waitForActiveRequests(activeRequests);
    await auditWriter.drain();
    await closePromise;
    await dataRootLock.release();
  })();
  const drained = await waitWithinTimeout(drainPromise, SHARE_SHUTDOWN_TIMEOUT_MS);

  if (!drained) {
    server.closeAllConnections();
    console.warn(
      `[share-server] shutdown drain timed out after ${SHARE_SHUTDOWN_TIMEOUT_MS}ms; forcing exit`
    );
    return false;
  }

  console.info("[share-server] shutdown drain complete");
  return true;
}

async function finalizeNormallyClosedShareServer(
  activeRequests: Set<Promise<void>>,
  dataRootLock: ShareDataRootLock
): Promise<void> {
  await waitForActiveRequests(activeRequests);
  await auditWriter.drain();
  await dataRootLock.release();
}

async function waitForActiveRequests(activeRequests: Set<Promise<void>>): Promise<void> {
  while (activeRequests.size > 0) {
    await Promise.allSettled([...activeRequests]);
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  const closed = new Promise<void>((resolvePromise) => {
    server.close((error) => {
      if (error) {
        console.warn("[share-server] HTTP close failed", error);
      }
      resolvePromise();
    });
  });
  server.closeIdleConnections();
  return closed;
}

async function waitWithinTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise(false), timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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
  let issueReadSessionForPage = false;

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
      const record = await readAvailableShareRecord(request, response, readShareId, "page");
      if (!record) {
        return;
      }
      issueShareReadSessionCookie(response, readShareId);
      const auditPromise = writeShareAuditEvent(request, {
        action: "page",
        shareId: readShareId,
        outcome: "ok",
        details: {
          authorization: "query-bootstrap"
        }
      });
      redirectToUrlWithoutQueryKey(response, requestUrl);
      await auditPromise;
      return;
    }

    if (
      readShareId &&
      method === "GET" &&
      /^\/share\/[a-zA-Z0-9_-]{1,128}$/.test(pathname) &&
      authorization.source !== "read-session"
    ) {
      issueReadSessionForPage = true;
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
    await handleSharePage(request, response, sharePageMatch[1], issueReadSessionForPage);
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

  let reservedRecordSlot = false;
  let inspectionSlotHeld = true;
  const releaseAdmissionLease = () => {
    if (reservedRecordSlot) {
      reservedRecordSlot = false;
      reservedShareRecordSlots -= 1;
    }
    if (inspectionSlotHeld) {
      inspectionSlotHeld = false;
      activeUploadInspections -= 1;
    }
  };
  try {
    reservedRecordSlot = await tryReserveShareRecordSlot();
    if (!reservedRecordSlot) {
      releaseAdmissionLease();
      closeRequestAfterResponse(request, response);
      await writeShareAuditEvent(request, {
        action: "upload",
        outcome: "blocked",
        details: {
          reason: "record-capacity",
          limit: SHARE_RECORD_ADMISSION_LIMIT
        }
      });
      respondJson(response, 507, {
        error: `Share record capacity is exhausted (${SHARE_RECORD_ADMISSION_LIMIT}). Wait for expired records to pass retention and be pruned, remove retained data administratively, or raise the admission limit.`
      });
      return;
    }

    await handleUploadWithinInspectionSlot(request, response, releaseAdmissionLease);
  } finally {
    releaseAdmissionLease();
  }
}

async function handleUploadWithinInspectionSlot(
  request: IncomingMessage,
  response: ServerResponse,
  releaseAdmissionLease: () => void
): Promise<void> {
  const id = randomUUID().replaceAll("-", "");
  const archiveDirectoryIdentity = getManagedStorageDirectoryIdentity(ARCHIVES_DIR);
  await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
  const upload: PendingShareUpload = {
    id,
    tempPath: join(ARCHIVES_DIR, `.${id}.upload`),
    archivePath: archivePathForId(id),
    archiveDirectoryIdentity,
    tempIdentity: null,
    archiveIdentity: null,
    committed: false
  };

  try {
    await processUploadWithinInspectionSlot(request, response, upload, releaseAdmissionLease);
  } finally {
    if (!upload.committed) {
      await removeUncommittedUploadFiles(upload);
    }
  }
}

async function commitUploadedArchive(upload: PendingShareUpload): Promise<void> {
  const temporaryIdentity = upload.tempIdentity;
  if (!temporaryIdentity) {
    throw new Error("Upload temporary file identity is unavailable.");
  }

  await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
  await assertPrivateArchiveFilePathIdentity(upload.tempPath, temporaryIdentity);
  await rename(upload.tempPath, upload.archivePath);
  upload.tempIdentity = null;
  upload.archiveIdentity = temporaryIdentity;

  await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
  await assertPrivateArchiveFilePathIdentity(upload.archivePath, temporaryIdentity);
  await syncDirectoryBestEffort(ARCHIVES_DIR);
  await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
  await assertPrivateArchiveFilePathIdentity(upload.archivePath, temporaryIdentity);
}

async function removeUncommittedUploadFiles(upload: PendingShareUpload): Promise<void> {
  if (upload.tempIdentity) {
    await removePrivateArchiveFileIfUnchanged(
      upload.tempPath,
      upload.tempIdentity,
      upload.archiveDirectoryIdentity
    );
    upload.tempIdentity = null;
  }

  if (upload.archiveIdentity) {
    await removePrivateArchiveFileIfUnchanged(
      upload.archivePath,
      upload.archiveIdentity,
      upload.archiveDirectoryIdentity
    );
    upload.archiveIdentity = null;
  }
}

async function removePrivateArchiveFileIfUnchanged(
  filePath: string,
  expectedFileIdentity: BigIntStats,
  archiveDirectoryIdentity: BigIntStats
): Promise<void> {
  await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
  try {
    await assertStoragePathIdentity(filePath, expectedFileIdentity, "file");
  } catch (error) {
    if (error instanceof UnsafeStoragePathError && isFileNotFoundError(error.cause)) {
      return;
    }
    throw error;
  }
  await rm(filePath, { force: true });
  await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
}

async function processUploadWithinInspectionSlot(
  request: IncomingMessage,
  response: ServerResponse,
  upload: PendingShareUpload,
  releaseAdmissionLease: () => void
): Promise<void> {
  const { id } = upload;
  let bytes: Uint8Array;
  let checksumSha256: string;
  try {
    const stored = await readRequestBodyToTempFile(request, upload, MAX_UPLOAD_BYTES);
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
    if (!archiveEnvelope.encrypted && !ALLOW_PLAINTEXT_SHARE_UPLOADS) {
      await writeShareAuditEvent(request, {
        action: "upload",
        shareId: id,
        outcome: "blocked",
        details: {
          reason: "plaintext-upload-disabled"
        }
      });
      respondJson(response, 422, {
        error: "Public share uploads require encrypted WebBlackbox archives."
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

  await commitUploadedArchive(upload);
  await writeRecord(record);
  upload.committed = true;
  releaseAdmissionLease();
  const auditPromise = writeShareAuditEvent(request, {
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
  await auditPromise;
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
      error: `List pagination requires either a valid cursor or an integer offset >= 0, plus a limit between 1 and ${MAX_SHARE_LIST_LIMIT}.`
    });
    return;
  }

  await pruneExpiredShareRecords(Date.now());
  const candidates = selectShareRecordIndexPage(pagination);
  const records: ShareRecord[] = [];

  for (const candidate of candidates) {
    const record = await readRecord(candidate.id);
    if (
      !record ||
      record.createdAt !== candidate.createdAt ||
      record.expiresAt !== candidate.expiresAt ||
      !(await hasValidStoredArchive(record))
    ) {
      await removeStoredShare(candidate.id);
      continue;
    }

    records.push(record);
  }

  const lastCandidate = candidates.at(-1);
  const hasMore = lastCandidate ? hasShareRecordIndexEntryAfter(lastCandidate) : false;
  const nextCursor = hasMore && lastCandidate ? encodeShareListCursor(lastCandidate) : null;
  const nextOffset =
    pagination.mode === "offset" && hasMore ? pagination.offset + candidates.length : null;

  const auditPromise = writeShareAuditEvent(request, {
    action: "list",
    outcome: "ok"
  });
  respondJson(response, 200, {
    items: records.map((record) => buildPublicShareMetadata(record)),
    total: shareRecordIndexById.size,
    offset: pagination.mode === "offset" ? pagination.offset : null,
    limit: pagination.limit,
    nextOffset,
    nextCursor
  });
  await auditPromise;
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

  const auditPromise = writeShareAuditEvent(request, {
    action: "metadata",
    shareId: id,
    outcome: "ok"
  });
  respondJson(response, 200, buildPublicShareMetadata(record));
  await auditPromise;
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

  let verifiedArchive: VerifiedArchiveFile | null = null;

  try {
    verifiedArchive = await openVerifiedArchive(record);

    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(record.sizeBytes),
      "content-disposition": `attachment; filename="${record.fileName}"`
    });

    await streamArchiveDownload(request, response, verifiedArchive.handle, record.sizeBytes);
    await writeShareAuditEvent(request, {
      action: "download",
      shareId: id,
      outcome: "ok"
    });
  } catch (error) {
    const clientAborted = error instanceof ClientAbortedDownloadError;

    if (error instanceof ArchiveIntegrityError) {
      await removeStoredShare(id);
    }

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
  } finally {
    await verifiedArchive?.handle.close().catch(() => undefined);
  }
}

async function streamArchiveDownload(
  request: IncomingMessage,
  response: ServerResponse,
  archiveHandle: FileHandle,
  sizeBytes: number
): Promise<void> {
  const source = archiveHandle.createReadStream({
    autoClose: false,
    start: 0,
    end: sizeBytes - 1
  });
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

class ArchiveIntegrityError extends Error {}
class UnsafeStoragePathError extends Error {}

async function handleSharePage(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  issueReadSession: boolean
): Promise<void> {
  const record = await readAvailableShareRecord(request, response, id, "page");

  if (!record) {
    return;
  }

  if (issueReadSession) {
    issueShareReadSessionCookie(response, id);
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

  const auditPromise = writeShareAuditEvent(request, {
    action: "page",
    shareId: id,
    outcome: "ok"
  });
  respondHtml(response, 200, page);
  await auditPromise;
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
  const auditPromise = writeShareAuditEvent(request, {
    action: "revoke",
    shareId: id,
    outcome: "ok"
  });
  respondJson(response, 200, {
    shareId: id,
    revokedAt
  });
  await auditPromise;
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
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "not-found"
    });
    respondShareUnavailable(response, action, "not-found");
    return null;
  }

  if (isShareExpired(record, Date.now())) {
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "expired"
    });
    respondShareUnavailable(response, action, "expired");
    return null;
  }

  if (!allowRevoked && record.revokedAt) {
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "revoked"
    });
    respondShareUnavailable(response, action, "revoked");
    return null;
  }

  if (!(await hasValidStoredArchive(record))) {
    await removeStoredShare(id);
    await writeShareAuditEvent(request, {
      action,
      shareId: id,
      outcome: "not-found",
      details: {
        reason: "archive-integrity"
      }
    });
    respondShareUnavailable(response, action, "not-found");
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
    const events = player.events;
    const blobPaths = collectArchiveBlobPathsForPrivacyScan(player);
    if (blobPaths.length !== manifest.stats.blobCount) {
      throw new Error("Archive blob count does not match server privacy-scan inputs.");
    }
    const serverPrivacyManifest = await buildPrivacyManifest({
      events,
      blobs: readArchiveBlobsForPrivacyScan(player, blobPaths),
      expectedBlobCount: blobPaths.length,
      encrypted: Boolean(manifest.encryption),
      preEncryption: false,
      scan: {
        maxTotalBytes: SHARE_PRIVACY_SCAN_MAX_TOTAL_BYTES,
        maxTargetBytes: SHARE_PRIVACY_SCAN_MAX_TARGET_BYTES,
        maxFindings: SHARE_PRIVACY_SCAN_MAX_FINDINGS,
        deadlineMs: SHARE_PRIVACY_SCAN_DEADLINE_MS,
        stopOnFinding: true
      }
    });
    const scanCoverage = serverPrivacyManifest.scanner.coverage;
    if (!scanCoverage) {
      throw new Error("Server privacy scan did not report content coverage.");
    }
    const accountedBlobCount = scanCoverage.scannedBlobCount + scanCoverage.opaqueBlobCount;
    const scanTraversalComplete =
      scanCoverage.complete &&
      scanCoverage.scannedEventCount === events.length &&
      serverPrivacyManifest.totals.blobs === blobPaths.length &&
      accountedBlobCount === blobPaths.length;
    const scanComplete = scanTraversalComplete && scanCoverage.opaqueBlobCount === 0;
    const incompleteReason = scanComplete
      ? undefined
      : (scanCoverage.incompleteReason ??
        (scanCoverage.opaqueBlobCount > 0 ? "opaque-content" : "coverage-mismatch"));
    const publicScanCoverage: NonNullable<SharePrivacySummary["scanner"]["coverage"]> = {
      complete: scanComplete,
      scannedEventCount: scanCoverage.scannedEventCount,
      scannedBlobCount: scanCoverage.scannedBlobCount,
      opaqueBlobCount: scanCoverage.opaqueBlobCount,
      inspectedBytes: scanCoverage.inspectedBytes,
      expectedEventCount: events.length,
      expectedBlobCount: blobPaths.length,
      ...(incompleteReason ? { incompleteReason } : {})
    };

    return {
      schemaVersion: 2,
      source: "server",
      analyzed: true,
      encrypted: envelope.encrypted || Boolean(manifest.encryption),
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: scanComplete ? "server-analyzed" : "server-partially-analyzed"
      },
      manifest: {
        mode: manifest.mode,
        chunkCodec: manifest.chunkCodec,
        recordedAt: manifest.createdAt
      },
      totals: {
        events: derived.totals.events,
        blobs: blobPaths.length,
        privacyViolations: serverPrivacyManifest.totals.privacyViolations,
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
        scanner: {
          preEncryption: serverPrivacyManifest.scanner.preEncryption,
          status:
            serverPrivacyManifest.scanner.status === "blocked"
              ? "blocked"
              : scanComplete
                ? "passed"
                : "unknown",
          findingCount: serverPrivacyManifest.scanner.findings.length,
          coverage: publicScanCoverage
        },
        categories: serverPrivacyManifest.categories.map((category) => ({ ...category }))
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

function collectArchiveBlobPathsForPrivacyScan(player: WebBlackboxPlayer): string[] {
  const paths = Object.keys(player.archive.integrity.files)
    .filter((path) => path.startsWith("blobs/"))
    .sort();
  const invalidPath = paths.find((path) => !isCanonicalArchiveBlobPath(path));
  if (invalidPath) {
    throw new Error(`Archive blob ${invalidPath} is not a canonical privacy-scan input.`);
  }
  return paths;
}

async function* readArchiveBlobsForPrivacyScan(
  player: WebBlackboxPlayer,
  paths: string[]
): AsyncIterable<PrivacyScanBlob> {
  for (const path of paths) {
    const extension = path.slice(path.lastIndexOf(".") + 1);
    const mime = inferBlobMime(extension);
    if (!isPrivacyScannerTextMime(mime)) {
      yield { hash: path, mime, bytes: new Uint8Array(0) };
      continue;
    }

    try {
      const blob = await player.readBlobTransient(path, SHARE_PRIVACY_SCAN_MAX_TARGET_BYTES);
      if (!blob) {
        throw new Error(`Archive blob ${path} could not be read for server privacy analysis.`);
      }
      yield { hash: path, mime: blob.mime, bytes: blob.bytes };
    } catch (error) {
      if (!(error instanceof ArchiveEntryReadLimitError)) {
        throw error;
      }
      yield {
        hash: path,
        mime,
        bytes: new Uint8Array(0),
        truncated: true,
        sourceByteLength: error.actual
      };
    }
  }
}

async function inspectArchiveEnvelope(bytes: Uint8Array): Promise<ArchiveEnvelopeSummary> {
  try {
    assertArchiveInputResourceLimits(bytes, SHARE_ARCHIVE_RESOURCE_LIMITS);
    const zip = await JSZip.loadAsync(bytes);
    assertLoadedArchiveResourceLimits(zip, SHARE_ARCHIVE_RESOURCE_LIMITS);
    const archivePaths = Object.entries(zip.files)
      .filter(([, file]) => !file.dir)
      .map(([path]) => path);
    assertArchiveFilePaths(archivePaths);
    const zipReader = new BoundedZipReader(zip, SHARE_ARCHIVE_RESOURCE_LIMITS, false);
    const rawManifest = JSON.parse(await readZipText(zipReader, "manifest.json")) as unknown;
    const manifest = exportManifestSchema.parse(rawManifest);
    assertRequiredArchivePaths(archivePaths);
    const actualBlobCount = assertArchiveBlobPaths(archivePaths);
    if (actualBlobCount !== manifest.stats.blobCount) {
      throw new Error("Manifest blob count does not match archive contents.");
    }
    const encrypted = Boolean(manifest.encryption);
    const encryptedFiles = manifest.encryption?.files ?? {};
    const privatePaths = collectArchivePrivatePaths(zip);
    assertEncryptedFileMetadata(privatePaths, encryptedFiles, encrypted);
    const missingEncryptedPaths = encrypted
      ? privatePaths.filter((path) => !isEncryptedFileMeta(encryptedFiles[path]))
      : [];
    let plaintextEncryptedPaths: string[] = [];
    if (encrypted) {
      const integrity = parseHashesManifest(
        JSON.parse(await readZipText(zipReader, "integrity/hashes.json")) as unknown
      );
      assertArchiveIntegrityFileSet(archivePaths, integrity);
      plaintextEncryptedPaths = await inspectActualArchiveEntries(
        zip,
        zipReader,
        new Set(privatePaths),
        encryptedFiles,
        integrity
      );
    }

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

const REQUIRED_SHARE_ARCHIVE_PATHS = [
  "manifest.json",
  "index/time.json",
  "index/req.json",
  "index/inv.json",
  "integrity/hashes.json"
] as const;

function assertRequiredArchivePaths(paths: readonly string[]): void {
  const pathSet = new Set(paths);
  if (pathSet.size !== paths.length) {
    throw new Error("Archive contains duplicate file paths.");
  }
  for (const path of REQUIRED_SHARE_ARCHIVE_PATHS) {
    if (!pathSet.has(path)) {
      throw new Error(`Archive is missing required file '${path}'.`);
    }
  }
}

function assertEncryptedFileMetadata(
  privatePaths: readonly string[],
  encryptedFiles: Record<string, { ivBase64: string }>,
  encrypted: boolean
): void {
  if (!encrypted) {
    return;
  }

  const privatePathSet = new Set(privatePaths);
  const initializationVectors = new Set<string>();
  for (const [path, metadata] of Object.entries(encryptedFiles)) {
    if (!privatePathSet.has(path)) {
      throw new Error(`Encrypted archive declares metadata for non-private file '${path}'.`);
    }
    if (initializationVectors.has(metadata.ivBase64)) {
      throw new Error("Encrypted archive reuses an AES-GCM initialization vector.");
    }
    initializationVectors.add(metadata.ivBase64);
  }
}

function assertArchiveIntegrityFileSet(
  archivePaths: readonly string[],
  integrity: HashesManifest
): void {
  const actualPaths = archivePaths.filter((path) => path !== "integrity/hashes.json").sort();
  const expectedPaths = Object.keys(integrity.files).sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error("Archive integrity manifest does not match archive contents.");
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
  privatePaths: Set<string>,
  encryptedFiles: Record<string, { ivBase64: string }>,
  integrity: HashesManifest
): Promise<string[]> {
  const plaintextPaths: string[] = [];

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || path === "integrity/hashes.json") {
      continue;
    }

    const bytes = await zipReader.read(path);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    const expectedHash = integrity.files[path];
    if (!expectedHash || actualHash !== expectedHash) {
      throw new Error(`Archive integrity mismatch for '${path}'.`);
    }
    if (path === "manifest.json") {
      if (actualHash !== integrity.manifestSha256) {
        throw new Error("Archive integrity mismatch for 'manifest.json'.");
      }
      continue;
    }
    if (
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
  return new TextDecoder("utf-8", { fatal: true }).decode(await zipReader.read(path));
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

async function initializeDataRoot(): Promise<BigIntStats> {
  storageDirectoryIdentities.clear();
  await mkdir(DATA_ROOT, {
    recursive: true,
    mode: 0o700
  });
  const dataRootIdentity = await hardenStorageDirectory(DATA_ROOT);
  storageDirectoryIdentities.set(DATA_ROOT, dataRootIdentity);
  return dataRootIdentity;
}

async function ensureStorageLayout(dataRootIdentity: BigIntStats): Promise<void> {
  await assertStoragePathIdentity(DATA_ROOT, dataRootIdentity, "directory");
  for (const directoryPath of [ARCHIVES_DIR, RECORDS_DIR, AUDIT_DIR]) {
    await assertStoragePathIdentity(DATA_ROOT, dataRootIdentity, "directory");
    try {
      await mkdir(directoryPath, { mode: 0o700 });
    } catch (error) {
      if (!hasFileSystemErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await assertStoragePathIdentity(DATA_ROOT, dataRootIdentity, "directory");
    const directoryIdentity = await hardenStorageDirectory(directoryPath);
    storageDirectoryIdentities.set(directoryPath, directoryIdentity);
  }

  await assertManagedStorageLayout();
}

async function migrateLegacyStoragePermissions(): Promise<void> {
  await assertManagedStorageLayout();
  await hardenCommittedStorageFiles(ARCHIVES_DIR, (name) => name.endsWith(".webblackbox"));
  await hardenCommittedStorageFiles(RECORDS_DIR, (name) => name.endsWith(".json"));
  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
  for (const auditPath of [
    SHARE_AUDIT_LOG_PATH,
    SHARE_AUDIT_ROTATED_LOG_PATH,
    SHARE_AUDIT_HMAC_KEY_PATH
  ]) {
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    await hardenStorageFileIfPresent(auditPath);
  }
  await assertManagedStorageLayout();
}

async function loadOrCreatePersistedAuditHmacSecret(): Promise<Buffer> {
  const existingSecret = await readPersistedAuditHmacSecret();
  if (existingSecret) {
    return existingSecret;
  }

  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
  const secret = generateAuditHmacSecret();
  const temporaryPath = join(
    AUDIT_DIR,
    `.client-hash.${randomUUID().replaceAll("-", "")}.hmac-key.tmp`
  );
  let handle: FileHandle | null = null;

  try {
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await writeFileHandleFully(handle, secret);
    await handle.sync();
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    const temporaryStat = await handle.stat({ bigint: true });
    if (
      !temporaryStat.isFile() ||
      temporaryStat.nlink !== 1n ||
      temporaryStat.size !== BigInt(SHARE_AUDIT_HMAC_KEY_BYTES) ||
      (process.platform !== "win32" && (temporaryStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(temporaryPath, "could not create a private HMAC key file");
    }
    await handle.close();
    handle = null;
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    await assertStoragePathIdentity(temporaryPath, temporaryStat, "file");

    let published = false;
    try {
      await link(temporaryPath, SHARE_AUDIT_HMAC_KEY_PATH);
      published = true;
    } catch (error) {
      if (!hasFileSystemErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await rm(temporaryPath, { force: true });
    await syncDirectoryBestEffort(AUDIT_DIR);

    if (!published) {
      secret.fill(0);
      const concurrentlyCreatedSecret = await readPersistedAuditHmacSecret();
      if (!concurrentlyCreatedSecret) {
        throw new Error("The Share audit HMAC key was not published atomically.");
      }
      return concurrentlyCreatedSecret;
    }

    const persistedSecret = await readPersistedAuditHmacSecret();
    const persistedSecretMatches =
      persistedSecret !== null && timingSafeEqual(secret, persistedSecret);
    persistedSecret?.fill(0);
    if (!persistedSecretMatches) {
      throw new Error("The persisted Share audit HMAC key failed verification.");
    }
    return secret;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readPersistedAuditHmacSecret(): Promise<Buffer | null> {
  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
  await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
  let pathStat: BigIntStats;
  try {
    pathStat = await lstat(SHARE_AUDIT_HMAC_KEY_PATH, { bigint: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(SHARE_AUDIT_HMAC_KEY_PATH, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat({ bigint: true });
    if (
      !pathStat.isFile() ||
      !openedStat.isFile() ||
      openedStat.nlink !== 1n ||
      openedStat.size !== BigInt(SHARE_AUDIT_HMAC_KEY_BYTES) ||
      !isSameFileSystemObject(pathStat, openedStat) ||
      (process.platform !== "win32" && (openedStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(
        SHARE_AUDIT_HMAC_KEY_PATH,
        `expected a ${SHARE_AUDIT_HMAC_KEY_BYTES}-byte mode-0600 regular file`
      );
    }

    const secret = await readFileHandleExactly(handle, SHARE_AUDIT_HMAC_KEY_BYTES);
    if (estimateByteEntropyBits(secret) < MIN_SHARE_AUDIT_HMAC_ESTIMATED_ENTROPY_BITS) {
      secret.fill(0);
      throw unsafeStoragePathError(
        SHARE_AUDIT_HMAC_KEY_PATH,
        "stored HMAC key does not meet the entropy floor"
      );
    }
    await assertStoragePathIdentity(SHARE_AUDIT_HMAC_KEY_PATH, openedStat, "file");
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    return secret;
  } catch (error) {
    if (error instanceof UnsafeStoragePathError) {
      throw error;
    }
    throw unsafeStoragePathError(
      SHARE_AUDIT_HMAC_KEY_PATH,
      "refusing to follow or read this path",
      error
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeStaleAuditHmacSecretTemps(): Promise<void> {
  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
  await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
  const directory = await opendir(AUDIT_DIR);
  let directoryEntries = 0;

  for await (const entry of directory) {
    directoryEntries += 1;
    if (directoryEntries > MAX_SHARE_RECORD_DIRECTORY_ENTRIES) {
      throw new Error(
        `Share audit directory entry limit exceeded (${MAX_SHARE_RECORD_DIRECTORY_ENTRIES}).`
      );
    }
    if (/^\.client-hash\.[a-f0-9]{32}\.hmac-key\.tmp$/i.test(entry.name)) {
      await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
      await rm(join(AUDIT_DIR, entry.name), { force: true });
    }
  }

  await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
}

type AuditLogHmacMigrationState =
  | { kind: "current-or-missing" }
  | { kind: "defer-to-reconciliation" }
  | { kind: "legacy"; stat: BigIntStats; path: string };

async function migrateLegacyAuditLogs(): Promise<void> {
  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
  const states: AuditLogHmacMigrationState[] = [];
  for (const auditPath of [SHARE_AUDIT_LOG_PATH, SHARE_AUDIT_ROTATED_LOG_PATH]) {
    states.push(await classifyAuditLogHmacMigration(auditPath, auditDirectoryIdentity));
  }

  if (states.some((state) => state.kind === "defer-to-reconciliation")) {
    return;
  }

  let removedLegacyLog = false;
  for (const state of states) {
    if (state.kind !== "legacy") {
      continue;
    }
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    await assertStoragePathIdentity(state.path, state.stat, "file");
    await rm(state.path, { force: true });
    removedLegacyLog = true;
  }
  if (removedLegacyLog) {
    await syncDirectoryBestEffort(AUDIT_DIR);
  }
}

async function classifyAuditLogHmacMigration(
  auditPath: string,
  auditDirectoryIdentity: BigIntStats
): Promise<AuditLogHmacMigrationState> {
  await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
  let handle: FileHandle;
  try {
    handle = await open(auditPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { kind: "current-or-missing" };
    }
    throw unsafeStoragePathError(auditPath, "refusing to follow or replace this path", error);
  }

  try {
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1n ||
      (process.platform !== "win32" && (openedStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(auditPath, "expected a private regular audit log");
    }
    if (openedStat.size === 0n) {
      return { kind: "current-or-missing" };
    }
    if (openedStat.size > BigInt(MAX_SHARE_AUDIT_LOG_BYTES)) {
      return { kind: "defer-to-reconciliation" };
    }

    const finalByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(finalByte, 0, 1, Number(openedStat.size - 1n));
    if (bytesRead !== 1 || finalByte[0] !== 0x0a) {
      return { kind: "defer-to-reconciliation" };
    }

    let contents: Buffer;
    try {
      contents = await readFileHandleExactly(handle, Number(openedStat.size));
    } catch (error) {
      throw unsafeStoragePathError(auditPath, "changed during HMAC migration", error);
    }
    const verifiedStat = await handle.stat({ bigint: true });
    if (
      verifiedStat.size !== openedStat.size ||
      !isSameFileSystemObject(verifiedStat, openedStat)
    ) {
      throw unsafeStoragePathError(auditPath, "changed during HMAC migration");
    }
    await assertStoragePathIdentity(auditPath, verifiedStat, "file");
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");

    if (auditLogContainsOnlyHmacEvents(contents)) {
      return { kind: "current-or-missing" };
    }
    return { kind: "legacy", path: auditPath, stat: verifiedStat };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function auditLogContainsOnlyHmacEvents(contents: Buffer): boolean {
  try {
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(contents).split("\n");
    if (lines.pop() !== "" || lines.length === 0) {
      return false;
    }
    return lines.every((line) => {
      const event = asRecord(JSON.parse(line) as unknown);
      return (
        event.schemaVersion === 2 &&
        event.clientHashAlgorithm === SHARE_AUDIT_CLIENT_HASH_ALGORITHM &&
        typeof event.clientHash === "string" &&
        /^[a-f0-9]{64}$/.test(event.clientHash)
      );
    });
  } catch {
    return false;
  }
}

async function reconcileAuditLogLayout(): Promise<void> {
  const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);

  for (const auditPath of [SHARE_AUDIT_LOG_PATH, SHARE_AUDIT_ROTATED_LOG_PATH]) {
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    await validateAuditLogForStartup(auditPath, auditDirectoryIdentity);
  }

  await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
}

async function validateAuditLogForStartup(
  auditPath: string,
  auditDirectoryIdentity: BigIntStats
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(auditPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    throw unsafeStoragePathError(auditPath, "refusing to follow or replace this path", error);
  }

  try {
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1n ||
      (process.platform !== "win32" && (openedStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(auditPath, "expected a private regular audit log");
    }

    if (openedStat.size > BigInt(MAX_SHARE_AUDIT_LOG_BYTES)) {
      throw new Error(
        `Share audit log "${auditPath}" exceeds WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES (${MAX_SHARE_AUDIT_LOG_BYTES}). Move or delete the whole file before restarting; byte truncation can create an invalid JSONL record.`
      );
    }

    if (openedStat.size > 0n) {
      const finalByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(finalByte, 0, 1, Number(openedStat.size - 1n));
      if (bytesRead !== 1 || finalByte[0] !== 0x0a) {
        throw new Error(
          `Share audit log "${auditPath}" does not end at a complete JSONL record. Move or delete the whole file before restarting; byte truncation is not repaired automatically.`
        );
      }
    }

    const verifiedStat = await handle.stat({ bigint: true });
    if (
      verifiedStat.size !== openedStat.size ||
      !isSameFileSystemObject(verifiedStat, openedStat)
    ) {
      throw unsafeStoragePathError(auditPath, "changed during startup reconciliation");
    }
    await assertStoragePathIdentity(auditPath, verifiedStat, "file");
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hardenCommittedStorageFiles(
  directoryPath: string,
  isCommittedName: (name: string) => boolean
): Promise<void> {
  const directoryIdentity = getManagedStorageDirectoryIdentity(directoryPath);
  await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
  const directory = await opendir(directoryPath);
  let directoryEntries = 0;

  for await (const entry of directory) {
    directoryEntries += 1;
    assertShareRecordDirectoryEntryBudget(directoryEntries);
    if (!entry.name.startsWith(".") && isCommittedName(entry.name)) {
      await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
      await hardenStorageFileIfPresent(join(directoryPath, entry.name));
    }
  }

  await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
}

async function assertManagedStorageLayout(): Promise<void> {
  for (const directoryPath of [DATA_ROOT, ARCHIVES_DIR, RECORDS_DIR, AUDIT_DIR]) {
    await assertStoragePathIdentity(
      directoryPath,
      getManagedStorageDirectoryIdentity(directoryPath),
      "directory"
    );
  }
}

function getManagedStorageDirectoryIdentity(directoryPath: string): BigIntStats {
  const identity = storageDirectoryIdentities.get(directoryPath);
  if (!identity) {
    throw unsafeStoragePathError(directoryPath, "has not been securely initialized");
  }
  return identity;
}

async function hardenStorageDirectory(directoryPath: string): Promise<BigIntStats> {
  let handle: FileHandle | null = null;

  try {
    handle = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isDirectory()) {
      throw unsafeStoragePathError(directoryPath, "expected a regular directory");
    }

    if (process.platform !== "win32") {
      await handle.chmod(0o700);
    }
    const hardenedStat = await handle.stat({ bigint: true });
    if (
      !hardenedStat.isDirectory() ||
      (process.platform !== "win32" && (hardenedStat.mode & 0o777n) !== 0o700n)
    ) {
      throw unsafeStoragePathError(directoryPath, "could not enforce mode 0700");
    }

    await assertStoragePathIdentity(directoryPath, hardenedStat, "directory");
    return hardenedStat;
  } catch (error) {
    if (error instanceof UnsafeStoragePathError) {
      throw error;
    }
    throw unsafeStoragePathError(directoryPath, "refusing to follow or replace this path", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hardenStorageFileIfPresent(filePath: string): Promise<void> {
  let pathStat: BigIntStats;
  try {
    pathStat = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (!pathStat.isFile()) {
    throw unsafeStoragePathError(filePath, "expected a regular file");
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1n ||
      !isSameFileSystemObject(pathStat, openedStat)
    ) {
      throw unsafeStoragePathError(filePath, "changed while permissions were being migrated");
    }

    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    const hardenedStat = await handle.stat({ bigint: true });
    if (
      !hardenedStat.isFile() ||
      hardenedStat.nlink !== 1n ||
      (process.platform !== "win32" && (hardenedStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(filePath, "could not enforce mode 0600");
    }

    await assertStoragePathIdentity(filePath, hardenedStat, "file");
  } catch (error) {
    if (error instanceof UnsafeStoragePathError) {
      throw error;
    }
    throw unsafeStoragePathError(filePath, "refusing to follow or replace this path", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPrivateArchiveFileStat(
  filePath: string,
  stat: BigIntStats,
  expectedSize: bigint,
  requirePrivateMode = true
): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size !== expectedSize ||
    (requirePrivateMode && process.platform !== "win32" && (stat.mode & 0o777n) !== 0o600n)
  ) {
    throw unsafeStoragePathError(filePath, "expected a private regular archive file");
  }
}

async function assertPrivateArchiveFilePathIdentity(
  filePath: string,
  expectedStat: BigIntStats
): Promise<void> {
  let currentStat: BigIntStats;
  try {
    currentStat = await lstat(filePath, { bigint: true });
  } catch (error) {
    throw unsafeStoragePathError(filePath, "disappeared during an archive operation", error);
  }

  assertPrivateArchiveFileStat(filePath, currentStat, expectedStat.size);
  if (!isSameFileSystemObject(currentStat, expectedStat)) {
    throw unsafeStoragePathError(filePath, "changed during an archive operation");
  }
}

async function assertStoragePathIdentity(
  storagePath: string,
  expectedStat: BigIntStats,
  expectedKind: "directory" | "file"
): Promise<void> {
  let currentStat: BigIntStats;
  try {
    currentStat = await lstat(storagePath, { bigint: true });
  } catch (error) {
    throw unsafeStoragePathError(storagePath, "disappeared during a storage operation", error);
  }

  const hasExpectedKind =
    expectedKind === "directory" ? currentStat.isDirectory() : currentStat.isFile();
  const hasSafeLinkCount =
    expectedKind === "directory" || (currentStat.nlink === 1n && expectedStat.nlink === 1n);
  const expectedMode = expectedKind === "directory" ? 0o700n : 0o600n;
  const hasExpectedMode =
    process.platform === "win32" || (currentStat.mode & 0o777n) === expectedMode;
  if (
    !hasExpectedKind ||
    !hasSafeLinkCount ||
    !hasExpectedMode ||
    !isSameFileSystemObject(currentStat, expectedStat)
  ) {
    throw unsafeStoragePathError(storagePath, "changed during a storage operation");
  }
}

function unsafeStoragePathError(
  storagePath: string,
  reason: string,
  cause?: unknown
): UnsafeStoragePathError {
  return new UnsafeStoragePathError(`Unsafe share storage path "${storagePath}": ${reason}.`, {
    cause
  });
}

async function reconcileStorageLayout(startupNow: number): Promise<void> {
  await assertManagedStorageLayout();
  resetShareRecordIndex();
  const archiveIds = await collectStoredIds(ARCHIVES_DIR, ".webblackbox", ".upload");
  const recordIds = await collectStoredIds(RECORDS_DIR, ".json", ".record");
  const indexEntries: ShareRecordIndexEntry[] = [];
  if (recordIds.size > MAX_SHARE_RECORD_FILES) {
    throw new Error(`Share record hard limit exceeded (${MAX_SHARE_RECORD_FILES}).`);
  }

  for (const id of recordIds) {
    if (archiveIds.has(id)) {
      const record = await readRecord(id);
      if (record) {
        const indexEntry = createShareRecordIndexEntry(record);
        if (indexEntry.retentionDeadline <= startupNow) {
          await removeStoredShare(id);
          archiveIds.delete(id);
          continue;
        }
        if (await hasValidStoredArchive(record)) {
          indexEntries.push(indexEntry);
          continue;
        }
      }
    }

    await removeStoredShare(id);
    archiveIds.delete(id);
  }

  for (const id of archiveIds) {
    if (!recordIds.has(id)) {
      await assertStoragePathIdentity(
        ARCHIVES_DIR,
        getManagedStorageDirectoryIdentity(ARCHIVES_DIR),
        "directory"
      );
      await rm(archivePathForId(id), { force: true });
    }
  }
  initializeShareRecordIndex(indexEntries);
  await assertManagedStorageLayout();
}

async function hasValidStoredArchive(record: ShareRecord): Promise<boolean> {
  let verifiedArchive: VerifiedArchiveFile | null = null;

  try {
    verifiedArchive = await openVerifiedArchive(record);
    return true;
  } catch (error) {
    if (!(error instanceof ArchiveIntegrityError)) {
      throw error;
    }
    return false;
  } finally {
    await verifiedArchive?.handle.close().catch(() => undefined);
  }
}

type VerifiedArchiveFile = {
  handle: FileHandle;
};

async function openVerifiedArchive(record: ShareRecord): Promise<VerifiedArchiveFile> {
  let handle: FileHandle | null = null;

  try {
    const archiveDirectoryIdentity = getManagedStorageDirectoryIdentity(ARCHIVES_DIR);
    await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
    const archivePath = archivePathForId(record.id);
    const pathStat = await lstat(archivePath, { bigint: true });
    if (!pathStat.isFile() || pathStat.size !== BigInt(record.sizeBytes)) {
      throw new ArchiveIntegrityError();
    }

    handle = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1n ||
      openedStat.size !== BigInt(record.sizeBytes) ||
      !isSameFileSystemObject(pathStat, openedStat)
    ) {
      throw new ArchiveIntegrityError();
    }
    if (process.platform !== "win32" && (openedStat.mode & 0o777n) !== 0o600n) {
      await handle.chmod(0o600);
      openedStat = await handle.stat({ bigint: true });
      if (
        !openedStat.isFile() ||
        openedStat.nlink !== 1n ||
        openedStat.size !== BigInt(record.sizeBytes) ||
        (openedStat.mode & 0o777n) !== 0o600n
      ) {
        throw new ArchiveIntegrityError();
      }
    }

    const statFingerprint = archiveStatFingerprint(openedStat);
    const cached = verifiedArchiveCache.get(record.id);
    if (
      cached?.checksumSha256 === record.checksumSha256 &&
      cached.statFingerprint === statFingerprint
    ) {
      verifiedArchiveCache.delete(record.id);
      verifiedArchiveCache.set(record.id, cached);
      await assertArchivePathStillReferences(archivePath, openedStat);
      await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
      return { handle };
    }

    const checksumSha256 = await checksumArchiveFileHandle(handle, record.sizeBytes);
    const verifiedStat = await handle.stat({ bigint: true });
    if (
      archiveStatFingerprint(verifiedStat) !== statFingerprint ||
      !sha256HexMatches(checksumSha256, record.checksumSha256)
    ) {
      throw new ArchiveIntegrityError();
    }

    await assertArchivePathStillReferences(archivePath, verifiedStat);
    await assertStoragePathIdentity(ARCHIVES_DIR, archiveDirectoryIdentity, "directory");
    cacheVerifiedArchive(record.id, checksumSha256, statFingerprint);
    return { handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ArchiveIntegrityError) {
      throw error;
    }
    if (isFileNotFoundError(error) || hasFileSystemErrorCode(error, "ELOOP")) {
      throw new ArchiveIntegrityError();
    }
    throw error;
  }
}

async function assertArchivePathStillReferences(
  archivePath: string,
  openedStat: BigIntStats
): Promise<void> {
  const currentPathStat = await lstat(archivePath, { bigint: true });
  if (
    !currentPathStat.isFile() ||
    archiveStatFingerprint(currentPathStat) !== archiveStatFingerprint(openedStat)
  ) {
    throw new ArchiveIntegrityError();
  }
}

function isSameFileSystemObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function archiveStatFingerprint(archiveStat: BigIntStats): string {
  return [
    archiveStat.dev,
    archiveStat.ino,
    archiveStat.mode,
    archiveStat.size,
    archiveStat.mtimeNs,
    archiveStat.ctimeNs
  ].join(":");
}

async function checksumArchiveFileHandle(
  handle: FileHandle,
  expectedBytes: number
): Promise<string> {
  const checksum = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(ARCHIVE_CHECKSUM_BUFFER_BYTES, expectedBytes));
  let offset = 0;

  while (offset < expectedBytes) {
    const bytesToRead = Math.min(buffer.byteLength, expectedBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    if (bytesRead === 0) {
      throw new ArchiveIntegrityError();
    }
    checksum.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }

  return checksum.digest("hex");
}

function cacheVerifiedArchive(id: string, checksumSha256: string, statFingerprint: string): void {
  verifiedArchiveCache.delete(id);
  while (verifiedArchiveCache.size >= MAX_VERIFIED_ARCHIVE_CACHE_ENTRIES) {
    const oldestId = verifiedArchiveCache.keys().next().value as string | undefined;
    if (!oldestId) {
      break;
    }
    verifiedArchiveCache.delete(oldestId);
  }
  verifiedArchiveCache.set(id, { checksumSha256, statFingerprint });
}

async function removeStoredShare(id: string): Promise<void> {
  verifiedArchiveCache.delete(id);
  await Promise.all([
    assertStoragePathIdentity(
      RECORDS_DIR,
      getManagedStorageDirectoryIdentity(RECORDS_DIR),
      "directory"
    ),
    assertStoragePathIdentity(
      ARCHIVES_DIR,
      getManagedStorageDirectoryIdentity(ARCHIVES_DIR),
      "directory"
    )
  ]);
  await Promise.all([
    rm(recordPathForId(id), { force: true }),
    rm(archivePathForId(id), { force: true })
  ]);
  removeShareRecordIndexEntry(id);
}

async function collectStoredIds(
  directoryPath: string,
  committedSuffix: string,
  temporarySuffix: string
): Promise<Set<string>> {
  const directoryIdentity = getManagedStorageDirectoryIdentity(directoryPath);
  await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
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
      await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
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

  await assertStoragePathIdentity(directoryPath, directoryIdentity, "directory");
  return ids;
}

async function readRecord(id: string): Promise<ShareRecord | null> {
  if (!SHARE_ID_PATTERN.test(id)) {
    return null;
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const recordDirectoryIdentity = getManagedStorageDirectoryIdentity(RECORDS_DIR);
    await assertStoragePathIdentity(RECORDS_DIR, recordDirectoryIdentity, "directory");
    const recordPath = recordPathForId(id);
    handle = await open(recordPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let recordStat = await handle.stat({ bigint: true });
    if (
      !recordStat.isFile() ||
      recordStat.nlink !== 1n ||
      recordStat.size <= 0n ||
      recordStat.size > BigInt(MAX_SHARE_RECORD_BYTES)
    ) {
      return null;
    }
    if (process.platform !== "win32" && (recordStat.mode & 0o777n) !== 0o600n) {
      await handle.chmod(0o600);
      recordStat = await handle.stat({ bigint: true });
      if (
        !recordStat.isFile() ||
        recordStat.nlink !== 1n ||
        recordStat.size <= 0n ||
        recordStat.size > BigInt(MAX_SHARE_RECORD_BYTES) ||
        (recordStat.mode & 0o777n) !== 0o600n
      ) {
        return null;
      }
    }

    const raw = await readFileHandleExactly(handle, Number(recordStat.size));
    await assertStoragePathIdentity(recordPath, recordStat, "file");
    await assertStoragePathIdentity(RECORDS_DIR, recordDirectoryIdentity, "directory");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    return normalizePersistedShareRecord(parsed, id);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function tryReserveShareRecordSlot(): Promise<boolean> {
  const reservation = shareRecordAdmissionQueue.then(async () => {
    const initialCount = shareRecordIndexById.size;
    if (initialCount + reservedShareRecordSlots < SHARE_RECORD_ADMISSION_LIMIT) {
      reservedShareRecordSlots += 1;
      return true;
    }

    await pruneExpiredShareRecords(Date.now());
    const retainedCount = shareRecordIndexById.size;
    if (retainedCount + reservedShareRecordSlots >= SHARE_RECORD_ADMISSION_LIMIT) {
      return false;
    }

    reservedShareRecordSlots += 1;
    return true;
  });
  shareRecordAdmissionQueue = reservation.then(
    () => undefined,
    () => undefined
  );
  return reservation;
}

function assertShareRecordDirectoryEntryBudget(entries: number): void {
  if (entries > MAX_SHARE_RECORD_DIRECTORY_ENTRIES) {
    throw new Error(
      `Share record directory entry limit exceeded (${MAX_SHARE_RECORD_DIRECTORY_ENTRIES}).`
    );
  }
}

function resetShareRecordIndex(): void {
  shareRecordIndexById.clear();
  shareRecordListOrder.length = 0;
  shareRecordExpiryOrder.length = 0;
}

function initializeShareRecordIndex(entries: ShareRecordIndexEntry[]): void {
  if (entries.length > MAX_SHARE_RECORD_FILES) {
    throw new Error(`Share record hard limit exceeded (${MAX_SHARE_RECORD_FILES}).`);
  }

  resetShareRecordIndex();
  for (const entry of entries) {
    if (shareRecordIndexById.has(entry.id)) {
      throw new Error(`Duplicate share record index entry: ${entry.id}`);
    }
    shareRecordIndexById.set(entry.id, entry);
  }
  shareRecordListOrder.push(...entries);
  shareRecordListOrder.sort(compareShareRecordListEntries);
  shareRecordExpiryOrder.push(...entries);
  shareRecordExpiryOrder.sort(compareShareRecordExpiryEntries);
}

function assertShareRecordIndexCapacity(id: string): void {
  if (!shareRecordIndexById.has(id) && shareRecordIndexById.size >= MAX_SHARE_RECORD_FILES) {
    throw new Error(`Share record hard limit exceeded (${MAX_SHARE_RECORD_FILES}).`);
  }
}

function upsertShareRecordIndex(record: ShareRecord): void {
  const entry = createShareRecordIndexEntry(record);
  removeShareRecordIndexEntry(record.id);
  assertShareRecordIndexCapacity(record.id);
  shareRecordIndexById.set(entry.id, entry);
  insertSortedIndexEntry(shareRecordListOrder, entry, compareShareRecordListEntries);
  insertSortedIndexEntry(shareRecordExpiryOrder, entry, compareShareRecordExpiryEntries);
}

function createShareRecordIndexEntry(record: ShareRecord): ShareRecordIndexEntry {
  const retentionDeadline = addSafeIntegers(record.expiresAt, SHARE_RETAIN_EXPIRED_MS);
  if (retentionDeadline === null) {
    throw new Error("Share record retention deadline exceeds the safe integer range.");
  }

  return {
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    retentionDeadline
  };
}

function removeShareRecordIndexEntry(id: string): void {
  const entry = shareRecordIndexById.get(id);
  if (!entry) {
    return;
  }

  shareRecordIndexById.delete(id);
  removeSortedIndexEntry(shareRecordListOrder, entry, compareShareRecordListEntries);
  removeSortedIndexEntry(shareRecordExpiryOrder, entry, compareShareRecordExpiryEntries);
}

function compareShareRecordListEntries(left: ShareListCursor, right: ShareListCursor): number {
  return right.createdAt - left.createdAt || compareShareIds(left.id, right.id);
}

function compareShareRecordExpiryEntries(
  left: ShareRecordIndexEntry,
  right: ShareRecordIndexEntry
): number {
  return left.retentionDeadline - right.retentionDeadline || compareShareIds(left.id, right.id);
}

function compareShareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertSortedIndexEntry<T>(
  entries: T[],
  entry: T,
  compare: (left: T, right: T) => number
): void {
  entries.splice(findSortedIndex(entries, entry, compare, false), 0, entry);
}

function removeSortedIndexEntry<T>(
  entries: T[],
  entry: T,
  compare: (left: T, right: T) => number
): void {
  const index = findSortedIndex(entries, entry, compare, false);
  if (entries[index] === entry) {
    entries.splice(index, 1);
  }
}

function findSortedIndex<T, U>(
  entries: T[],
  target: U,
  compare: (left: T, right: U) => number,
  afterEqual: boolean
): number {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const comparison = compare(entries[middle] as T, target);
    if (comparison < 0 || (afterEqual && comparison === 0)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function selectShareRecordIndexPage(pagination: ShareListPagination): ShareRecordIndexEntry[] {
  const start =
    pagination.mode === "cursor"
      ? findSortedIndex(
          shareRecordListOrder,
          pagination.cursor,
          compareShareRecordListEntries,
          true
        )
      : pagination.offset;
  return shareRecordListOrder.slice(start, start + pagination.limit);
}

function hasShareRecordIndexEntryAfter(cursor: ShareListCursor): boolean {
  return (
    findSortedIndex(shareRecordListOrder, cursor, compareShareRecordListEntries, true) <
    shareRecordListOrder.length
  );
}

async function writeRecord(record: ShareRecord): Promise<void> {
  assertShareRecordIndexCapacity(record.id);
  const recordDirectoryIdentity = getManagedStorageDirectoryIdentity(RECORDS_DIR);
  await assertStoragePathIdentity(RECORDS_DIR, recordDirectoryIdentity, "directory");
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
    await assertStoragePathIdentity(RECORDS_DIR, recordDirectoryIdentity, "directory");
    await rename(temporaryPath, recordPathForId(record.id));
    committed = true;
    await syncDirectoryBestEffort(RECORDS_DIR);
    upsertShareRecordIndex(record);
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
    addSafeIntegers(expiresAt, SHARE_RETAIN_EXPIRED_MS) === null ||
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
  const record = readPersistedObject(value);
  const encrypted = record?.encrypted === true;

  if (record?.schemaVersion === 2) {
    return (
      normalizeCurrentPersistedShareSummary(record) ?? unavailablePersistedShareSummary(encrypted)
    );
  }

  return (
    normalizeLegacyPersistedShareSummary(record) ?? unavailablePersistedShareSummary(encrypted)
  );
}

function normalizeCurrentPersistedShareSummary(
  record: Record<string, unknown>
): ShareSummary | null {
  if (typeof record.encrypted !== "boolean") {
    return null;
  }

  const trust = readPersistedObject(record.trust);
  if (trust?.archiveEnvelope !== "server-inspected") {
    return null;
  }

  const manifest = normalizePersistedShareManifest(record.manifest);
  if (manifest === null) {
    return null;
  }

  if (record.source === "server") {
    const totals = normalizePersistedShareTotals(record.totals, "server");
    const topActionTriggers = normalizePersistedActionTriggerSummaries(record.topActionTriggers);
    const privacy = normalizePersistedSharePrivacySummary(record.privacy);
    const privateContent = trust.privateContent;
    if (
      record.analyzed !== true ||
      (privateContent !== "server-analyzed" && privateContent !== "server-partially-analyzed") ||
      trust.archiveDigestMatched !== undefined ||
      record.analysisError !== undefined ||
      record.clientClaim !== undefined ||
      manifest === undefined ||
      totals === null ||
      totals === undefined ||
      typeof totals.blobs !== "number" ||
      topActionTriggers === null ||
      topActionTriggers === undefined ||
      privacy === null ||
      privacy === undefined
    ) {
      return null;
    }
    const scanner = privacy.scanner;
    const coverage = scanner.coverage;
    const coverageMatchesArchiveTotals =
      coverage !== undefined &&
      coverage.expectedEventCount === totals.events &&
      coverage.expectedBlobCount === totals.blobs;
    const coverageCountsAreBounded =
      coverage !== undefined &&
      coverage.scannedEventCount <= coverage.expectedEventCount &&
      coverage.scannedBlobCount + coverage.opaqueBlobCount <= coverage.expectedBlobCount;
    const validCompleteAttestation =
      privateContent === "server-analyzed" &&
      scanner?.status === "passed" &&
      scanner.findingCount === 0 &&
      coverage?.complete === true &&
      coverageMatchesArchiveTotals &&
      coverage.scannedEventCount === coverage.expectedEventCount &&
      coverage.scannedBlobCount === coverage.expectedBlobCount &&
      coverage.opaqueBlobCount === 0;
    const validPartialAnalysis =
      privateContent === "server-partially-analyzed" &&
      scanner?.status === "unknown" &&
      scanner.findingCount === 0 &&
      coverage?.complete === false &&
      coverageMatchesArchiveTotals &&
      coverageCountsAreBounded;
    if (!validCompleteAttestation && !validPartialAnalysis) {
      return null;
    }

    return {
      schemaVersion: 2,
      source: "server",
      analyzed: true,
      encrypted: record.encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent
      },
      manifest,
      totals,
      topActionTriggers,
      privacy
    };
  }

  if (record.source === "client-unverified") {
    const totals = normalizePersistedShareTotals(record.totals, "envelope");
    const clientClaim = normalizePersistedClientClaim(record.clientClaim);
    if (
      record.analyzed !== false ||
      trust.privateContent !== "client-claim-unverified" ||
      (trust.archiveDigestMatched !== undefined && trust.archiveDigestMatched !== true) ||
      record.privacy !== undefined ||
      record.topActionTriggers !== undefined ||
      !isOptionalPersistedAnalysisError(record.analysisError) ||
      totals === null ||
      clientClaim === null
    ) {
      return null;
    }

    return {
      schemaVersion: 2,
      source: "client-unverified",
      analyzed: false,
      encrypted: record.encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "client-claim-unverified",
        ...(trust.archiveDigestMatched === true ? { archiveDigestMatched: true } : {})
      },
      manifest,
      totals,
      clientClaim,
      analysisError:
        trust.archiveDigestMatched === true
          ? "Encrypted private content was not analyzed by the share server; privacy fields are unverified client claims."
          : "Legacy client privacy fields were not archive-digest-bound and remain unverified claims."
    };
  }

  if (record.source === "unavailable") {
    const totals = normalizePersistedShareTotals(record.totals, "envelope");
    if (
      record.analyzed !== false ||
      trust.privateContent !== "not-analyzed" ||
      trust.archiveDigestMatched !== undefined ||
      record.privacy !== undefined ||
      record.topActionTriggers !== undefined ||
      record.clientClaim !== undefined ||
      !isOptionalPersistedAnalysisError(record.analysisError) ||
      totals === null
    ) {
      return null;
    }

    return {
      schemaVersion: 2,
      source: "unavailable",
      analyzed: false,
      encrypted: record.encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "not-analyzed"
      },
      manifest,
      totals,
      analysisError: "Stored share analysis is unavailable."
    };
  }

  return null;
}

function normalizeLegacyPersistedShareSummary(
  record: Record<string, unknown> | null
): ShareSummary | null {
  if (!record || typeof record.encrypted !== "boolean") {
    return null;
  }

  const manifest = normalizePersistedShareManifest(record.manifest);
  const totals = normalizePersistedShareTotals(record.totals, "server");
  const topActionTriggers = normalizePersistedActionTriggerSummaries(record.topActionTriggers);
  const privacy = normalizePersistedSharePrivacySummary(record.privacy);
  if (manifest === null || totals === null || topActionTriggers === null || privacy === null) {
    return null;
  }

  if (record.source === "client" || record.source === "client-unverified") {
    if (record.analyzed !== undefined && typeof record.analyzed !== "boolean") {
      return null;
    }

    return {
      schemaVersion: 2,
      source: "client-unverified",
      analyzed: false,
      encrypted: record.encrypted,
      trust: {
        archiveEnvelope: "server-inspected",
        privateContent: "client-claim-unverified"
      },
      manifest,
      totals:
        totals === undefined
          ? undefined
          : {
              events: totals.events,
              ...(totals.blobs === undefined ? {} : { blobs: totals.blobs }),
              durationMs: totals.durationMs
            },
      clientClaim: {
        totals:
          totals === undefined
            ? undefined
            : {
                ...(totals.privacyViolations === undefined
                  ? {}
                  : { privacyViolations: totals.privacyViolations }),
                ...(totals.errors === undefined ? {} : { errors: totals.errors }),
                ...(totals.requests === undefined ? {} : { requests: totals.requests }),
                ...(totals.actions === undefined ? {} : { actions: totals.actions })
              },
        topActionTriggers,
        privacy
      },
      analysisError:
        "Legacy client privacy fields were not archive-digest-bound and remain unverified claims."
    };
  }

  // Older server summaries predate independent scan coverage and may have promoted an embedded
  // archive claim. They cannot be upgraded into a current server attestation.
  if (record.source === "server" && record.analyzed === true) {
    return null;
  }

  return null;
}

function normalizePersistedShareManifest(value: unknown): ShareSummary["manifest"] | null {
  if (value === undefined) {
    return undefined;
  }

  const record = readPersistedObject(value);
  const mode = exportManifestSchema.shape.mode.safeParse(record?.mode);
  const chunkCodec = exportManifestSchema.shape.chunkCodec.safeParse(record?.chunkCodec);
  const recordedAt = exportManifestSchema.shape.createdAt.safeParse(record?.recordedAt);
  if (!mode.success || !chunkCodec.success || !recordedAt.success) {
    return null;
  }

  return {
    mode: mode.data,
    chunkCodec: chunkCodec.data,
    recordedAt: recordedAt.data
  };
}

function normalizePersistedShareTotals(
  value: unknown,
  kind: "server" | "envelope"
): ShareSummary["totals"] | null {
  if (value === undefined) {
    return undefined;
  }

  const record = readPersistedObject(value);
  if (!record) {
    return null;
  }
  const events = readPersistedNonNegativeInteger(
    record.events,
    SHARE_ARCHIVE_RESOURCE_LIMITS.maxEventCount
  );
  const durationMs = readPersistedNonNegativeInteger(record.durationMs, Number.MAX_SAFE_INTEGER);
  const blobs = readOptionalPersistedNonNegativeInteger(
    record,
    "blobs",
    SHARE_ARCHIVE_RESOURCE_LIMITS.maxEntryCount
  );
  if (events === null || durationMs === null || blobs === null) {
    return null;
  }

  const privacyViolations = readOptionalPersistedSummaryCount(record, "privacyViolations");
  const errors = readOptionalPersistedSummaryCount(record, "errors");
  const requests = readOptionalPersistedSummaryCount(record, "requests");
  const actions = readOptionalPersistedSummaryCount(record, "actions");
  if (
    privacyViolations === null ||
    errors === null ||
    requests === null ||
    actions === null ||
    (kind === "envelope" &&
      (privacyViolations !== undefined ||
        errors !== undefined ||
        requests !== undefined ||
        actions !== undefined))
  ) {
    return null;
  }

  return {
    events,
    ...(blobs === undefined ? {} : { blobs }),
    ...(kind === "server"
      ? {
          ...(privacyViolations === undefined ? {} : { privacyViolations }),
          ...(errors === undefined ? {} : { errors }),
          ...(requests === undefined ? {} : { requests }),
          ...(actions === undefined ? {} : { actions })
        }
      : {}),
    durationMs
  };
}

function normalizePersistedClientClaim(value: unknown): ShareSummary["clientClaim"] | null {
  if (value === undefined) {
    return undefined;
  }

  const record = readPersistedObject(value);
  if (!record) {
    return null;
  }

  let totals: NonNullable<ShareSummary["clientClaim"]>["totals"];
  if (record.totals !== undefined) {
    const totalsRecord = readPersistedObject(record.totals);
    if (!totalsRecord) {
      return null;
    }
    const privacyViolations = readOptionalPersistedSummaryCount(totalsRecord, "privacyViolations");
    const errors = readOptionalPersistedSummaryCount(totalsRecord, "errors");
    const requests = readOptionalPersistedSummaryCount(totalsRecord, "requests");
    const actions = readOptionalPersistedSummaryCount(totalsRecord, "actions");
    if (privacyViolations === null || errors === null || requests === null || actions === null) {
      return null;
    }
    totals = {
      ...(privacyViolations === undefined ? {} : { privacyViolations }),
      ...(errors === undefined ? {} : { errors }),
      ...(requests === undefined ? {} : { requests }),
      ...(actions === undefined ? {} : { actions })
    };
  }

  const topActionTriggers = normalizePersistedActionTriggerSummaries(record.topActionTriggers);
  const privacy = normalizePersistedSharePrivacySummary(record.privacy);
  if (topActionTriggers === null || privacy === null) {
    return null;
  }

  return { totals, topActionTriggers, privacy };
}

function normalizePersistedSharePrivacySummary(value: unknown): ShareSummary["privacy"] | null {
  if (value === undefined) {
    return undefined;
  }

  const record = readPersistedObject(value);
  const redaction = readPersistedObject(record?.redaction);
  const detected = readPersistedObject(record?.detected);
  const scanner = readPersistedObject(record?.scanner);
  if (!record || !redaction || !detected || !scanner) {
    return null;
  }

  const headerRuleCount = readPersistedSummaryCount(redaction.headerRuleCount);
  const cookieRuleCount = readPersistedSummaryCount(redaction.cookieRuleCount);
  const bodyPatternCount = readPersistedSummaryCount(redaction.bodyPatternCount);
  const blockedSelectorCount = readPersistedSummaryCount(redaction.blockedSelectorCount);
  const redactedMarkers = readPersistedSummaryCount(detected.redactedMarkers);
  const hashedSensitiveValues = readPersistedSummaryCount(detected.hashedSensitiveValues);
  const sensitiveKeyMentions = readPersistedSummaryCount(detected.sensitiveKeyMentions);
  const findingCount = readPersistedSummaryCount(scanner.findingCount);
  const coverage = normalizePersistedPrivacyScanCoverage(scanner.coverage);
  if (
    typeof redaction.hashSensitiveValues !== "boolean" ||
    headerRuleCount === null ||
    cookieRuleCount === null ||
    bodyPatternCount === null ||
    blockedSelectorCount === null ||
    redactedMarkers === null ||
    hashedSensitiveValues === null ||
    sensitiveKeyMentions === null ||
    typeof scanner.preEncryption !== "boolean" ||
    (scanner.status !== "passed" && scanner.status !== "blocked" && scanner.status !== "unknown") ||
    findingCount === null ||
    coverage === null
  ) {
    return null;
  }

  const categories = normalizePersistedCategorySummaries(record.categories);
  if (categories === null) {
    return null;
  }

  return {
    redaction: {
      hashSensitiveValues: redaction.hashSensitiveValues,
      headerRuleCount,
      cookieRuleCount,
      bodyPatternCount,
      blockedSelectorCount
    },
    detected: {
      redactedMarkers,
      hashedSensitiveValues,
      sensitiveKeyMentions
    },
    scanner: {
      preEncryption: scanner.preEncryption,
      status: scanner.status,
      findingCount,
      ...(coverage === undefined ? {} : { coverage })
    },
    categories
  };
}

function normalizePersistedPrivacyScanCoverage(
  value: unknown
): SharePrivacySummary["scanner"]["coverage"] | null {
  if (value === undefined) {
    return undefined;
  }

  const record = readPersistedObject(value);
  if (!record || typeof record.complete !== "boolean") {
    return null;
  }
  const scannedEventCount = readPersistedSummaryCount(record.scannedEventCount);
  const scannedBlobCount = readPersistedSummaryCount(record.scannedBlobCount);
  const opaqueBlobCount = readPersistedSummaryCount(record.opaqueBlobCount);
  const inspectedBytes = readPersistedSummaryCount(record.inspectedBytes);
  const expectedEventCount = readPersistedSummaryCount(record.expectedEventCount);
  const expectedBlobCount = readPersistedSummaryCount(record.expectedBlobCount);
  const incompleteReason = record.incompleteReason;
  if (
    scannedEventCount === null ||
    scannedBlobCount === null ||
    opaqueBlobCount === null ||
    inspectedBytes === null ||
    expectedEventCount === null ||
    expectedBlobCount === null ||
    (incompleteReason !== undefined &&
      incompleteReason !== "deadline" &&
      incompleteReason !== "decode-failed" &&
      incompleteReason !== "finding-limit" &&
      incompleteReason !== "target-byte-limit" &&
      incompleteReason !== "total-byte-limit" &&
      incompleteReason !== "opaque-content" &&
      incompleteReason !== "coverage-mismatch")
  ) {
    return null;
  }

  if (
    (record.complete && incompleteReason !== undefined) ||
    (!record.complete && !incompleteReason)
  ) {
    return null;
  }

  return {
    complete: record.complete,
    scannedEventCount,
    scannedBlobCount,
    opaqueBlobCount,
    inspectedBytes,
    expectedEventCount,
    expectedBlobCount,
    ...(incompleteReason === undefined ? {} : { incompleteReason })
  };
}

function normalizePersistedActionTriggerSummaries(
  value: unknown
): ShareSummary["topActionTriggers"] | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 10) {
    return null;
  }

  const summaries: NonNullable<ShareSummary["topActionTriggers"]> = [];
  for (const entry of value) {
    const record = readPersistedObject(entry);
    const triggerType = readPersistedPublicText(record?.triggerType, 64);
    const count = readPersistedSummaryCount(record?.count);
    const errorRate = record?.errorRate;
    if (
      triggerType === null ||
      count === null ||
      typeof errorRate !== "number" ||
      !Number.isFinite(errorRate) ||
      errorRate < 0 ||
      errorRate > 1
    ) {
      return null;
    }
    summaries.push({ triggerType, count, errorRate });
  }
  return summaries;
}

function normalizePersistedCategorySummaries(
  value: unknown
): NonNullable<ShareSummary["privacy"]>["categories"] | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 24) {
    return null;
  }

  const summaries: NonNullable<NonNullable<ShareSummary["privacy"]>["categories"]> = [];
  for (const entry of value) {
    const record = readPersistedObject(entry);
    const category = readPersistedPublicText(record?.category, 32);
    const events = readPersistedSummaryCount(record?.events);
    const low = readPersistedSummaryCount(record?.low);
    const medium = readPersistedSummaryCount(record?.medium);
    const high = readPersistedSummaryCount(record?.high);
    const redacted = readPersistedSummaryCount(record?.redacted);
    const unredacted = readPersistedSummaryCount(record?.unredacted);
    if (
      category === null ||
      events === null ||
      low === null ||
      medium === null ||
      high === null ||
      redacted === null ||
      unredacted === null
    ) {
      return null;
    }
    summaries.push({ category, events, low, medium, high, redacted, unredacted });
  }
  return summaries;
}

function readPersistedObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPersistedNonNegativeInteger(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function readOptionalPersistedNonNegativeInteger(
  record: Record<string, unknown> | null,
  key: string,
  maximum: number
): number | undefined | null {
  if (!record || !(key in record)) {
    return undefined;
  }
  return readPersistedNonNegativeInteger(record[key], maximum);
}

function readPersistedSummaryCount(value: unknown): number | null {
  return readPersistedNonNegativeInteger(
    value,
    SHARE_ARCHIVE_RESOURCE_LIMITS.maxTotalUncompressedBytes
  );
}

function readOptionalPersistedSummaryCount(
  record: Record<string, unknown>,
  key: string
): number | undefined | null {
  return key in record ? readPersistedSummaryCount(record[key]) : undefined;
}

function readPersistedPublicText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    return null;
  }
  return redactText(value, maximumLength);
}

function isOptionalPersistedAnalysisError(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 240);
}

function unavailablePersistedShareSummary(encrypted: boolean): ShareSummary {
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

function parseShareListPagination(requestUrl: URL): ShareListPagination | null {
  if (
    requestUrl.searchParams.getAll("cursor").length > 1 ||
    requestUrl.searchParams.getAll("offset").length > 1 ||
    requestUrl.searchParams.getAll("limit").length > 1
  ) {
    return null;
  }

  const limit = parseBoundedQueryInteger(
    requestUrl.searchParams.get("limit"),
    DEFAULT_SHARE_LIST_LIMIT,
    1,
    MAX_SHARE_LIST_LIMIT
  );
  if (limit === null) {
    return null;
  }

  const rawCursor = requestUrl.searchParams.get("cursor");
  if (rawCursor !== null) {
    if (requestUrl.searchParams.has("offset")) {
      return null;
    }
    const cursor = decodeShareListCursor(rawCursor);
    return cursor ? { mode: "cursor", cursor, limit } : null;
  }

  const offset = parseBoundedQueryInteger(
    requestUrl.searchParams.get("offset"),
    0,
    0,
    MAX_SHARE_RECORD_FILES
  );
  return offset === null ? null : { mode: "offset", offset, limit };
}

function encodeShareListCursor(cursor: ShareListCursor): string {
  return Buffer.from(
    JSON.stringify({ version: 1, createdAt: cursor.createdAt, id: cursor.id }),
    "utf8"
  ).toString("base64url");
}

function decodeShareListCursor(raw: string): ShareListCursor | null {
  if (
    raw.length === 0 ||
    raw.length > MAX_SHARE_LIST_CURSOR_BYTES * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    return null;
  }

  try {
    const bytes = Buffer.from(raw, "base64url");
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_SHARE_LIST_CURSOR_BYTES ||
      bytes.toString("base64url") !== raw
    ) {
      return null;
    }

    const cursor = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const createdAt = readSafeNonNegativeInteger(cursor.createdAt);
    if (
      cursor.version !== 1 ||
      createdAt === null ||
      typeof cursor.id !== "string" ||
      !SHARE_ID_PATTERN.test(cursor.id)
    ) {
      return null;
    }

    return { createdAt, id: cursor.id };
  } catch {
    return null;
  }
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
  while ((shareRecordExpiryOrder[0]?.retentionDeadline ?? Number.POSITIVE_INFINITY) <= now) {
    const expired = shareRecordExpiryOrder[0];
    if (!expired) {
      return;
    }
    await removeStoredShare(expired.id);
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
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    action: input.action,
    outcome: input.outcome,
    shareId: input.shareId,
    clientHashAlgorithm: SHARE_AUDIT_CLIENT_HASH_ALGORITHM,
    clientHash: hashAuditValue(resolveClientKey(request)),
    details: input.details
  };
  const line = `${JSON.stringify(event)}\n`;
  const result = await auditWriter.write(line);

  if (result.status === "written") {
    if (result.recovered) {
      console.info("[share-server] audit sink recovered");
    }
    return;
  }

  reportAuditWriteDegradation(result, input.action, input.shareId);
}

async function appendShareAuditLine(line: string, signal: AbortSignal): Promise<void> {
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_SHARE_AUDIT_LOG_BYTES) {
    throw new Error("Share audit event exceeds the configured log size ceiling.");
  }

  throwIfAuditWriteAborted(signal);
  let currentLog = await openAuditLogForAppend();
  try {
    if (
      currentLog.stat.size > 0n &&
      currentLog.stat.size + BigInt(lineBytes) > BigInt(MAX_SHARE_AUDIT_LOG_BYTES)
    ) {
      await currentLog.handle?.close();
      currentLog = { handle: null, stat: currentLog.stat };
      throwIfAuditWriteAborted(signal);
      await assertStoragePathIdentity(
        AUDIT_DIR,
        getManagedStorageDirectoryIdentity(AUDIT_DIR),
        "directory"
      );
      await rm(SHARE_AUDIT_ROTATED_LOG_PATH, { force: true });
      throwIfAuditWriteAborted(signal);
      try {
        await rename(SHARE_AUDIT_LOG_PATH, SHARE_AUDIT_ROTATED_LOG_PATH);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }
      await hardenStorageFileIfPresent(SHARE_AUDIT_ROTATED_LOG_PATH);
      throwIfAuditWriteAborted(signal);
      currentLog = await openAuditLogForAppend();
    }

    if (!currentLog.handle) {
      throw new Error("Share audit log handle is unavailable.");
    }
    throwIfAuditWriteAborted(signal);
    await currentLog.handle.appendFile(line, { encoding: "utf8" });
    await assertStoragePathIdentity(SHARE_AUDIT_LOG_PATH, currentLog.stat, "file");
  } finally {
    await currentLog.handle?.close().catch(() => undefined);
  }
}

async function openAuditLogForAppend(): Promise<{
  handle: FileHandle | null;
  stat: BigIntStats;
}> {
  let handle: FileHandle | null = null;
  try {
    const auditDirectoryIdentity = getManagedStorageDirectoryIdentity(AUDIT_DIR);
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    handle = await open(
      SHARE_AUDIT_LOG_PATH,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600
    );
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || openedStat.nlink !== 1n) {
      throw unsafeStoragePathError(SHARE_AUDIT_LOG_PATH, "expected a regular audit log");
    }

    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    const hardenedStat = await handle.stat({ bigint: true });
    if (
      hardenedStat.nlink !== 1n ||
      (process.platform !== "win32" && (hardenedStat.mode & 0o777n) !== 0o600n)
    ) {
      throw unsafeStoragePathError(SHARE_AUDIT_LOG_PATH, "could not enforce mode 0600");
    }
    await assertStoragePathIdentity(SHARE_AUDIT_LOG_PATH, hardenedStat, "file");
    await assertStoragePathIdentity(AUDIT_DIR, auditDirectoryIdentity, "directory");
    return { handle, stat: hardenedStat };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof UnsafeStoragePathError) {
      throw error;
    }
    throw unsafeStoragePathError(
      SHARE_AUDIT_LOG_PATH,
      "refusing to follow or replace this path",
      error
    );
  }
}

function reportAuditWriteDegradation(
  result: Exclude<AuditWriteResult, { status: "written" }>,
  action: ShareAuditAction,
  shareId?: string
): void {
  const now = Date.now();
  if (now - lastAuditDegradationWarningAt < AUDIT_DEGRADATION_WARNING_INTERVAL_MS) {
    suppressedAuditDegradationWarnings += 1;
    return;
  }

  const suppressedWarnings = suppressedAuditDegradationWarnings;
  lastAuditDegradationWarningAt = now;
  suppressedAuditDegradationWarnings = 0;
  const details: Record<string, number | string | undefined> = {
    action,
    shareId,
    reason: result.reason,
    suppressedWarnings: suppressedWarnings || undefined
  };

  if (result.status === "failed" && result.error !== undefined) {
    details.error = redactText(
      result.error instanceof Error ? result.error.message : String(result.error),
      240
    );
  }

  console.warn(
    result.status === "failed"
      ? "[share-server] audit append failed"
      : "[share-server] audit event dropped",
    details
  );
}

function throwIfAuditWriteAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : new Error("Share audit append aborted.");
}

function isFileNotFoundError(error: unknown): boolean {
  return hasFileSystemErrorCode(error, "ENOENT");
}

function hasFileSystemErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function hashAuditValue(value: string): string {
  if (!shareAuditHmacSecret) {
    throw new Error("Share audit HMAC key is not initialized.");
  }

  return createHmac("sha256", shareAuditHmacSecret)
    .update(SHARE_AUDIT_CLIENT_HASH_DOMAIN)
    .update(value)
    .digest("hex");
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
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

function formatHostForUrl(host: string): string {
  const normalized = host.trim().replace(/^\[|\]$/g, "");
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function validateAuthorizationConfiguration(bindHost: string, publicOrigin: string): void {
  if (!ALLOW_UNAUTHENTICATED_LOOPBACK) {
    return;
  }

  if (!isLoopbackHost(bindHost) || !isLoopbackHost(new URL(publicOrigin).hostname)) {
    throw new Error(
      "WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK is development-only and requires both a loopback bind host and loopback public origin."
    );
  }

  if (TRUST_X_FORWARDED_FOR || TRUSTED_PROXY_ADDRESSES.size > 0) {
    throw new Error(
      "WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK must not be enabled with proxy or forwarded-client configuration."
    );
  }
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
  upload: PendingShareUpload,
  maxBytes: number
): Promise<{ bytes: Uint8Array; checksumSha256: string }> {
  const declaredBytes = readDeclaredContentLength(request);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
  const handle = await open(
    upload.tempPath,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
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
    let temporaryStat = await handle.stat({ bigint: true });
    assertPrivateArchiveFileStat(upload.tempPath, temporaryStat, 0n, false);
    upload.tempIdentity = temporaryStat;
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
      temporaryStat = await handle.stat({ bigint: true });
      assertPrivateArchiveFileStat(upload.tempPath, temporaryStat, 0n);
      upload.tempIdentity = temporaryStat;
    }
    await assertPrivateArchiveFilePathIdentity(upload.tempPath, temporaryStat);
    await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");

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
    let storedStat = await handle.stat({ bigint: true });
    assertPrivateArchiveFileStat(upload.tempPath, storedStat, BigInt(totalBytes));
    upload.tempIdentity = storedStat;
    await assertPrivateArchiveFilePathIdentity(upload.tempPath, storedStat);
    await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
    storedBytes = await readFileHandleExactly(handle, totalBytes);
    const verifiedStat = await handle.stat({ bigint: true });
    assertPrivateArchiveFileStat(upload.tempPath, verifiedStat, BigInt(totalBytes));
    if (!isSameFileSystemObject(storedStat, verifiedStat)) {
      throw unsafeStoragePathError(upload.tempPath, "changed while its contents were verified");
    }
    storedStat = verifiedStat;
    upload.tempIdentity = storedStat;
    await assertPrivateArchiveFilePathIdentity(upload.tempPath, storedStat);
    await assertStoragePathIdentity(ARCHIVES_DIR, upload.archiveDirectoryIdentity, "directory");
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
  if (ALLOW_UNAUTHENTICATED_LOOPBACK && isLoopbackRequest(request)) {
    return {
      authorized: true,
      source: "unauthenticated-loopback-dev"
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
  const family = isIP(trimmed);
  if (family === 0) {
    return null;
  }

  const socketAddress = SocketAddress.parse(family === 6 ? `[${trimmed}]:0` : `${trimmed}:0`);
  if (!socketAddress) {
    return null;
  }

  const canonical = socketAddress.address.toLowerCase();
  const mappedIpv4 = canonical.startsWith("::ffff:") ? canonical.slice("::ffff:".length) : null;
  return mappedIpv4 && isIP(mappedIpv4) === 4 ? mappedIpv4 : canonical;
}

function isTrustedProxyAddress(address: string): boolean {
  return TRUSTED_PROXY_ADDRESSES.has(address);
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

function parseAuditHmacEnvironmentSecret(value: string | undefined): Buffer | null {
  if (value === undefined || value.length === 0) {
    return null;
  }

  const invalidSecret = () =>
    new Error(
      `${SHARE_AUDIT_HMAC_SECRET_ENV} must be canonical base64url encoding of 32 to 64 high-entropy bytes (at least 128 bits of estimated entropy).`
    );
  if (value !== value.trim() || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidSecret();
  }

  const secret = Buffer.from(value, "base64url");
  if (
    secret.toString("base64url") !== value ||
    secret.byteLength < SHARE_AUDIT_HMAC_KEY_BYTES ||
    secret.byteLength > MAX_SHARE_AUDIT_HMAC_KEY_BYTES ||
    estimateByteEntropyBits(secret) < MIN_SHARE_AUDIT_HMAC_ESTIMATED_ENTROPY_BITS
  ) {
    secret.fill(0);
    throw invalidSecret();
  }

  return secret;
}

function generateAuditHmacSecret(): Buffer {
  let secret = randomBytes(SHARE_AUDIT_HMAC_KEY_BYTES);
  while (estimateByteEntropyBits(secret) < MIN_SHARE_AUDIT_HMAC_ESTIMATED_ENTROPY_BITS) {
    secret.fill(0);
    secret = randomBytes(SHARE_AUDIT_HMAC_KEY_BYTES);
  }
  return secret;
}

function estimateByteEntropyBits(bytes: Uint8Array): number {
  const counts = new Uint16Array(256);
  for (const byte of bytes) {
    counts[byte] = (counts[byte] ?? 0) + 1;
  }

  let bitsPerByte = 0;
  for (const count of counts) {
    if (count === 0) {
      continue;
    }
    const probability = count / bytes.byteLength;
    bitsPerByte -= probability * Math.log2(probability);
  }
  return bitsPerByte * bytes.byteLength;
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

function parseConfiguredInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
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
  const durationMs = Math.max(1_000, Math.floor(parsed));
  return Number.isSafeInteger(durationMs) ? durationMs : fallback;
}

function parseConfiguredDurationMs(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer number of milliseconds.`);
  }

  const durationMs = Number(value);
  if (!Number.isSafeInteger(durationMs) || durationMs < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return durationMs;
}

function validateShareDurationConfiguration(
  defaultTtlMs: number,
  maxTtlMs: number,
  retainExpiredMs: number
): void {
  if (defaultTtlMs > maxTtlMs) {
    throw new Error(
      "WEBBLACKBOX_SHARE_DEFAULT_TTL_MS must not exceed WEBBLACKBOX_SHARE_MAX_TTL_MS."
    );
  }

  const maximumExpiry = addSafeIntegers(Date.now(), maxTtlMs);
  const maximumRetentionDeadline =
    maximumExpiry === null ? null : addSafeIntegers(maximumExpiry, retainExpiredMs);
  if (maximumRetentionDeadline === null) {
    throw new Error(
      "The configured share TTL and expired-record retention exceed the safe timestamp range."
    );
  }
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
