#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const root = dirname(fileURLToPath(import.meta.url));
const playerRoot = resolve(root, "..");
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(playerRoot, "build");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-player-playback-profile-${Date.now()}`;
const artifactsDir =
  process.env.WB_E2E_ARTIFACTS_DIR ?? `/tmp/webblackbox-player-playback-artifacts-${Date.now()}`;
const chromeLogPath =
  process.env.WB_E2E_LOG ?? `/tmp/webblackbox-player-playback-${Date.now()}.log`;
const chromeReadyTimeoutMs = Number(process.env.WB_E2E_CHROME_READY_TIMEOUT_MS ?? "25000");
const chromeLaunchAttempts = Number(process.env.WB_E2E_CHROME_LAUNCH_ATTEMPTS ?? "2");
const requestedRemotePort = process.env.WB_E2E_REMOTE_PORT
  ? Number(process.env.WB_E2E_REMOTE_PORT)
  : null;

const chromeCandidates = [
  process.env.WB_E2E_CHROME_BIN,
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium"
].filter(Boolean);

const state = {
  chromeProcess: null,
  logStream: null,
  client: null,
  targetId: null,
  baseUrl: null,
  server: null
};

main().catch(async (error) => {
  console.error(
    "Player playback regression E2E failed:",
    error instanceof Error ? error.message : String(error)
  );
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureBuildInputs();
  await mkdir(artifactsDir, { recursive: true });

  const archivePath = resolve(artifactsDir, "mixed-mono-playback.webblackbox");
  await writeFile(archivePath, await createMixedMonoArchive());

  const server = await startPlayerServer(playerDir);
  state.server = server.server;

  const playerUrl = `http://127.0.0.1:${server.port}/`;
  const chromeBinary = await resolveChromeBinary(chromeCandidates);
  const chrome = await launchChromeWithRetry(chromeBinary, {
    profileDir,
    requestedRemotePort,
    headless,
    logPath: chromeLogPath,
    attempts: Math.max(1, Math.floor(chromeLaunchAttempts)),
    readyTimeoutMs: Math.max(10_000, Math.floor(chromeReadyTimeoutMs))
  });

  state.chromeProcess = chrome.proc;
  state.logStream = chrome.logStream;
  state.baseUrl = chrome.baseUrl;

  const target = await openTarget(chrome.baseUrl, playerUrl);
  state.targetId = target.id;

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  state.client = client;

  await client.send("Runtime.enable");
  await client.send("DOM.enable");

  const runtimeExceptions = [];
  client.on("Runtime.exceptionThrown", (params) => {
    runtimeExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  await waitForPlayerReady(client, 20_000);
  await loadArchiveFile(client, archivePath);

  const loaded = await waitForPlaybackRegressionSnapshot(client, 25_000);
  assert(
    loaded.progressMax >= 2_350 && loaded.progressMax <= 2_450,
    "Playback duration was not normalized to the wall-clock timeline",
    loaded
  );
  assert(loaded.totalText === "2.40s", "Unexpected playback total label", loaded);
  assert(loaded.markerCounts.network >= 1, "Missing network progress marker", loaded);
  assert(loaded.markerCounts.screenshot >= 2, "Missing screenshot progress markers", loaded);
  assert(loaded.markerCounts.action >= 2, "Missing user action progress markers", loaded);
  assert(loaded.markerCounts.error >= 1, "Missing error progress marker", loaded);
  assert(
    markerInRange(loaded.markers, "network", 18, 24),
    "Network marker is not positioned on the normalized timeline",
    loaded
  );
  assert(
    markerInRange(loaded.markers, "screenshot", 39, 44) &&
      markerInRange(loaded.markers, "screenshot", 90, 94),
    "Screenshot markers are not positioned on the normalized timeline",
    loaded
  );
  assert(
    markerInRange(loaded.markers, "action", 8, 13) &&
      markerInRange(loaded.markers, "action", 75, 80),
    "Action markers are not positioned on the normalized timeline",
    loaded
  );

  const playback = await playUntilScreenshotMarkerVisible(client, 8_000);
  assert(
    playback.progressValue >= 950 && playback.progressValue <= loaded.progressMax,
    "Playback did not advance across the first screenshot",
    playback
  );
  assert(playback.cursorVisible, "Screenshot pointer marker was not visible during playback", {
    loaded,
    playback
  });
  assert(playback.trailSegments > 0, "Screenshot pointer trail was not visible during playback", {
    loaded,
    playback
  });

  const hover = await verifyProgressHoverResponse(client, 12_000);
  assert(hover.responseVisible, "Network hover response preview did not open", hover);
  assert(hover.bodyText.includes("fixture"), "Network hover response body is unexpected", hover);
  assert(hover.toggleEnabled, "JSON response hover toggle is disabled", hover);

  const playwright = await verifyPlaywrightPreview(client, 10_000);
  assert(playwright.open, "Playwright preview dialog did not open", playwright);
  assert(
    playwright.script.includes('await page.goto("https://example.test");'),
    "Playwright preview did not include the archive origin",
    playwright
  );
  assert(
    playwright.script.includes('await page.click("button.submit");') &&
      playwright.script.includes('await page.fill("input[name=query]", "mixed mono");'),
    "Playwright preview did not include normalized user actions",
    playwright
  );

  if (runtimeExceptions.length > 0) {
    throw new Error(`Player page runtime exceptions: ${JSON.stringify(runtimeExceptions)}`);
  }

  console.log("Player URL:", playerUrl);
  console.log("Archive:", archivePath);
  console.log("Timeline:", JSON.stringify(loaded));
  console.log("Playback:", JSON.stringify(playback));
  console.log("Hover:", JSON.stringify(hover));
  console.log(
    "Playwright preview:",
    JSON.stringify({
      open: playwright.open,
      length: playwright.script.length
    })
  );
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Player playback regression E2E passed.");

  await cleanup();
}

async function createMixedMonoArchive() {
  const zip = new JSZip();
  const textEncoder = new TextEncoder();
  const base = 1_700_000_000_000;
  const screenshotBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
  const responseBytes = textEncoder.encode(
    JSON.stringify({
      ok: true,
      fixture: "mixed-mono-player-regression",
      items: [1, 2, 3]
    })
  );
  const screenshotHash = sha256Hex(screenshotBytes);
  const responseHash = sha256Hex(responseBytes);
  const events = [
    event("E-000", base, 0, "meta.session.start", {
      url: "https://example.test"
    }),
    event(
      "E-010",
      base + 250,
      250,
      "user.click",
      {
        x: 210,
        y: 180,
        button: 0,
        target: {
          selector: "button.submit",
          text: "Submit"
        }
      },
      {
        act: "A-submit"
      }
    ),
    event(
      "E-020",
      base + 360,
      360,
      "user.input",
      {
        value: "mixed mono",
        target: {
          selector: "input[name=query]"
        }
      },
      {
        act: "A-submit"
      }
    ),
    event(
      "E-030",
      base + 500,
      base + 900_000,
      "network.request",
      {
        reqId: "R-mixed",
        url: "https://example.test/api/search?q=mixed",
        method: "POST",
        resourceType: "fetch",
        headers: {
          "content-type": "application/json"
        },
        postDataSize: 22
      },
      {
        act: "A-submit",
        req: "R-mixed"
      }
    ),
    event(
      "E-040",
      base + 820,
      base + 900_320,
      "network.response",
      {
        reqId: "R-mixed",
        status: 200,
        statusText: "OK",
        mimeType: "application/json",
        encodedDataLength: responseBytes.byteLength,
        headers: {
          "content-type": "application/json"
        }
      },
      {
        act: "A-submit",
        req: "R-mixed"
      }
    ),
    event(
      "E-050",
      base + 860,
      base + 900_360,
      "network.body",
      {
        reqId: "R-mixed",
        contentHash: responseHash,
        size: responseBytes.byteLength
      },
      {
        act: "A-submit",
        req: "R-mixed"
      }
    ),
    event("E-060", base + 900, 900, "user.mousemove", {
      x: 320,
      y: 210
    }),
    event(
      "E-070",
      base + 1_000,
      base + 901_000,
      "screen.screenshot",
      {
        shotId: screenshotHash,
        format: "png",
        w: 800,
        h: 600,
        size: screenshotBytes.byteLength,
        reason: "after-network",
        viewport: {
          width: 800,
          height: 600,
          dpr: 1
        },
        pointer: {
          x: 330,
          y: 218,
          t: base + 1_000,
          mono: base + 901_000
        }
      },
      {
        shot: screenshotHash
      }
    ),
    event("E-080", base + 1_250, 1_250, "console.entry", {
      level: "info",
      source: "console-api",
      text: "mixed mono fixture loaded"
    }),
    event("E-090", base + 1_500, base + 901_500, "error.exception", {
      message: "Synthetic fixture error",
      name: "Error",
      stack: "Error: Synthetic fixture error"
    }),
    event("E-100", base + 1_650, 1_650, "user.mousemove", {
      x: 420,
      y: 260
    }),
    event(
      "E-110",
      base + 1_850,
      1_850,
      "user.click",
      {
        x: 455,
        y: 286,
        button: 0,
        target: {
          selector: "button.confirm",
          text: "Confirm"
        }
      },
      {
        act: "A-confirm"
      }
    ),
    event(
      "E-120",
      base + 2_200,
      base + 902_200,
      "screen.screenshot",
      {
        shotId: screenshotHash,
        format: "png",
        w: 800,
        h: 600,
        size: screenshotBytes.byteLength,
        reason: "after-confirm",
        viewport: {
          width: 800,
          height: 600,
          dpr: 1
        },
        pointer: {
          x: 455,
          y: 286,
          t: base + 2_200,
          mono: base + 902_200
        }
      },
      {
        act: "A-confirm",
        shot: screenshotHash
      }
    ),
    event("E-130", base + 2_400, 2_400, "meta.session.end", {
      reason: "complete"
    })
  ];
  const ndjson = `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const chunkBytes = textEncoder.encode(ndjson);
  const chunkHash = sha256Hex(chunkBytes);
  const rawMonos = events.map((entry) => entry.mono);
  const wallTimes = events.map((entry) => entry.t);
  const timeIndex = [
    {
      chunkId: "C-000001",
      seq: 1,
      tStart: Math.min(...wallTimes),
      tEnd: Math.max(...wallTimes),
      monoStart: Math.min(...rawMonos),
      monoEnd: Math.max(...rawMonos),
      eventCount: events.length,
      byteLength: chunkBytes.byteLength,
      codec: "none",
      sha256: chunkHash
    }
  ];
  const manifest = {
    protocolVersion: 1,
    createdAt: new Date(base).toISOString(),
    mode: "full",
    site: {
      origin: "https://example.test",
      title: "Mixed Mono Playback Fixture"
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
      eventCount: events.length,
      chunkCount: 1,
      blobCount: 2,
      durationMs: 2_400
    }
  };

  zip.file("events/C-000001.ndjson", chunkBytes);
  zip.file("index/time.json", JSON.stringify(timeIndex, null, 2));
  zip.file(
    "index/req.json",
    JSON.stringify(
      [
        {
          reqId: "R-mixed",
          eventIds: ["E-030", "E-040", "E-050"]
        }
      ],
      null,
      2
    )
  );
  zip.file("index/inv.json", JSON.stringify([], null, 2));
  zip.file(`blobs/sha256-${responseHash}.json`, responseBytes);
  zip.file(`blobs/sha256-${screenshotHash}.png`, screenshotBytes);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  await writeIntegrityManifest(zip);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    }
  });
}

function event(id, t, mono, type, data, ref = undefined) {
  return {
    v: 1,
    sid: "S-player-mixed-mono",
    tab: 1,
    t,
    mono,
    type,
    id,
    ...(ref ? { ref } : {}),
    data
  };
}

async function writeIntegrityManifest(zip) {
  const fileHashes = {};

  for (const path of Object.keys(zip.files).sort()) {
    if (path === "integrity/hashes.json") {
      continue;
    }

    const file = zip.file(path);

    if (!file) {
      continue;
    }

    fileHashes[path] = sha256Hex(await file.async("uint8array"));
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify(
      {
        manifestSha256: fileHashes["manifest.json"] ?? "",
        files: fileHashes
      },
      null,
      2
    )
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function ensureBuildInputs() {
  await access(playerDir, constants.R_OK);
  await access(resolve(playerDir, "index.html"), constants.R_OK);
  await access(resolve(playerDir, "main.js"), constants.R_OK);
}

async function startPlayerServer(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath =
        decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      await serveStatic(response, rootDir, relativePath);
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local player server address.");
  }

  return {
    server,
    port: address.port
  };
}

async function serveStatic(response, rootDir, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  const resolved = resolve(rootDir, safeRelative);
  const guardedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;

  if (resolved !== rootDir && !resolved.startsWith(guardedRoot)) {
    writeJson(response, 403, {
      ok: false,
      error: "path-traversal"
    });
    return;
  }

  let filePath = resolved;

  try {
    const info = await stat(filePath);

    if (info.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  let bytes;

  try {
    bytes = await readFile(filePath);
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: "asset-not-found",
      path: relativePath
    });
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypeFor(filePath),
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : "index.html";
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".ico") {
    return "image/x-icon";
  }

  if (extension === ".map") {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}

function writeJson(response, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);

    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Unable to find Chrome. Set WB_E2E_CHROME_BIN to a Chrome or Chromium executable."
  );
}

async function resolveExecutable(candidate) {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();

  if (!trimmed) {
    return null;
  }

  if (isAbsolute(trimmed) || trimmed.startsWith(".")) {
    try {
      await access(trimmed, constants.X_OK);
      return trimmed;
    } catch {
      return null;
    }
  }

  const which = spawnSync("which", [trimmed], {
    encoding: "utf8"
  });

  if (which.status !== 0) {
    return null;
  }

  const resolved = which.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!resolved) {
    return null;
  }

  try {
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

async function launchChromeWithRetry(binary, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const attemptProfileDir =
      attempt === 1 ? options.profileDir : `${options.profileDir}-retry-${attempt}`;
    const attemptLogPath =
      attempt === 1
        ? options.logPath
        : options.logPath.replace(/(\.[^.]+)?$/, `-retry-${attempt}$1`);

    await rm(attemptProfileDir, { recursive: true, force: true });
    await mkdir(attemptProfileDir, { recursive: true });

    const remotePort =
      attempt === 1 && Number.isFinite(options.requestedRemotePort)
        ? options.requestedRemotePort
        : await reserveEphemeralPort();
    const baseUrl = `http://127.0.0.1:${remotePort}`;
    const { proc, logStream } = startChrome(binary, {
      profileDir: attemptProfileDir,
      remotePort,
      headless: options.headless,
      logPath: attemptLogPath
    });

    try {
      const version = await waitForChromeReady(baseUrl, options.readyTimeoutMs, {
        proc,
        logPath: attemptLogPath
      });
      return {
        proc,
        logStream,
        baseUrl,
        remotePort,
        profileDir: attemptProfileDir,
        version
      };
    } catch (error) {
      lastError = error;
      await terminateChromeProcess(proc);
      logStream.end();

      if (attempt < options.attempts) {
        console.warn(
          `Chrome launch attempt ${attempt} failed; retrying with a fresh profile. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function startChrome(binary, options) {
  const args = [
    `--remote-debugging-port=${options.remotePort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--window-size=1400,1000",
    "--enable-logging=stderr",
    "about:blank"
  ];

  if (options.headless) {
    args.unshift("--headless=new");
  }

  if (process.platform === "linux") {
    args.unshift("--disable-dev-shm-usage");
    args.unshift("--disable-setuid-sandbox");
    args.unshift("--no-sandbox");
  }

  const proc = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logStream = createWriteStream(options.logPath, { flags: "a" });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`Chrome exited with code ${code}.`);
    }

    if (signal) {
      console.warn(`Chrome exited via signal ${signal}.`);
    }
  });

  return {
    proc,
    logStream
  };
}

