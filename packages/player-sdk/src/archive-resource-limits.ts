import type JSZip from "jszip";

const MEBIBYTE = 1024 * 1024;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

/** Resource limits applied before and while an archive is opened. Overrides may only tighten them. */
export type ArchiveResourceLimits = {
  maxInputBytes: number;
  maxEntryCount: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxMetadataEntryBytes: number;
  maxTotalMetadataBytes: number;
  maxCompressionRatio: number;
  maxEventCount: number;
  maxIndexRecords: number;
  maxIndexEventReferences: number;
  maxChunkDecodedBytes: number;
  maxTotalDecodedBytes: number;
  decodeTimeoutMs: number;
};

/** Safe upper bounds used by archive consumers unless a caller supplies tighter values. */
export const DEFAULT_ARCHIVE_RESOURCE_LIMITS: Readonly<ArchiveResourceLimits> = Object.freeze({
  maxInputBytes: 256 * MEBIBYTE,
  maxEntryCount: 10_000,
  maxEntryUncompressedBytes: 128 * MEBIBYTE,
  maxTotalUncompressedBytes: 256 * MEBIBYTE,
  maxMetadataEntryBytes: 8 * MEBIBYTE,
  maxTotalMetadataBytes: 24 * MEBIBYTE,
  maxCompressionRatio: 10_000,
  maxEventCount: 1_000_000,
  maxIndexRecords: 500_000,
  maxIndexEventReferences: 2_000_000,
  maxChunkDecodedBytes: 32 * MEBIBYTE,
  maxTotalDecodedBytes: 64 * MEBIBYTE,
  decodeTimeoutMs: 5_000
});

export type ArchiveResourceName = keyof ArchiveResourceLimits;

/** Raised when an archive would exceed a configured resource limit. */
export class ArchiveResourceLimitError extends Error {
  public override readonly name = "ArchiveResourceLimitError";

  public constructor(
    public readonly resource: ArchiveResourceName,
    public readonly limit: number,
    public readonly actual: number,
    detail?: string
  ) {
    super(
      `Archive resource limit exceeded for ${resource}: ${formatNumber(actual)} > ${formatNumber(
        limit
      )}${detail ? ` (${detail})` : ""}.`
    );
  }
}

/** Resolves caller overrides and rejects attempts to weaken the built-in safety ceiling. */
export function resolveArchiveResourceLimits(
  overrides: Partial<ArchiveResourceLimits> = {}
): ArchiveResourceLimits {
  const resolved = { ...DEFAULT_ARCHIVE_RESOURCE_LIMITS };

  for (const resource of Object.keys(DEFAULT_ARCHIVE_RESOURCE_LIMITS) as ArchiveResourceName[]) {
    const value = overrides[resource];

    if (value === undefined) {
      continue;
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`Archive resource limit '${resource}' must be a positive finite number.`);
    }

    if (resource !== "maxCompressionRatio" && !Number.isSafeInteger(value)) {
      throw new TypeError(`Archive resource limit '${resource}' must be a safe integer.`);
    }

    if (resource === "maxCompressionRatio" && value < 1) {
      throw new TypeError("Archive resource limit 'maxCompressionRatio' must be at least 1.");
    }

    const safeMaximum = DEFAULT_ARCHIVE_RESOURCE_LIMITS[resource];
    if (value > safeMaximum) {
      throw new TypeError(
        `Archive resource limit '${resource}' may only tighten the safe default (${safeMaximum}).`
      );
    }

    resolved[resource] = value;
  }

  return resolved;
}

/** Performs checks available from the ZIP bytes before JSZip constructs its entry table. */
export function assertArchiveInputResourceLimits(
  bytes: Uint8Array,
  limits: Readonly<ArchiveResourceLimits>
): void {
  assertWithinLimit("maxInputBytes", bytes.byteLength, limits.maxInputBytes);

  const declaredEntryCount = readDeclaredZipEntryCount(bytes);
  if (declaredEntryCount === null) {
    throw new Error(
      "Invalid WebBlackbox archive: ZIP end-of-central-directory record is missing or outside the supported trailing-data window."
    );
  }

  assertWithinLimit("maxEntryCount", declaredEntryCount, limits.maxEntryCount);
}

