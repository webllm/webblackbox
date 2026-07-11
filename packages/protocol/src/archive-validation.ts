import type {
  ChunkTimeIndexEntry,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent
} from "./types.js";

import {
  exportManifestSchema,
  hashesManifestSchema,
  invertedIndexSchema,
  privacyManifestSchema,
  requestIndexSchema,
  timeIndexSchema,
  webBlackboxEventSchema
} from "./schemas.js";

const REQUIRED_ARCHIVE_PATHS = [
  "manifest.json",
  "index/time.json",
  "index/req.json",
  "index/inv.json"
] as const;

const SUPPORTED_ARCHIVE_METADATA_PATHS = new Set([
  ...REQUIRED_ARCHIVE_PATHS,
  "integrity/hashes.json",
  "privacy/manifest.json"
]);

const PRIVATE_INDEX_PATHS = new Set([
  "index/time.json",
  "index/req.json",
  "index/inv.json",
  "privacy/manifest.json"
]);

const EVENT_PATH_PATTERN = /^events\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})\.ndjson$/;
const BLOB_PATH_PATTERN = /^blobs\/sha256-([a-f0-9]{64})\.(bin|html|json|mp4|png|webm|webp)$/;

type ParseResult<TValue> =
  | { success: true; data: TValue }
  | {
      success: false;
      error: {
        issues: Array<{
          path: PropertyKey[];
          message: string;
        }>;
      };
    };

type RuntimeSchema<TValue> = {
  safeParse(value: unknown): ParseResult<TValue>;
};

export type ArchiveLayoutInput = {
  paths: string[];
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  privacyManifest: PrivacyManifest | null;
};

export type ArchiveChunkValidationInput = {
  path: string;
  index: ChunkTimeIndexEntry;
  encodedByteLength: number;
  encodedSha256: string;
  events: WebBlackboxEvent[];
};

/** Parses a runtime value with the protocol archive manifest schema. */
export function parseExportManifest(value: unknown): ExportManifest {
  return parseWithSchema(exportManifestSchema, value, "manifest.json");
}

/** Parses a runtime value with the protocol integrity manifest schema. */
export function parseHashesManifest(value: unknown): HashesManifest {
  return parseWithSchema(hashesManifestSchema, value, "integrity/hashes.json");
}

/** Parses a runtime value with the protocol time-index schema. */
export function parseTimeIndex(value: unknown): ChunkTimeIndexEntry[] {
  return parseWithSchema(timeIndexSchema, value, "index/time.json");
}

/** Parses a runtime value with the protocol request-index schema. */
export function parseRequestIndex(value: unknown): RequestIndexEntry[] {
  return parseWithSchema(requestIndexSchema, value, "index/req.json");
}

/** Parses a runtime value with the protocol inverted-index schema. */
export function parseInvertedIndex(value: unknown): InvertedIndexEntry[] {
  return parseWithSchema(invertedIndexSchema, value, "index/inv.json");
}

/** Parses a runtime value with the protocol privacy-manifest schema. */
export function parsePrivacyManifest(value: unknown): PrivacyManifest {
  return parseWithSchema(privacyManifestSchema, value, "privacy/manifest.json");
}

/** Parses and validates a single archived protocol event. */
export function parseArchivedEvent(value: unknown, path: string, line: number): WebBlackboxEvent {
  return parseWithSchema(webBlackboxEventSchema, value, `${path} event line ${line}`);
}

/** Returns whether an archive path contains private session material. */
export function isPrivateArchivePath(path: string): boolean {
  return path.startsWith("events/") || path.startsWith("blobs/") || PRIVATE_INDEX_PATHS.has(path);
}

/**
 * Validates file/index/encryption invariants shared by archive readers.
 * This intentionally validates relationships that independent Zod schemas cannot express.
 */
