import JSZip from "jszip";

import type {
  ChunkTimeIndexEntry,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { decodeEventsNdjson } from "./codec.js";
import { sha256Hex } from "./hash.js";
import type { StoredBlob, StoredChunk } from "./storage.js";

export type ExportBundleInput = {
  manifest: ExportManifest;
  chunks: StoredChunk[];
  blobs: StoredBlob[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
};

export type ExportBundleOutput = {
  bytes: Uint8Array;
  integrity: HashesManifest;
};

export async function createWebBlackboxArchive(
  input: ExportBundleInput
): Promise<ExportBundleOutput> {
  const zip = new JSZip();
  const fileHashes: Record<string, string> = {};

  await addJsonFile(zip, "manifest.json", input.manifest, fileHashes);

  for (const chunk of input.chunks) {
    const path = `events/${chunk.meta.chunkId}.ndjson`;
    zip.file(path, chunk.bytes);
    fileHashes[path] = await sha256Hex(chunk.bytes);
  }

  await addJsonFile(zip, "index/time.json", input.timeIndex, fileHashes);
  await addJsonFile(zip, "index/req.json", input.requestIndex, fileHashes);
  await addJsonFile(zip, "index/inv.json", input.invertedIndex, fileHashes);

  for (const blob of input.blobs) {
    const extension = inferFileExtension(blob.mime);
    const path = `blobs/sha256-${blob.hash}.${extension}`;
    zip.file(path, blob.bytes);
    fileHashes[path] = await sha256Hex(blob.bytes);
  }

  const manifestHash = await sha256Hex(JSON.stringify(input.manifest));
  const integrity: HashesManifest = {
    manifestSha256: manifestHash,
    files: fileHashes
  };

  await addJsonFile(zip, "integrity/hashes.json", integrity, fileHashes);

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

  return {
    bytes,
    integrity
  };
}

export type ParsedWebBlackboxArchive = {
  manifest: ExportManifest;
  events: WebBlackboxEvent[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest | null;
};

export async function readWebBlackboxArchive(
  bytes: ArrayBuffer | Uint8Array
): Promise<ParsedWebBlackboxArchive> {
  const zip = await JSZip.loadAsync(bytes);

  const manifest = await readJson<ExportManifest>(zip, "manifest.json");
  const timeIndex = await readJson<ChunkTimeIndexEntry[]>(zip, "index/time.json");
  const requestIndex = await readJson<RequestIndexEntry[]>(zip, "index/req.json");
  const invertedIndex = await readJson<InvertedIndexEntry[]>(zip, "index/inv.json");

  const eventEntries = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();

  const events: WebBlackboxEvent[] = [];

  for (const path of eventEntries) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const content = await file.async("uint8array");
    events.push(...decodeEventsNdjson(content));
  }

  const integrityFile = zip.file("integrity/hashes.json");
  const integrity = integrityFile
    ? await readJson<HashesManifest>(zip, "integrity/hashes.json")
    : null;

  return {
    manifest,
    events,
    timeIndex,
    requestIndex,
    invertedIndex,
    integrity
  };
}

async function addJsonFile(
  zip: JSZip,
  path: string,
  value: unknown,
  fileHashes: Record<string, string>
): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  zip.file(path, content);
  fileHashes[path] = await sha256Hex(content);
}

async function readJson<TValue>(zip: JSZip, path: string): Promise<TValue> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  const content = await file.async("string");
  return JSON.parse(content) as TValue;
}

function inferFileExtension(mime: string): string {
  if (mime.includes("png")) {
    return "png";
  }

  if (mime.includes("webp")) {
    return "webp";
  }

  if (mime.includes("json")) {
    return "json";
  }

  return "bin";
}