async function waitForChromeReady(urlBase, timeoutMs, context = undefined) {
  try {
    return await waitFor(
      async () => {
        if (context?.proc?.exitCode !== null && context?.proc?.exitCode !== undefined) {
          throw new Error(
            `Chrome exited before DevTools was ready (exitCode=${context.proc.exitCode}).`
          );
        }

        if (context?.proc?.signalCode) {
          throw new Error(
            `Chrome exited before DevTools was ready (signalCode=${context.proc.signalCode}).`
          );
        }

        const version = await fetchJson(`${urlBase}/json/version`, 4_000);
        return version?.Browser ? version : null;
      },
      timeoutMs,
      250,
      "Chrome DevTools endpoint not ready"
    );
  } catch (error) {
    const logTail = context?.logPath ? await readLogTail(context.logPath, 40).catch(() => "") : "";
    const suffix = logTail ? `\nChrome log tail:\n${logTail}` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${suffix}`);
  }
}

async function readLogTail(path, maxLines) {
  const content = await readFile(path, "utf8");
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return lines.slice(-maxLines).join("\n");
}

async function reserveEphemeralPort() {
  const server = createNetServer();

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve an ephemeral port.");
  }

  const port = address.port;

  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });

  return port;
}

async function openTarget(urlBase, url) {
  const target = await fetchJson(`${urlBase}/json/new?${encodeURIComponent(url)}`, 6_000, {
    method: "PUT"
  });

  if (!target?.id || !target?.webSocketDebuggerUrl) {
    throw new Error(`Failed to open target: ${url}`);
  }

  return target;
}

async function closeTarget(urlBase, targetId) {
  try {
    await fetchJson(`${urlBase}/json/close/${targetId}`, 4_000);
  } catch {
    // Ignore cleanup failures after the browser has already started shutting down.
  }
}

async function waitForPlayerReady(client, timeoutMs) {
  return waitFor(
    async () => {
      const ready = await client.evaluate(`
        (() => Boolean(document.querySelector('#archive-input')))()
      `);
      return ready ? true : null;
    },
    timeoutMs,
    250,
    "Player UI not ready"
  );
}

async function loadArchiveFile(client, archivePath) {
  const runtimeResult = await client.send("Runtime.evaluate", {
    expression: "document.querySelector('#archive-input')",
    returnByValue: false,
    awaitPromise: false
  });
  const objectId = runtimeResult?.result?.objectId;

  if (!objectId) {
    throw new Error("File input not found: #archive-input");
  }

  await client.send("DOM.setFileInputFiles", {
    files: [archivePath],
    objectId
  });
  await client.evaluate(`
    (() => {
      const input = document.querySelector('#archive-input');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

async function waitForPlaybackRegressionSnapshot(client, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await client.evaluate(`
        (() => {
          const progress = document.getElementById('playback-progress');
          const preview = document.getElementById('filmstrip-preview');
          const cursor = document.getElementById('filmstrip-cursor');
          const eventCount = document.querySelectorAll('#timeline-list .event').length;
          const markers = Array.from(document.querySelectorAll('#playback-markers button')).map(
            (marker) => ({
              kind: marker.getAttribute('data-marker-kind') || '',
              mono: Number(marker.getAttribute('data-marker-mono')),
              left: Number.parseFloat(marker.style.left || '')
            })
          );
          const markerCounts = markers.reduce(
            (counts, marker) => {
              counts[marker.kind] = (counts[marker.kind] || 0) + 1;
              return counts;
            },
            { error: 0, network: 0, screenshot: 0, action: 0 }
          );
          const screenshotButtons = document.querySelectorAll(
            '#filmstrip-list button[data-shot-event]'
          ).length;
          const trailSegments = document.querySelectorAll(
            '#filmstrip-trail-svg .preview-trail-line, #filmstrip-trail-svg .preview-trail-point'
          ).length;

          return {
            eventCount,
            progressMax: Number(progress?.max ?? NaN),
            progressValue: Number(progress?.value ?? NaN),
            totalText: (document.getElementById('playback-total')?.textContent || '').trim(),
            currentText: (document.getElementById('playback-current')?.textContent || '').trim(),
            markerCounts,
            markers,
            screenshotButtons,
            cursorVisible: Boolean(cursor && !cursor.hidden),
            trailSegments,
            previewLoaded: Boolean(
              preview &&
                !preview.hidden &&
                preview.complete &&
                preview.naturalWidth > 0 &&
                preview.naturalHeight > 0
            ),
            filmstripMeta: (document.getElementById('filmstrip-meta')?.textContent || '').trim(),
            waterfallRows: document.querySelectorAll('#waterfall-body tr').length
          };
        })()
      `);

      if (
        !snapshot ||
        snapshot.eventCount < 10 ||
        !Number.isFinite(snapshot.progressMax) ||
        snapshot.markerCounts.network < 1 ||
        snapshot.markerCounts.screenshot < 2 ||
        snapshot.markerCounts.action < 2 ||
        snapshot.screenshotButtons < 2 ||
        !snapshot.previewLoaded ||
        !snapshot.cursorVisible ||
        snapshot.trailSegments <= 0 ||
        snapshot.waterfallRows < 1
      ) {
        return null;
      }

      return snapshot;
    },
    timeoutMs,
    250,
    "Player did not render the normalized playback fixture"
  );
}

async function playUntilScreenshotMarkerVisible(client, timeoutMs) {
  const started = await client.evaluate(`
    (() => {
      const toggle = document.getElementById('playback-toggle');
      if (!toggle) {
        return { ok: false, reason: 'missing-toggle' };
      }
      toggle.click();
      return {
        ok: true,
        value: Number(document.getElementById('playback-progress')?.value ?? NaN)
      };
    })()
  `);

  if (!started?.ok) {
    throw new Error(`Failed to start playback: ${JSON.stringify(started)}`);
  }

  try {
    return await waitFor(
      async () => {
        const snapshot = await client.evaluate(`
          (() => {
            const progress = document.getElementById('playback-progress');
            const cursor = document.getElementById('filmstrip-cursor');
            const trailSegments = document.querySelectorAll(
              '#filmstrip-trail-svg .preview-trail-line, #filmstrip-trail-svg .preview-trail-point'
            ).length;
            return {
              progressValue: Number(progress?.value ?? NaN),
              progressMax: Number(progress?.max ?? NaN),
              currentText: (document.getElementById('playback-current')?.textContent || '').trim(),
              totalText: (document.getElementById('playback-total')?.textContent || '').trim(),
              cursorVisible: Boolean(cursor && !cursor.hidden),
              trailSegments,
              toggleText: (document.getElementById('playback-toggle')?.textContent || '').trim()
            };
          })()
        `);

        if (
          !snapshot ||
          !Number.isFinite(snapshot.progressValue) ||
          snapshot.progressValue < 950 ||
          !snapshot.cursorVisible ||
          snapshot.trailSegments <= 0
        ) {
          return null;
        }

        return snapshot;
      },
      timeoutMs,
      100,
      "Playback did not advance to a screenshot marker"
    );
  } finally {
    await client
      .evaluate(
        `
      (() => {
        const toggle = document.getElementById('playback-toggle');
        if (toggle && (toggle.textContent || '').trim() === 'Pause') {
          toggle.click();
        }
      })()
    `
      )
      .catch(() => undefined);
  }
}

async function verifyProgressHoverResponse(client, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await client.evaluate(`
        (() => {
          const marker = document.querySelector(
            '#playback-markers button[data-marker-kind="network"]'
          );
          const hover = document.getElementById('progress-hover');
          const response = document.getElementById('progress-hover-response');
          const body = document.getElementById('progress-hover-response-body');
          const toggle = document.getElementById('progress-hover-response-toggle');
          const copy = document.getElementById('progress-hover-response-copy');

          if (!marker || !hover || !response || !body || !toggle || !copy) {
            return null;
          }

          const readSnapshot = () => ({
            responseVisible: !hover.hidden && !response.hidden,
            bodyText: (body.textContent || '').trim(),
            toggleEnabled: !toggle.disabled,
            copyEnabled: !copy.disabled,
            meta: (document.getElementById('progress-hover-response-meta')?.textContent || '').trim()
          });
          const current = readSnapshot();

          if (current.responseVisible && current.bodyText.includes('fixture')) {
            return current;
          }

          const rect = marker.getBoundingClientRect();
          marker.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerType: 'mouse',
              clientX: rect.left + Math.max(1, rect.width / 2),
              clientY: rect.top + Math.max(1, rect.height / 2)
            })
          );

          return readSnapshot();
        })()
      `);

      if (
        !snapshot?.responseVisible ||
        !snapshot.bodyText.includes("fixture") ||
        !snapshot.toggleEnabled
      ) {
        return null;
      }

      return snapshot;
    },
    timeoutMs,
    200,
    "Progress hover response preview did not render"
  );
}

