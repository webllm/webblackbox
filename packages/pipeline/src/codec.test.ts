import { brotliCompressSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ArchiveDecompressionLimitError } from "@webblackbox/protocol";

import { decodeChunkBytes } from "./codec.js";

const PADDING = new Uint8Array(8 * 1024 * 1024);

describe("decodeChunkBytes", () => {
  it("stops a gzip chunk that decodes beyond the output limit", async () => {
    await expect(
      decodeChunkBytes(new Uint8Array(gzipSync(PADDING)), "gzip", 1024 * 1024)
    ).rejects.toBeInstanceOf(ArchiveDecompressionLimitError);
  });

  it("stops a brotli chunk that decodes beyond the output limit", async () => {
    await expect(
      decodeChunkBytes(new Uint8Array(brotliCompressSync(PADDING)), "br", 1024 * 1024)
    ).rejects.toBeInstanceOf(ArchiveDecompressionLimitError);
  });

  it("decodes chunks within the limit", async () => {
    const decoded = await decodeChunkBytes(
      new Uint8Array(gzipSync(PADDING)),
      "gzip",
      PADDING.byteLength
    );

    expect(decoded.byteLength).toBe(PADDING.byteLength);
  });
});
