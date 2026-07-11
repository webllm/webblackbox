import JSZip from "jszip";

import {
  assertArchiveChunk,
  assertArchiveEventIndexes,
  assertArchiveLayout,
  inferBlobFileExtension,
  parseArchivedEvent,
  parseExportManifest,
  parseHashesManifest,
  parseInvertedIndex,
  parsePrivacyManifest,
  parseRequestIndex,
  parseTimeIndex
} from "@webblackbox/protocol";

import type {
  ChunkCodec,
  ChunkTimeIndexEntry,
  ExportEncryption,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { decodeChunkBytes } from "./codec.js";
import { sha256Hex } from "./hash.js";
import type { StoredBlob, StoredChunk } from "./storage.js";

export type ExportBundleInput = {
  manifest: ExportManifest;
  chunks: StoredChunk[];
  blobs: StoredBlob[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  privacyManifest: PrivacyManifest;
};

export type ExportBundleOutput = {
  bytes: Uint8Array;
  integrity: HashesManifest;
};

export type ArchiveExportOptions = {
  passphrase?: string;
};

export type ArchiveReadOptions = {
  passphrase?: string;
};

const ENCRYPTION_KEY_DERIVATION_ITERATIONS = 120_000;
const AES_GCM_IV_BYTES = 12;
const LARGE_ARCHIVE_STORE_THRESHOLD_BYTES = 128 * 1024 * 1024;

export async function createWebBlackboxArchive(
  input: ExportBundleInput,
  options: ArchiveExportOptions = {}
): Promise<ExportBundleOutput> {
  const zip = new JSZip();
  const fileHashes: Record<string, string> = {};
  const encryption = options.passphrase
    ? await createArchiveEncryptionState(options.passphrase)
    : null;

  for (const chunk of input.chunks) {
    const path = `events/${chunk.meta.chunkId}.ndjson`;
    const bytes = encryption ? await encryptForArchive(path, chunk.bytes, encryption) : chunk.bytes;
    zip.file(path, bytes);
    fileHashes[path] = await sha256Hex(bytes);
  }

  await addJsonFile(zip, "index/time.json", input.timeIndex, fileHashes, encryption);
  await addJsonFile(zip, "index/req.json", input.requestIndex, fileHashes, encryption);
  await addJsonFile(zip, "index/inv.json", input.invertedIndex, fileHashes, encryption);
  await addJsonFile(zip, "privacy/manifest.json", input.privacyManifest, fileHashes, encryption);

  for (const blob of input.blobs) {
    const extension = inferBlobFileExtension(blob.mime);
    const path = `blobs/sha256-${blob.hash}.${extension}`;
    const bytes = encryption ? await encryptForArchive(path, blob.bytes, encryption) : blob.bytes;
    zip.file(path, bytes);
    fileHashes[path] = await sha256Hex(bytes);
  }

  const manifest: ExportManifest = encryption
    ? {
        ...input.manifest,
        encryption: encryption.meta
      }
    : input.manifest;

  await addJsonFile(zip, "manifest.json", manifest, fileHashes);

  const manifestHash = fileHashes["manifest.json"] ?? "";
  const integrity: HashesManifest = {
    manifestSha256: manifestHash,
    files: {
      ...fileHashes
    }
  };

  zip.file("integrity/hashes.json", JSON.stringify(integrity, null, 2));

  const estimatedPayloadBytes = estimateArchivePayloadBytes(input);
  const preferStore =
    Boolean(encryption) || estimatedPayloadBytes >= LARGE_ARCHIVE_STORE_THRESHOLD_BYTES;
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: preferStore ? "STORE" : "DEFLATE",
    compressionOptions: preferStore ? undefined : { level: 6 }
  });

  return {
    bytes,
    integrity
  };
}

function estimateArchivePayloadBytes(input: ExportBundleInput): number {
  let total = 0;

  for (const chunk of input.chunks) {
    total += chunk.bytes.byteLength;
  }

  for (const blob of input.blobs) {
    total += blob.bytes.byteLength;
  }

  total += new TextEncoder().encode(JSON.stringify(input.manifest)).byteLength;
  total += new TextEncoder().encode(JSON.stringify(input.timeIndex)).byteLength;
  total += new TextEncoder().encode(JSON.stringify(input.requestIndex)).byteLength;
  total += new TextEncoder().encode(JSON.stringify(input.invertedIndex)).byteLength;
  total += new TextEncoder().encode(JSON.stringify(input.privacyManifest)).byteLength;

  return total;
}

