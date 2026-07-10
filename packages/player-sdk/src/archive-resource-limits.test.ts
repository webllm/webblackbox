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

  it("rejects duplicate or normalization-ambiguous physical ZIP entry names", async () => {
    const duplicateZip = new JSZip();
    duplicateZip.file("entry-one.json", "first");
    duplicateZip.file("entry-two.json", "second");
    const duplicateBytes = await duplicateZip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });
    expect(replaceAsciiInPlace(duplicateBytes, "entry-two.json", "entry-one.json")).toBe(2);

    expect(() =>
      assertArchiveInputResourceLimits(duplicateBytes, resolveArchiveResourceLimits())
    ).toThrow(/duplicate ZIP entry 'entry-one\.json'/i);

    const ambiguousZip = new JSZip();
    ambiguousZip.file("safe/../manifest.json", "{}");
    const ambiguousBytes = await ambiguousZip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });

    expect(() =>
      assertArchiveInputResourceLimits(ambiguousBytes, resolveArchiveResourceLimits())
    ).toThrow(/non-canonical ZIP entry name/i);
  });

  it("rejects Unicode Path overrides before JSZip can collapse logical entry names", async () => {
    const zip = new JSZip();
    zip.file("logical-one-😀", "first");
    zip.file("logical-two-😀", "second");
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "STORE",
      encodeFileName(name) {
        if (name === "logical-one-😀") {
          return "entry-one.json";
        }
        if (name === "logical-two-😀") {
          return "entry-two.json";
        }
        return name;
      }
    });
    expect(replaceUtf8InPlace(bytes, "logical-two-😀", "logical-one-😀")).toBe(2);

    const loaded = await JSZip.loadAsync(bytes);
    expect(Object.keys(loaded.files)).toEqual(["logical-one-😀"]);
    await expect(loaded.file("logical-one-😀")?.async("string")).resolves.toBe("second");
    expect(() => assertArchiveInputResourceLimits(bytes, resolveArchiveResourceLimits())).toThrow(
      /Unicode Path ZIP extra fields/i
    );
  });

  it("rejects local filename and Unicode-extra differences from the central directory", async () => {
    const mismatchedZip = new JSZip();
    mismatchedZip.file("safe-name.json", "payload");
    const mismatchedBytes = await mismatchedZip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });
    replaceZipHeaderFileName(mismatchedBytes, 0x04034b50, "safe-name.json", "evil-name.json");

    const loaded = await JSZip.loadAsync(mismatchedBytes);
    expect(Object.keys(loaded.files)).toEqual(["evil-name.json"]);
    expect(() =>
      assertArchiveInputResourceLimits(mismatchedBytes, resolveArchiveResourceLimits())
    ).toThrow(/local and central ZIP filenames differ/i);

    const localUnicodeZip = new JSZip();
    localUnicodeZip.file("logical-only-😀", "payload");
    const localUnicodeBytes = await localUnicodeZip.generateAsync({
      type: "uint8array",
      compression: "STORE",
      encodeFileName(name) {
        return name === "logical-only-😀" ? "safe-name.json" : name;
      }
    });
    replaceZipExtraFieldId(localUnicodeBytes, 0x02014b50, "safe-name.json", 0x7075, 0x7076);
    expect(() =>
      assertArchiveInputResourceLimits(localUnicodeBytes, resolveArchiveResourceLimits())
    ).toThrow(/Unicode Path ZIP extra fields.*local file header/i);
  });

  it("rejects malformed central and local ZIP extra-field bounds", async () => {
    const centralZip = new JSZip();
    centralZip.file("central.bin", "payload", { comment: "abc" });
    const centralBytes = await centralZip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });
    moveCentralCommentIntoMalformedExtraField(centralBytes, "central.bin");
    expect(() =>
      assertArchiveInputResourceLimits(centralBytes, resolveArchiveResourceLimits())
    ).toThrow(/malformed ZIP extra fields.*central directory/i);

    const localZip = new JSZip();
    localZip.file("local.bin", "payload");
    const localBytes = await localZip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });
    forgeLocalExtraLength(localBytes, "local.bin", 0xffff);
    expect(() =>
      assertArchiveInputResourceLimits(localBytes, resolveArchiveResourceLimits())
    ).toThrow(/malformed local ZIP header/i);
  });

  it("resolves ZIP64 local offsets with prepended archive bytes", async () => {
    const zip = new JSZip();
    zip.file("payload.bin", "payload");
    const generated = await zip.generateAsync({
      type: "uint8array",
      compression: "STORE"
    });
    const zip64 = promoteCentralLocalHeaderOffsetToZip64(generated, "payload.bin");
    const prepended = new Uint8Array(zip64.byteLength + 128);
    prepended.fill(0x41, 0, 128);
    prepended.set(zip64, 128);

    await expect(JSZip.loadAsync(prepended)).resolves.toBeInstanceOf(JSZip);
    expect(() =>
      assertArchiveInputResourceLimits(prepended, resolveArchiveResourceLimits())
    ).not.toThrow();
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

function replaceAsciiInPlace(bytes: Uint8Array, search: string, replacement: string): number {
  return replaceUtf8InPlace(bytes, search, replacement);
}

function replaceUtf8InPlace(bytes: Uint8Array, search: string, replacement: string): number {
  const searchBytes = new TextEncoder().encode(search);
  const replacementBytes = new TextEncoder().encode(replacement);
  if (searchBytes.byteLength !== replacementBytes.byteLength) {
    throw new Error("ZIP test replacement names must have the same byte length.");
  }

  let replacements = 0;
  for (let offset = 0; offset <= bytes.byteLength - searchBytes.byteLength; offset += 1) {
    let matches = true;
    for (let index = 0; index < searchBytes.byteLength; index += 1) {
      if (bytes[offset + index] !== searchBytes[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }

    bytes.set(replacementBytes, offset);
    replacements += 1;
    offset += searchBytes.byteLength - 1;
  }

  return replacements;
}

function replaceZipHeaderFileName(
  bytes: Uint8Array,
  signature: number,
  search: string,
  replacement: string
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const replacementBytes = encoder.encode(replacement);

  for (let offset = 0; offset + 30 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== signature) {
      continue;
    }

    const local = signature === 0x04034b50;
    const fileNameBytes = view.getUint16(offset + (local ? 26 : 28), true);
    const fileNameOffset = offset + (local ? 30 : 46);
    if (decoder.decode(bytes.subarray(fileNameOffset, fileNameOffset + fileNameBytes)) !== search) {
      continue;
    }
    if (replacementBytes.byteLength !== fileNameBytes) {
      throw new Error("ZIP test replacement names must have the same byte length.");
    }

    bytes.set(replacementBytes, fileNameOffset);
    return;
  }

  throw new Error(`ZIP test header was not found for '${search}'.`);
}

function replaceZipExtraFieldId(
  bytes: Uint8Array,
  signature: number,
  targetName: string,
  searchId: number,
  replacementId: number
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== signature) {
      continue;
    }

    const fileNameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const fileNameOffset = offset + 46;
    if (
      decoder.decode(bytes.subarray(fileNameOffset, fileNameOffset + fileNameBytes)) !== targetName
    ) {
      continue;
    }

    let extraOffset = fileNameOffset + fileNameBytes;
    const extraEnd = extraOffset + extraBytes;
    while (extraOffset + 4 <= extraEnd) {
      const fieldId = view.getUint16(extraOffset, true);
      const fieldBytes = view.getUint16(extraOffset + 2, true);
      if (fieldId === searchId) {
        view.setUint16(extraOffset, replacementId, true);
        return;
      }
      extraOffset += 4 + fieldBytes;
    }
  }

  throw new Error(`ZIP test extra field ${searchId} was not found for '${targetName}'.`);
}

function moveCentralCommentIntoMalformedExtraField(bytes: Uint8Array, targetName: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }
    const fileNameBytes = view.getUint16(offset + 28, true);
    const fileNameOffset = offset + 46;
    if (
      decoder.decode(bytes.subarray(fileNameOffset, fileNameOffset + fileNameBytes)) !== targetName
    ) {
      continue;
    }

    const commentBytes = view.getUint16(offset + 32, true);
    if (commentBytes < 1 || view.getUint16(offset + 30, true) !== 0) {
      throw new Error("ZIP test requires a comment and no existing central extra fields.");
    }
    view.setUint16(offset + 30, commentBytes, true);
    view.setUint16(offset + 32, 0, true);
    return;
  }

  throw new Error(`ZIP test central entry was not found for '${targetName}'.`);
}

