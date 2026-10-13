import type { ChunkCodec, WebBlackboxEvent } from "@webblackbox/protocol";

import { ArchiveDecompressionLimitError } from "@webblackbox/protocol";

type NodeZlibOptions = {
  maxOutputLength?: number;
};

type NodeZlibLike = {
  gzipSync?: (input: Uint8Array) => Uint8Array;
  gunzipSync?: (input: Uint8Array, options?: NodeZlibOptions) => Uint8Array;
  brotliCompressSync?: (input: Uint8Array) => Uint8Array;
  brotliDecompressSync?: (input: Uint8Array, options?: NodeZlibOptions) => Uint8Array;
  zstdCompressSync?: (input: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (input: Uint8Array, options?: NodeZlibOptions) => Uint8Array;
};

const warnedFallbackCodecs = new Set<ChunkCodec>();
const STREAM_CODEC_TIMEOUT_MS = 5_000;

export function encodeEventsNdjson(events: WebBlackboxEvent[]): Uint8Array {
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  return new TextEncoder().encode(lines);
}

export function decodeEventsNdjson(input: string | Uint8Array): WebBlackboxEvent[] {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);

  if (!text.trim()) {
    return [];
  }

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WebBlackboxEvent);
}

export async function encodeChunkEvents(
  events: WebBlackboxEvent[],
  codec: ChunkCodec
): Promise<{
  bytes: Uint8Array;
  codec: ChunkCodec;
}> {
  const encoded = encodeEventsNdjson(events);
  return encodeChunkBytes(encoded, codec);
}