export function assertArchiveLayout(input: ArchiveLayoutInput): void {
  const uniquePaths = new Set(input.paths);

  if (uniquePaths.size !== input.paths.length) {
    throw archiveError("archive contains duplicate file paths");
  }

  for (const requiredPath of REQUIRED_ARCHIVE_PATHS) {
    if (!uniquePaths.has(requiredPath)) {
      throw archiveError(`archive is missing required file '${requiredPath}'`);
    }
  }

  assertArchiveFilePaths(input.paths);

  assertEncryptionCoverage(input.manifest, input.paths);
  assertTimeIndexLayout(input.manifest, input.timeIndex, input.paths);
  assertSecondaryIndexes(input.requestIndex, input.invertedIndex);
  assertPrivacyConsistency(input.manifest, input.privacyManifest);

  const blobCount = assertArchiveBlobPaths(input.paths);

  if (input.manifest.stats.blobCount !== blobCount) {
    throw archiveError("manifest blob count does not match archive contents");
  }
}

/** Validates canonical blob names and returns the number of unique content digests. */
export function assertArchiveBlobPaths(paths: readonly string[]): number {
  const blobPaths = paths.filter((path) => path.startsWith("blobs/"));
  const blobHashes = new Set<string>();

  for (const path of blobPaths) {
    const match = BLOB_PATH_PATTERN.exec(path);
    const hash = match?.[1];
    if (!hash) {
      throw archiveError(`archive contains invalid blob path '${path}'`);
    }
    if (blobHashes.has(hash)) {
      throw archiveError(`archive contains duplicate blob hash '${hash}'`);
    }
    blobHashes.add(hash);
  }

  return blobPaths.length;
}

/** Rejects files outside the closed archive layout before any private entry must be decoded. */
export function assertArchiveFilePaths(paths: string[]): void {
  for (const path of paths) {
    if (path.startsWith("blobs/")) {
      if (!isCanonicalArchiveBlobPath(path)) {
        throw archiveError(`archive contains invalid blob path '${path}'`);
      }
      continue;
    }
    if (SUPPORTED_ARCHIVE_METADATA_PATHS.has(path) || EVENT_PATH_PATTERN.test(path)) {
      continue;
    }
    throw archiveError(`archive contains unsupported file '${path}'`);
  }
}

/** Returns whether a path uses the canonical archive blob namespace understood by readers. */
export function isCanonicalArchiveBlobPath(path: string): boolean {
  return BLOB_PATH_PATTERN.test(path);
}

/** Validates an already decoded event chunk against its signed time-index entry. */
export function assertArchiveChunk(input: ArchiveChunkValidationInput): void {
  const { index, events } = input;

  if (input.encodedByteLength !== index.byteLength) {
    throw archiveError(`chunk metadata byte length mismatch for '${input.path}'`);
  }

  if (input.encodedSha256 !== index.sha256) {
    throw archiveError(`chunk metadata digest mismatch for '${input.path}'`);
  }

  if (events.length !== index.eventCount) {
    throw archiveError(`chunk metadata event count mismatch for '${input.path}'`);
  }

  if (events.length === 0) {
    throw archiveError(`indexed event chunk '${input.path}' is empty`);
  }

  const first = events[0];
  const last = events[events.length - 1];

  if (
    !first ||
    !last ||
    first.t !== index.tStart ||
    last.t !== index.tEnd ||
    first.mono !== index.monoStart ||
    last.mono !== index.monoEnd
  ) {
    throw archiveError(`chunk time bounds do not match events for '${input.path}'`);
  }

  const eventIds = new Set<string>();
  let previousTime = Number.NEGATIVE_INFINITY;
  let previousMono = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw archiveError(`chunk '${input.path}' contains duplicate event ids`);
    }

    if (event.t < previousTime) {
      throw archiveError(`chunk '${input.path}' events are not in wall-clock order`);
    }

    if (event.mono < previousMono) {
      throw archiveError(`chunk '${input.path}' events are not in monotonic order`);
    }

    if (
      event.t < index.tStart ||
      event.t > index.tEnd ||
      event.mono < index.monoStart ||
      event.mono > index.monoEnd
    ) {
      throw archiveError(`chunk '${input.path}' contains an event outside its index bounds`);
    }

    eventIds.add(event.id);
    previousTime = event.t;
    previousMono = event.mono;
  }
}