async function verifyPlaywrightPreview(client, timeoutMs) {
  const clicked = await client.evaluate(`
    (() => {
      const button = document.getElementById('export-playwright');
      if (!button) {
        return false;
      }
      button.click();
      return true;
    })()
  `);

  if (!clicked) {
    throw new Error("Missing #export-playwright button");
  }

  return waitFor(
    async () => {
      const snapshot = await client.evaluate(`
        (() => {
          const dialog = document.getElementById('playwright-preview-dialog');
          const preview = document.getElementById('playwright-script-preview');
          return {
            open: Boolean(dialog && dialog.open),
            script: preview?.value || ''
          };
        })()
      `);

      if (
        !snapshot?.open ||
        !snapshot.script.includes("button.submit") ||
        !snapshot.script.includes("input[name=query]")
      ) {
        return null;
      }

      return snapshot;
    },
    timeoutMs,
    200,
    "Playwright preview did not render"
  );
}

function markerInRange(markers, kind, minLeft, maxLeft) {
  return markers.some(
    (marker) =>
      marker.kind === kind &&
      Number.isFinite(marker.left) &&
      marker.left >= minLeft &&
      marker.left <= maxLeft
  );
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function fetchJson(url, timeoutMs, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function waitFor(fn, timeoutMs, intervalMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  if (lastError instanceof Error) {
    throw new Error(`${timeoutMessage}: ${lastError.message}`);
  }

  throw new Error(timeoutMessage);
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function terminateChromeProcess(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => {
      proc.once("exit", resolvePromise);
    }),
    sleep(5_000)
  ]);

  if (proc.exitCode === null && !proc.killed) {
    proc.kill("SIGKILL");
    await Promise.race([
      new Promise((resolvePromise) => {
        proc.once("exit", resolvePromise);
      }),
      sleep(2_000)
    ]);
  }
}

