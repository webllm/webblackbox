import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request as createHttpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = "share-test-key";
const BLOB_FIXTURE_PATH =
  "blobs/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
const TEXT_BLOB_FIXTURE_PATH =
  "blobs/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin";

type RunningShareServer = {
  baseUrl: string;
  child: ChildProcess;
  dataDir: string;
  logs: string[];
};

let runningServers: RunningShareServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.map((server) => stopShareServer(server)));
  runningServers = [];
});

describe("share-server", () => {
  it("returns 413 when an upload exceeds the configured size limit", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES: "4"
    });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "too-large.webblackbox"
      },
      body: Buffer.from("12345")
    });

    await expect(response.json()).resolves.toEqual({
      error: "Upload payload exceeds 4 bytes."
    });
    expect(response.status).toBe(413);
  });

  it("rejects forged-size ZIP bombs from actual inflater output", async () => {
    const server = await startShareServer();
    const zip = new JSZip();
    zip.file("manifest.json", "x".repeat(9 * 1024 * 1024));
    const archive = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
    forgeZipUncompressedSize(archive, "manifest.json", 1);

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "compressed-bomb.webblackbox"
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      error: string;
      resource: string;
      limit: number;
    };

    expect(response.status).toBe(413);
    expect(payload.resource).toBe("maxMetadataEntryBytes");
    expect(payload.limit).toBe(8 * 1024 * 1024);
    expect(payload.error).toMatch(/resource limit exceeded/i);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const archiveFiles = await readdir(resolve(server.dataDir, "archives"));
    expect(archiveFiles).toEqual([]);
  });

  it("validates actual output for unreferenced lazy ZIP entries before retention", async () => {
    const server = await startShareServer();
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    zip.file("index/unreferenced.json", "x".repeat(9 * 1024 * 1024));
    const archive = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
    forgeZipUncompressedSize(archive, "index/unreferenced.json", 1);

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as { resource: string };

    expect(response.status).toBe(413);
    expect(payload.resource).toBe("maxMetadataEntryBytes");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await expect(readdir(resolve(server.dataDir, "archives"))).resolves.toEqual([]);
  });

  it("bounds concurrent upload buffering and inspection", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_CONCURRENT_INSPECTIONS: "1"
    });
    const pendingUpload = createHttpRequest(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "1024",
        "x-webblackbox-api-key": apiKey
      }
    });
    pendingUpload.on("error", () => undefined);
    pendingUpload.flushHeaders();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey
      },
      body: Buffer.from("second")
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Archive inspection capacity is temporarily exhausted."
    });
    expect(response.headers.get("retry-after")).toBe("1");
    pendingUpload.destroy();
  });

  it("releases the upload slot and removes temporary files after an idle timeout", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_UPLOAD_IDLE_TIMEOUT_MS: "50",
      WEBBLACKBOX_SHARE_UPLOAD_TOTAL_TIMEOUT_MS: "500"
    });
    const pendingUpload = createHttpRequest(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "1024",
        "x-webblackbox-api-key": apiKey
      }
    });
    const timedOut = new Promise<void>((resolvePromise) => {
      pendingUpload.once("error", () => resolvePromise());
    });
    pendingUpload.flushHeaders();
    await timedOut;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    const upload = await uploadEncryptedFixture(server);
    expect(upload.shareId).toMatch(/^[a-f0-9]+$/);
    const archiveFiles = await readdir(resolve(server.dataDir, "archives"));
    expect(archiveFiles.some((name) => name.endsWith(".upload"))).toBe(false);
  });

  it("does not advertise passphrase upload headers", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "OPTIONS"
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type,authorization,x-webblackbox-api-key,x-webblackbox-filename,x-webblackbox-share-summary,x-webblackbox-share-ttl-ms"
    );
  });

  it("returns only allowlisted public metadata", async () => {
    const server = await startShareServer();
    const secret = "customer-alpha.internal/users/reset-token-123";
    const encryptedArchive = await createEncryptedEnvelopeArchive();
    const summary = {
      schemaVersion: 2,
      source: "client",
      archiveSha256: sha256Hex(encryptedArchive),
      analyzed: true,
      encrypted: true,
      manifest: {
        origin: `https://${secret}`,
        mode: "lite",
        chunkCodec: "none",
        recordedAt: "2026-02-13T00:00:00.000Z"
      },
      totals: {
        events: 0,
        errors: 0,
        requests: 0,
        actions: 0,
        durationMs: 0
      },
      topEndpoints: [
        {
          endpoint: `https://${secret}`,
          method: "GET",
          count: 1
        }
      ],
      sensitivePreview: {
        totalMatches: 1,
        samples: [{ snippet: secret }]
      },
      privacy: {
        redaction: {
          hashSensitiveValues: true,
          headerRuleCount: 2,
          cookieRuleCount: 1,
          bodyPatternCount: 3,
          blockedSelectorCount: 4
        },
        detected: {
          redactedMarkers: 1,
          hashedSensitiveValues: 0,
          sensitiveKeyMentions: 0
        },
        scanner: {
          preEncryption: true,
          status: "passed",
          findingCount: 0
        }
      }
    };

    const uploadResponse = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "customer-alpha-reset-token-123.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(encryptedArchive)
    });
    const uploadPayload = (await uploadResponse.json()) as { shareId: string };

    expect(uploadResponse.status).toBe(201);

    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );
    const metadataText = await metadataResponse.text();

    expect(metadataResponse.status).toBe(200);
    expect(metadataText).not.toContain(secret);
    expect(metadataText).not.toContain("topEndpoints");
    expect(metadataText).not.toContain("sensitivePreview");
    expect(metadataText).not.toContain("customer-alpha-reset-token-123");
  });

  it("rejects plaintext public share uploads by default", async () => {
    const server = await startShareServer();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "plain.webblackbox"
      },
      body: Buffer.from(await createPlaintextEnvelopeArchive())
    });

    await expect(response.json()).resolves.toEqual({
      error: "Public share uploads require encrypted WebBlackbox archives."
    });
    expect(response.status).toBe(422);
  });

  it("does not present an encrypted upload without a client claim as analyzed", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox"
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      summary: {
        schemaVersion: number;
        source: string;
        analyzed: boolean;
        trust: { privateContent: string };
      };
    };

    expect(response.status).toBe(201);
    expect(payload.summary).toMatchObject({
      schemaVersion: 2,
      source: "unavailable",
      analyzed: false,
      trust: { privateContent: "not-analyzed" }
    });
  });

  it("rejects legacy client privacy assurance headers", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-encryption": "encrypted",
        "x-webblackbox-policy-eligible": "true",
        "x-webblackbox-redaction-summary": "passed"
      },
      body: Buffer.from(archive)
    });

    await expect(response.json()).resolves.toEqual({
      error: "Legacy client assurance headers are not accepted. Use an archive-bound share summary."
    });
    expect(response.status).toBe(400);
  });

  it("rejects client summaries that are not bound to the uploaded archive", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();
    const summary = buildPassedShareSummary(archive) as Record<string, unknown>;
    summary.archiveSha256 = "0".repeat(64);

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(archive)
    });

    await expect(response.json()).resolves.toEqual({
      error: "Share summary archive digest does not match the upload."
    });
    expect(response.status).toBe(400);
  });

  it("rejects legacy unbound share-summary schemas on new uploads", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();
    const summary = buildPassedShareSummary(archive) as Record<string, unknown>;
    summary.schemaVersion = 1;
    delete summary.archiveSha256;

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(archive)
    });

    await expect(response.json()).resolves.toEqual({
      error: "Share summary must use schemaVersion 2 with source 'client'."
    });
    expect(response.status).toBe(400);
  });

  it("rejects archive-bound client summaries that contradict inspected envelope facts", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();
    const summary = buildPassedShareSummary(archive) as Record<string, unknown>;
    summary.encrypted = false;

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(archive)
    });

    await expect(response.json()).resolves.toEqual({
      error: "Share summary conflicts with server-inspected archive envelope facts."
    });
    expect(response.status).toBe(400);
  });

  it("labels bound client privacy fields as unverified claims", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      summary: {
        source: string;
        analyzed: boolean;
        archiveSha256?: string;
        privacy?: unknown;
        clientClaim?: { privacy?: { scanner?: { status?: string } } };
        trust: { privateContent: string; archiveDigestMatched?: boolean };
        analysisError?: string;
      };
    };

    expect(response.status).toBe(201);
    expect(payload.summary).toMatchObject({
      source: "client-unverified",
      analyzed: false,
      trust: {
        privateContent: "client-claim-unverified",
        archiveDigestMatched: true
      }
    });
    expect(payload.summary.archiveSha256).toBeUndefined();
    expect(payload.summary.privacy).toBeUndefined();
    expect(payload.summary.clientClaim?.privacy?.scanner?.status).toBe("passed");
    expect(payload.summary.analysisError).toMatch(/unverified client claims/i);
  });

  it("uses a client's explicit blocked result only to reject, never to attest acceptance", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive();
    const summary = buildPassedShareSummary(archive) as {
      privacy: { scanner: { status: string; findingCount: number } };
    };
    summary.privacy.scanner.status = "blocked";
    summary.privacy.scanner.findingCount = 1;

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(JSON.stringify(summary))
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(payload.error).toBe("Share upload blocked by the client's privacy scanner claim.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await expect(readdir(resolve(server.dataDir, "archives"))).resolves.toEqual([]);
  });

  it("rebuilds current persisted server summaries from allowlisted public fields", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const initialResponse = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const initialPayload = (await initialResponse.json()) as {
      summary: {
        source: string;
        clientClaim?: { privacy?: { scanner?: { status?: string } } };
      };
    };
    expect(initialResponse.status).toBe(200);
    expect(initialPayload.summary.source).toBe("client-unverified");
    expect(initialPayload.summary.clientClaim?.privacy?.scanner?.status).toBe("passed");

    const recordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      summary: Record<string, unknown>;
    };
    const extraSecret = "persisted-extra-secret";
    record.summary = buildPersistedServerSummary(record.summary);
    record.summary.extraSecret = extraSecret;
    const privacy = record.summary.privacy as Record<string, unknown>;
    privacy.extraSecret = extraSecret;
    const scanner = privacy.scanner as Record<string, unknown>;
    scanner.extraSecret = extraSecret;
    await writeFile(recordPath, JSON.stringify(record));

    const response = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const payload = (await response.json()) as {
      summary: {
        source: string;
        analyzed: boolean;
        extraSecret?: unknown;
        privacy?: {
          extraSecret?: unknown;
          scanner: { status: string; extraSecret?: unknown };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.summary).toMatchObject({
      source: "server",
      analyzed: true,
      privacy: { scanner: { status: "passed" } }
    });
    expect(payload.summary.extraSecret).toBeUndefined();
    expect(payload.summary.privacy?.extraSecret).toBeUndefined();
    expect(payload.summary.privacy?.scanner.extraSecret).toBeUndefined();
    expect(JSON.stringify(payload.summary)).not.toContain(extraSecret);
  });

  it("downgrades malformed current persisted server summaries to unavailable", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const recordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      summary: Record<string, unknown>;
    };
    const validSummary = buildPersistedServerSummary(record.summary);
    const mutations: Array<{
      name: string;
      mutate: (summary: Record<string, unknown>) => void;
    }> = [
      {
        name: "encrypted type",
        mutate: (summary) => {
          summary.encrypted = "true";
        }
      },
      {
        name: "totals type",
        mutate: (summary) => {
          (summary.totals as Record<string, unknown>).events = "0";
        }
      },
      {
        name: "totals bound",
        mutate: (summary) => {
          (summary.totals as Record<string, unknown>).events = Number.MAX_SAFE_INTEGER;
        }
      },
      {
        name: "privacy type",
        mutate: (summary) => {
          const privacy = summary.privacy as Record<string, unknown>;
          (privacy.scanner as Record<string, unknown>).preEncryption = "true";
        }
      }
    ];

    for (const { name, mutate } of mutations) {
      record.summary = structuredClone(validSummary);
      mutate(record.summary);
      await writeFile(recordPath, JSON.stringify(record));

      const response = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
        headers: { "x-webblackbox-api-key": apiKey }
      });
      const payload = (await response.json()) as {
        summary: {
          source: string;
          analyzed: boolean;
          privacy?: unknown;
          clientClaim?: unknown;
          trust: { privateContent: string };
        };
      };

      expect(response.status, name).toBe(200);
      expect(payload.summary, name).toMatchObject({
        source: "unavailable",
        analyzed: false,
        trust: { privateContent: "not-analyzed" }
      });
      expect(payload.summary.privacy, name).toBeUndefined();
      expect(payload.summary.clientClaim, name).toBeUndefined();
    }
  });

  it("downgrades persisted client claims that forge top-level verified privacy", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const recordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      summary: Record<string, unknown>;
    };
    const clientClaim = record.summary.clientClaim as Record<string, unknown>;
    record.summary.privacy = clientClaim.privacy;
    await writeFile(recordPath, JSON.stringify(record));

    const response = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const payload = (await response.json()) as {
      summary: {
        source: string;
        analyzed: boolean;
        privacy?: unknown;
        clientClaim?: unknown;
        trust: { privateContent: string };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.summary).toMatchObject({
      source: "unavailable",
      analyzed: false,
      trust: { privateContent: "not-analyzed" }
    });
    expect(payload.summary.privacy).toBeUndefined();
    expect(payload.summary.clientClaim).toBeUndefined();
  });

  it("downgrades legacy stored client summaries instead of exposing them as analyzed", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const recordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      summary: Record<string, unknown>;
    };
    record.summary.schemaVersion = 1;
    record.summary.source = "client";
    record.summary.analyzed = true;
    const storedClientClaim = record.summary.clientClaim as
      | {
          totals?: Record<string, unknown>;
          topActionTriggers?: unknown;
          privacy?: unknown;
        }
      | undefined;
    record.summary.totals = {
      ...(record.summary.totals as Record<string, unknown>),
      ...storedClientClaim?.totals
    };
    record.summary.topActionTriggers = storedClientClaim?.topActionTriggers;
    record.summary.privacy = storedClientClaim?.privacy;
    delete record.summary.clientClaim;
    delete record.summary.trust;
    await writeFile(recordPath, JSON.stringify(record));

    const response = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const payload = (await response.json()) as {
      summary: {
        schemaVersion: number;
        source: string;
        analyzed: boolean;
        privacy?: unknown;
        clientClaim?: { privacy?: unknown };
        trust: { privateContent: string; archiveDigestMatched?: boolean };
        analysisError: string;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.summary).toMatchObject({
      schemaVersion: 2,
      source: "client-unverified",
      analyzed: false,
      trust: { privateContent: "client-claim-unverified" }
    });
    expect(payload.summary.privacy).toBeUndefined();
    expect(payload.summary.clientClaim?.privacy).toBeDefined();
    expect(payload.summary.trust.archiveDigestMatched).toBeUndefined();
    expect(payload.summary.analysisError).toMatch(/not archive-digest-bound/i);
  });

  it("rejects encrypted public share uploads with incomplete encrypted file metadata", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive({ completeEncryptionMap: false });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      error: string;
      missingEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive is missing encrypted file metadata.");
    expect(payload.missingEncryptedPaths).toContain("index/time.json");
  });

  it("rejects encrypted public share uploads with plaintext private files", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive({ privateFileMode: "plaintext" });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain("index/time.json");
  });

  it("rejects encrypted public share uploads with plaintext private blobs", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive({ blobFileMode: "plaintext" });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain(BLOB_FIXTURE_PATH);
  });

  it("rejects encrypted public share uploads with plaintext text blobs", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive({ textBlobFileMode: "plaintext" });

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-filename": "encrypted.webblackbox",
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      error: string;
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Encrypted WebBlackbox archive contains plaintext private files.");
    expect(payload.plaintextEncryptedPaths).toContain(TEXT_BLOB_FIXTURE_PATH);
  });

  it("scans complete private entries for plaintext beyond the former prefix window", async () => {
    const server = await startShareServer();
    const archive = await createEncryptedEnvelopeArchive({
      privateFileMode: "plaintext",
      textBlobFileMode: "plaintext",
      plaintextPrefixBytes: 64 * 1024 + 1
    });
    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const payload = (await response.json()) as {
      plaintextEncryptedPaths: string[];
    };

    expect(response.status).toBe(400);
    expect(payload.plaintextEncryptedPaths).toEqual(
      expect.arrayContaining(["index/time.json", TEXT_BLOB_FIXTURE_PATH])
    );
  });

  it("binds persisted records to safe filenames before metadata or cleanup", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const recordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const persisted = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    persisted.shareUrl = "https://attacker.example/share/poisoned";
    persisted.fileName = 'poisoned".zip';
    await writeFile(recordPath, JSON.stringify(persisted));

    const metadataResponse = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const metadata = (await metadataResponse.json()) as { shareUrl: string; fileName: string };
    expect(metadataResponse.status).toBe(200);
    expect(metadata.shareUrl).toBe(`${server.baseUrl}/share/${upload.shareId}`);
    expect(metadata.fileName).toMatch(/^webblackbox-share-[a-f0-9]+\.zip$/);

    const sentinelPath = resolve(server.dataDir, "sentinel.json");
    await writeFile(sentinelPath, "keep-me");
    await writeFile(
      resolve(server.dataDir, "records", "malicious.json"),
      JSON.stringify({
        ...persisted,
        id: "../sentinel",
        createdAt: 1,
        expiresAt: 2
      })
    );

    const listResponse = await fetch(`${server.baseUrl}/api/share/list`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(listResponse.status).toBe(200);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep-me");

    await writeFile(
      resolve(server.dataDir, "records", "oversized.json"),
      " ".repeat(256 * 1024 + 1)
    );
    const oversizedResponse = await fetch(`${server.baseUrl}/api/share/oversized/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(oversizedResponse.status).toBe(404);
  });

  it("paginates bounded share listings with strict query validation", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const sourceRecord = JSON.parse(
      await readFile(resolve(server.dataDir, "records", `${upload.shareId}.json`), "utf8")
    ) as Record<string, unknown>;
    const sourceArchive = await readFile(
      resolve(server.dataDir, "archives", `${upload.shareId}.webblackbox`)
    );
    const createdAt = Number(sourceRecord.createdAt);
    const cloneIds = ["a".repeat(32), "b".repeat(32)];

    for (const [index, id] of cloneIds.entries()) {
      await writeFile(
        resolve(server.dataDir, "records", `${id}.json`),
        JSON.stringify({
          ...sourceRecord,
          id,
          createdAt: createdAt - index - 1
        })
      );
      await writeFile(resolve(server.dataDir, "archives", `${id}.webblackbox`), sourceArchive);
    }

    const firstResponse = await fetch(`${server.baseUrl}/api/share/list?limit=2&offset=0`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const first = (await firstResponse.json()) as {
      items: Array<{ id: string }>;
      total: number;
      offset: number;
      limit: number;
      nextOffset: number | null;
    };
    expect(first).toMatchObject({ total: 3, offset: 0, limit: 2, nextOffset: 2 });
    expect(first.items).toHaveLength(2);

    const secondResponse = await fetch(`${server.baseUrl}/api/share/list?limit=2&offset=2`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const second = (await secondResponse.json()) as {
      items: Array<{ id: string }>;
      nextOffset: number | null;
    };
    expect(second.items).toHaveLength(1);
    expect(second.nextOffset).toBeNull();

    const invalidResponse = await fetch(`${server.baseUrl}/api/share/list?limit=201`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("rejects uploads before buffering when retained record capacity is exhausted", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_RECORDS: "2"
    });
    await uploadEncryptedFixture(server);
    await uploadEncryptedFixture(server);
    const archive = await createEncryptedEnvelopeArchive();

    const response = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });

    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toEqual({
      error:
        "Share record capacity is exhausted (2). Wait for expired records to pass retention and be pruned, remove retained data administratively, or raise the admission limit."
    });
    await expect(readdir(resolve(server.dataDir, "archives"))).resolves.toHaveLength(2);
  });

  it("reserves record capacity across concurrent upload inspections", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_RECORDS: "1",
      WEBBLACKBOX_SHARE_MAX_CONCURRENT_INSPECTIONS: "2"
    });
    const archive = await createEncryptedEnvelopeArchive();
    const headers = {
      "content-type": "application/octet-stream",
      "x-webblackbox-api-key": apiKey,
      "x-webblackbox-share-summary": encodeURIComponent(
        JSON.stringify(buildPassedShareSummary(archive))
      )
    };

    const responses = await Promise.all([
      fetch(`${server.baseUrl}/api/share/upload`, {
        method: "POST",
        headers,
        body: Buffer.from(archive)
      }),
      fetch(`${server.baseUrl}/api/share/upload`, {
        method: "POST",
        headers,
        body: Buffer.from(archive)
      })
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 507]);
    await expect(readdir(resolve(server.dataDir, "records"))).resolves.toHaveLength(1);
    await expect(readdir(resolve(server.dataDir, "archives"))).resolves.toHaveLength(1);
  });

  it("keeps existing shares operable when the upload admission limit is lowered", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_RECORDS: "4"
    });
    const firstUpload = await uploadEncryptedFixture(server);
    const secondUpload = await uploadEncryptedFixture(server);
    const thirdUpload = await uploadEncryptedFixture(server);

    await stopShareServer(server, false);
    const restarted = await startShareServer(
      {
        WEBBLACKBOX_SHARE_MAX_RECORDS: "1"
      },
      server.dataDir
    );

    const firstListResponse = await fetch(`${restarted.baseUrl}/api/share/list?limit=2&offset=0`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const firstList = (await firstListResponse.json()) as {
      items: Array<{ id: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(firstListResponse.status).toBe(200);
    expect(firstList).toMatchObject({ total: 3, nextOffset: 2 });
    expect(firstList.items).toHaveLength(2);

    const secondListResponse = await fetch(`${restarted.baseUrl}/api/share/list?limit=2&offset=2`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const secondList = (await secondListResponse.json()) as {
      items: Array<{ id: string }>;
      total: number;
      nextOffset: number | null;
    };
    expect(secondListResponse.status).toBe(200);
    expect(secondList).toMatchObject({ total: 3, nextOffset: null });
    expect(secondList.items).toHaveLength(1);
    expect([...firstList.items, ...secondList.items].map(({ id }) => id).sort()).toEqual(
      [firstUpload.shareId, secondUpload.shareId, thirdUpload.shareId].sort()
    );

    const metadataResponse = await fetch(
      `${restarted.baseUrl}/api/share/${firstUpload.shareId}/meta`,
      {
        headers: { "x-webblackbox-api-key": apiKey }
      }
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({ id: firstUpload.shareId });

    const revokeResponse = await fetch(
      `${restarted.baseUrl}/api/share/${secondUpload.shareId}/revoke`,
      {
        method: "POST",
        headers: { "x-webblackbox-api-key": apiKey }
      }
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      shareId: secondUpload.shareId
    });

    const archive = await createEncryptedEnvelopeArchive();
    const rejectedUploadResponse = await fetch(`${restarted.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    expect(rejectedUploadResponse.status).toBe(507);
    await expect(rejectedUploadResponse.json()).resolves.toEqual({
      error:
        "Share record capacity is exhausted (1). Wait for expired records to pass retention and be pruned, remove retained data administratively, or raise the admission limit."
    });
    await expect(readdir(resolve(restarted.dataDir, "archives"))).resolves.toHaveLength(3);
  });

  it("atomically persists records and reconciles interrupted storage on restart", async () => {
    const server = await startShareServer();
    const upload = await uploadEncryptedFixture(server);
    const validRecordPath = resolve(server.dataDir, "records", `${upload.shareId}.json`);
    const validRecord = JSON.parse(await readFile(validRecordPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect((await stat(validRecordPath)).mode & 0o777).toBe(0o600);

    const orphanArchiveId = "c".repeat(32);
    const orphanRecordId = "d".repeat(32);
    const unsafeExpiryId = "e".repeat(32);
    await writeFile(
      resolve(server.dataDir, "archives", `${orphanArchiveId}.webblackbox`),
      "orphan"
    );
    await writeFile(
      resolve(server.dataDir, "records", `${orphanRecordId}.json`),
      JSON.stringify({ ...validRecord, id: orphanRecordId })
    );
    await writeFile(
      resolve(server.dataDir, "archives", `${unsafeExpiryId}.webblackbox`),
      await readFile(resolve(server.dataDir, "archives", `${upload.shareId}.webblackbox`))
    );
    await writeFile(
      resolve(server.dataDir, "records", `${unsafeExpiryId}.json`),
      JSON.stringify({
        ...validRecord,
        id: unsafeExpiryId,
        expiresAt: Number.MAX_SAFE_INTEGER
      })
    );
    await writeFile(resolve(server.dataDir, "archives", ".interrupted.upload"), "partial");
    await writeFile(resolve(server.dataDir, "records", ".interrupted.record"), "partial");

    await stopShareServer(server, false);
    const restarted = await startShareServer({}, server.dataDir);

    await expect(readdir(resolve(restarted.dataDir, "archives"))).resolves.toEqual([
      `${upload.shareId}.webblackbox`
    ]);
    await expect(readdir(resolve(restarted.dataDir, "records"))).resolves.toEqual([
      `${upload.shareId}.json`
    ]);
    const metadataResponse = await fetch(`${restarted.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(metadataResponse.status).toBe(200);
  });

  it.each(["truncated", "same-size replacement"] as const)(
    "removes a %s persisted archive during restart reconciliation",
    async (corruption) => {
      const server = await startShareServer();
      const upload = await uploadEncryptedFixture(server);
      const archivePath = resolve(server.dataDir, "archives", `${upload.shareId}.webblackbox`);
      const storedArchive = await readFile(archivePath);
      const corruptedArchive =
        corruption === "truncated"
          ? storedArchive.subarray(0, storedArchive.byteLength - 1)
          : Buffer.alloc(storedArchive.byteLength, 0xa5);
      expect(sha256Hex(corruptedArchive)).not.toBe(sha256Hex(storedArchive));

      await stopShareServer(server, false);
      await writeFile(archivePath, corruptedArchive);
      const restarted = await startShareServer({}, server.dataDir);

      const listResponse = await fetch(`${restarted.baseUrl}/api/share/list`, {
        headers: { "x-webblackbox-api-key": apiKey }
      });
      const list = (await listResponse.json()) as { items: unknown[]; total: number };
      expect(listResponse.status).toBe(200);
      expect(list).toMatchObject({ items: [], total: 0 });
      await expect(readdir(resolve(restarted.dataDir, "archives"))).resolves.toEqual([]);
      await expect(readdir(resolve(restarted.dataDir, "records"))).resolves.toEqual([]);

      const metadataResponse = await fetch(
        `${restarted.baseUrl}/api/share/${upload.shareId}/meta`,
        { headers: { "x-webblackbox-api-key": apiKey } }
      );
      const downloadResponse = await fetch(
        `${restarted.baseUrl}/api/share/${upload.shareId}/archive`,
        { headers: { "x-webblackbox-api-key": apiKey } }
      );
      expect(metadataResponse.status).toBe(404);
      expect(downloadResponse.status).toBe(404);
    }
  );

  it("does not expose stale metadata or downloads after archives change at runtime", async () => {
    const server = await startShareServer();
    const truncatedUpload = await uploadEncryptedFixture(server);
    const truncatedPath = resolve(
      server.dataDir,
      "archives",
      `${truncatedUpload.shareId}.webblackbox`
    );
    const truncatedBytes = await readFile(truncatedPath);
    await writeFile(truncatedPath, truncatedBytes.subarray(0, truncatedBytes.byteLength - 1));

    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${truncatedUpload.shareId}/meta`,
      { headers: { "x-webblackbox-api-key": apiKey } }
    );
    expect(metadataResponse.status).toBe(404);

    const replacedUpload = await uploadEncryptedFixture(server);
    const replacedPath = resolve(
      server.dataDir,
      "archives",
      `${replacedUpload.shareId}.webblackbox`
    );
    const replacedBytes = await readFile(replacedPath);
    await writeFile(replacedPath, Buffer.alloc(replacedBytes.byteLength, 0x5a));

    const downloadResponse = await fetch(
      `${server.baseUrl}/api/share/${replacedUpload.shareId}/archive`,
      { headers: { "x-webblackbox-api-key": apiKey } }
    );
    expect(downloadResponse.status).toBe(404);
    expect(downloadResponse.headers.get("content-type")).toContain("application/json");

    const listResponse = await fetch(`${server.baseUrl}/api/share/list`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    const list = (await listResponse.json()) as { items: unknown[]; total: number };
    expect(list).toMatchObject({ items: [], total: 0 });
  });

  it("expires shares and blocks archive download after ttl", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_DEFAULT_TTL_MS: "1000"
    });
    const uploadPayload = await uploadEncryptedFixture(server);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`, {
      headers: {
        "x-webblackbox-api-key": apiKey
      }
    });

    await expect(response.json()).resolves.toEqual({
      error: "Share has expired."
    });
    expect(response.status).toBe(410);
  });

  it("accepts zero retention and prunes an expired share on restart", async () => {
    const durationEnv = {
      WEBBLACKBOX_SHARE_DEFAULT_TTL_MS: "1000",
      WEBBLACKBOX_SHARE_MAX_TTL_MS: "1000",
      WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS: "0"
    };
    const server = await startShareServer(durationEnv);
    await uploadEncryptedFixture(server);

    await stopShareServer(server, false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    const restarted = await startShareServer(durationEnv, server.dataDir);

    await expect(readdir(resolve(restarted.dataDir, "records"))).resolves.toEqual([]);
    await expect(readdir(resolve(restarted.dataDir, "archives"))).resolves.toEqual([]);
  });

  it("rejects unsafe or contradictory duration configuration", async () => {
    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_MAX_TTL_MS: String(Number.MAX_SAFE_INTEGER)
      })
    ).rejects.toThrow(/safe timestamp range/);

    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_DEFAULT_TTL_MS: "2000",
        WEBBLACKBOX_SHARE_MAX_TTL_MS: "1000"
      })
    ).rejects.toThrow(/must not exceed/);

    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS: "not-a-duration"
      })
    ).rejects.toThrow(/must be an integer/);
  });

  it("cancels a streamed archive download when the client disconnects", async () => {
    const server = await startShareServer();
    const archive = await createLargeEncryptedEnvelopeArchive(8 * 1024 * 1024);
    const uploadResponse = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(archive))
        )
      },
      body: Buffer.from(archive)
    });
    const upload = (await uploadResponse.json()) as { shareId: string };
    expect(uploadResponse.status).toBe(201);

    await new Promise<void>((resolvePromise, reject) => {
      const download = createHttpRequest(`${server.baseUrl}/api/share/${upload.shareId}/archive`, {
        method: "GET",
        headers: { "x-webblackbox-api-key": apiKey }
      });
      download.once("error", () => undefined);
      download.once("response", (archiveResponse) => {
        archiveResponse.once("error", () => undefined);
        archiveResponse.once("data", () => {
          archiveResponse.destroy();
          download.destroy();
          resolvePromise();
        });
        archiveResponse.once("end", () => {
          reject(new Error("Expected to abort before the complete archive was streamed."));
        });
      });
      download.end();
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const metadataResponse = await fetch(`${server.baseUrl}/api/share/${upload.shareId}/meta`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(metadataResponse.status).toBe(200);
    expect(server.child.exitCode).toBeNull();
  });

  it("revokes shares and writes redacted audit events", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const revokeResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/revoke`,
      {
        method: "POST",
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    expect(revokeResponse.status).toBe(200);

    const archiveResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    await expect(archiveResponse.json()).resolves.toEqual({
      error: "Share has been revoked."
    });
    expect(archiveResponse.status).toBe(410);

    const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
    const auditEvents = auditLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; clientHash?: string });

    expect(auditEvents.some((event) => event.action === "upload")).toBe(true);
    expect(auditEvents.some((event) => event.action === "revoke")).toBe(true);
    expect(auditEvents.some((event) => event.action === "download")).toBe(true);
    expect(auditEvents.every((event) => typeof event.clientHash === "string")).toBe(true);
    expect(auditLog).not.toContain("127.0.0.1");
    expect(auditLog).not.toContain("webblackbox-share-");
  });

  it("audits authorization failures within a bounded rotating log", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES: "512"
    });
    const rejectedKey = "raw-rejected-api-key";

    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(`${server.baseUrl}/api/share/list`, {
        headers: {
          "x-webblackbox-api-key": rejectedKey
        }
      });
      expect(response.status).toBe(401);
    }

    const auditFiles = await readdir(resolve(server.dataDir, "audit"));
    expect(auditFiles).toEqual(
      expect.arrayContaining(["share-access.jsonl", "share-access.1.jsonl"])
    );
    const auditLogs = await Promise.all(
      auditFiles.map((name) => readFile(resolve(server.dataDir, "audit", name), "utf8"))
    );
    expect(auditLogs.join("\n")).toContain('"outcome":"blocked"');
    expect(auditLogs.join("\n")).toContain('"reason":"unauthorized"');
    expect(auditLogs.join("\n")).not.toContain(rejectedKey);

    for (const name of auditFiles) {
      expect((await stat(resolve(server.dataDir, "audit", name))).size).toBeLessThanOrEqual(512);
    }
  });

  it("keeps committed operations successful when the audit sink is unavailable", async () => {
    const server = await startShareServer();
    const auditPath = resolve(server.dataDir, "audit/share-access.jsonl");
    await rm(auditPath, { force: true });
    await mkdir(auditPath);

    const uploadPayload = await uploadEncryptedFixture(server);
    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    expect(metadataResponse.status).toBe(200);
    expect(server.child.exitCode).toBeNull();
    expect(server.logs.join("")).toContain("[share-server] audit append failed");
    await expect(terminateShareServer(server)).resolves.toEqual({ code: 0, signal: null });
  });

  it("drains an accepted operation audit before exiting on SIGTERM", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);
    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );

    expect(metadataResponse.status).toBe(200);
    await metadataResponse.arrayBuffer();

    const exit = await terminateShareServer(server);
    const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
    const auditEvents = auditLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; shareId?: string });

    expect(exit).toEqual({ code: 0, signal: null });
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: "metadata",
        shareId: uploadPayload.shareId
      })
    );
    expect(server.logs.join("")).toContain("[share-server] shutdown drain complete");
  });

  it("bounds shutdown when the audit sink cannot drain", async () => {
    if (process.platform === "win32") {
      return;
    }

    const server = await startShareServer({
      WEBBLACKBOX_SHARE_SHUTDOWN_TIMEOUT_MS: "150"
    });
    const uploadPayload = await uploadEncryptedFixture(server);
    const auditPath = resolve(server.dataDir, "audit/share-access.jsonl");
    await waitForAuditEvent(server, "upload", uploadPayload.shareId);
    await rm(auditPath, { force: true });
    const auditReader = await createFullNamedPipe(auditPath);

    try {
      const metadataResponse = await fetch(
        `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
        {
          headers: {
            "x-webblackbox-api-key": apiKey
          }
        }
      );
      expect(metadataResponse.status).toBe(200);
      await metadataResponse.arrayBuffer();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

      const startedAt = Date.now();
      const exit = await terminateShareServer(server);

      expect(exit.signal === "SIGKILL" || exit.code === 128 + 9).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await auditReader.close();
    }
  });

  it("enforces scoped API keys", async () => {
    const uploadKey = "upload-scope-key";
    const readKey = "read-scope-key";
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEYS: `${uploadKey}:upload;${readKey}:read`
    });
    const uploadPayload = await uploadEncryptedFixture(server, uploadKey);

    const blockedRead = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`, {
      headers: {
        "x-webblackbox-api-key": uploadKey
      }
    });

    expect(blockedRead.status).toBe(401);

    const allowedRead = await fetch(`${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`, {
      headers: {
        "x-webblackbox-api-key": readKey
      }
    });

    expect(allowedRead.status).toBe(200);
  });

  it("serves share pages with no-referrer and strict csp headers", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const response = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}`, {
      headers: {
        "x-webblackbox-api-key": apiKey
      }
    });
    const html = await response.text();
    const cookie = readSetCookiePair(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("?key=");
    expect(html).not.toContain(apiKey);
    expect(cookie).toMatch(/^webblackbox_share_read=/);

    const archiveResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/archive`,
      {
        headers: {
          cookie
        }
      }
    );
    expect(archiveResponse.status).toBe(200);
    expect((await archiveResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("rejects query API keys by default", async () => {
    const server = await startShareServer();
    const uploadPayload = await uploadEncryptedFixture(server);

    const response = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}?key=${apiKey}`, {
      redirect: "manual"
    });

    expect(response.status).toBe(401);
  });

  it("does not create read sessions or success audits for unavailable shares", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY: "true"
    });
    const missingId = "missing-share";

    const queryResponse = await fetch(
      `${server.baseUrl}/share/${missingId}?key=${encodeURIComponent(apiKey)}`,
      { redirect: "manual" }
    );
    expect(queryResponse.status).toBe(404);
    expect(queryResponse.headers.get("location")).toBeNull();
    expect(queryResponse.headers.get("set-cookie")).toBeNull();

    const headerResponse = await fetch(`${server.baseUrl}/share/${missingId}`, {
      headers: { "x-webblackbox-api-key": apiKey }
    });
    expect(headerResponse.status).toBe(404);
    expect(headerResponse.headers.get("set-cookie")).toBeNull();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
    expect(auditLog).toContain('"outcome":"not-found"');
    expect(auditLog).not.toContain('"authorization":"query-bootstrap"');
  });

  it("does not trust Host or forwarded-protocol headers for public URLs and CORS", async () => {
    const server = await startShareServer();
    const encryptedArchive = await createEncryptedEnvelopeArchive();
    const uploadResponse = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "POST",
      headers: {
        host: "attacker.example",
        origin: "https://attacker.example",
        "x-forwarded-proto": "https",
        "content-type": "application/octet-stream",
        "x-webblackbox-api-key": apiKey,
        "x-webblackbox-share-summary": encodeURIComponent(
          JSON.stringify(buildPassedShareSummary(encryptedArchive))
        )
      },
      body: Buffer.from(encryptedArchive)
    });
    const upload = (await uploadResponse.json()) as { shareUrl: string };

    expect(uploadResponse.status).toBe(201);
    expect(upload.shareUrl).toMatch(new RegExp(`^${escapeRegExp(server.baseUrl)}/share/`));
    expect(upload.shareUrl).not.toContain("attacker.example");
    expect(uploadResponse.headers.get("access-control-allow-origin")).toBeNull();

    const allowedPreflight = await fetch(`${server.baseUrl}/api/share/upload`, {
      method: "OPTIONS",
      headers: {
        host: "attacker.example",
        origin: server.baseUrl,
        "x-forwarded-proto": "javascript"
      }
    });
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
  });

  it("uses the configured HTTPS public origin and secures browser session cookies", async () => {
    const publicOrigin = "https://shares.example.test";
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY: "true",
      WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: publicOrigin
    });
    const uploadPayload = await uploadEncryptedFixture(server);

    const metadataResponse = await fetch(
      `${server.baseUrl}/api/share/${uploadPayload.shareId}/meta`,
      {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      }
    );
    const metadata = (await metadataResponse.json()) as { shareUrl: string };
    expect(metadata.shareUrl).toBe(`${publicOrigin}/share/${uploadPayload.shareId}`);

    const redirectResponse = await fetch(
      `${server.baseUrl}/share/${uploadPayload.shareId}?key=${apiKey}`,
      { redirect: "manual" }
    );
    expect(redirectResponse.headers.get("set-cookie")).toContain("; Secure");
  });

  it("requires an explicit secure public origin for non-loopback binds", async () => {
    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_BIND_HOST: "0.0.0.0",
        WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: ""
      })
    ).rejects.toThrow(/WEBBLACKBOX_SHARE_PUBLIC_ORIGIN is required/);

    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_BIND_HOST: "0.0.0.0",
        WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: "http://shares.example.test"
      })
    ).rejects.toThrow(/must use HTTPS for non-loopback hosts/);
  });

  it("requires credentials for remote public origins and validates trusted proxy IPs", async () => {
    await expect(
      startShareServer({
        WEBBLACKBOX_SHARE_API_KEY: "",
        WEBBLACKBOX_SHARE_API_KEYS: "",
        WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: "https://shares.example.test"
      })
    ).rejects.toThrow(/credential is required for a non-loopback public origin/);

    await expect(
      startShareServer({
        WEBBLACKBOX_TRUSTED_PROXY_IPS: "not-an-ip"
      })
    ).rejects.toThrow(/contains an invalid IP address/);
  });

  it("denies protected routes from direct loopback clients when no credential is configured", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_SHARE_API_KEYS: ""
    });
    const requests = [
      ["GET", "/api/share/list"],
      ["POST", "/api/share/upload"],
      ["GET", "/api/share/example/meta"],
      ["GET", "/api/share/example/archive"],
      ["GET", "/share/example"],
      ["POST", "/api/share/example/revoke"]
    ] as const;

    for (const [method, pathname] of requests) {
      const response = await fetch(`${server.baseUrl}${pathname}`, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
    }
  });

  it("allows explicit development-only unauthenticated access from a loopback peer", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_SHARE_API_KEYS: "",
      WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK: "true"
    });

    const response = await fetch(`${server.baseUrl}/api/share/list`);

    expect(response.status).toBe(200);
    expect(server.logs.join("")).toContain(
      "WARNING: unauthenticated loopback development access is enabled"
    );
  });

  it("rejects the unauthenticated loopback development opt-out in proxy modes", async () => {
    const baseOverrides = {
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_SHARE_API_KEYS: "",
      WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK: "true"
    };

    await expect(
      startShareServer({
        ...baseOverrides,
        WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true"
      })
    ).rejects.toThrow(/must not be enabled with proxy or forwarded-client configuration/);

    await expect(
      startShareServer({
        ...baseOverrides,
        WEBBLACKBOX_TRUSTED_PROXY_IPS: "203.0.113.10"
      })
    ).rejects.toThrow(/must not be enabled with proxy or forwarded-client configuration/);
  });

  it("rejects the unauthenticated loopback development opt-out for public endpoints", async () => {
    const baseOverrides = {
      WEBBLACKBOX_SHARE_API_KEY: "",
      WEBBLACKBOX_SHARE_API_KEYS: "",
      WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK: "true",
      WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: "https://shares.example.test"
    };

    await expect(startShareServer(baseOverrides)).rejects.toThrow(
      /requires both a loopback bind host and loopback public origin/
    );

    await expect(
      startShareServer({
        ...baseOverrides,
        WEBBLACKBOX_SHARE_BIND_HOST: "0.0.0.0"
      })
    ).rejects.toThrow(/requires both a loopback bind host and loopback public origin/);

    await expect(
      startShareServer({
        ...baseOverrides,
        WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: "https://127.attacker.example"
      })
    ).rejects.toThrow(/requires both a loopback bind host and loopback public origin/);
  });

  it("derives forwarded clients from the first untrusted hop next to trusted proxies", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true"
    });
    const response = await fetch(`${server.baseUrl}/api/share/list`, {
      headers: {
        "x-webblackbox-api-key": apiKey,
        "x-forwarded-for": "198.51.100.99, 203.0.113.10"
      }
    });
    expect(response.status).toBe(200);

    const auditLog = await readFile(resolve(server.dataDir, "audit", "share-access.jsonl"), "utf8");
    const events = auditLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; clientHash: string });
    const expectedHash = createHash("sha256")
      .update("webblackbox-share-audit:ip:203.0.113.10")
      .digest("hex");
    const spoofedHash = createHash("sha256")
      .update("webblackbox-share-audit:ip:198.51.100.99")
      .digest("hex");
    expect(events.at(-1)).toMatchObject({ action: "list", clientHash: expectedHash });
    expect(events.at(-1)?.clientHash).not.toBe(spoofedHash);
  });

  it.each([
    ["expanded IPv6", "2001:0db8:0:0:0:0:0:1", "2001:db8::1"],
    ["IPv4-mapped IPv6", "0:0:0:0:0:ffff:c000:0201", "192.0.2.1"]
  ])(
    "canonicalizes %s trusted proxy addresses across equivalent spellings",
    async (_label, configuredProxy, forwardedProxy) => {
      const server = await startShareServer({
        WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "true",
        WEBBLACKBOX_TRUSTED_PROXY_IPS: configuredProxy
      });
      const clientAddress = "198.51.100.99";
      const response = await fetch(`${server.baseUrl}/api/share/list`, {
        headers: {
          "x-webblackbox-api-key": apiKey,
          "x-forwarded-for": `${clientAddress}, ${forwardedProxy}`
        }
      });
      expect(response.status).toBe(200);

      const auditLog = await readFile(resolve(server.dataDir, "audit/share-access.jsonl"), "utf8");
      const events = auditLog
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { action: string; clientHash: string });
      const expectedHash = createHash("sha256")
        .update(`webblackbox-share-audit:ip:${clientAddress}`)
        .digest("hex");
      expect(events.at(-1)).toMatchObject({ action: "list", clientHash: expectedHash });
    }
  );

  it("supports opt-in query API key bootstrap without propagating the key", async () => {
    const server = await startShareServer({
      WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY: "true"
    });
    const uploadPayload = await uploadEncryptedFixture(server);

    const redirectResponse = await fetch(
      `${server.baseUrl}/share/${uploadPayload.shareId}?key=${apiKey}`,
      {
        redirect: "manual"
      }
    );
    const cookie = readSetCookiePair(redirectResponse);

    expect(redirectResponse.status).toBe(303);
    expect(redirectResponse.headers.get("location")).toBe(`/share/${uploadPayload.shareId}`);
    expect(redirectResponse.headers.get("location")).not.toContain(apiKey);
    expect(cookie).toMatch(/^webblackbox_share_read=/);

    const pageResponse = await fetch(`${server.baseUrl}/share/${uploadPayload.shareId}`, {
      headers: {
        cookie
      }
    });
    const html = await pageResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(html).not.toContain("?key=");
    expect(html).not.toContain(apiKey);
  });
});

async function terminateShareServer(
  server: RunningShareServer
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return {
      code: server.child.exitCode,
      signal: server.child.signalCode
    };
  }

  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      server.child.kill("SIGKILL");
      reject(new Error(`share-server did not exit after SIGTERM: ${server.logs.join("")}`));
    }, 2_500);
    server.child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });

    if (!server.child.kill("SIGTERM")) {
      clearTimeout(timeout);
      reject(new Error("Failed to send SIGTERM to share-server."));
    }
  });
}

async function waitForAuditEvent(
  server: RunningShareServer,
  action: string,
  shareId: string
): Promise<void> {
  const auditPath = resolve(server.dataDir, "audit/share-access.jsonl");
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
      const found = lines.some((line) => {
        const event = JSON.parse(line) as { action?: string; shareId?: string };
        return event.action === action && event.shareId === shareId;
      });
      if (found) {
        return;
      }
    } catch {
      // Audit creation may still be in flight after the HTTP response completes.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  throw new Error(`Timed out waiting for ${action} audit event for ${shareId}.`);
}

async function createFullNamedPipe(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const fifoResult = spawnSync("mkfifo", [path]);
  if (fifoResult.status !== 0) {
    throw new Error(`Failed to create audit FIFO: ${String(fifoResult.stderr)}`);
  }

  const reader = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  const writer = await open(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
  const chunk = Buffer.alloc(4 * 1024, 0x78);

  try {
    for (let written = 0; written < 16 * 1024 * 1024; ) {
      try {
        const result = await writer.write(chunk);
        if (result.bytesWritten <= 0) {
          break;
        }
        written += result.bytesWritten;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ((error as Error & { code?: string }).code === "EAGAIN" ||
            (error as Error & { code?: string }).code === "EWOULDBLOCK")
        ) {
          return reader;
        }
        throw error;
      }
    }
  } catch (error) {
    await reader.close();
    throw error;
  } finally {
    await writer.close();
  }

  await reader.close();
  throw new Error("Failed to fill audit FIFO before the safety limit.");
}

async function startShareServer(
  envOverrides: Record<string, string> = {},
  existingDataDir?: string
): Promise<RunningShareServer> {
  const port = await reservePort();
  const dataDir = existingDataDir ?? (await mkdtemp(resolve(tmpdir(), "webblackbox-share-test-")));
  const child = spawn(process.execPath, [tsxCli, resolve(appRoot, "src/index.ts")], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WEBBLACKBOX_SHARE_API_KEY: apiKey,
      WEBBLACKBOX_SHARE_API_KEYS: "",
      WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK: "false",
      WEBBLACKBOX_SHARE_BIND_HOST: "127.0.0.1",
      WEBBLACKBOX_SHARE_PUBLIC_ORIGIN: "",
      WEBBLACKBOX_SHARE_DATA_DIR: dataDir,
      WEBBLACKBOX_TRUST_X_FORWARDED_FOR: "false",
      WEBBLACKBOX_TRUSTED_PROXY_IPS: "",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const server: RunningShareServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    dataDir,
    logs: []
  };

  child.stdout?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    server.logs.push(String(chunk));
  });
  runningServers.push(server);

  await waitForShareServer(server);
  return server;
}

async function stopShareServer(server: RunningShareServer, removeData = true): Promise<void> {
  if (server.child.exitCode === null && !server.child.killed) {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      server.child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  if (!removeData) {
    runningServers = runningServers.filter((candidate) => candidate !== server);
  }

  if (removeData) {
    await rm(server.dataDir, {
      recursive: true,
      force: true
    });
  }
}

async function waitForShareServer(server: RunningShareServer): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `share-server exited early with ${server.child.exitCode}: ${server.logs.join("")}`
      );
    }

    try {
      await fetch(`${server.baseUrl}/api/share/list`, {
        headers: {
          "x-webblackbox-api-key": apiKey
        }
      });

      return;
    } catch {
      // retry until the process binds the port
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`share-server did not become ready: ${server.logs.join("")}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a local TCP port.");
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });

  return address.port;
}

