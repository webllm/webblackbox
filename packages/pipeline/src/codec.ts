import type { ChunkCodec, WebBlackboxEvent } from "@webblackbox/protocol";

type NodeZlibLike = {
  gzipSync?: (input: Uint8Array) => Uint8Array;
  gunzipSync?: (input: Uint8Array) => Uint8Array;
  brotliCompressSync?: (input: Uint8Array) => Uint8Array;
  brotliDecompressSync?: (input: Uint8Array) => Uint8Array;
  zstdCompressSync?: (input: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
};

const warnedFallbackCodecs = new Set<ChunkCodec>();

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
  codec: ChunkCodec
): Promise<WebBlackboxEvent[]> {
  const bytes = await decodeChunkBytes(input, codec);
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

export async function decodeChunkBytes(input: Uint8Array, codec: ChunkCodec): Promise<Uint8Array> {
  if (codec === "none") {
    return cloneBytes(input);
  }

  const decompressed = await tryDecompress(codec, input);

  if (!decompressed) {
    throw new Error(`Chunk codec '${codec}' is not supported in this runtime.`);
  }

  return decompressed;
}

async function tryCompress(codec: ChunkCodec, input: Uint8Array): Promise<Uint8Array | null> {
  const webStreamsOutput = await tryWithWebStreams(codec, input, "compress");

  if (webStreamsOutput) {
    return webStreamsOutput;
  }

  return tryWithNodeZlib(codec, input, "compress");
}

async function tryDecompress(codec: ChunkCodec, input: Uint8Array): Promise<Uint8Array | null> {
  const webStreamsOutput = await tryWithWebStreams(codec, input, "decompress");

  if (webStreamsOutput) {
    return webStreamsOutput;
  }

  return tryWithNodeZlib(codec, input, "decompress");
}

async function tryWithWebStreams(
  codec: ChunkCodec,
  input: Uint8Array,
  mode: "compress" | "decompress"
): Promise<Uint8Array | null> {
  const compressionCtor = globalThis.CompressionStream;
  const decompressionCtor = globalThis.DecompressionStream;

  if (
    (mode === "compress" && typeof compressionCtor === "undefined") ||
    (mode === "decompress" && typeof decompressionCtor === "undefined")
  ) {
    return null;
  }

  for (const format of codecFormats(codec)) {
    try {
      const stream =
        mode === "compress"
          ? new CompressionStream(format as CompressionFormat)
          : new DecompressionStream(format as CompressionFormat);
      const writer = stream.writable.getWriter();
      await writer.write(toArrayBuffer(input));
      await writer.close();
      return await readReadableStream(stream.readable);
    } catch {
      continue;
    }
  }

  return null;
}

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
    chunks.push(bytes);
    totalLength += bytes.byteLength;
  }

  const output = new Uint8Array(totalLength);
  let cursor = 0;

  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return output;
}

async function tryWithNodeZlib(
  codec: ChunkCodec,
  input: Uint8Array,
  mode: "compress" | "decompress"
): Promise<Uint8Array | null> {
  const zlib = await loadNodeZlib();

  if (!zlib) {
    return null;
  }

  try {
    if (codec === "gzip") {
      const fn = mode === "compress" ? zlib.gzipSync : zlib.gunzipSync;
      return typeof fn === "function" ? cloneBytes(fn(input)) : null;
    }

    if (codec === "br") {
      const fn = mode === "compress" ? zlib.brotliCompressSync : zlib.brotliDecompressSync;
      return typeof fn === "function" ? cloneBytes(fn(input)) : null;
    }

    if (codec === "zst") {
      const fn = mode === "compress" ? zlib.zstdCompressSync : zlib.zstdDecompressSync;
      return typeof fn === "function" ? cloneBytes(fn(input)) : null;
    }
  } catch {
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
