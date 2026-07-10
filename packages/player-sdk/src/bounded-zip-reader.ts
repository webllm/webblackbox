import type JSZip from "jszip";

import {
  type ArchiveResourceLimits,
  ArchiveResourceLimitError
} from "./archive-resource-limits.js";
import { ArchiveDecodeTimeoutError } from "./bounded-stream-reader.js";

type JSZipWorker = {
  error?: (reason: Error) => boolean;
  resume?: () => boolean;
  isFinished?: boolean;
};

type JSZipStreamHelper = {
  _worker?: JSZipWorker;
  on(event: "data", callback: (data: Uint8Array) => void): JSZipStreamHelper;
  on(event: "error", callback: (error: Error) => void): JSZipStreamHelper;
  on(event: "end", callback: () => void): JSZipStreamHelper;
  pause(): JSZipStreamHelper;
  resume(): JSZipStreamHelper;
};

type JSZipObjectWithInternals = JSZip.JSZipObject & {
  internalStream?: (type: "uint8array") => JSZipStreamHelper;
  _data?: {
    compressedContent?: unknown;
  };
};

type EntryState = {
  bytes: number;
  metadata: boolean;
};

/** Reads JSZip entries with limits based on actual inflater output instead of declared ZIP sizes. */
export class BoundedZipReader {
  private readonly budget: ZipOutputBudget;

  private readonly reads = new Map<string, Promise<Uint8Array>>();

  public constructor(
    private readonly zip: JSZip,
    private readonly limits: Readonly<ArchiveResourceLimits>,
    private readonly cacheReads = true
  ) {
    this.budget = new ZipOutputBudget(limits);
  }

  public has(path: string): boolean {
    return Boolean(this.zip.file(path));
  }

  public read(path: string): Promise<Uint8Array> {
    const cached = this.reads.get(path);
    if (cached) {
      return cached;
    }

    const pending = this.readEntry(path);
    this.reads.set(path, pending);
    if (!this.cacheReads) {
      void pending.then(
        () => this.deleteRead(path, pending),
        () => this.deleteRead(path, pending)
      );
    }
    return pending;
  }

  /** Evicts a completed cached result after its caller no longer needs the inflated bytes. */
  public release(path: string): void {
    this.reads.delete(path);
  }

  private deleteRead(path: string, pending: Promise<Uint8Array>): void {
    if (this.reads.get(path) === pending) {
      this.reads.delete(path);
    }
  }

  private async readEntry(path: string): Promise<Uint8Array> {
    const file = this.zip.file(path) as JSZipObjectWithInternals | null;
    if (!file) {
      throw new Error(`Archive is missing required file: ${path}`);
    }
    if (typeof file.internalStream !== "function") {
      throw new Error("The installed JSZip runtime does not expose bounded entry streaming.");
    }

    const compressedBytes = readCompressedContentBytes(file);
    if (compressedBytes === null) {
      throw new Error(`Unable to determine compressed input size for archive entry '${path}'.`);
    }

    const helper = file.internalStream("uint8array");
    const accumulator = new ByteAccumulator(this.limits.maxEntryUncompressedBytes);
    const metadata = isArchiveMetadataPath(path);
    this.budget.begin(path, metadata);

    return new Promise<Uint8Array>((resolve, reject) => {
      let terminal = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clearTimer = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const stopWorker = (reason: Error) => {
        try {
          helper.pause();
        } catch {
          // Actual byte accounting already rejected the public promise; cleanup is best effort.
        }
        queueMicrotask(() => {
          try {
            const worker = helper._worker;
            if (typeof worker?.error !== "function" || typeof worker.resume !== "function") {
              return;
            }

            worker.error(reason);
            if (!worker.isFinished) {
              worker.resume();
            }
          } catch {
            // JSZip's private worker API is pinned and used only to release work after rejection.
          }
        });
      };
      const fail = (error: unknown, stop = true) => {
        if (terminal) {
          return;
        }

        terminal = true;
        clearTimer();
        this.budget.abort(path);
        const resolvedError = error instanceof Error ? error : new Error(String(error));
        if (stop) {
          stopWorker(resolvedError);
        }
        reject(resolvedError);
      };

      try {
        helper
          .on("data", (chunk) => {
            if (terminal) {
              return;
            }

            try {
              const nextBytes = accumulator.length + chunk.byteLength;
              this.budget.progress(path, compressedBytes, nextBytes);
              accumulator.append(chunk);
            } catch (error) {
              fail(error);
            }
          })
          .on("error", (error) => {
            fail(error, false);
          })
          .on("end", () => {
            if (terminal) {
              return;
            }

            try {
              this.budget.commit(path, compressedBytes, accumulator.length);
              terminal = true;
              clearTimer();
              resolve(accumulator.bytes());
            } catch (error) {
              fail(error, false);
            }
          });

        timer = setTimeout(() => {
          fail(new ArchiveDecodeTimeoutError(this.limits.decodeTimeoutMs, `ZIP entry '${path}'`));
        }, this.limits.decodeTimeoutMs);
        helper.resume();
      } catch (error) {
        fail(error, false);
      }
    });
  }
}

