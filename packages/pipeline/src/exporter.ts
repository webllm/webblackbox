import JSZip from "jszip";

import type {
  ChunkTimeIndexEntry,
  ExportEncryption,
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

export type ArchiveExportOptions = {
  passphrase?: string;
};

export type ArchiveReadOptions = {
  passphrase?: string;
};

const ENCRYPTION_KEY_DERIVATION_ITERATIONS = 120_000;
const AES_GCM_IV_BYTES = 12;

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

  await addJsonFile(zip, "index/time.json", input.timeIndex, fileHashes);
  await addJsonFile(zip, "index/req.json", input.requestIndex, fileHashes);
  await addJsonFile(zip, "index/inv.json", input.invertedIndex, fileHashes);

  for (const blob of input.blobs) {
    const extension = inferFileExtension(blob.mime);
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
  bytes: ArrayBuffer | Uint8Array,
  options: ArchiveReadOptions = {}
): Promise<ParsedWebBlackboxArchive> {
  const zip = await JSZip.loadAsync(bytes);

  const manifest = await readJson<ExportManifest>(zip, "manifest.json");
  const archiveKey = await resolveArchiveReadKey(manifest, options.passphrase);
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
    const decoded = await decryptArchiveFile(path, content, manifest, archiveKey);
    events.push(...decodeEventsNdjson(decoded));
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
    return bytes;
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