export type ParsedWebBlackboxArchive = {
  manifest: ExportManifest;
  events: WebBlackboxEvent[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  privacyManifest: PrivacyManifest | null;
  integrity: HashesManifest | null;
};

export async function readWebBlackboxArchive(
  bytes: ArrayBuffer | Uint8Array,
  options: ArchiveReadOptions = {}
): Promise<ParsedWebBlackboxArchive> {
  const zip = await JSZip.loadAsync(bytes);
  const integrity = parseHashesManifest(await readJsonValue(zip, "integrity/hashes.json"));

  await verifyArchiveIntegrity(zip, integrity);

  const manifest = parseExportManifest(await readJsonValue(zip, "manifest.json"));
  const archiveKey = await resolveArchiveReadKey(manifest, options.passphrase);
  const timeIndex = parseTimeIndex(
    await readArchiveJsonValue(zip, "index/time.json", manifest, archiveKey)
  );
  const requestIndex = parseRequestIndex(
    await readArchiveJsonValue(zip, "index/req.json", manifest, archiveKey)
  );
  const invertedIndex = parseInvertedIndex(
    await readArchiveJsonValue(zip, "index/inv.json", manifest, archiveKey)
  );
  const privacyValue = await readOptionalArchiveJsonValue(
    zip,
    "privacy/manifest.json",
    manifest,
    archiveKey
  );
  const privacyManifest = privacyValue === null ? null : parsePrivacyManifest(privacyValue);

  assertArchiveLayout({
    paths: archiveFilePaths(zip),
    manifest,
    timeIndex,
    requestIndex,
    invertedIndex,
    privacyManifest
  });

  const eventEntries = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();
  const chunkIndexById = new Map(timeIndex.map((entry) => [entry.chunkId, entry] as const));

  const events: WebBlackboxEvent[] = [];

  for (const path of eventEntries) {
    const file = zip.file(path);

    if (!file) {
      throw new Error(`Invalid WebBlackbox archive: missing indexed event chunk '${path}'.`);
    }

    const content = await file.async("uint8array");
    const decoded = await decryptArchiveFile(path, content, manifest, archiveKey);
    const chunkId = parseChunkIdFromPath(path);
    const index = chunkId ? chunkIndexById.get(chunkId) : undefined;

    if (!index) {
      throw new Error(`Invalid WebBlackbox archive: time index is missing event chunk '${path}'.`);
    }

    const chunkEvents = await parseArchiveChunkEvents(decoded, index.codec, path);

    assertArchiveChunk({
      path,
      index,
      encodedByteLength: decoded.byteLength,
      encodedSha256: await sha256Hex(decoded),
      events: chunkEvents
    });

    events.push(...chunkEvents);
  }

  assertArchiveEventIndexes(manifest, events, requestIndex, invertedIndex);

  return {
    manifest,
    events,
    timeIndex,
    requestIndex,
    invertedIndex,
    privacyManifest,
    integrity
  };
}

async function addJsonFile(
  zip: JSZip,
  path: string,
  value: unknown,
  fileHashes: Record<string, string>,
  encryption: ArchiveEncryptionState | null = null
): Promise<void> {
  const content = new TextEncoder().encode(JSON.stringify(value, null, 2));
  const bytes = encryption ? await encryptForArchive(path, content, encryption) : content;
  zip.file(path, bytes);
  fileHashes[path] = await sha256Hex(bytes);
}

async function readJsonValue(zip: JSZip, path: string): Promise<unknown> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  const content = decodeArchiveUtf8(await file.async("uint8array"), path);
  return parseArchiveJson(content, path);
}

async function readArchiveJsonValue(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<unknown> {
  const content = await readArchiveFileText(zip, path, manifest, archiveKey);
  return parseArchiveJson(content, path);
}

async function readOptionalArchiveJsonValue(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<unknown | null> {
  if (!zip.file(path)) {
    return null;
  }

  return readArchiveJsonValue(zip, path, manifest, archiveKey);
}

function parseArchiveJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Invalid WebBlackbox archive: '${path}' contains malformed JSON.`);
  }
}

async function parseArchiveChunkEvents(
  encoded: Uint8Array,
  codec: ChunkCodec,
  path: string
): Promise<WebBlackboxEvent[]> {
  const decoded = await decodeChunkBytes(encoded, codec);
  const lines = decodeArchiveUtf8(decoded, path)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const events: WebBlackboxEvent[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    let value: unknown;

    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `Invalid WebBlackbox archive: '${path}' contains malformed JSON at event line ${lineIndex + 1}.`
      );
    }

    events.push(parseArchivedEvent(value, path, lineIndex + 1));
  }

  return events;
}

function archiveFilePaths(zip: JSZip): string[] {
  return Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path);
}

async function readArchiveFileText(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<string> {
  const bytes = await readFileBytes(zip, path);
  const decrypted = await decryptArchiveFile(path, bytes, manifest, archiveKey);
  return decodeArchiveUtf8(decrypted, path);
}

function decodeArchiveUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Invalid WebBlackbox archive: '${path}' contains invalid UTF-8.`);
  }
}

