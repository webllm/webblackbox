/** Minimal shape of a zip entry needed to budget decompression. */
export type ArchiveZipEntryLike = {
  dir?: boolean;
  _data?: {
    uncompressedSize?: unknown;
  };
};

export type ArchiveDecompressionLimits = {
  /** Largest decompressed size accepted for a single archive entry. */
  maxEntryBytes: number;
  /** Largest decompressed size accepted across every archive entry. */
  maxTotalBytes: number;
};

export const DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS: ArchiveDecompressionLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
};

/** Raised when an archive would decompress beyond the accepted budget. */
export class ArchiveDecompressionLimitError extends Error {}

/**
 * Rejects archives that would decompress far beyond the accepted budget.
 *
 * The budget is checked against the central directory before any entry is
 * inflated, so a small hostile archive cannot exhaust memory just by being
 * opened. Readers should pair this with `archiveEntrySizeMatches` after
 * inflating, because the declared sizes are attacker-controlled.
 */
export function assertArchiveDecompressionLimits(
  files: Record<string, ArchiveZipEntryLike>,
  limits: Partial<ArchiveDecompressionLimits> = {}
): void {
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS.maxEntryBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS.maxTotalBytes;
  let total = 0;

  for (const [path, file] of Object.entries(files)) {
    if (file.dir) {
      continue;
    }

    const size = declaredUncompressedSize(file);

    if (size === null) {
      continue;
    }

    if (size > maxEntryBytes) {
      throw new ArchiveDecompressionLimitError(
        `Archive entry ${path} decompresses to ${size} bytes, above the ${maxEntryBytes} byte limit.`
      );
    }

    total += size;

    if (total > maxTotalBytes) {
      throw new ArchiveDecompressionLimitError(
        `Archive decompresses to more than the ${maxTotalBytes} byte limit.`
      );
    }
  }
}

/** Reports whether inflated bytes match the size the central directory declared. */
export function archiveEntrySizeMatches(file: ArchiveZipEntryLike, actualBytes: number): boolean {
  const size = declaredUncompressedSize(file);
  return size === null || size === actualBytes;
}

function declaredUncompressedSize(file: ArchiveZipEntryLike): number | null {
  const size = file._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}