function readSetCookiePair(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uploadEncryptedFixture(
  server: RunningShareServer,
  credential = apiKey
): Promise<{ shareId: string }> {
  const archive = await createEncryptedEnvelopeArchive();
  const response = await fetch(`${server.baseUrl}/api/share/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-webblackbox-api-key": credential,
      "x-webblackbox-filename": "fixture.webblackbox",
      "x-webblackbox-share-summary": encodeURIComponent(
        JSON.stringify(buildPassedShareSummary(archive))
      )
    },
    body: Buffer.from(archive)
  });

  expect(response.status).toBe(201);
  return (await response.json()) as { shareId: string };
}

function buildPersistedServerSummary(
  clientSummary: Record<string, unknown>
): Record<string, unknown> {
  const envelopeTotals = clientSummary.totals as Record<string, unknown>;
  const clientClaim = clientSummary.clientClaim as Record<string, unknown>;

  return {
    schemaVersion: 2,
    source: "server",
    analyzed: true,
    encrypted: clientSummary.encrypted,
    trust: {
      archiveEnvelope: "server-inspected",
      privateContent: "server-analyzed"
    },
    manifest: clientSummary.manifest,
    totals: {
      events: envelopeTotals.events,
      blobs: envelopeTotals.blobs,
      privacyViolations: 0,
      errors: 0,
      requests: 0,
      actions: 0,
      durationMs: envelopeTotals.durationMs
    },
    topActionTriggers: [],
    privacy: clientClaim.privacy
  };
}

function buildPassedShareSummary(archive: Uint8Array): unknown {
  return {
    schemaVersion: 2,
    source: "client",
    archiveSha256: sha256Hex(archive),
    analyzed: true,
    encrypted: true,
    manifest: {
      mode: "lite",
      chunkCodec: "none",
      recordedAt: "2026-02-13T00:00:00.000Z"
    },
    totals: {
      events: 0,
      errors: 0,
      requests: 0,
      actions: 0,
      durationMs: 0
    },
    privacy: {
      redaction: {
        hashSensitiveValues: true,
        headerRuleCount: 0,
        cookieRuleCount: 0,
        bodyPatternCount: 0,
        blockedSelectorCount: 0
      },
      detected: {
        redactedMarkers: 0,
        hashedSensitiveValues: 0,
        sensitiveKeyMentions: 0
      },
      scanner: {
        preEncryption: true,
        status: "passed",
        findingCount: 0
      }
    }
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createEncryptedEnvelopeArchive(
  options: {
    completeEncryptionMap?: boolean;
    privateFileMode?: "ciphertext" | "plaintext";
    blobFileMode?: "ciphertext" | "plaintext";
    textBlobFileMode?: "ciphertext" | "plaintext";
    plaintextPrefixBytes?: number;
  } = {}
): Promise<Uint8Array> {
  return createEnvelopeArchive(true, options);
}

async function createPlaintextEnvelopeArchive(): Promise<Uint8Array> {
  return createEnvelopeArchive(false);
}

async function createLargeEncryptedEnvelopeArchive(blobBytes: number): Promise<Uint8Array> {
  const source = await createEncryptedEnvelopeArchive();
  const zip = await JSZip.loadAsync(source);
  const integrityFile = zip.file("integrity/hashes.json");
  if (!integrityFile) {
    throw new Error("Missing fixture integrity manifest.");
  }

  const integrity = JSON.parse(await integrityFile.async("string")) as {
    manifestSha256: string;
    files: Record<string, string>;
  };
  const ciphertext = randomBytes(blobBytes);
  zip.file(BLOB_FIXTURE_PATH, ciphertext);
  integrity.files[BLOB_FIXTURE_PATH] = createHash("sha256").update(ciphertext).digest("hex");
  zip.file("integrity/hashes.json", JSON.stringify(integrity));
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

async function createEnvelopeArchive(
  encrypted: boolean,
  options: {
    completeEncryptionMap?: boolean;
    privateFileMode?: "ciphertext" | "plaintext";
    blobFileMode?: "ciphertext" | "plaintext";
    textBlobFileMode?: "ciphertext" | "plaintext";
    plaintextPrefixBytes?: number;
  } = {}
): Promise<Uint8Array> {
  const zip = new JSZip();
  const files: Record<string, string> = {};
  const encryptedFiles =
    encrypted && options.completeEncryptionMap !== false
      ? {
          "index/time.json": { ivBase64: toBase64(randomBytes(12)) },
          "index/req.json": { ivBase64: toBase64(randomBytes(12)) },
          "index/inv.json": { ivBase64: toBase64(randomBytes(12)) },
          [BLOB_FIXTURE_PATH]: { ivBase64: toBase64(randomBytes(12)) },
          [TEXT_BLOB_FIXTURE_PATH]: { ivBase64: toBase64(randomBytes(12)) }
        }
      : encrypted
        ? {
            "index/req.json": { ivBase64: toBase64(randomBytes(12)) }
          }
        : {};
  const manifest = {
    protocolVersion: 1,
    createdAt: "2026-02-13T00:00:00.000Z",
    mode: "lite",
    site: {
      origin: "https://fixture.example",
      title: "Fixture"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: 0,
      chunkCount: 0,
      blobCount: 2,
      durationMs: 0
    },
    ...(encrypted
      ? {
          encryption: {
            algorithm: "AES-GCM",
            kdf: {
              name: "PBKDF2",
              hash: "SHA-256",
              iterations: 250000,
              saltBase64: "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            files: encryptedFiles
          }
        }
      : {})
  };

  addJsonFile(zip, files, "manifest.json", manifest);
  addPrivateFile(
    zip,
    files,
    "index/time.json",
    [],
    encrypted,
    options.privateFileMode,
    options.plaintextPrefixBytes
  );
  addPrivateFile(
    zip,
    files,
    "index/req.json",
    [],
    encrypted,
    options.privateFileMode,
    options.plaintextPrefixBytes
  );
  addPrivateFile(
    zip,
    files,
    "index/inv.json",
    [],
    encrypted,
    options.privateFileMode,
    options.plaintextPrefixBytes
  );
  addPrivateFile(
    zip,
    files,
    BLOB_FIXTURE_PATH,
    { token: "blob-secret-token" },
    encrypted,
    options.blobFileMode,
    options.plaintextPrefixBytes
  );
  addPrivateFile(
    zip,
    files,
    TEXT_BLOB_FIXTURE_PATH,
    "plain-text-secret-token",
    encrypted,
    options.textBlobFileMode,
    options.plaintextPrefixBytes
  );
  addJsonFile(zip, files, "integrity/hashes.json", {
    manifestSha256: files["manifest.json"],
    files
  });

  return zip.generateAsync({ type: "uint8array" });
}

function addJsonFile(
  zip: JSZip,
  files: Record<string, string>,
  path: string,
  value: unknown
): void {
  const content = JSON.stringify(value);
  zip.file(path, content);

  if (path !== "integrity/hashes.json") {
    files[path] = createHash("sha256").update(content).digest("hex");
  }
}

function addPrivateFile(
  zip: JSZip,
  files: Record<string, string>,
  path: string,
  value: unknown,
  encrypted: boolean,
  mode: "ciphertext" | "plaintext" = "ciphertext",
  plaintextPrefixBytes = 0
): void {
  const content = Buffer.from(JSON.stringify(value));
  const bytes =
    encrypted && mode === "ciphertext"
      ? randomBytes(Math.max(32, content.byteLength + 16))
      : Buffer.concat([Buffer.alloc(plaintextPrefixBytes, 0x20), content]);

  zip.file(path, bytes);
  files[path] = createHash("sha256").update(bytes).digest("hex");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

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
