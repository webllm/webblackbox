import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits
} from "./archive-resource-limits.js";
import { BoundedZipReader } from "./bounded-zip-reader.js";

describe("BoundedZipReader", () => {
  it("counts actual inflater output when declared uncompressed sizes are forged", async () => {
    const zip = new JSZip();
    zip.file("bomb.bin", "x".repeat(2 * 1024 * 1024));
    zip.file("safe.txt", "safe");
    const source = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
    forgeZipUncompressedSize(source, "bomb.bin", 1);

    const loaded = await JSZip.loadAsync(source);
    const limits = resolveArchiveResourceLimits({
      maxEntryUncompressedBytes: 1024 * 1024,
      maxTotalUncompressedBytes: 2 * 1024 * 1024
    });
    expect(() => assertLoadedArchiveResourceLimits(loaded, limits)).not.toThrow();

    const reader = new BoundedZipReader(loaded, limits);
    await expect(reader.read("bomb.bin")).rejects.toMatchObject({
      name: "ArchiveResourceLimitError",
      resource: "maxEntryUncompressedBytes"
    });
    await expect(reader.read("safe.txt")).resolves.toEqual(new TextEncoder().encode("safe"));
  });

  it("accepts a legitimate highly compressible first-party-sized entry by default", async () => {
    const zip = new JSZip();
    zip.file("blobs/sha256-repeat.bin", new Uint8Array(1024 * 1024));
    const source = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
    const loaded = await JSZip.loadAsync(source);
    const limits = resolveArchiveResourceLimits();
    const reader = new BoundedZipReader(loaded, limits);

    await expect(reader.read("blobs/sha256-repeat.bin")).resolves.toHaveLength(1024 * 1024);
  });

  it("accounts concurrent distinct entries against one aggregate output budget", async () => {
    const zip = new JSZip();
    zip.file("left.bin", new Uint8Array(2 * 1024 * 1024));
    zip.file("right.bin", new Uint8Array(2 * 1024 * 1024));
    const source = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const loaded = await JSZip.loadAsync(source);
    const limits = resolveArchiveResourceLimits({
      maxEntryUncompressedBytes: 3 * 1024 * 1024,
      maxTotalUncompressedBytes: 3 * 1024 * 1024
    });
    const reader = new BoundedZipReader(loaded, limits, true);

    const results = await Promise.allSettled([reader.read("left.bin"), reader.read("right.bin")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ resource: "maxTotalUncompressedBytes" })
      })
    ]);
  });

  it("memoizes concurrent and subsequent reads of the same entry", async () => {
    const zip = new JSZip();
    zip.file("once.bin", new Uint8Array(256 * 1024));
    const source = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const loaded = await JSZip.loadAsync(source);
    const file = loaded.file("once.bin") as JSZip.JSZipObject & {
      internalStream: (type: "uint8array") => unknown;
    };
    const internalStream = vi.spyOn(file, "internalStream");
    const reader = new BoundedZipReader(loaded, resolveArchiveResourceLimits(), true);

    const [first, second, third] = await Promise.all([
      reader.read("once.bin"),
      reader.read("once.bin"),
      reader.read("once.bin")
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(internalStream).toHaveBeenCalledOnce();
  });

  it("deduplicates only in-flight reads when completed-result caching is disabled", async () => {
    const zip = new JSZip();
    zip.file("once.bin", new Uint8Array(256 * 1024));
    const source = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const loaded = await JSZip.loadAsync(source);
    const file = loaded.file("once.bin") as JSZip.JSZipObject & {
      internalStream: (type: "uint8array") => unknown;
    };
    const internalStream = vi.spyOn(file, "internalStream");
    const reader = new BoundedZipReader(loaded, resolveArchiveResourceLimits(), false);

    await Promise.all([reader.read("once.bin"), reader.read("once.bin")]);
    expect(internalStream).toHaveBeenCalledOnce();
    await reader.read("once.bin");
    expect(internalStream).toHaveBeenCalledTimes(2);
  });

  it("counts physical central-directory records even when EOCD under-reports them", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) {
      zip.file(`entry-${index}.txt`, "");
    }
    const source = await zip.generateAsync({ type: "uint8array" });
    forgeEocdEntryCount(source, 1);

    expect(() =>
      assertArchiveInputResourceLimits(source, resolveArchiveResourceLimits({ maxEntryCount: 5 }))
    ).toThrowError(expect.objectContaining({ resource: "maxEntryCount", actual: 6 }));
  });

  it("counts prepended archives using the physical central-directory location", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) {
      zip.file(`entry-${index}.txt`, "");
    }
    const generated = await zip.generateAsync({ type: "uint8array" });
    forgeEocdEntryCount(generated, 1);
    const source = new Uint8Array(generated.byteLength + 128);
    source.fill(0x41, 0, 128);
    source.set(generated, 128);

    expect(() =>
      assertArchiveInputResourceLimits(source, resolveArchiveResourceLimits({ maxEntryCount: 5 }))
    ).toThrowError(expect.objectContaining({ resource: "maxEntryCount", actual: 6 }));
  });

  it("fails closed before JSZip when trailing data hides the ZIP directory record", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) {
      zip.file(`entry-${index}.txt`, "");
    }
    const generated = await zip.generateAsync({ type: "uint8array" });
    forgeEocdEntryCount(generated, 1);
    const source = new Uint8Array(generated.byteLength + 70 * 1024);
    source.set(generated);

    await expect(JSZip.loadAsync(source)).resolves.toBeInstanceOf(JSZip);
    expect(() =>
      assertArchiveInputResourceLimits(source, resolveArchiveResourceLimits({ maxEntryCount: 5 }))
    ).toThrow(/end-of-central-directory.*supported trailing-data window/i);
  });
});

function forgeZipUncompressedSize(bytes: Uint8Array, targetName: string, size: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      const nameBytes = view.getUint16(offset + 26, true);
      const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameBytes));
      if (name === targetName) {
        view.setUint32(offset + 22, size, true);
      }
    }
    if (signature === 0x02014b50) {
      const nameBytes = view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
      if (name === targetName) {
        view.setUint32(offset + 24, size, true);
      }
    }
  }
}

function forgeEocdEntryCount(bytes: Uint8Array, count: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) {
      continue;
    }

    view.setUint16(offset + 8, count, true);
    view.setUint16(offset + 10, count, true);
    return;
  }

  throw new Error("Fixture ZIP is missing EOCD.");
}
