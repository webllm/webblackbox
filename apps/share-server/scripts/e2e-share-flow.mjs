#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");
const apiKey = "share-e2e-key";
const port = Number(process.env.WEBBLACKBOX_SHARE_E2E_PORT ?? "8789");
const baseUrl = `http://127.0.0.1:${port}`;

let child = null;
let dataDir = null;

main().catch(async (error) => {
  console.error("Share E2E failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  dataDir = await mkdtemp(resolve(tmpdir(), "webblackbox-share-e2e-"));
  child = spawn(process.execPath, [resolve(appRoot, "dist/index.js")], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WEBBLACKBOX_SHARE_DATA_DIR: dataDir,
      WEBBLACKBOX_SHARE_API_KEY: apiKey,
      WEBBLACKBOX_SHARE_BIND_HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`share-server exited with ${code}`);
    }
  });

  await waitForServer();
  const archive = await createFixtureArchive();
  const upload = await fetchJson(`${baseUrl}/api/share/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-webblackbox-api-key": apiKey,
      "x-webblackbox-filename": "share-flow.webblackbox"
    },
    body: archive
  });

  assert(typeof upload.shareId === "string", "Upload did not return shareId", upload);
  assert(upload.summary?.privacy, "Upload summary missing privacy preflight", upload);
  assert(
    upload.summary?.sensitivePreview?.totalMatches >= 1,
    "Upload summary missing sensitive preview",
    upload
  );

  const meta = await fetchJson(`${baseUrl}/api/share/${upload.shareId}/meta`, {
    headers: {
      "x-webblackbox-api-key": apiKey
    }
  });
  assert(
    meta.summary?.privacy?.redaction?.headers?.includes("authorization"),
    "Metadata redaction summary missing",
    meta
  );

  const archiveResponse = await fetch(`${baseUrl}/api/share/${upload.shareId}/archive`, {
    headers: {
      "x-webblackbox-api-key": apiKey
    }
  });
  assert(archiveResponse.ok, "Archive download failed", { status: archiveResponse.status });
  assert(
    Number(archiveResponse.headers.get("content-length") ?? "0") > 0,
    "Archive download empty"
  );

  console.log("Share E2E passed.");
  await cleanup();
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/share/list?key=${encodeURIComponent(apiKey)}`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("share-server did not become ready");
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }
  return JSON.parse(text);
}

async function createFixtureArchive() {
  const zip = new JSZip();
  const events = [
    {
      v: 1,
      sid: "S-share-e2e",
      tab: 1,
      t: 1,
      mono: 1,
      type: "network.request",
      id: "E-share-1",
      data: {
        reqId: "R-share",
        url: "https://share.example.test/api?token=[redacted]",
        method: "POST",
        headers: {
          authorization: "[REDACTED]"
        }
      }
    }
  ];
  const manifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "lite",
    site: {
      origin: "https://share.example.test"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: ["authorization"],
      redactCookieNames: ["session"],
      redactBodyPatterns: ["token"],
      blockedSelectors: ["[data-webblackbox-redact]"],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 0,
      durationMs: 1
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file("index/req.json", JSON.stringify([{ reqId: "R-share", eventIds: ["E-share-1"] }]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file("events/chunk-share.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));
  await writeIntegrity(zip);
  return zip.generateAsync({ type: "uint8array" });
}

async function writeIntegrity(zip) {
  const files = {};
  for (const path of Object.keys(zip.files).sort()) {
    if (path === "integrity/hashes.json") {
      continue;
    }
    const file = zip.file(path);
    if (file) {
      files[path] = createHash("sha256")
        .update(await file.async("uint8array"))
        .digest("hex");
    }
  }
  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"], files }, null, 2)
  );
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? ` | ${JSON.stringify(details)}` : ""}`);
  }
}

async function cleanup() {
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
}
