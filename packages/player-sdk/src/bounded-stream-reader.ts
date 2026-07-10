/** Raised when a codec stream does not complete within the configured open budget. */
export class ArchiveDecodeTimeoutError extends Error {
  public override readonly name = "ArchiveDecodeTimeoutError";

  public constructor(
    public readonly timeoutMs: number,
    detail: string
  ) {
    super(`Archive decode timed out after ${timeoutMs}ms (${detail}).`);
  }
}

/** Reads a web stream while validating growth and always cancels it on timeout or failure. */
export async function readBoundedReadableStream(
  stream: ReadableStream<Uint8Array>,
  options: {
    timeoutMs: number;
    detail: string;
    maxBytes: number;
    validateTotalBytes: (totalBytes: number) => void;
  }
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const accumulator = new StreamByteAccumulator(options.maxBytes);
  let totalBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Promise<void> | undefined;
  const timeoutError = new ArchiveDecodeTimeoutError(options.timeoutMs, options.detail);
  const cancel = (reason: unknown) => {
    cancellation ??= cancelReader(reader, reason);
    return cancellation;
  };

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      options.validateTotalBytes(totalBytes);
      accumulator.append(chunk);
    }

    return accumulator.bytes();
  })();
  const timeoutPromise = new Promise<Uint8Array>((_, reject) => {
    timer = setTimeout(() => {
      void cancel(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } catch (error) {
    void cancel(error);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class StreamByteAccumulator {
  private output = new Uint8Array(0);

  private length = 0;

  public constructor(private readonly maxBytes: number) {}

  public append(chunk: Uint8Array): void {
    const nextLength = this.length + chunk.byteLength;
    if (nextLength > this.maxBytes) {
      throw new Error(`Bounded stream exceeded its allocation ceiling (${this.maxBytes} bytes).`);
    }

    if (nextLength > this.output.byteLength) {
      const grownCapacity = Math.max(
        nextLength,
        Math.ceil(Math.max(1, this.output.byteLength) * 1.5)
      );
      const grown = new Uint8Array(Math.min(this.maxBytes, grownCapacity));
      grown.set(this.output.subarray(0, this.length));
      this.output = grown;
    }

    this.output.set(chunk, this.length);
    this.length = nextLength;
  }

  public bytes(): Uint8Array {
    return this.output.subarray(0, this.length);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // The original timeout/resource error is more useful than a secondary cancellation failure.
  }
}