async function cleanup() {
  if (state.client) {
    state.client.close();
    state.client = null;
  }

  if (state.targetId && state.baseUrl) {
    await closeTarget(state.baseUrl, state.targetId);
    state.targetId = null;
  }

  await terminateChromeProcess(state.chromeProcess);
  state.chromeProcess = null;
  state.baseUrl = null;

  if (state.logStream) {
    await new Promise((resolvePromise) => {
      state.logStream.end(resolvePromise);
    });
    state.logStream = null;
  }

  if (state.server) {
    await new Promise((resolvePromise) => {
      state.server.close(() => resolvePromise());
    });
    state.server = null;
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    await new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;

      socket.addEventListener("open", () => {
        resolvePromise();
      });

      socket.addEventListener("error", () => {
        reject(new Error(`Failed to open WebSocket: ${this.wsUrl}`));
      });

      socket.addEventListener("close", () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("CDP socket closed"));
        }
        this.pending.clear();
      });

      socket.addEventListener("message", (eventMessage) => {
        const payload = JSON.parse(String(eventMessage.data));

        if (typeof payload.id === "number") {
          const pending = this.pending.get(payload.id);

          if (!pending) {
            return;
          }

          this.pending.delete(payload.id);

          if (payload.error) {
            pending.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
            return;
          }

          pending.resolve(payload.result);
          return;
        }

        if (typeof payload.method === "string") {
          const handlers = this.eventHandlers.get(payload.method) ?? [];

          for (const handler of handlers) {
            handler(payload.params ?? {});
          }
        }
      });
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = ++this.sequence;
    const message = JSON.stringify({
      id,
      method,
      params
    });

    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, {
        resolve: resolvePromise,
        reject
      });
      this.socket.send(message);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.text ?? "Runtime.evaluate failed";
      throw new Error(message);
    }

    return result?.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}