export async function decodeChunkEvents(
  input: Uint8Array,
  codec: ChunkCodec,
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<WebBlackboxEvent[]> {
  const bytes = await decodeChunkBytes(input, codec, maxOutputBytes);
  return decodeEventsNdjson(bytes);
}

export async function encodeChunkBytes(
  input: Uint8Array,
  codec: ChunkCodec
): Promise<{
  bytes: Uint8Array;
  codec: ChunkCodec;
}> {
  if (codec === "none") {
    return {
      bytes: cloneBytes(input),
      codec: "none"
    };
  }

  const compressed = await tryCompress(codec, input);

  if (compressed) {
    return {
      bytes: compressed,
      codec
    };
  }

  warnCodecFallback(codec);

  return {
    bytes: cloneBytes(input),
    codec: "none"
  };
}

/**
 * Decodes one chunk's codec layer. `maxOutputBytes` stops a decompression
 * bomb as it inflates; archive readers pass their remaining budget, while
 * local storage reads leave it unbounded.
 */
export async function decodeChunkBytes(
  input: Uint8Array,
  codec: ChunkCodec,
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<Uint8Array> {
  const decoded =
    codec === "none" ? cloneBytes(input) : await tryDecompress(codec, input, maxOutputBytes);

  if (!decoded) {
    throw new Error(`Chunk codec '${codec}' is not supported in this runtime.`);
  }

  if (decoded.byteLength > maxOutputBytes) {
    throw chunkDecodeLimitError(maxOutputBytes);
  }

  return decoded;
}

async function tryCompress(codec: ChunkCodec, input: Uint8Array): Promise<Uint8Array | null> {
  const webStreamsOutput = await tryWithWebStreams(codec, input, "compress");

  if (webStreamsOutput) {
    return webStreamsOutput;
  }

  return tryWithNodeZlib(codec, input, "compress");
}

async function tryDecompress(
  codec: ChunkCodec,
  input: Uint8Array,
  maxOutputBytes: number
): Promise<Uint8Array | null> {
  const webStreamsOutput = await tryWithWebStreams(codec, input, "decompress", maxOutputBytes);

  if (webStreamsOutput) {
    return webStreamsOutput;
  }

  return tryWithNodeZlib(codec, input, "decompress", maxOutputBytes);
}

async function tryWithWebStreams(
  codec: ChunkCodec,
  input: Uint8Array,
  mode: "compress" | "decompress",
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<Uint8Array | null> {
  const compressionCtor = globalThis.CompressionStream;
  const decompressionCtor = globalThis.DecompressionStream;

  if (
    (mode === "compress" && typeof compressionCtor === "undefined") ||
    (mode === "decompress" && typeof decompressionCtor === "undefined") ||
    typeof Blob === "undefined"
  ) {
    return null;
  }

  for (const format of codecFormats(codec)) {
    try {
      const transform =
        mode === "compress"
          ? new CompressionStream(format as CompressionFormat)
          : new DecompressionStream(format as CompressionFormat);
      const output = new Blob([toArrayBuffer(input)]).stream().pipeThrough(transform);
      return await readReadableStreamWithTimeout(output, mode, codec, format, maxOutputBytes);
    } catch (error) {
      if (error instanceof ArchiveDecompressionLimitError) {
        throw error;
      }

      continue;
    }
  }

  return null;
}

async function readReadableStream(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalLength += bytes.byteLength;

    if (totalLength > maxOutputBytes) {
      void reader.cancel().catch(() => undefined);
      throw chunkDecodeLimitError(maxOutputBytes);
    }

    chunks.push(bytes);
  }

  const output = new Uint8Array(totalLength);
  let cursor = 0;

  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return output;
}

async function readReadableStreamWithTimeout(
  stream: ReadableStream<Uint8Array>,
  mode: "compress" | "decompress",
  codec: ChunkCodec,
  format: string,
  maxOutputBytes: number
): Promise<Uint8Array> {
  return withTimeout(
    readReadableStream(stream, maxOutputBytes),
    STREAM_CODEC_TIMEOUT_MS,
    `Chunk codec '${codec}' ${mode} timed out for format '${format}'.`
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function tryWithNodeZlib(
  codec: ChunkCodec,
  input: Uint8Array,
  mode: "compress" | "decompress",
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<Uint8Array | null> {
  const zlib = await loadNodeZlib();

  if (!zlib) {
    return null;
  }

  const options: NodeZlibOptions | undefined =
    mode === "decompress" && Number.isFinite(maxOutputBytes)
      ? { maxOutputLength: Math.max(1, Math.floor(maxOutputBytes)) }
      : undefined;

  try {
    if (codec === "gzip") {
      const fn = mode === "compress" ? zlib.gzipSync : zlib.gunzipSync;
      return typeof fn === "function" ? cloneBytes(fn(input, options)) : null;
    }

    if (codec === "br") {
      const fn = mode === "compress" ? zlib.brotliCompressSync : zlib.brotliDecompressSync;
      return typeof fn === "function" ? cloneBytes(fn(input, options)) : null;
    }

    if (codec === "zst") {
      const fn = mode === "compress" ? zlib.zstdCompressSync : zlib.zstdDecompressSync;
      return typeof fn === "function" ? cloneBytes(fn(input, options)) : null;
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw chunkDecodeLimitError(maxOutputBytes);
    }

    return null;
  }

  return null;
}

async function loadNodeZlib(): Promise<NodeZlibLike | null> {
  if (
    typeof process === "undefined" ||
    typeof process.versions !== "object" ||
    typeof process.versions?.node !== "string"
  ) {
    return null;
  }

  try {
    const module = await import("node:zlib");
    return module as unknown as NodeZlibLike;
  } catch {
    return null;
  }
}

function codecFormats(codec: ChunkCodec): string[] {
  if (codec === "gzip") {
    return ["gzip"];
  }

  if (codec === "br") {
    return ["brotli", "br"];
  }

  if (codec === "zst") {
    return ["zstd", "zst"];
  }

  return [];
}

function chunkDecodeLimitError(maxOutputBytes: number): ArchiveDecompressionLimitError {
  return new ArchiveDecompressionLimitError(
    `Event chunk decodes to more than the ${maxOutputBytes} byte limit.`
  );
}

function warnCodecFallback(codec: ChunkCodec): void {
  if (warnedFallbackCodecs.has(codec)) {
    return;
  }

  warnedFallbackCodecs.add(codec);
  console.warn(`[WebBlackbox] chunk codec '${codec}' is unavailable; falling back to 'none'.`);
}

function cloneBytes(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  output.set(input);
  return output;
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(input.byteLength);
  output.set(input);
  return output.buffer;
}