/** Uses declared central-directory sizes for early rejection; actual output is checked on read. */
export function assertLoadedArchiveResourceLimits(
  zip: JSZip,
  limits: Readonly<ArchiveResourceLimits>
): void {
  const entries = Object.values(zip.files);
  assertWithinLimit("maxEntryCount", entries.length, limits.maxEntryCount);

  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if (entry.dir) {
      continue;
    }

    const sizes = readZipEntrySizes(entry);
    if (!sizes) {
      throw new ArchiveResourceLimitError(
        "maxEntryUncompressedBytes",
        limits.maxEntryUncompressedBytes,
        Number.POSITIVE_INFINITY,
        `missing declared size metadata for '${entry.name}'`
      );
    }

    assertWithinLimit(
      "maxEntryUncompressedBytes",
      sizes.uncompressedSize,
      limits.maxEntryUncompressedBytes,
      entry.name
    );

    totalUncompressedBytes = addWithoutOverflow(totalUncompressedBytes, sizes.uncompressedSize);
    assertWithinLimit(
      "maxTotalUncompressedBytes",
      totalUncompressedBytes,
      limits.maxTotalUncompressedBytes
    );

    const ratio = compressionRatio(sizes.uncompressedSize, sizes.compressedSize);
    assertWithinLimit("maxCompressionRatio", ratio, limits.maxCompressionRatio, entry.name);
  }
}

/** Tracks nested event-codec output and parsed event counts across one open operation. */
export class ArchiveDecodeBudget {
  private totalDecodedBytes = 0;

  private totalEvents = 0;

  private totalIndexRecords = 0;

  private totalIndexEventReferences = 0;

  public constructor(public readonly limits: Readonly<ArchiveResourceLimits>) {}

  public assertDecodedSize(path: string, compressedBytes: number, decodedBytes: number): void {
    assertWithinLimit("maxChunkDecodedBytes", decodedBytes, this.limits.maxChunkDecodedBytes, path);
    assertWithinLimit(
      "maxCompressionRatio",
      compressionRatio(decodedBytes, compressedBytes),
      this.limits.maxCompressionRatio,
      path
    );
    assertWithinLimit(
      "maxTotalDecodedBytes",
      addWithoutOverflow(this.totalDecodedBytes, decodedBytes),
      this.limits.maxTotalDecodedBytes
    );
  }

  public commitDecoded(path: string, compressedBytes: number, decodedBytes: number): void {
    this.assertDecodedSize(path, compressedBytes, decodedBytes);
    this.totalDecodedBytes += decodedBytes;
  }

  public commitEvents(path: string, count: number): void {
    const nextTotal = addWithoutOverflow(this.totalEvents, count);
    assertWithinLimit("maxEventCount", nextTotal, this.limits.maxEventCount, path);
    this.totalEvents = nextTotal;
  }

  public commitIndex(path: string, records: number, eventReferences: number): void {
    const nextRecords = addWithoutOverflow(this.totalIndexRecords, records);
    assertWithinLimit("maxIndexRecords", nextRecords, this.limits.maxIndexRecords, path);
    const nextReferences = addWithoutOverflow(this.totalIndexEventReferences, eventReferences);
    assertWithinLimit(
      "maxIndexEventReferences",
      nextReferences,
      this.limits.maxIndexEventReferences,
      path
    );
    this.totalIndexRecords = nextRecords;
    this.totalIndexEventReferences = nextReferences;
  }
}

function assertWithinLimit(
  resource: ArchiveResourceName,
  actual: number,
  limit: number,
  detail?: string
): void {
  if (!Number.isFinite(actual) || actual > limit) {
    throw new ArchiveResourceLimitError(resource, limit, actual, detail);
  }
}

function readZipEntrySizes(
  entry: JSZip.JSZipObject
): { compressedSize: number; uncompressedSize: number } | null {
  // JSZip 3.x intentionally omits this loadAsync metadata from its public typings. Fail closed if
  // a future implementation stops exposing the central-directory sizes before decompression.
  const data = (
    entry as JSZip.JSZipObject & {
      _data?: { compressedSize?: unknown; uncompressedSize?: unknown };
    }
  )._data;
  const compressedSize = data?.compressedSize;
  const uncompressedSize = data?.uncompressedSize;

  if (
    typeof compressedSize !== "number" ||
    !Number.isSafeInteger(compressedSize) ||
    compressedSize < 0 ||
    typeof uncompressedSize !== "number" ||
    !Number.isSafeInteger(uncompressedSize) ||
    uncompressedSize < 0
  ) {
    return null;
  }

  return { compressedSize, uncompressedSize };
}