/** Validates global event and secondary-index references after all chunks are decoded. */
export function assertArchiveEventIndexes(
  manifest: ExportManifest,
  events: WebBlackboxEvent[],
  requestIndex: RequestIndexEntry[],
  invertedIndex: InvertedIndexEntry[]
): void {
  if (events.length !== manifest.stats.eventCount) {
    throw archiveError("manifest event count does not match decoded events");
  }

  const eventIds = new Set<string>();
  let sessionId: string | null = null;

  for (const event of events) {
    if (eventIds.has(event.id)) {
      throw archiveError("archive contains duplicate event ids");
    }

    if (sessionId !== null && event.sid !== sessionId) {
      throw archiveError("archive event chunks contain multiple session ids");
    }

    sessionId ??= event.sid;
    eventIds.add(event.id);
  }

  for (const entry of [...requestIndex, ...invertedIndex]) {
    for (const eventId of entry.eventIds) {
      if (!eventIds.has(eventId)) {
        throw archiveError("archive index references an unknown event id");
      }
    }
  }
}

function assertEncryptionCoverage(manifest: ExportManifest, paths: string[]): void {
  const encryption = manifest.encryption;

  if (!encryption) {
    return;
  }

  const privatePaths = paths.filter(isPrivateArchivePath).sort();
  const privatePathSet = new Set(privatePaths);
  const mappedPaths = Object.keys(encryption.files).sort();

  for (const path of privatePaths) {
    if (!encryption.files[path]) {
      throw archiveError(`encrypted archive is missing file metadata for '${path}'`);
    }
  }

  for (const path of mappedPaths) {
    if (!privatePathSet.has(path)) {
      throw archiveError(`encrypted archive contains invalid file metadata for '${path}'`);
    }
  }

  const initializationVectors = new Set<string>();

  for (const path of mappedPaths) {
    const iv = encryption.files[path]?.ivBase64;

    if (!iv) {
      throw archiveError(`encrypted archive is missing an initialization vector for '${path}'`);
    }

    if (initializationVectors.has(iv)) {
      throw archiveError("encrypted archive reuses an initialization vector");
    }

    initializationVectors.add(iv);
  }
}

function assertTimeIndexLayout(
  manifest: ExportManifest,
  timeIndex: ChunkTimeIndexEntry[],
  paths: string[]
): void {
  const eventPaths = paths.filter((path) => path.startsWith("events/")).sort();
  const indexedPaths = new Set<string>();
  const chunkIds = new Set<string>();
  const sequences = new Set<number>();
  let previousSequence = 0;
  let previousTimeEnd = Number.NEGATIVE_INFINITY;
  let previousMonoEnd = Number.NEGATIVE_INFINITY;
  let indexedEventCount = 0;

  for (const entry of timeIndex) {
    const path = `events/${entry.chunkId}.ndjson`;

    if (!EVENT_PATH_PATTERN.test(path)) {
      throw archiveError("time index contains an invalid chunk id");
    }

    if (chunkIds.has(entry.chunkId) || sequences.has(entry.seq) || indexedPaths.has(path)) {
      throw archiveError("time index contains duplicate chunk ids or sequences");
    }

    if (entry.seq <= previousSequence) {
      throw archiveError("time index sequences are not strictly increasing");
    }

    if (entry.tStart < previousTimeEnd) {
      throw archiveError("time index wall-clock ranges move backwards between chunks");
    }

    if (entry.monoStart < previousMonoEnd) {
      throw archiveError("time index monotonic ranges move backwards between chunks");
    }

    chunkIds.add(entry.chunkId);
    sequences.add(entry.seq);
    indexedPaths.add(path);
    previousSequence = entry.seq;
    previousTimeEnd = entry.tEnd;
    previousMonoEnd = entry.monoEnd;
    indexedEventCount += entry.eventCount;
  }

  if (eventPaths.length !== indexedPaths.size) {
    throw archiveError("time index does not match archive event chunks");
  }

  for (const path of eventPaths) {
    if (!indexedPaths.has(path)) {
      throw archiveError(`time index is missing event chunk '${path}'`);
    }
  }

  if (manifest.stats.chunkCount !== timeIndex.length) {
    throw archiveError("manifest chunk count does not match time index");
  }

  if (manifest.stats.eventCount !== indexedEventCount) {
    throw archiveError("manifest event count does not match time index");
  }
}

