/** Archive path holding the per-file hash manifest. */
export const ARCHIVE_INTEGRITY_PATH = "integrity/hashes.json";

/**
 * Reports whether an archive path carries captured session content.
 *
 * Every private path must be encrypted in an encrypted archive; see
 * `assertEncryptedArchiveCoverage`.
 */
export function isPrivateArchivePath(path: string): boolean {
  return (
    path.startsWith("events/") ||
    path.startsWith("blobs/") ||
    path === "index/time.json" ||
    path === "index/req.json" ||
    path === "index/inv.json" ||
    path === "privacy/manifest.json"
  );
}

/**
 * Rejects an encrypted archive whose layout would let unencrypted content in.
 *
 * Readers hand back any entry missing from the encryption map unchanged, so
 * the map must cover the integrity manifest and every private path. A
 * plaintext hash list could be rewritten without the passphrase to match
 * removed or injected entries, and an unlisted private entry would be trusted
 * as session content.
 */
export function assertEncryptedArchiveCoverage(
  files: Record<string, ArchiveZipEntryLike>,
  encryptedFiles: Record<string, unknown>
): void {
  if (!Object.hasOwn(encryptedFiles, ARCHIVE_INTEGRITY_PATH)) {
    throw new Error(
      `Encrypted archive stores ${ARCHIVE_INTEGRITY_PATH} unencrypted, so it cannot be verified. ` +
        "It was written by an older exporter or has been tampered with."
    );
  }

  for (const [path, file] of Object.entries(files)) {
    if (file.dir || !isPrivateArchivePath(path)) {
      continue;
    }

    if (!Object.hasOwn(encryptedFiles, path)) {
      throw new Error(`Encrypted archive contains unencrypted content at ${path}.`);
    }
  }
}

/** Incremental reader JSZip returns from `ZipObject.internalStream`. */
export type ArchiveEntryStream = {
  on(event: "data", callback: (chunk: Uint8Array) => void): ArchiveEntryStream;
  on(event: "error", callback: (error: Error) => void): ArchiveEntryStream;
  on(event: "end", callback: () => void): ArchiveEntryStream;
  pause(): ArchiveEntryStream;
  resume(): ArchiveEntryStream;
};

/** Minimal shape of a zip entry needed to budget and inflate it. */
export type ArchiveZipEntryLike = {
  dir?: boolean;
  _data?: {
    uncompressedSize?: unknown;
  };
  internalStream?: (type: "uint8array") => ArchiveEntryStream;
};

export type ArchiveDecompressionLimits = {
  /**
   * Largest decompressed size accepted for a single archive entry, and for a
   * single event chunk once its chunk codec is decoded.
   */
  maxEntryBytes: number;
  /**
   * Largest decompressed size accepted across every archive entry, and across
   * every decoded event chunk.
   */
  maxTotalBytes: number;
};

export const DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS: ArchiveDecompressionLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
};

/** Raised when an archive would decompress beyond the accepted budget. */
export class ArchiveDecompressionLimitError extends Error {}

/** Fills in the default for any limit the caller left out. */
export function resolveArchiveDecompressionLimits(
  limits: Partial<ArchiveDecompressionLimits> = {}
): ArchiveDecompressionLimits {
  return {
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS.maxEntryBytes,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_ARCHIVE_DECOMPRESSION_LIMITS.maxTotalBytes
  };
}

/**
 * Rejects archives that would decompress far beyond the accepted budget.
 *
 * The budget is checked against the central directory before any entry is
 * inflated, so a small hostile archive cannot exhaust memory just by being
 * opened. The declared sizes are attacker-controlled, so readers must inflate
 * entries through `readArchiveEntryBytes`, which holds each one to its
 * declared size.
 */
export function assertArchiveDecompressionLimits(
  files: Record<string, ArchiveZipEntryLike>,
  limits: Partial<ArchiveDecompressionLimits> = {}
): void {
  const { maxEntryBytes, maxTotalBytes } = resolveArchiveDecompressionLimits(limits);
  let total = 0;

  for (const [path, file] of Object.entries(files)) {
    if (file.dir) {
      continue;
    }

    const size = declaredUncompressedSize(file);

    if (size === null) {
      throw new ArchiveDecompressionLimitError(
        `Archive entry ${path} does not declare its decompressed size.`
      );
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

/**
 * Inflates one archive entry, stopping as soon as it outgrows the size its
 * central directory record declared.
 *
 * JSZip only compares the inflated size with the declared one after the whole
 * entry is in memory, so a forged small size would otherwise let one entry
 * inflate without bound despite `assertArchiveDecompressionLimits`.
 */
export function readArchiveEntryBytes(
  path: string,
  file: ArchiveZipEntryLike
): Promise<Uint8Array> {
  const declaredSize = declaredUncompressedSize(file);

  if (declaredSize === null) {
    return Promise.reject(
      new ArchiveDecompressionLimitError(
        `Archive entry ${path} does not declare its decompressed size.`
      )
    );
  }

  if (typeof file.internalStream !== "function") {
    return Promise.reject(new Error(`Archive entry ${path} cannot be read incrementally.`));
  }

  const stream = file.internalStream("uint8array");

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;

    stream
      .on("data", (chunk) => {
        if (settled) {
          return;
        }

        received += chunk.byteLength;

        if (received > declaredSize) {
          settled = true;
          stream.pause();
          reject(
            new ArchiveDecompressionLimitError(
              `Archive entry ${path} inflates beyond its declared ${declaredSize} bytes.`
            )
          );
          return;
        }

        chunks.push(chunk);
      })
      .on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      })
      .on("end", () => {
        if (!settled) {
          settled = true;
          resolve(concatBytes(chunks, received));
        }
      })
      .resume();
  });
}

function declaredUncompressedSize(file: ArchiveZipEntryLike): number | null {
  const size = file._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

// Always copies: a stored entry's chunks can be views into the whole archive
// buffer, and callers expect a standalone array as file.async() returned.
function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const output = new Uint8Array(totalLength);
  let cursor = 0;

  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return output;
}