class ZipOutputBudget {
  private readonly committed = new Map<string, EntryState>();

  private readonly inFlight = new Map<string, EntryState>();

  private committedBytes = 0;

  private committedMetadataBytes = 0;

  public constructor(private readonly limits: Readonly<ArchiveResourceLimits>) {}

  public begin(path: string, metadata: boolean): void {
    if (!this.inFlight.has(path)) {
      this.inFlight.set(path, { bytes: 0, metadata });
    }
  }

  public progress(path: string, compressedBytes: number, actualBytes: number): void {
    const state = this.inFlight.get(path);
    if (!state) {
      throw new Error(`Archive ZIP budget was not initialized for '${path}'.`);
    }

    assertLimit(
      "maxEntryUncompressedBytes",
      actualBytes,
      this.limits.maxEntryUncompressedBytes,
      path
    );
    if (state.metadata) {
      assertLimit("maxMetadataEntryBytes", actualBytes, this.limits.maxMetadataEntryBytes, path);
    }
    assertLimit(
      "maxCompressionRatio",
      compressionRatio(actualBytes, compressedBytes),
      this.limits.maxCompressionRatio,
      path
    );

    const alreadyCommitted = this.committed.has(path);
    const otherInFlightBytes = sumUncommittedEntryBytes(this.inFlight, this.committed, path);
    assertLimit(
      "maxTotalUncompressedBytes",
      this.committedBytes + otherInFlightBytes + (alreadyCommitted ? 0 : actualBytes),
      this.limits.maxTotalUncompressedBytes
    );

    if (state.metadata) {
      const otherMetadataBytes = sumUncommittedMetadataBytes(this.inFlight, this.committed, path);
      assertLimit(
        "maxTotalMetadataBytes",
        this.committedMetadataBytes + otherMetadataBytes + (alreadyCommitted ? 0 : actualBytes),
        this.limits.maxTotalMetadataBytes
      );
    }

    state.bytes = actualBytes;
  }

  public commit(path: string, compressedBytes: number, actualBytes: number): void {
    this.progress(path, compressedBytes, actualBytes);
    const state = this.inFlight.get(path);
    this.inFlight.delete(path);

    if (!state || this.committed.has(path)) {
      return;
    }

    this.committed.set(path, { ...state });
    this.committedBytes += state.bytes;
    if (state.metadata) {
      this.committedMetadataBytes += state.bytes;
    }
  }

  public abort(path: string): void {
    this.inFlight.delete(path);
  }
}

class ByteAccumulator {
  private output = new Uint8Array(0);

  public length = 0;

  public constructor(private readonly maxBytes: number) {}

  public append(chunk: Uint8Array): void {
    const nextLength = this.length + chunk.byteLength;
    if (nextLength > this.output.byteLength) {
      const nextCapacity = Math.min(
        this.maxBytes,
        Math.max(nextLength, Math.max(1, this.output.byteLength) * 2)
      );
      const grown = new Uint8Array(nextCapacity);
      grown.set(this.output.subarray(0, this.length));
      this.output = grown;
    }

    this.output.set(chunk, this.length);
    this.length = nextLength;
  }

  public bytes(): Uint8Array {
    return this.output.byteLength === this.length ? this.output : this.output.slice(0, this.length);
  }
}

function readCompressedContentBytes(file: JSZipObjectWithInternals): number | null {
  const content = file._data?.compressedContent;
  if (typeof content === "string" || Array.isArray(content)) {
    return content.length;
  }
  if (
    content instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && content instanceof SharedArrayBuffer)
  ) {
    return content.byteLength;
  }
  if (ArrayBuffer.isView(content)) {
    return content.byteLength;
  }
  return null;
}

function isArchiveMetadataPath(path: string): boolean {
  return (
    path === "manifest.json" ||
    path === "integrity/hashes.json" ||
    path.startsWith("index/") ||
    path === "privacy/manifest.json"
  );
}

function sumUncommittedEntryBytes(
  entries: Map<string, EntryState>,
  committed: Map<string, EntryState>,
  currentPath: string
): number {
  let total = 0;
  for (const [path, entry] of entries) {
    if (path === currentPath || committed.has(path)) {
      continue;
    }
    total += entry.bytes;
  }
  return total;
}

function sumUncommittedMetadataBytes(
  entries: Map<string, EntryState>,
  committed: Map<string, EntryState>,
  currentPath: string
): number {
  let total = 0;
  for (const [path, entry] of entries) {
    if (path !== currentPath && !committed.has(path) && entry.metadata) {
      total += entry.bytes;
    }
  }
  return total;
}

function compressionRatio(uncompressedBytes: number, compressedBytes: number): number {
  if (uncompressedBytes === 0) {
    return 0;
  }
  return compressedBytes === 0 ? Number.POSITIVE_INFINITY : uncompressedBytes / compressedBytes;
}

function assertLimit(
  resource: keyof ArchiveResourceLimits,
  actual: number,
  limit: number,
  detail?: string
): void {
  if (!Number.isFinite(actual) || actual > limit) {
    throw new ArchiveResourceLimitError(resource, limit, actual, detail);
  }
}