async function verifyArchiveIntegrity(zip: JSZip, integrity: HashesManifest): Promise<void> {
  assertArchiveFileSet(zip, integrity);

  const manifestBytes = await readFileBytes(zip, "manifest.json");
  const manifestHash = await sha256Hex(manifestBytes);

  if (manifestHash !== integrity.manifestSha256) {
    throw new Error("Archive integrity mismatch for manifest.json");
  }

  for (const [path, expectedHash] of Object.entries(integrity.files)) {
    const actualHash = await sha256Hex(await readFileBytes(zip, path));

    if (actualHash !== expectedHash) {
      throw new Error(`Archive integrity mismatch for ${path}`);
    }
  }
}

function assertArchiveFileSet(zip: JSZip, integrity: HashesManifest): void {
  const actualPaths = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path)
    .filter((path) => path !== "integrity/hashes.json")
    .sort();
  const expectedPaths = Object.keys(integrity.files).sort();

  if (actualPaths.length !== expectedPaths.length) {
    throw new Error("Archive integrity manifest does not match archive contents.");
  }

  for (let index = 0; index < actualPaths.length; index += 1) {
    if (actualPaths[index] !== expectedPaths[index]) {
      throw new Error("Archive integrity manifest does not match archive contents.");
    }
  }
}

async function readFileBytes(zip: JSZip, path: string): Promise<Uint8Array> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  return file.async("uint8array");
}

type ArchiveEncryptionState = {
  key: CryptoKey;
  meta: ExportEncryption;
};

async function createArchiveEncryptionState(passphrase: string): Promise<ArchiveEncryptionState> {
  const salt = randomBytes(16);
  const key = await deriveArchiveKey(
    passphrase,
    salt,
    ENCRYPTION_KEY_DERIVATION_ITERATIONS,
    "encrypt"
  );

  return {
    key,
    meta: {
      algorithm: "AES-GCM",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: ENCRYPTION_KEY_DERIVATION_ITERATIONS,
        saltBase64: toBase64(salt)
      },
      files: {}
    }
  };
}

async function encryptForArchive(
  path: string,
  bytes: Uint8Array,
  state: ArchiveEncryptionState
): Promise<Uint8Array> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const encrypted = await encryptBytes(bytes, state.key, iv);

  state.meta.files[path] = {
    ivBase64: toBase64(iv)
  };

  return encrypted;
}

async function resolveArchiveReadKey(
  manifest: ExportManifest,
  passphrase?: string
): Promise<CryptoKey | null> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return null;
  }

  if (!passphrase) {
    throw new Error("Archive is encrypted. Provide a passphrase to read it.");
  }

  return deriveArchiveKey(
    passphrase,
    fromBase64(encryption.kdf.saltBase64),
    encryption.kdf.iterations,
    "decrypt"
  );
}

async function decryptArchiveFile(
  path: string,
  bytes: Uint8Array,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<Uint8Array> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return bytes;
  }

  const fileMeta = encryption.files[path];

  if (!fileMeta) {
    throw new Error(
      `Invalid WebBlackbox archive: encrypted archive is missing file metadata for '${path}'.`
    );
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  try {
    return await decryptBytes(bytes, archiveKey, fromBase64(fileMeta.ivBase64));
  } catch {
    throw new Error("Unable to decrypt archive content. The passphrase may be invalid.");
  }
}

async function deriveArchiveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt"
): Promise<CryptoKey> {
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toArrayBuffer(salt)
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    [usage]
  );
}

async function encryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(source)
  );

  return new Uint8Array(encrypted);
}

async function decryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const decrypted = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(source)
  );

  return new Uint8Array(decrypted);
}

function randomBytes(size: number): Uint8Array {
  const cryptoApi = requireCryptoApi();
  const bytes = new Uint8Array(size);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required for archive encryption.");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  throw new Error("Base64 encoding is unavailable in this environment.");
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  throw new Error("Base64 decoding is unavailable in this environment.");
}

function parseChunkIdFromPath(path: string): string | null {
  const match = /^events\/(.+)\.ndjson$/.exec(path);
  return match?.[1] ?? null;
}