function forgeLocalExtraLength(bytes: Uint8Array, targetName: string, extraBytes: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  for (let offset = 0; offset + 30 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      continue;
    }
    const fileNameBytes = view.getUint16(offset + 26, true);
    const fileNameOffset = offset + 30;
    if (
      decoder.decode(bytes.subarray(fileNameOffset, fileNameOffset + fileNameBytes)) === targetName
    ) {
      view.setUint16(offset + 28, extraBytes, true);
      return;
    }
  }

  throw new Error(`ZIP test local entry was not found for '${targetName}'.`);
}

function promoteCentralLocalHeaderOffsetToZip64(bytes: Uint8Array, targetName: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const eocdOffset = findEocdOffset(view);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralEnd = centralOffset + centralBytes;
  const records: Uint8Array[] = [];
  let matched = false;

  for (let offset = centralOffset; offset < centralEnd; ) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP test central directory is malformed.");
    }
    const fileNameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const fileNameOffset = offset + 46;
    const extraOffset = fileNameOffset + fileNameBytes;
    const commentOffset = extraOffset + extraBytes;
    const nextOffset = commentOffset + commentBytes;
    const record = bytes.slice(offset, nextOffset);

    if (decoder.decode(bytes.subarray(fileNameOffset, extraOffset)) === targetName) {
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const zip64Extra = new Uint8Array(12);
      const zip64View = new DataView(zip64Extra.buffer);
      zip64View.setUint16(0, 0x0001, true);
      zip64View.setUint16(2, 8, true);
      zip64View.setBigUint64(4, BigInt(localHeaderOffset), true);

      const expanded = new Uint8Array(record.byteLength + zip64Extra.byteLength);
      const insertionOffset = 46 + fileNameBytes + extraBytes;
      expanded.set(record.subarray(0, insertionOffset));
      expanded.set(zip64Extra, insertionOffset);
      expanded.set(record.subarray(insertionOffset), insertionOffset + zip64Extra.byteLength);
      const expandedView = new DataView(expanded.buffer);
      expandedView.setUint16(30, extraBytes + zip64Extra.byteLength, true);
      expandedView.setUint32(42, 0xffffffff, true);
      records.push(expanded);
      matched = true;
    } else {
      records.push(record);
    }

    offset = nextOffset;
  }

  if (!matched) {
    throw new Error(`ZIP test central entry was not found for '${targetName}'.`);
  }

  const expandedCentralBytes = records.reduce((total, record) => total + record.byteLength, 0);
  const output = new Uint8Array(
    centralOffset + expandedCentralBytes + (bytes.byteLength - eocdOffset)
  );
  output.set(bytes.subarray(0, centralOffset));
  let outputOffset = centralOffset;
  for (const record of records) {
    output.set(record, outputOffset);
    outputOffset += record.byteLength;
  }
  output.set(bytes.subarray(eocdOffset), outputOffset);
  new DataView(output.buffer).setUint32(outputOffset + 12, expandedCentralBytes, true);
  return output;
}

function findEocdOffset(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP test end-of-central-directory record was not found.");
}