function assertSecondaryIndexes(
  requestIndex: RequestIndexEntry[],
  invertedIndex: InvertedIndexEntry[]
): void {
  const requestIds = new Set<string>();
  const terms = new Set<string>();

  for (const entry of requestIndex) {
    if (requestIds.has(entry.reqId) || new Set(entry.eventIds).size !== entry.eventIds.length) {
      throw archiveError("request index contains duplicate ids or event references");
    }

    requestIds.add(entry.reqId);
  }

  for (const entry of invertedIndex) {
    const normalizedTerm = entry.term.toLowerCase();

    if (terms.has(normalizedTerm) || new Set(entry.eventIds).size !== entry.eventIds.length) {
      throw archiveError("inverted index contains duplicate terms or event references");
    }

    terms.add(normalizedTerm);
  }
}

function assertPrivacyConsistency(
  manifest: ExportManifest,
  privacyManifest: PrivacyManifest | null
): void {
  if (!privacyManifest) {
    return;
  }

  const encrypted = Boolean(manifest.encryption);

  if (
    privacyManifest.encryption.archive !== (encrypted ? "encrypted" : "plaintext") ||
    (privacyManifest.encryption.algorithm !== undefined) !== encrypted
  ) {
    throw archiveError("privacy manifest encryption state does not match archive manifest");
  }

  if (privacyManifest.transfer && privacyManifest.transfer.encrypted !== encrypted) {
    throw archiveError("privacy transfer encryption state does not match archive manifest");
  }

  if (
    privacyManifest.totals.events !== manifest.stats.eventCount ||
    privacyManifest.totals.blobs !== manifest.stats.blobCount
  ) {
    throw archiveError("privacy manifest totals do not match archive manifest");
  }

  const scanner = privacyManifest.scanner;
  if (
    (scanner.status === "passed" && scanner.findings.length > 0) ||
    (scanner.status === "blocked" && scanner.findings.length === 0)
  ) {
    throw archiveError("privacy scanner status does not match its findings");
  }

  const coverage = scanner.coverage;
  if (!coverage) {
    return;
  }
  const accountedBlobCount = coverage.scannedBlobCount + coverage.opaqueBlobCount;
  if (
    coverage.scannedEventCount > privacyManifest.totals.events ||
    accountedBlobCount > privacyManifest.totals.blobs
  ) {
    throw archiveError("privacy scanner coverage exceeds archive totals");
  }
  if (
    coverage.complete !== (coverage.incompleteReason === undefined) ||
    (coverage.complete &&
      (coverage.scannedEventCount !== privacyManifest.totals.events ||
        accountedBlobCount !== privacyManifest.totals.blobs))
  ) {
    throw archiveError("privacy scanner coverage is inconsistent with archive totals");
  }
}

function parseWithSchema<TValue>(
  schema: RuntimeSchema<TValue>,
  value: unknown,
  label: string
): TValue {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

  throw archiveError(`${label} failed schema validation${issues ? ` (${issues})` : ""}`);
}

function archiveError(message: string): Error {
  return new Error(`Invalid WebBlackbox archive: ${message}.`);
}