function compressionRatio(uncompressedBytes: number, compressedBytes: number): number {
  if (uncompressedBytes === 0) {
    return 0;
  }

  if (compressedBytes === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return uncompressedBytes / compressedBytes;
}

function addWithoutOverflow(left: number, right: number): number {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.POSITIVE_INFINITY;
}

function readDeclaredZipEntryCount(bytes: Uint8Array): number | null {
  if (bytes.byteLength < ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(
    0,
    bytes.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES - ZIP_MAX_COMMENT_BYTES
  );

  for (
    let offset = bytes.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES;
    offset >= searchStart;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES + commentBytes > bytes.byteLength) {
      continue;
    }

    const entryCount = view.getUint16(offset + 10, true);
    if (entryCount !== 0xffff) {
      const centralDirectoryBytes = view.getUint32(offset + 12, true);
      const centralDirectoryOffset = view.getUint32(offset + 16, true);
      if (centralDirectoryOffset + centralDirectoryBytes > offset) {
        continue;
      }

      const physicalEntryCount = countPhysicalCentralDirectoryEntries(
        view,
        offset - centralDirectoryBytes,
        offset
      );
      return physicalEntryCount === null
        ? Number.POSITIVE_INFINITY
        : Math.max(entryCount, physicalEntryCount);
    }

    const zip64 = readZip64CentralDirectory(view, offset);
    if (!zip64) {
      return Number.POSITIVE_INFINITY;
    }

    const physicalEntryCount = countPhysicalCentralDirectoryEntries(
      view,
      zip64.recordOffset - zip64.centralDirectoryBytes,
      zip64.recordOffset
    );
    return physicalEntryCount === null
      ? Number.POSITIVE_INFINITY
      : Math.max(zip64.entryCount, physicalEntryCount);
  }

  return null;
}

function countPhysicalCentralDirectoryEntries(
  view: DataView,
  centralDirectoryOffset: number,
  centralDirectoryEnd: number
): number | null {
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > view.byteLength) {
    return null;
  }

  let count = 0;
  let offset = centralDirectoryOffset;
  const names = new Set<string>();

  while (offset < centralDirectoryEnd) {
    if (offset + 4 > centralDirectoryEnd) {
      return null;
    }

    const signature = view.getUint32(offset, true);
    if (signature === ZIP_CENTRAL_DIRECTORY_DIGITAL_SIGNATURE) {
      if (offset + 6 > centralDirectoryEnd) {
        return null;
      }
      offset += 6 + view.getUint16(offset + 4, true);
      continue;
    }
    if (signature !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE || offset + 46 > centralDirectoryEnd) {
      return null;
    }

    const fileNameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const fileNameOffset = offset + 46;
    const nextOffset = fileNameOffset + fileNameBytes + extraBytes + commentBytes;
    if (nextOffset > centralDirectoryEnd) {
      return null;
    }

    const fileName = readCanonicalArchiveEntryName(view, fileNameOffset, fileNameBytes);
    if (names.has(fileName)) {
      throw new Error(`Invalid WebBlackbox archive: duplicate ZIP entry '${fileName}'.`);
    }
    names.add(fileName);

    offset = nextOffset;
    count += 1;
  }

  return offset === centralDirectoryEnd ? count : null;
}

function readCanonicalArchiveEntryName(
  view: DataView,
  fileNameOffset: number,
  fileNameBytes: number
): string {
  if (fileNameBytes === 0) {
    throw new Error("Invalid WebBlackbox archive: ZIP entries must have a name.");
  }

  let name = "";
  for (let index = 0; index < fileNameBytes; index += 1) {
    const byte = view.getUint8(fileNameOffset + index);
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error(
        "Invalid WebBlackbox archive: ZIP entry names must use canonical printable ASCII."
      );
    }
    name += String.fromCharCode(byte);
  }

  if (name.includes("\\") || name.startsWith("/") || name.includes("//")) {
    throw new Error(`Invalid WebBlackbox archive: non-canonical ZIP entry name '${name}'.`);
  }

  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = path.split("/");
  if (
    path.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid WebBlackbox archive: non-canonical ZIP entry name '${name}'.`);
  }

  return name;
}

function readZip64CentralDirectory(
  view: DataView,
  eocdOffset: number
): {
  entryCount: number;
  centralDirectoryBytes: number;
  recordOffset: number;
} | null {
  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset < 0 ||
    view.getUint32(locatorOffset, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
  ) {
    return null;
  }

  const zip64OffsetBigInt = view.getBigUint64(locatorOffset + 8, true);
  if (zip64OffsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      entryCount: Number.POSITIVE_INFINITY,
      centralDirectoryBytes: Number.POSITIVE_INFINITY,
      recordOffset: 0
    };
  }

  const zip64Offset = Number(zip64OffsetBigInt);
  if (
    zip64Offset < 0 ||
    zip64Offset + 56 > view.byteLength ||
    view.getUint32(zip64Offset, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
  ) {
    return null;
  }

  const entryCount = view.getBigUint64(zip64Offset + 32, true);
  const centralDirectoryBytes = view.getBigUint64(zip64Offset + 40, true);
  if (
    entryCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    centralDirectoryBytes > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return {
      entryCount: Number.POSITIVE_INFINITY,
      centralDirectoryBytes: Number.POSITIVE_INFINITY,
      recordOffset: zip64Offset
    };
  }

  return {
    entryCount: Number(entryCount),
    centralDirectoryBytes: Number(centralDirectoryBytes),
    recordOffset: zip64Offset
  };
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : "unbounded";
}
