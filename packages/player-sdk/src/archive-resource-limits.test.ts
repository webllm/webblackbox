import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  ArchiveDecodeBudget,
  ArchiveResourceLimitError,
  assertArchiveInputResourceLimits,
  assertLoadedArchiveResourceLimits,
  resolveArchiveResourceLimits
} from "./archive-resource-limits.js";

describe("archive resource limits", () => {
  it("accepts exact input and entry-size boundaries", async () => {
    const zip = new JSZip();
    zip.file("payload.bin", new Uint8Array(1024));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const loaded = await JSZip.loadAsync(bytes);
    const limits = resolveArchiveResourceLimits({
      maxInputBytes: bytes.byteLength,
      maxEntryCount: 1,
      maxEntryUncompressedBytes: 1024,
      maxTotalUncompressedBytes: 1024,
      maxCompressionRatio: 1
    });

    expect(() => assertArchiveInputResourceLimits(bytes, limits)).not.toThrow();
    expect(() => assertLoadedArchiveResourceLimits(loaded, limits)).not.toThrow();
    expect(() =>
      assertLoadedArchiveResourceLimits(
        loaded,
        resolveArchiveResourceLimits({ maxEntryUncompressedBytes: 1023 })
      )
    ).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxEntryUncompressedBytes",
        actual: 1024
      })
    );
  });

  it("rejects entry floods from the end-of-central-directory record before loading", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) {
      zip.file(`entry-${index}.txt`, "");
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const bytesWithTrailingData = new Uint8Array(bytes.byteLength + 1);
    bytesWithTrailingData.set(bytes);
    const limits = resolveArchiveResourceLimits({ maxEntryCount: 5 });

    expect(() => assertArchiveInputResourceLimits(bytesWithTrailingData, limits)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxEntryCount",
        actual: 6
      })
    );
  });

  it("rejects high compression ratios without inflating an entry", async () => {
    const zip = new JSZip();
    zip.file("repetitive.txt", "a".repeat(512 * 1024));
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
    const loaded = await JSZip.loadAsync(bytes);
    const limits = resolveArchiveResourceLimits({ maxCompressionRatio: 10 });

    expect(() => assertLoadedArchiveResourceLimits(loaded, limits)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxCompressionRatio"
      })
    );
  });

  it("enforces cumulative expanded bytes and decoded event counts", async () => {
    const zip = new JSZip();
    zip.file("left.bin", new Uint8Array(800));
    zip.file("right.bin", new Uint8Array(800));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    const loaded = await JSZip.loadAsync(bytes);
    const limits = resolveArchiveResourceLimits({
      maxTotalUncompressedBytes: 1500,
      maxEventCount: 2
    });

    expect(() => assertLoadedArchiveResourceLimits(loaded, limits)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxTotalUncompressedBytes"
      })
    );

    const budget = new ArchiveDecodeBudget(limits);
    budget.commitEvents("events/one.ndjson", 2);
    expect(() => budget.commitEvents("events/two.ndjson", 1)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxEventCount",
        actual: 3
      })
    );

    const decodedBudget = new ArchiveDecodeBudget(
      resolveArchiveResourceLimits({
        maxChunkDecodedBytes: 10,
        maxTotalDecodedBytes: 15,
        maxCompressionRatio: 10
      })
    );
    decodedBudget.commitDecoded("events/one.ndjson", 10, 10);
    decodedBudget.commitDecoded("events/two.ndjson", 5, 5);
    expect(() => decodedBudget.commitDecoded("events/three.ndjson", 1, 1)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxTotalDecodedBytes",
        actual: 16
      })
    );

    const indexBudget = new ArchiveDecodeBudget(
      resolveArchiveResourceLimits({ maxIndexRecords: 2, maxIndexEventReferences: 3 })
    );
    indexBudget.commitIndex("index/req.json", 1, 2);
    expect(() => indexBudget.commitIndex("index/inv.json", 2, 2)).toThrowError(
      expect.objectContaining<Partial<ArchiveResourceLimitError>>({
        resource: "maxIndexRecords",
        actual: 3
      })
    );
  });

  it("allows callers to tighten but not relax safety ceilings", () => {
    expect(resolveArchiveResourceLimits({ maxInputBytes: 1024 }).maxInputBytes).toBe(1024);
    expect(() => resolveArchiveResourceLimits({ maxInputBytes: Number.MAX_SAFE_INTEGER })).toThrow(
      /may only tighten/i
    );
    expect(() => resolveArchiveResourceLimits({ maxCompressionRatio: 0.5 })).toThrow(/at least 1/i);
  });
});
