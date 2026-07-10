import { DEFAULT_ARCHIVE_RESOURCE_LIMITS } from "@webblackbox/player-sdk";

export const MAX_PLAYER_ARCHIVE_INPUT_BYTES = DEFAULT_ARCHIVE_RESOURCE_LIMITS.maxInputBytes;

export class ArchiveInputLimitError extends Error {
  public override readonly name = "ArchiveInputLimitError";

  public constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number
  ) {
    super(`Archive input exceeds the Player limit (${actualBytes} > ${maxBytes} bytes).`);
  }
}

type ArchiveBlobInput = Pick<Blob, "size" | "arrayBuffer">;

type ArchiveByteChunk = Uint8Array<ArrayBufferLike>;

type ArchiveResponseInput = {
  body: ReadableStream<ArchiveByteChunk> | null;
  headers: Pick<Headers, "get">;
};

export async function readArchiveBlobBounded(
  input: ArchiveBlobInput,
  maxBytes = MAX_PLAYER_ARCHIVE_INPUT_BYTES
): Promise<Uint8Array> {
  assertMaxBytes(maxBytes);
  assertObservedBytes(input.size, maxBytes, "Blob size");

  const bytes = new Uint8Array(await input.arrayBuffer());
  assertObservedBytes(bytes.byteLength, maxBytes, "Blob contents");
  if (bytes.byteLength !== input.size) {
    throw new Error(
      `Archive Blob size changed while being read (${bytes.byteLength} bytes read; expected ${input.size}).`
    );
  }
  return bytes;
}

export async function readArchiveResponseBounded(
  response: ArchiveResponseInput,
  maxBytes = MAX_PLAYER_ARCHIVE_INPUT_BYTES
): Promise<Uint8Array> {
  assertMaxBytes(maxBytes);
  const body = response.body;
  let declaredBytes: number | null;
  try {
    declaredBytes = parseContentLength(response.headers.get("content-length"), maxBytes);
  } catch (error) {
    if (body) {
      await cancelStream(body, error);
    }
    throw error;
  }
  if (!body) {
    throw new Error("Archive response has no readable body.");
  }

  const reader = body.getReader();
  const accumulator = new BoundedByteAccumulator(maxBytes, declaredBytes);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Archive response stream produced a non-byte chunk.");
      }
      accumulator.append(value);
    }

    return accumulator.finish();
  } catch (error) {
    await cancelReader(reader, error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null, maxBytes: number): number | null {
  if (value === null) {
    return null;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Archive response has an invalid Content-Length header: ${value}`);
  }

  const declaredBytes = Number(value);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw new Error(`Archive response has an invalid Content-Length header: ${value}`);
  }
  if (declaredBytes > maxBytes) {
    throw new ArchiveInputLimitError(declaredBytes, maxBytes);
  }
  return declaredBytes;
}

class BoundedByteAccumulator {
  private output: Uint8Array;

  private length = 0;

  public constructor(
    private readonly maxBytes: number,
    private readonly declaredBytes: number | null
  ) {
    this.output = new Uint8Array(0);
  }

  public append(chunk: ArchiveByteChunk): void {
    const nextLength = this.length + chunk.byteLength;
    if (!Number.isSafeInteger(nextLength) || nextLength > this.maxBytes) {
      throw new ArchiveInputLimitError(nextLength, this.maxBytes);
    }
    if (this.declaredBytes !== null && nextLength > this.declaredBytes) {
      throw new Error(
        `Archive response exceeded its Content-Length (${nextLength} > ${this.declaredBytes} bytes).`
      );
    }

    if (nextLength > this.output.byteLength) {
      const grownCapacity = Math.min(
        this.maxBytes,
        Math.max(nextLength, Math.ceil(Math.max(1, this.output.byteLength) * 1.5))
      );
      const grown = new Uint8Array(grownCapacity);
      grown.set(this.output.subarray(0, this.length));
      this.output = grown;
    }

    this.output.set(chunk, this.length);
    this.length = nextLength;
  }

  public finish(): Uint8Array {
    if (this.declaredBytes !== null && this.length !== this.declaredBytes) {
      throw new Error(
        `Archive response Content-Length mismatch (${this.length} bytes read; expected ${this.declaredBytes}).`
      );
    }
    return this.output.byteLength === this.length ? this.output : this.output.slice(0, this.length);
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Archive input limit must be a positive safe integer.");
  }
}

function assertObservedBytes(actualBytes: number, maxBytes: number, detail: string): void {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    throw new Error(`Archive ${detail} is not a valid byte length.`);
  }
  if (actualBytes > maxBytes) {
    throw new ArchiveInputLimitError(actualBytes, maxBytes);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<ArchiveByteChunk>,
  reason: unknown
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Preserve the original validation or stream failure.
  }
}

async function cancelStream(
  stream: ReadableStream<ArchiveByteChunk>,
  reason: unknown
): Promise<void> {
  try {
    await stream.cancel(reason);
  } catch {
    // Preserve the Content-Length validation failure.
  }
}
