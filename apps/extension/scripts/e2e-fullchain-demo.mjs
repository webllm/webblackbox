#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");
const workspaceRoot = resolve(extensionRoot, "..", "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(extensionRoot, "build");
const demoDir = resolve(extensionRoot, "e2e-demo");
const playerDir = process.env.WB_E2E_PLAYER_DIR ?? resolve(workspaceRoot, "apps/player/build");

const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9233");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-fullchain-profile-${Date.now()}`;
const downloadDir =
  process.env.WB_E2E_DOWNLOAD_DIR ?? `/tmp/webblackbox-ext-fullchain-downloads-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-fullchain-${Date.now()}.log`;
const chromeReadyTimeoutMs = Number(process.env.WB_E2E_CHROME_READY_TIMEOUT_MS ?? "25000");
const chromeLaunchAttempts = Number(process.env.WB_E2E_CHROME_LAUNCH_ATTEMPTS ?? "2");
const downloadTimeoutMs = Number(process.env.WB_E2E_DOWNLOAD_TIMEOUT_MS ?? "45000");
const captureMode = process.env.WB_E2E_MODE === "lite" ? "lite" : "full";
const reloadAfterStart = (process.env.WB_E2E_RELOAD_AFTER_START ?? "0") === "1";
const usePopupUiActions =
  process.env.WB_E2E_USE_POPUP_UI === undefined
    ? !headless
    : process.env.WB_E2E_USE_POPUP_UI !== "0";
const exportPassphrase = process.env.WB_E2E_EXPORT_PASSPHRASE ?? "webblackbox-e2e-passphrase";
const e2eExportPolicy = {
  includeScreenshots: true,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};
const realWorldScenario = process.env.WB_E2E_REALWORLD_SCENARIO ?? "";
const realWorldLongRecordingMs = Number(process.env.WB_E2E_REALWORLD_LONG_MS ?? "2500");
const realWorldLargeResponseBytes = Number(
  process.env.WB_E2E_REALWORLD_LARGE_RESPONSE_BYTES ?? "1048576"
);

const chromeCandidates = [
  process.env.WB_E2E_CHROME_BIN,
  "/Users/unadlib/Library/Caches/ms-playwright/chromium-1212/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
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
  browserClient: null,
  swClient: null,
  popupClient: null,
  demoClient: null,
  playerClient: null,
  openedTargetIds: [],
  server: null,
  baseUrl: null
};

main().catch(async (error) => {
  console.error("Fullchain E2E failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureBuildInputs();

  await mkdir(downloadDir, { recursive: true });

  const server = await startDemoServer({
    demoDir,
    playerDir,
    artifactsDir: downloadDir
  });

  state.server = server.server;

  const demoUrl = `http://127.0.0.1:${server.port}/demo/`;
  const playerUrl = `http://127.0.0.1:${server.port}/player/`;

  const chromeBinary = await resolveChromeBinary(chromeCandidates);

  const chrome = await launchChromeWithRetry(chromeBinary, {
    extensionDir,
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath,
    attempts: Math.max(1, Math.floor(chromeLaunchAttempts)),
    readyTimeoutMs: Math.max(10_000, Math.floor(chromeReadyTimeoutMs))
  });
  const baseUrl = chrome.baseUrl;

  state.chromeProcess = chrome.proc;
  state.logStream = chrome.logStream;
  state.baseUrl = baseUrl;

  const version = chrome.version;
  console.log(`Chrome: ${version.Browser}`);
  assertCommandLineExtensionLoadingSupported(chromeBinary, version.Browser);

  const browserWsUrl =
    typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : null;

  if (browserWsUrl) {
    const browserClient = new CdpClient(browserWsUrl);
    await browserClient.connect();
    state.browserClient = browserClient;
    await browserClient
      .send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true
      })
      .catch(() => undefined);
  }

  // Open demo early so content scripts can wake the extension worker in CI/headless runs.
  const demoTarget = await openTarget(baseUrl, demoUrl);
  state.openedTargetIds.push(demoTarget.id);

  const preferredExtensionId = await resolvePreferredExtensionId(extensionDir);
  if (preferredExtensionId) {
    console.log(`Preferred extension ID: ${preferredExtensionId}`);
  }

  let swTarget = await waitForExtensionServiceWorker(baseUrl, 8_000, preferredExtensionId).catch(
    () => null
  );
  if (!swTarget) {
    swTarget = await waitForExtensionServiceWorker(baseUrl, 20_000, preferredExtensionId).catch(
      () => null
    );
  }
  const extensionId = swTarget
    ? extractExtensionId(swTarget.url)
    : (preferredExtensionId ??
      (await waitForExtensionIdFromProfile(baseUrl, profileDir, extensionDir, 30_000)));
  console.log(`Extension ID: ${extensionId}`);

  let popupTarget = null;
  let warmupPopupTargetId = null;
  const swExceptions = [];

  if (!swTarget && usePopupUiActions) {
    popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
    state.openedTargetIds.push(popupTarget.id);
    warmupPopupTargetId = popupTarget.id;
    swTarget = await waitForExtensionServiceWorker(baseUrl, 25_000, extensionId).catch(() => null);
  }

  if (swTarget?.webSocketDebuggerUrl) {
    const swClient = new CdpClient(swTarget.webSocketDebuggerUrl);
    await swClient.connect();
    await swClient.send("Runtime.enable");
    state.swClient = swClient;

    swClient.on("Runtime.exceptionThrown", (params) => {
      swExceptions.push({
        text: params?.exceptionDetails?.text ?? "unknown",
        line: params?.exceptionDetails?.lineNumber ?? null
      });
    });
  } else {
    console.warn("Service worker target is unavailable; continuing without SW runtime hook.");
  }

  const demoClient = new CdpClient(demoTarget.webSocketDebuggerUrl);
  const demoContexts = createRuntimeContextTracker(demoClient);
  await demoClient.connect();
  await demoClient.send("Runtime.enable");
  await demoClient.send("DOM.enable");
  state.demoClient = demoClient;

  let usePopupUiActionsEffective = usePopupUiActions;
  let control = null;

  if (usePopupUiActionsEffective) {
    if (!popupTarget) {
      popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
      state.openedTargetIds.push(popupTarget.id);
    } else if (warmupPopupTargetId) {
      await closeTarget(baseUrl, warmupPopupTargetId);
      state.openedTargetIds = state.openedTargetIds.filter((id) => id !== warmupPopupTargetId);
      popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
      state.openedTargetIds.push(popupTarget.id);
    }

    const popupClient = new CdpClient(popupTarget.webSocketDebuggerUrl);
    await popupClient.connect();
    await popupClient.send("Runtime.enable");
    await popupClient.send("DOM.enable");
    state.popupClient = popupClient;

    const popupUiReady = await waitForPopupUiReady(popupClient, 20_000).catch(() => null);

    if (!popupUiReady) {
      const popupRuntimeReady = await waitForPopupRuntimeReady(popupClient, 12_000).catch(
        () => null
      );

      if (popupRuntimeReady) {
        usePopupUiActionsEffective = false;
        console.warn("Popup UI not ready; falling back to runtime message actions.");
      } else {
        throw new Error("Popup UI/runtime is not ready");
      }
    }

    control = {
      kind: "popup",
      client: popupClient,
      useUiActions: usePopupUiActionsEffective
    };
  } else {
    let runtimeContext = await waitForExtensionRuntimeContext(
      demoClient,
      demoContexts,
      extensionId,
      15_000
    ).catch(() => null);

    if (!runtimeContext) {
      await demoClient.send("Page.reload", { ignoreCache: true }).catch(() => undefined);
      runtimeContext = await waitForExtensionRuntimeContext(
        demoClient,
        demoContexts,
        extensionId,
        20_000
      );
    }

    control = {
      kind: "content-runtime",
      client: demoClient,
      contextId: runtimeContext.contextId,
      contextTracker: demoContexts,
      extensionId
    };

    if (!state.swClient) {
      swTarget = await waitForExtensionServiceWorker(baseUrl, 10_000, extensionId).catch(
        () => null
      );

      if (swTarget?.webSocketDebuggerUrl) {
        const swClient = new CdpClient(swTarget.webSocketDebuggerUrl);
        await swClient.connect();
        await swClient.send("Runtime.enable");
        state.swClient = swClient;

        swClient.on("Runtime.exceptionThrown", (params) => {
          swExceptions.push({
            text: params?.exceptionDetails?.text ?? "unknown",
            line: params?.exceptionDetails?.lineNumber ?? null
          });
        });
      }
    }
  }

  const demoExceptions = [];
  demoClient.on("Runtime.exceptionThrown", (params) => {
    demoExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const recorderConfigured = await configureE2eRecorderOptions(control, captureMode);
  assert(recorderConfigured?.ok === true, "Failed to configure E2E recorder options", {
    recorderConfigured,
    captureMode
  });

  await sleep(1_200);

  const start = await startSessionFromControl(control, captureMode, demoUrl);
  assert(start?.ok === true, `Failed to start ${captureMode} mode`, start);
  const demoTab =
    control.kind === "popup" && control.useUiActions
      ? await findTabByUrlFromPopup(control.client, demoUrl)
      : null;
  if (control.kind === "popup" && control.useUiActions) {
    assert(typeof demoTab?.id === "number", "Demo tab is not discoverable from popup", {
      demoUrl,
      demoTab,
      start
    });
  }

  const indicator = await waitForIndicatorText(demoClient, `REC ${captureMode}`, 25_000);
  assert(typeof indicator === "string", "Recorder indicator did not appear", {
    indicator,
    start
  });

  if (reloadAfterStart) {
    await demoClient.send("Page.reload", { ignoreCache: true });
    const reloadedIndicator = await waitForIndicatorText(demoClient, `REC ${captureMode}`, 25_000);
    assert(
      typeof reloadedIndicator === "string",
      "Recorder indicator did not recover after reload",
      {
        reloadedIndicator,
        captureMode
      }
    );
  }

  const activeSessions = await readRuntimeSessions(control);
  assert(
    Array.isArray(activeSessions) && activeSessions.length === 1,
    "Expected exactly one active runtime session",
    { activeSessions }
  );

  const sid = activeSessions[0]?.sid;
  assert(typeof sid === "string" && sid.length > 0, "Missing session id", { activeSessions });
  if (typeof demoTab?.id === "number") {
    assert(activeSessions[0]?.tabId === demoTab.id, "Session started on unexpected tab", {
      expectedTabId: demoTab.id,
      activeSessions,
      demoTab,
      start
    });
  }

  const scenarioResult = await runDemoScenario(demoClient);
  assert(scenarioResult?.ok === true, "Demo scenario failed", scenarioResult);

  const realWorldResult = await runRealWorldScenarioAddons({
    scenario: realWorldScenario,
    demoClient,
    control,
    baseUrl,
    demoUrl,
    browserClient: state.browserClient,
    extensionId
  });
  assert(realWorldResult.ok, "Real-world scenario failed", realWorldResult);

  const finalMarker = await requestFinalE2eMarkerCapture(demoClient, captureMode);
  assert(finalMarker?.ok === true, "Failed to request final E2E marker capture", finalMarker);

  await sleep(captureMode === "lite" ? 2_400 : 1_600);

  const stop = await stopActiveSessionFromControl(control, sid);
  assert(stop?.ok === true, `Failed to stop ${captureMode} mode`, stop);

  const indicatorGone = await waitForIndicatorGone(demoClient, 15_000);
  assert(indicatorGone, "Recorder indicator did not clear after stop", { indicatorGone, stop });

  const sessionsAfterStop = await waitFor(
    async () => {
      const rows = await readRuntimeSessions(control);
      return Array.isArray(rows) && rows.length === 0 ? rows : null;
    },
    10_000,
    200,
    "Runtime sessions were not cleared"
  );
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    "Runtime sessions were not cleared",
    {
      sessionsAfterStop
    }
  );

  const exportStartedAtMs = Date.now();
  const exportStatusBefore =
    control.kind === "popup" && control.useUiActions
      ? await readExportStatusLine(control.client)
      : null;
  const exportTriggered = await exportSessionFromControl(control, sid);
  assert(exportTriggered?.ok === true, "Failed to trigger export from popup", exportTriggered);
  const exportStatus =
    control.kind === "popup" && control.useUiActions
      ? await waitForExportStatus(control.client, exportStatusBefore, 35_000)
      : { ok: true, text: "Export triggered (runtime fallback)." };
  assert(exportStatus?.ok, "Export status indicates failure", exportStatus);

  const downloadClient = control.kind === "popup" ? control.client : state.swClient;
  const downloadRecord = downloadClient
    ? await waitForExportedDownload(downloadClient, sid, exportStartedAtMs, downloadTimeoutMs)
    : await waitForExportedArchiveFile(sid, exportStartedAtMs, downloadTimeoutMs);
  assert(typeof downloadRecord?.filename === "string", "Download record missing filename", {
    downloadRecord
  });

  let exportedPath = downloadRecord.filename;
  let fileInfo = await waitForFile(exportedPath, 10_000);

  if (fileInfo.size === 0) {
    const rebuiltPath = resolve(downloadDir, `${sid}.webblackbox`);
    const rebuilt = await rebuildArchiveFromDataUrl(downloadRecord.url, rebuiltPath);

    if (rebuilt) {
      exportedPath = rebuiltPath;
      fileInfo = await waitForFile(exportedPath, 5_000);
    }
  }

  assert(fileInfo.size > 0, "Exported archive is empty", {
    exportedPath,
    fileInfo,
    downloadRecord
  });

  const archiveEvidenceResult =
    realWorldScenario && realWorldResult.archiveEvidence
      ? await verifyRealWorldArchiveEvidence(exportedPath, realWorldResult.archiveEvidence)
      : { ok: true, skipped: true };
  assert(
    archiveEvidenceResult.ok,
    "Exported archive missing real-world captured evidence",
    archiveEvidenceResult
  );

  const playerTarget = await openTarget(baseUrl, playerUrl);
  state.openedTargetIds.push(playerTarget.id);

  const playerClient = new CdpClient(playerTarget.webSocketDebuggerUrl);
  await playerClient.connect();
  await playerClient.send("Runtime.enable");
  await playerClient.send("DOM.enable");
  state.playerClient = playerClient;

  const playerExceptions = [];
  playerClient.on("Runtime.exceptionThrown", (params) => {
    playerExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  await waitForPlayerReady(playerClient, 20_000);
  await installPlayerArchivePassphraseAutoSubmit(playerClient, exportPassphrase);
  await setFileInputFiles(playerClient, "#archive-input", [exportedPath]);
  await playerClient.evaluate(`
    (() => {
      const input = document.querySelector('#archive-input');
      if (!input) {
        return { ok: false, reason: 'archive-input-not-found' };
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()
  `);
  const playerResult = await waitForPlayerLoad(playerClient, 35_000, exportPassphrase);
  assert(playerResult.eventCount > 0, "Player rendered zero timeline events", playerResult);
  assert(
    playerResult.waterfallCount > 0,
    "Player rendered zero network waterfall rows",
    playerResult
  );

  const hasApiRequest = [
    ...(playerResult.waterfallSamples ?? []),
    ...(playerResult.waterfallSampleUrls ?? [])
  ].some((sample) => sample.includes("/api/"));
  assert(hasApiRequest, "Player waterfall does not include demo API requests", playerResult);

  const requiredEventTypes =
    captureMode === "lite"
      ? [
          "user.mousemove",
          "console.entry",
          "network.request",
          "dom.snapshot",
          "storage.local.snapshot"
        ]
      : ["user.click", "screen.screenshot", "console.entry"];

  for (const eventType of requiredEventTypes) {
    await waitForPlayerEventType(playerClient, eventType, 20_000);
  }

  const markerResult =
    captureMode === "full"
      ? await verifyPlayerScreenshotMarker(playerClient, 20_000)
      : {
          ok: true,
          skipped: "lite-screenshot-not-required"
        };
  if (captureMode === "full") {
    assert(markerResult.ok, "Player screenshot marker is missing", markerResult);
  }
  const hoverResponseResult =
    captureMode === "full"
      ? await verifyPlayerProgressHoverResponse(playerClient, 20_000)
      : {
          ok: true,
          skipped: "lite-response-body-preview-not-required"
        };
  assert(
    hoverResponseResult.ok,
    "Player hover response controls are not working",
    hoverResponseResult
  );

  if (swExceptions.length > 0) {
    throw new Error(`Service worker runtime exceptions: ${JSON.stringify(swExceptions)}`);
  }

  if (demoExceptions.length > 0) {
    throw new Error(`Demo page runtime exceptions: ${JSON.stringify(demoExceptions)}`);
  }

  if (playerExceptions.length > 0) {
    throw new Error(`Player page runtime exceptions: ${JSON.stringify(playerExceptions)}`);
  }

  const restartResult = realWorldScenario.includes("restart")
    ? await verifyExtensionRestart(control, baseUrl, extensionId)
    : { ok: true, skipped: true };
  assert(restartResult.ok, "Extension restart verification failed", restartResult);

  console.log("Demo URL:", demoUrl);
  console.log("Player URL:", playerUrl);
  console.log("Capture mode:", captureMode);
  console.log(
    "Popup actions:",
    control.kind === "popup" ? (control.useUiActions ? "ui" : "runtime") : control.kind
  );
  console.log("Reload after start:", reloadAfterStart);
  console.log("Session:", sid);
  console.log("Export:", exportStatus.text);
  console.log("Archive:", exportedPath);
  console.log("Archive bytes:", fileInfo.size);
  console.log("Scenario:", JSON.stringify(scenarioResult));
  console.log("Real-world scenario:", JSON.stringify(realWorldResult));
  console.log("Real-world archive evidence:", JSON.stringify(archiveEvidenceResult));
  console.log("Player:", JSON.stringify(playerResult));
  console.log("Screenshot marker:", JSON.stringify(markerResult));
  console.log("Hover response:", JSON.stringify(hoverResponseResult));
  console.log("Extension restart:", JSON.stringify(restartResult));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Fullchain E2E passed.");

  await cleanup();
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

async function ensureBuildInputs() {
  await access(extensionDir, constants.R_OK);
  await access(resolve(extensionDir, "manifest.json"), constants.R_OK);
  await access(resolve(extensionDir, "sw.js"), constants.R_OK);

  await access(demoDir, constants.R_OK);
  await access(resolve(demoDir, "index.html"), constants.R_OK);
  await access(resolve(demoDir, "app.js"), constants.R_OK);

  await access(playerDir, constants.R_OK);
  await access(resolve(playerDir, "index.html"), constants.R_OK);
  await access(resolve(playerDir, "main.js"), constants.R_OK);
}

async function resolveChromeBinary(candidates) {
  for (const candidate of candidates) {
    const resolved = await resolveChromeCandidate(candidate);

    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    "Chrome binary not found. Set WB_E2E_CHROME_BIN or install Chrome for Testing/Google Chrome."
  );
}

function assertCommandLineExtensionLoadingSupported(binary, browserVersion) {
  const major = Number(/^Chrome\/(\d+)/u.exec(browserVersion ?? "")?.[1] ?? "0");
  const normalizedBinary = String(binary).replaceAll("\\", "/").toLowerCase();
  const isChromeForTesting = normalizedBinary.includes("chrome for testing");
  const isChromium = normalizedBinary.includes("chromium");
  const isMacBrandedChrome = normalizedBinary.includes("/applications/google chrome.app/");

  if (major >= 137 && isMacBrandedChrome && !isChromeForTesting && !isChromium) {
    throw new Error(
      [
        "This E2E requires a browser that still supports command-line unpacked extensions.",
        "Official Chrome branded builds block --load-extension starting with Chrome 137.",
        "Set WB_E2E_CHROME_BIN to Chrome for Testing or Chromium."
      ].join(" ")
    );
  }
}

async function resolveChromeCandidate(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }

  const trimmed = candidate.trim();

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
    "--safebrowsing-disable-download-protection",
    "--window-size=1400,1000",
    `--disable-extensions-except=${options.extensionDir}`,
    `--load-extension=${options.extensionDir}`,
    "--enable-logging=stderr",
    "--v=1",
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

  return { proc, logStream };
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

    const launchPort =
      attempt === 1 ? await resolveLaunchPort(options.remotePort) : await reserveEphemeralPort();
    const baseUrl = `http://127.0.0.1:${launchPort}`;
    const { proc, logStream } = startChrome(binary, {
      extensionDir: options.extensionDir,
      profileDir: attemptProfileDir,
      remotePort: launchPort,
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
        remotePort: launchPort,
        profileDir: attemptProfileDir,
        version
      };
    } catch (error) {
      lastError = error;
      await terminateChromeProcess(proc);
      logStream.end();

      if (attempt < options.attempts) {
        console.warn(
          `Chrome launch attempt ${attempt} failed; retrying on a fresh profile. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function terminateChromeProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      proc.once("exit", resolve);
    }),
    sleep(5_000)
  ]);

  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => {
        proc.once("exit", resolve);
      }),
      sleep(2_000)
    ]);
  }
}

async function resolveLaunchPort(preferredPort) {
  if (Number.isFinite(preferredPort) && preferredPort > 0) {
    const preferredAvailable = await canBindPort(preferredPort);
    if (preferredAvailable) {
      return preferredPort;
    }
  }

  return reserveEphemeralPort();
}

async function canBindPort(port) {
  const server = createNetServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      }).catch(() => undefined);
    }
  }
}

async function reserveEphemeralPort() {
  const server = createNetServer();

  try {
    return await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to reserve an ephemeral port."));
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
    }).catch(() => undefined);
  }
}

async function startDemoServer({ demoDir, playerDir, artifactsDir }) {
  const tasks = [];

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/") {
        redirect(response, "/demo/");
        return;
      }

      if (pathname.startsWith("/api/")) {
        await handleApiRequest(request, response, requestUrl, tasks);
        return;
      }

      if (pathname === "/demo") {
        redirect(response, "/demo/");
        return;
      }

      if (pathname.startsWith("/demo/")) {
        const relativePath = pathname.slice("/demo/".length) || "index.html";
        await serveStatic(response, demoDir, relativePath);
        return;
      }

      if (pathname === "/player") {
        redirect(response, "/player/");
        return;
      }

      if (pathname.startsWith("/player/")) {
        const relativePath = pathname.slice("/player/".length) || "index.html";
        await serveStatic(response, playerDir, relativePath);
        return;
      }

      if (pathname.startsWith("/artifacts/")) {
        const relativePath = pathname.slice("/artifacts/".length);
        await serveStatic(response, artifactsDir, relativePath);
        return;
      }

      writeJson(response, 404, {
        ok: false,
        error: "not-found",
        path: pathname
      });
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local demo server address.");
  }

  return {
    server,
    port: address.port
  };
}

async function handleApiRequest(request, response, requestUrl, tasks) {
  const pathname = requestUrl.pathname;

  if (pathname === "/api/dashboard" && request.method === "GET") {
    writeJson(response, 200, {
      ok: true,
      view: requestUrl.searchParams.get("view") ?? "default",
      generatedAt: new Date().toISOString(),
      totals: {
        open: tasks.length,
        completed: 0
      },
      tasks: tasks.slice(-10)
    });
    return;
  }

  if (pathname === "/api/slow-report" && request.method === "GET") {
    const rawDelay = Number(requestUrl.searchParams.get("delay") ?? "600");
    const delay = Number.isFinite(rawDelay) ? Math.max(150, Math.min(rawDelay, 2_000)) : 600;
    await sleep(delay);

    writeJson(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      delayMs: delay,
      report: {
        p95: 312,
        p99: 640,
        errorRate: 0.013
      }
    });
    return;
  }

  if (pathname === "/api/large-response" && request.method === "GET") {
    const rawBytes = Number(requestUrl.searchParams.get("bytes") ?? realWorldLargeResponseBytes);
    const size = Number.isFinite(rawBytes)
      ? Math.max(1024, Math.min(rawBytes, 4 * 1024 * 1024))
      : 1024;
    const payload = {
      ok: true,
      kind: "real-world-large-response",
      bytes: size,
      data: "x".repeat(Math.max(0, size - 96))
    };

    writeJson(response, 200, payload);
    return;
  }

  if (pathname === "/api/fail" && request.method === "GET") {
    const rawStatus = Number(requestUrl.searchParams.get("code") ?? "503");
    const status = Number.isFinite(rawStatus) ? Math.max(400, Math.min(rawStatus, 599)) : 503;

    writeJson(response, status, {
      ok: false,
      code: status,
      reason: "synthetic-upstream-failure"
    });
    return;
  }

  if (pathname === "/api/tasks" && request.method === "POST") {
    const bodyText = await readRequestBody(request, 512_000);
    let body;

    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    } catch {
      writeJson(response, 400, {
        ok: false,
        error: "invalid-json"
      });
      return;
    }

    const title =
      typeof body?.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : `Task ${tasks.length + 1}`;

    const task = {
      id: `task-${tasks.length + 1}`,
      title,
      source: typeof body?.source === "string" ? body.source : "unknown",
      createdAt: new Date().toISOString()
    };

    tasks.push(task);

    writeJson(response, 201, {
      ok: true,
      task,
      total: tasks.length
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: "api-route-not-found",
    path: pathname,
    method: request.method
  });
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

function redirect(response, location) {
  response.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  response.end();
}

async function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.byteLength;

      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
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

  if (extension === ".webblackbox" || extension === ".zip") {
    return "application/zip";
  }

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
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

async function waitForExtensionServiceWorker(urlBase, timeoutMs, extensionId) {
  const extensionPrefix = extensionId
    ? `chrome-extension://${extensionId}/`
    : "chrome-extension://";
  let lastTargetSummary = "none";

  try {
    return await waitFor(
      async () => {
        const targets = await fetchJson(`${urlBase}/json/list`, 4_000);

        if (!Array.isArray(targets)) {
          return null;
        }

        lastTargetSummary = summarizeTargetsForDebug(targets);

        return (
          targets.find(
            (target) =>
              target?.type === "service_worker" &&
              typeof target?.url === "string" &&
              target.url.startsWith(extensionPrefix) &&
              target.url.endsWith("/sw.js")
          ) ?? null
        );
      },
      timeoutMs,
      250,
      "Extension service worker target not found"
    );
  } catch (error) {
    throw new Error(
      `Extension service worker target not found for prefix '${extensionPrefix}'. Targets: ${lastTargetSummary}. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function resolvePreferredExtensionId(extensionDir) {
  const fromEnv = process.env.WB_E2E_EXTENSION_ID?.trim();

  if (isLikelyExtensionId(fromEnv)) {
    return fromEnv;
  }

  const manifestPath = resolve(extensionDir, "manifest.json");
  let manifestRaw;

  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let manifest;

  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return null;
  }

  const key = typeof manifest?.key === "string" ? manifest.key.trim() : "";

  if (key.length === 0) {
    return null;
  }

  try {
    const id = computeExtensionIdFromManifestKey(key);
    return isLikelyExtensionId(id) ? id : null;
  } catch {
    return null;
  }
}

function computeExtensionIdFromManifestKey(keyBase64) {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";

  for (let i = 0; i < 16; i += 1) {
    const value = digest[i];
    id += alphabet[(value >> 4) & 0x0f];
    id += alphabet[value & 0x0f];
  }

  return id;
}

async function waitForExtensionIdFromProfile(urlBase, profileDir, extensionDir, timeoutMs) {
  const normalizedExtensionDir = normalizeFsPath(extensionDir);
  const retryProbeAfterMs = 3_000;
  const nextProbeAtById = new Map();

  return waitFor(
    async () => {
      const idFromSettings = await readExtensionIdFromProfile(profileDir, normalizedExtensionDir);

      if (idFromSettings) {
        return idFromSettings;
      }

      const candidateIds = new Set([
        ...(await readExtensionIdsFromProfile(profileDir)),
        ...(await readExtensionIdsFromLocalSettings(profileDir)),
        ...(await readExtensionIdsFromTargets(urlBase))
      ]);

      if (candidateIds.size === 0) {
        return null;
      }

      const now = Date.now();

      for (const candidateId of candidateIds) {
        const nextProbeAt = nextProbeAtById.get(candidateId) ?? 0;

        if (nextProbeAt > now) {
          continue;
        }

        const matched = await probeExtensionPopup(urlBase, candidateId, 2_500);
        nextProbeAtById.set(candidateId, now + retryProbeAfterMs);

        if (matched) {
          return candidateId;
        }
      }

      return null;
    },
    timeoutMs,
    250,
    `Extension id not found in profile/local settings for path '${normalizedExtensionDir}'`
  );
}

async function readExtensionIdFromProfile(profileDir, normalizedExtensionDir) {
  for (const fileName of ["Secure Preferences", "Preferences"]) {
    const path = resolve(profileDir, "Default", fileName);
    let content;

    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const settings = parsed?.extensions?.settings;

    if (!settings || typeof settings !== "object") {
      continue;
    }

    for (const [candidateId, candidateValue] of Object.entries(settings)) {
      if (!isLikelyExtensionId(candidateId)) {
        continue;
      }

      if (!candidateValue || typeof candidateValue !== "object") {
        continue;
      }

      const pathValue =
        typeof candidateValue.path === "string" ? normalizeFsPath(candidateValue.path) : null;

      if (!pathValue) {
        continue;
      }

      if (pathsLikelyEqual(pathValue, normalizedExtensionDir)) {
        return candidateId;
      }
    }
  }

  return null;
}

async function readExtensionIdsFromProfile(profileDir) {
  const ids = new Set();

  for (const fileName of ["Secure Preferences", "Preferences"]) {
    const path = resolve(profileDir, "Default", fileName);
    let content;

    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const settings = parsed?.extensions?.settings;

    if (!settings || typeof settings !== "object") {
      continue;
    }

    for (const candidateId of Object.keys(settings)) {
      if (isLikelyExtensionId(candidateId)) {
        ids.add(candidateId);
      }
    }
  }

  return [...ids];
}

async function readExtensionIdsFromLocalSettings(profileDir) {
  const settingsDir = resolve(profileDir, "Default", "Local Extension Settings");
  let entries;

  try {
    entries = await readdir(settingsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && isLikelyExtensionId(entry.name))
    .map((entry) => entry.name);
}

async function readExtensionIdsFromTargets(urlBase) {
  let targets;

  try {
    targets = await fetchJson(`${urlBase}/json/list`, 4_000);
  } catch {
    return [];
  }

  if (!Array.isArray(targets)) {
    return [];
  }

  const ids = new Set();

  for (const target of targets) {
    const url = typeof target?.url === "string" ? target.url : "";
    const match = /^chrome-extension:\/\/([^/]+)\//.exec(url);

    if (match && isLikelyExtensionId(match[1])) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

async function probeExtensionPopup(urlBase, extensionId, timeoutMs) {
  let target = null;
  let popupClient = null;

  try {
    target = await openTarget(urlBase, `chrome-extension://${extensionId}/popup.html`);

    popupClient = new CdpClient(target.webSocketDebuggerUrl);
    await popupClient.connect();
    await popupClient.send("Runtime.enable");
    await popupClient.send("DOM.enable").catch(() => undefined);

    const ready = await waitFor(
      async () => {
        const snapshot = await popupClient.evaluate(`
          (() => {
            const title = (document.querySelector('.wb-popup__title')?.textContent ?? '').trim();
            const hasStartLite = Boolean(document.querySelector("[data-action='start-lite']"));
            const hasStartFull = Boolean(document.querySelector("[data-action='start-full']"));
            const runtimeId =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.runtime === "object" &&
              chrome.runtime !== null &&
              typeof chrome.runtime.id === "string"
                ? chrome.runtime.id
                : null;

            return {
              title,
              hasStartLite,
              hasStartFull,
              runtimeId
            };
          })()
        `);

        const isPopupReady =
          snapshot &&
          snapshot.title === "WebBlackbox" &&
          snapshot.hasStartLite === true &&
          snapshot.hasStartFull === true &&
          snapshot.runtimeId === extensionId;

        return isPopupReady ? snapshot : null;
      },
      timeoutMs,
      150,
      `Popup probe timed out for extension '${extensionId}'`
    ).catch(() => null);

    return Boolean(ready);
  } catch {
    return false;
  } finally {
    if (popupClient) {
      popupClient.close();
    }

    if (target?.id) {
      await closeTarget(urlBase, target.id);
    }
  }
}

function isLikelyExtensionId(value) {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

function normalizeFsPath(value) {
  return resolve(String(value)).replaceAll("\\", "/").replace(/\/+$/g, "");
}

function pathsLikelyEqual(left, right) {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

function summarizeTargetsForDebug(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return "[]";
  }

  return targets
    .slice(0, 12)
    .map((target) => {
      const type = typeof target?.type === "string" ? target.type : "unknown";
      const url = typeof target?.url === "string" ? target.url : "";
      const normalizedUrl = url.length > 120 ? `${url.slice(0, 117)}...` : url;
      return `${type}:${normalizedUrl}`;
    })
    .join(", ");
}

function extractExtensionId(url) {
  const match = /^chrome-extension:\/\/([^/]+)\//.exec(url);

  if (!match) {
    throw new Error(`Failed to parse extension id from target URL: ${url}`);
  }

  return match[1];
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
    // ignore during cleanup
  }
}

function createRuntimeContextTracker(client) {
  const contexts = new Map();

  client.on("Runtime.executionContextCreated", (params) => {
    const context = params?.context;

    if (context && typeof context.id === "number") {
      contexts.set(context.id, context);
    }
  });

  client.on("Runtime.executionContextDestroyed", (params) => {
    const id = params?.executionContextId;

    if (typeof id === "number") {
      contexts.delete(id);
    }
  });

  client.on("Runtime.executionContextsCleared", () => {
    contexts.clear();
  });

  return {
    list() {
      return [...contexts.values()];
    }
  };
}

async function waitForExtensionRuntimeContext(pageClient, tracker, extensionId, timeoutMs) {
  let lastSnapshot = null;

  try {
    return await waitFor(
      async () => {
        const contexts = tracker.list().filter((context) => {
          const origin = typeof context.origin === "string" ? context.origin : "";
          const name = typeof context.name === "string" ? context.name : "";
          const auxData =
            context.auxData && typeof context.auxData === "object" ? context.auxData : {};
          const type = typeof auxData.type === "string" ? auxData.type : "";

          return (
            type === "isolated" ||
            origin.startsWith(`chrome-extension://${extensionId}`) ||
            name.includes(extensionId) ||
            name.includes("WebBlackbox")
          );
        });

        for (const context of contexts) {
          const snapshot = await pageClient
            .evaluate(
              `
                (() => {
                  const chromeApi =
                    typeof chrome === "object" && chrome !== null ? chrome : null;
                  const runtime = chromeApi?.runtime ?? null;
                  return {
                    contextId: ${JSON.stringify(context.id)},
                    contextName: ${JSON.stringify(context.name ?? "")},
                    contextOrigin: ${JSON.stringify(context.origin ?? "")},
                    url: location.href,
                    runtimeId:
                      runtime && typeof runtime.id === "string" ? runtime.id : null,
                    hasRuntimeMessaging:
                      runtime !== null && typeof runtime.sendMessage === "function",
                    hasStorageLocal:
                      typeof chromeApi?.storage?.local?.get === "function"
                  };
                })()
              `,
              { contextId: context.id }
            )
            .catch((error) => ({
              contextId: context.id,
              error: error instanceof Error ? error.message : String(error)
            }));

          lastSnapshot = snapshot;

          if (
            snapshot?.hasRuntimeMessaging &&
            (snapshot.runtimeId === extensionId || typeof snapshot.runtimeId === "string")
          ) {
            return {
              contextId: context.id,
              snapshot
            };
          }
        }

        return null;
      },
      timeoutMs,
      200,
      "Extension runtime context not ready"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const contextSummary = tracker
      .list()
      .map((context) => ({
        id: context.id,
        name: context.name,
        origin: context.origin,
        auxData: context.auxData
      }))
      .slice(0, 12);
    throw new Error(
      `${message}; lastSnapshot=${JSON.stringify(lastSnapshot)}; contexts=${JSON.stringify(
        contextSummary
      )}`
    );
  }
}

async function evaluateControl(control, expression) {
  try {
    return await control.client.evaluate(
      expression,
      typeof control.contextId === "number" ? { contextId: control.contextId } : undefined
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const canRefreshContext =
      control.kind === "content-runtime" &&
      control.contextTracker &&
      control.extensionId &&
      /Cannot find context|Execution context|Cannot find object with id/u.test(message);

    if (!canRefreshContext) {
      throw error;
    }

    const runtimeContext = await waitForExtensionRuntimeContext(
      control.client,
      control.contextTracker,
      control.extensionId,
      10_000
    );
    control.contextId = runtimeContext.contextId;

    return control.client.evaluate(expression, { contextId: control.contextId });
  }
}

async function configureE2eRecorderOptions(control, mode) {
  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.storage?.local?.set !== 'function') {
          return { ok: false, reason: 'storage-api-unavailable' };
        }

        const capturePolicy = {
          schemaVersion: 2,
          mode: 'lab',
          captureContext: 'synthetic',
          captureContextEvidenceRef: 'synthetic:e2e-fullchain',
          consent: {
            id: 'webblackbox-e2e-consent',
            provenance: 'self-recording',
            purpose: 'qa',
            grantedBy: 'webblackbox-e2e',
            grantedAt: new Date().toISOString()
          },
          unmaskPolicySource: 'extension-managed',
          scope: {
            tabId: 0,
            origin: '',
            allowedOrigins: [],
            deniedOrigins: [],
            includeSubframes: true,
            stopOnOriginChange: true,
            excludedUrlPatterns: []
          },
          categories: {
            actions: 'allow',
            inputs: 'masked',
            dom: 'allow',
            screenshots: ${JSON.stringify(mode)} === 'full' ? 'allow' : 'off',
            console: 'allow',
            network: 'body-allowlist',
            storage: 'allow',
            indexedDb: 'names-only',
            cookies: 'names-only',
            cdp: ${JSON.stringify(mode)} === 'full' ? 'full' : 'safe-subset',
            heapProfiles: 'off'
          },
          redaction: {
            redactHeaders: [
              'authorization',
              'cookie',
              'set-cookie',
              'proxy-authorization',
              'x-api-key',
              'x-auth-token',
              'x-csrf-token',
              'x-xsrf-token'
            ],
            redactCookieNames: ['token', 'session', 'auth', 'jwt', 'refresh_token', 'csrf', 'xsrf'],
            redactBodyPatterns: [
              'password',
              'token',
              'secret',
              'otp',
              'credential',
              'api_key',
              'apikey',
              'private_key',
              'refresh_token'
            ],
            blockedSelectors: [
              '.secret',
              '[data-sensitive]',
              '[data-webblackbox-redact]',
              "input[type='password']",
              "input[name*='token']",
              "input[name*='secret']",
              "input[autocomplete='cc-number']"
            ],
            hashSensitiveValues: true
          },
          encryption: {
            localAtRest: 'required',
            archive: 'required',
            archiveKeyEnvelope: 'passphrase'
          },
          retention: {
            localTtlMs: 24 * 60 * 60 * 1000
          }
        };

        await chromeApi.storage.local.set({
          'webblackbox.options': {
            optionsVersion: 1,
            mode: ${JSON.stringify(mode)},
            freezeOnNetworkFailure: false,
            freezeOnLongTaskSpike: false,
            sampling: {
              mousemoveHz: 20,
              scrollHz: 15,
              domFlushMs: 100,
              screenshotIdleMs: ${JSON.stringify(mode)} === 'full' ? 600 : 0,
              snapshotIntervalMs: 1000,
              actionWindowMs: 1500,
              bodyCaptureMaxBytes: ${JSON.stringify(mode)} === 'full' ? 65536 : 32768
            },
            capturePolicy
          }
        });

        return {
          ok: true,
          mode: ${JSON.stringify(mode)},
          cdp: capturePolicy.categories.cdp,
          screenshots: capturePolicy.categories.screenshots,
          screenshotIdleMs: ${JSON.stringify(mode)} === 'full' ? 600 : 0
        };
      })()
    `
  );
}

async function startSessionFromControl(control, mode, expectedUrl) {
  if (control.kind === "popup") {
    return startSessionFromPopup(control.client, mode, expectedUrl, control.useUiActions);
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;
        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.start',
          mode: ${JSON.stringify(mode)}
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return {
            ok: false,
            reason: 'runtime-start-rejected',
            response
          };
        }

        return { ok: true, mode: ${JSON.stringify(mode)}, via: 'content-runtime' };
      })()
    `
  );
}

async function startSessionFromPopup(popupClient, mode, expectedUrl, useUiActions) {
  if (useUiActions) {
    const expression = `
      (() => {
        const selector = ${JSON.stringify(mode === "lite" ? "[data-action='start-lite']" : "[data-action='start-full']")};
        const button = document.querySelector(selector);
        const tabLine =
          Array.from(document.querySelectorAll('p'))
            .map((line) => (line.textContent ?? '').trim())
            .find((line) => line.startsWith('Tab:')) ?? null;
        const statusLine =
          Array.from(document.querySelectorAll('p'))
            .map((line) => (line.textContent ?? '').trim())
            .find((line) => line.startsWith('Status:')) ?? null;

        if (!(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: 'start-button-not-found', selector, tabLine, statusLine };
        }

        if (button.disabled) {
          return { ok: false, reason: 'start-button-disabled', selector, tabLine, statusLine };
        }

        button.click();
        return { ok: true, mode: ${JSON.stringify(mode)}, via: 'popup-ui', tabLine, statusLine };
      })()
    `;

    return popupClient.evaluate(expression);
  }

  const expression = `
    (async () => {
      if (typeof chrome?.tabs?.query === 'function') {
        const tabs = await chrome.tabs.query({});
        const exact = tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          tab.url.startsWith(${JSON.stringify(expectedUrl)})
        );

        const fallback = tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          !tab.url.startsWith('chrome-extension://') &&
          tab.url !== 'about:blank'
        );

        const target = exact ?? fallback;

        if (!target || typeof target.id !== 'number') {
          return {
            ok: false,
            reason: 'target-tab-not-found',
            tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active }))
          };
        }

        await chrome.runtime.sendMessage({ kind: 'ui.start', tabId: target.id, mode: ${JSON.stringify(
          mode
        )} });
        return { ok: true, tabId: target.id, mode: ${JSON.stringify(mode)}, via: 'runtime-tabs' };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.start', mode: ${JSON.stringify(mode)} });
      return { ok: true, mode: ${JSON.stringify(mode)}, via: 'runtime-active-tab-fallback' };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function stopActiveSessionFromControl(control, expectedSid) {
  if (control.kind === "popup") {
    return stopActiveSessionFromPopup(control.client, control.useUiActions, expectedSid);
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const store =
          typeof chromeApi?.storage?.local?.get === 'function'
            ? await chromeApi.storage.local.get('webblackbox.runtime.sessions')
            : {};
        const rows = store['webblackbox.runtime.sessions'];
        const sessions = Array.isArray(rows) ? rows : [];
        const expectedSid = ${JSON.stringify(expectedSid)};
        const active =
          (expectedSid
            ? sessions.find((row) => row?.sid === expectedSid && typeof row?.tabId === 'number')
            : undefined) ??
          sessions.find((row) => typeof row?.tabId === 'number');

        if (!active || typeof active.tabId !== 'number') {
          if (expectedSid) {
            return {
              ok: true,
              sid: expectedSid,
              alreadyStopped: true,
              via: 'content-runtime',
              rows: sessions
            };
          }

          return { ok: false, reason: 'no-active-session', rows: sessions };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.stop',
          tabId: active.tabId
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return { ok: false, reason: 'runtime-stop-rejected', response };
        }

        return { ok: true, tabId: active.tabId, via: 'content-runtime' };
      })()
    `
  );
}

async function stopActiveSessionFromPopup(popupClient, useUiActions, expectedSid) {
  if (useUiActions) {
    const expression = `
      (() => {
        const button = document.querySelector("[data-action='stop']");

        if (!(button instanceof HTMLButtonElement)) {
          if (${JSON.stringify(expectedSid)}) {
            return {
              ok: true,
              sid: ${JSON.stringify(expectedSid)},
              alreadyStopped: true,
              via: 'popup-ui'
            };
          }

          return { ok: false, reason: 'stop-button-not-found' };
        }

        if (button.disabled) {
          return { ok: false, reason: 'stop-button-disabled' };
        }

        button.click();
        return { ok: true, via: 'popup-ui' };
      })()
    `;

    return popupClient.evaluate(expression);
  }

  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      const sessions = Array.isArray(rows) ? rows : [];
      const expectedSid = ${JSON.stringify(expectedSid)};
      const active =
        (expectedSid
          ? sessions.find((row) => row?.sid === expectedSid && typeof row?.tabId === 'number')
          : undefined) ??
        sessions.find((row) => typeof row?.tabId === 'number');

      if (!active || typeof active.tabId !== 'number') {
        if (expectedSid) {
          return {
            ok: true,
            sid: expectedSid,
            alreadyStopped: true,
            via: 'popup-runtime',
            rows: sessions
          };
        }

        return { ok: false, reason: 'no-active-session', rows: sessions };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: active.tabId });
      return { ok: true, tabId: active.tabId };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function exportSessionFromControl(control, sid) {
  if (control.kind === "popup") {
    return exportSessionFromPopup(control.client, sid, control.useUiActions);
  }

  return evaluateControl(
    control,
    `
      (async () => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.sendMessage !== 'function') {
          return { ok: false, reason: 'runtime-api-unavailable' };
        }

        const response = await chromeApi.runtime.sendMessage({
          kind: 'ui.export',
          sid: ${JSON.stringify(sid)},
          passphrase: ${JSON.stringify(exportPassphrase)},
          saveAs: false,
          policy: ${JSON.stringify(e2eExportPolicy)}
        });

        if (response && typeof response === 'object' && response.ok === false) {
          return { ok: false, reason: 'runtime-export-rejected', response };
        }

        return { ok: true, sid: ${JSON.stringify(sid)}, via: 'content-runtime' };
      })()
    `
  );
}

async function exportSessionFromPopup(popupClient, sid, useUiActions) {
  if (useUiActions) {
    const expression = `
      (() => {
        const button = document.querySelector("[data-action='export']");

        if (!(button instanceof HTMLButtonElement)) {
          return { ok: false, reason: 'export-button-not-found' };
        }

        if (button.disabled) {
          return { ok: false, reason: 'export-button-disabled' };
        }

        const previousPrompt = globalThis.prompt;

        try {
          globalThis.prompt = () => "";

          const includeScreenshots = document.querySelector('#export-include-screenshots');

          if (includeScreenshots instanceof HTMLInputElement) {
            includeScreenshots.checked = true;
            includeScreenshots.dispatchEvent(new Event('change', { bubbles: true }));
          }

          button.click();

          const passphraseInput = document.querySelector('#wb-passphrase-input');

          if (passphraseInput instanceof HTMLInputElement) {
            passphraseInput.value = ${JSON.stringify(exportPassphrase)};
            passphraseInput.dispatchEvent(new Event('input', { bubbles: true }));

            const form = passphraseInput.closest('form');

            if (form instanceof HTMLFormElement) {
              form.requestSubmit();
              return {
                ok: true,
                sid: ${JSON.stringify(sid)},
                via: 'popup-ui',
                passphraseMode: ${JSON.stringify(exportPassphrase.length > 0 ? "provided" : "empty")}
              };
            }

            return { ok: false, reason: 'passphrase-form-not-found' };
          }
        } finally {
          globalThis.prompt = previousPrompt;
        }

        return { ok: true, sid: ${JSON.stringify(sid)}, via: 'popup-ui', flow: 'prompt-fallback' };
      })()
    `;

    return popupClient.evaluate(expression);
  }

  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({
        kind: 'ui.export',
        sid: ${JSON.stringify(sid)},
        passphrase: ${JSON.stringify(exportPassphrase)},
        saveAs: false,
        policy: ${JSON.stringify(e2eExportPolicy)}
      });
      return { ok: true, sid: ${JSON.stringify(sid)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function readRuntimeSessions(control) {
  const expression = `
    (async () => {
      const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

      if (typeof chromeApi?.storage?.local?.get !== 'function') {
        return [];
      }

      const store = await chromeApi.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      return Array.isArray(rows) ? rows : [];
    })()
  `;

  return evaluateControl(control, expression);
}

async function findTabByUrlFromPopup(popupClient, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((tab) =>
        typeof tab.id === 'number' &&
        typeof tab.url === 'string' &&
        tab.url.startsWith(${JSON.stringify(expectedUrl)})
      );

      if (!match || typeof match.id !== 'number') {
        return null;
      }

      return {
        id: match.id,
        active: match.active === true,
        url: match.url ?? null
      };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function readExportStatusLine(popupClient) {
  const expression = `
    (() => {
      const lines = Array.from(document.querySelectorAll('p')).map((el) =>
        (el.textContent ?? '').trim()
      );
      return lines.find((line) => line.startsWith('Export')) ?? null;
    })()
  `;

  return popupClient.evaluate(expression);
}

async function waitForExportStatus(popupClient, previousStatus, timeoutMs) {
  return waitFor(
    async () => {
      const status = await readExportStatusLine(popupClient);

      if (!status || status === previousStatus) {
        return null;
      }

      return {
        ok: status.startsWith("Exported:"),
        text: status
      };
    },
    timeoutMs,
    250,
    "Export status not observed"
  );
}

async function waitForExportedDownload(popupClient, sid, startedAtMs, timeoutMs) {
  const expression = `
    (async () => {
      const sid = ${JSON.stringify(sid)};
      const startedAtMs = ${JSON.stringify(startedAtMs)};
      const rows = await chrome.downloads.search({
        orderBy: ['-startTime'],
        limit: 40
      });

      const recent = rows.filter((item) => {
        if (typeof item.startTime !== 'string') {
          return false;
        }
        const ts = Date.parse(item.startTime);
        return Number.isFinite(ts) && ts >= startedAtMs - 4_000;
      });

      const archiveRows = recent.filter((item) => {
        if (typeof item.filename !== 'string') {
          return false;
        }

        return (
          item.filename.includes(sid + '.webblackbox') ||
          item.filename.endsWith('.webblackbox') ||
          item.filename.endsWith('.zip') ||
          item.mime === 'application/zip'
        );
      });
      const match =
        archiveRows.find((item) => item.filename.includes(sid + '.webblackbox')) ??
        archiveRows.find((item) => item.filename.endsWith('.webblackbox')) ??
        archiveRows.find((item) => item.filename.endsWith('.zip')) ??
        archiveRows[0] ??
        null;

      const latest = match ?? null;
      const latestRecent = recent[0] ?? null;

      return {
        complete:
          latest && latest.state === 'complete' && typeof latest.filename === 'string'
            ? {
                id: latest.id,
                filename: latest.filename,
                state: latest.state,
                bytesReceived: latest.bytesReceived,
                totalBytes: latest.totalBytes,
                mime: latest.mime,
                url: latest.url
              }
            : null,
        latest: latest
          ? {
              id: latest.id,
              filename: latest.filename,
              state: latest.state,
              error: latest.error,
              bytesReceived: latest.bytesReceived,
              totalBytes: latest.totalBytes,
              mime: latest.mime,
              url: latest.url
            }
          : null,
        latestRecent: latestRecent
          ? {
              id: latestRecent.id,
              filename: latestRecent.filename,
              state: latestRecent.state,
              error: latestRecent.error,
              bytesReceived: latestRecent.bytesReceived,
              totalBytes: latestRecent.totalBytes,
              mime: latestRecent.mime,
              url: latestRecent.url
            }
          : null
      };
    })()
  `;

  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(expression);

      if (!snapshot) {
        return null;
      }

      if (snapshot.complete) {
        return snapshot.complete;
      }

      const latest = snapshot.latest;

      if (latest && latest.state && latest.state !== "in_progress") {
        const suffix = latest.error ? ` (${latest.error})` : "";
        throw new Error(`Download ended in state '${latest.state}'${suffix}`);
      }

      return null;
    },
    timeoutMs,
    400,
    "Download not completed"
  );
}

async function waitForExportedArchiveFile(sid, startedAtMs, timeoutMs) {
  return waitFor(
    async () => {
      const directories = [resolve(downloadDir, "webblackbox"), downloadDir];
      const matches = [];

      for (const directory of directories) {
        let entries;

        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          const isArchive = entry.name.endsWith(".webblackbox") || entry.name.endsWith(".zip");

          if (!entry.isFile() || !isArchive) {
            continue;
          }

          const filename = resolve(directory, entry.name);
          const info = await stat(filename).catch(() => null);

          if (!info || info.size <= 0 || info.mtimeMs < startedAtMs - 5_000) {
            continue;
          }

          matches.push({
            filename,
            state: "complete",
            bytesReceived: info.size,
            totalBytes: info.size,
            url: null,
            mtimeMs: info.mtimeMs,
            sidMatch: entry.name.includes(sid)
          });
        }
      }

      matches.sort(
        (left, right) =>
          Number(right.sidMatch) - Number(left.sidMatch) || right.mtimeMs - left.mtimeMs
      );
      return matches[0] ?? null;
    },
    timeoutMs,
    400,
    "Exported archive file not found"
  );
}

async function verifyRealWorldArchiveEvidence(archivePath, evidence) {
  if (exportPassphrase.length > 0) {
    return { ok: true, skipped: "encrypted-export" };
  }

  const events = await readArchiveEvents(archivePath);
  const eventTexts = events.map((event) => `${event.type} ${safeStringify(event.data)}`);
  const missingMarkers = (evidence.markers ?? []).filter(
    (marker) => !eventTexts.some((text) => text.includes(marker))
  );
  const missingUrls = (evidence.urls ?? []).filter(
    (url) => !eventTexts.some((text) => text.includes(url))
  );
  const missingEventTypes = (evidence.eventTypes ?? []).filter(
    (type) => !events.some((event) => event.type === type)
  );

  return {
    ok: missingMarkers.length === 0 && missingUrls.length === 0 && missingEventTypes.length === 0,
    eventCount: events.length,
    missingMarkers,
    missingUrls,
    missingEventTypes
  };
}

async function readArchiveEvents(archivePath) {
  const zip = await JSZip.loadAsync(await readFile(archivePath));
  const paths = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();
  const events = [];

  for (const path of paths) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const text = await file.async("string");

    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      try {
        events.push(JSON.parse(trimmed));
      } catch (error) {
        throw new Error(
          `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return events;
}

async function runDemoScenario(demoClient) {
  const expression = `
    (async () => {
      if (!window.__wbDemo || typeof window.__wbDemo.runScenario !== 'function') {
        return { ok: false, reason: 'demo-scenario-missing' };
      }

      try {
        return await window.__wbDemo.runScenario({ taskTitle: 'Fullchain E2E Task' });
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `;

  return demoClient.evaluate(expression);
}

async function runRealWorldScenarioAddons({
  scenario,
  demoClient,
  control,
  baseUrl,
  demoUrl,
  browserClient
}) {
  if (!scenario) {
    return { ok: true, skipped: true };
  }

  const wantsIframeNetwork = scenario.includes("iframe") || scenario.includes("multitarget");
  const wantsChildTarget = scenario.includes("multitarget");
  const wantsMultiTab = scenario.includes("multitab");
  const pageResult = await demoClient.evaluate(`
    (async () => {
      const result = {
        ok: true,
        scenario: ${JSON.stringify(scenario)},
        spaRoutes: [],
        markers: [],
        iframe: false,
        iframeNetworkBytes: 0,
        worker: false,
        workerNetworkBytes: 0,
        upload: false,
        download: false,
        largeResponseBytes: 0,
        longRecordingMs: 0,
        permissionDenied: false
      };
      const mark = (message) => {
        const marker = '[wb-realworld] ' + message;
        result.markers.push(marker);
        console.info(marker);
        return marker;
      };

      try {
        history.pushState({ route: 'settings' }, '', '#/settings');
        window.dispatchEvent(new PopStateEvent('popstate', { state: { route: 'settings' } }));
        result.spaRoutes.push(location.href);
        history.replaceState({ route: 'checkout' }, '', '#/checkout?step=payment');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        result.spaRoutes.push(location.href);
        mark('spa route checkout');

        const iframe = document.createElement('iframe');
        iframe.id = 'wb-realworld-frame';
        iframe.srcdoc = '<!doctype html><button id="frame-button">Frame action</button><script>document.body.dataset.ready="true";<\\/script>';
        document.body.appendChild(iframe);
        await new Promise((resolve) => setTimeout(resolve, 150));
        iframe.contentDocument?.getElementById('frame-button')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true })
        );
        result.iframe = iframe.contentDocument?.body?.dataset.ready === 'true';
        mark('iframe ready');

        if (${JSON.stringify(wantsIframeNetwork)}) {
          const iframeResponse = await iframe.contentWindow?.fetch('/api/large-response?source=iframe&bytes=2048');
          const iframeText = iframeResponse ? await iframeResponse.text() : '';
          result.iframeNetworkBytes = iframeText.length;
          mark('iframe network ' + result.iframeNetworkBytes);
        }

        if (${JSON.stringify(wantsChildTarget)}) {
          const workerResult = await new Promise((resolve) => {
            const workerFetchUrl = new URL('/api/large-response?source=worker&bytes=2048', location.href).href;
            const workerSource = [
              'self.onmessage = async () => {',
              '  try {',
              '    const response = await fetch(' + JSON.stringify(workerFetchUrl) + ');',
              '    const text = await response.text();',
              '    self.postMessage({ ok: true, bytes: text.length });',
              '  } catch (error) {',
              '    self.postMessage({',
              '      ok: false,',
              '      reason: error instanceof Error ? error.message : String(error)',
              '    });',
              '  }',
              '};'
            ].join('\\n');
            const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
            const worker = new Worker(blobUrl);
            const timeout = setTimeout(() => {
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve({ ok: false, reason: 'worker-timeout' });
            }, 5000);
            worker.onmessage = (event) => {
              clearTimeout(timeout);
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timeout);
              worker.terminate();
              URL.revokeObjectURL(blobUrl);
              resolve({ ok: false, reason: event.message || 'worker-error' });
            };
            worker.postMessage({ start: true });
          });
          result.worker = workerResult?.ok === true;
          result.workerNetworkBytes = Number(workerResult?.bytes ?? 0);
          if (!result.worker) {
            result.workerReason = workerResult?.reason ?? 'worker-failed';
          }
          mark('worker target network ' + result.workerNetworkBytes);
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'wb-realworld-upload';
        document.body.appendChild(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        result.upload = true;
        mark('upload change');

        const link = document.createElement('a');
        link.download = 'webblackbox-realworld-download.txt';
        link.href = URL.createObjectURL(new Blob(['download-body'], { type: 'text/plain' }));
        document.body.appendChild(link);
        link.click();
        result.download = true;
        mark('download click');

        const response = await fetch('/api/large-response?bytes=${Math.floor(realWorldLargeResponseBytes)}');
        const text = await response.text();
        result.largeResponseBytes = text.length;
        mark('large response ' + result.largeResponseBytes);

        document.body.dataset.realWorldTick = String(performance.now());
        mark('long recording page ready');

        return result;
      } catch (error) {
        return {
          ...result,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `);

  const pointerResult = await performRealWorldPointerActivity(
    demoClient,
    Math.max(500, Math.floor(realWorldLongRecordingMs))
  );
  if (pageResult && typeof pageResult === "object") {
    pageResult.longRecordingMs = pointerResult.durationMs;
    pageResult.pointerMoves = pointerResult.moves;
  }
  const pointerMarker = await emitPageRealWorldMarker(
    demoClient,
    `trusted pointer moves ${pointerResult.moves}`
  );

  const permissionResult = await evaluateControl(
    control,
    `
    (async () => {
      try {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (!chromeApi?.permissions?.request) {
          return { ok: true, denied: false, granted: false, unavailable: true, reason: 'permissions-api-unavailable' };
        }

        const granted = await new Promise((resolve) => {
          chromeApi.permissions.request({ permissions: ['bookmarks'] }, (value) => {
            resolve(Boolean(value));
          });
        });
        const lastError = chromeApi.runtime.lastError?.message ?? null;
        return { ok: true, denied: !granted, granted, lastError };
      } catch (error) {
        return {
          ok: true,
          denied: true,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `
  );

  const permissionMarker = await emitPageRealWorldMarker(
    demoClient,
    permissionResult?.granted
      ? "permission unexpectedly granted"
      : permissionResult?.unavailable
        ? "permission unavailable"
        : "permission denied"
  );

  let multiTabResult = { ok: true, skipped: true };
  let multiTabMarker = null;
  if (wantsMultiTab) {
    const target = await openTarget(baseUrl, `${demoUrl}?realworld-secondary=1`);
    state.openedTargetIds.push(target.id);
    let secondaryClient = null;

    try {
      secondaryClient = new CdpClient(target.webSocketDebuggerUrl);
      await secondaryClient.connect();
      await secondaryClient.send("Runtime.enable");
      await waitFor(
        async () => {
          const loaded = await secondaryClient.evaluate(`
            (() => ({
              href: location.href,
              readyState: document.readyState
            }))()
          `);

          return loaded?.href?.includes("realworld-secondary=1") && loaded?.readyState !== "loading"
            ? loaded
            : null;
        },
        5_000,
        100,
        "Secondary target did not finish loading"
      );
      const secondaryMarker = await emitPageRealWorldMarker(
        secondaryClient,
        "secondary target exercised"
      );

      multiTabResult = {
        ok: Boolean(target.id && secondaryMarker),
        targetId: target.id,
        url: target.url ?? null,
        secondaryMarker
      };
    } catch (error) {
      multiTabResult = {
        ok: false,
        targetId: target.id,
        url: target.url ?? null,
        reason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (secondaryClient) {
        secondaryClient.close();
      }
    }

    await closeTarget(baseUrl, target.id);
    state.openedTargetIds = state.openedTargetIds.filter((id) => id !== target.id);
    if (multiTabResult.ok) {
      multiTabMarker = await emitPageRealWorldMarker(demoClient, "primary tab survived multitab");
    }
  }

  const expectedMarkers = [
    ...(Array.isArray(pageResult?.markers) ? pageResult.markers : []),
    pointerMarker,
    permissionMarker,
    multiTabMarker
  ].filter((marker) => typeof marker === "string" && marker.length > 0);
  const expectedUrls = ["/api/large-response?bytes="];
  if (wantsIframeNetwork) {
    expectedUrls.push("/api/large-response?source=iframe");
  }
  if (wantsChildTarget) {
    expectedUrls.push("/api/large-response?source=worker");
  }

  return {
    ok:
      pageResult?.ok === true &&
      pageResult.iframe === true &&
      (!wantsIframeNetwork || pageResult.iframeNetworkBytes >= 1024) &&
      (!wantsChildTarget ||
        (pageResult.worker === true && pageResult.workerNetworkBytes >= 1024)) &&
      pageResult.upload === true &&
      pageResult.download === true &&
      pageResult.largeResponseBytes >= 1024 &&
      pointerResult.ok === true &&
      pointerResult.durationMs >= 500 &&
      permissionResult?.ok === true &&
      permissionResult?.granted !== true &&
      multiTabResult.ok === true,
    page: pageResult,
    pointer: pointerResult,
    permission: permissionResult,
    multiTab: multiTabResult,
    archiveEvidence: {
      markers: expectedMarkers,
      urls: expectedUrls,
      eventTypes: ["console.entry", "network.request"]
    },
    browserConnected: Boolean(browserClient)
  };
}

async function performRealWorldPointerActivity(demoClient, durationMs) {
  const started = Date.now();
  let moves = 0;

  while (Date.now() - started < durationMs) {
    await demoClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 24 + (moves % 32),
      y: 24 + ((moves * 3) % 32),
      button: "none"
    });
    moves += 1;
    await sleep(125);
  }

  return {
    ok: moves > 0,
    moves,
    durationMs: Date.now() - started
  };
}

async function emitPageRealWorldMarker(demoClient, message) {
  return demoClient.evaluate(`
    (() => {
      const marker = ${JSON.stringify("[wb-realworld] ")} + ${JSON.stringify(message)};
      console.info(marker);
      return marker;
    })()
  `);
}

async function requestFinalE2eMarkerCapture(demoClient, mode) {
  return demoClient.evaluate(`
    (() => {
      const message = '[wb-e2e] final ' + ${JSON.stringify(mode)} + ' marker';

      window.postMessage(
        {
          source: 'webblackbox-injected',
          kind: 'marker',
          message
        },
        '*'
      );
      console.info(message);

      return { ok: true, message };
    })()
  `);
}

async function verifyExtensionRestart(control, urlBase, extensionId) {
  let reload = await evaluateControl(
    control,
    `
      (() => {
        const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

        if (typeof chromeApi?.runtime?.reload !== 'function') {
          return { ok: false, reason: 'runtime-reload-unavailable' };
        }

        chromeApi.runtime.reload();
        return { ok: true, via: ${JSON.stringify(control.kind)} };
      })()
    `
  ).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error)
  }));

  if (!reload.ok && control.kind !== "popup") {
    const swTarget = await waitForExtensionServiceWorker(urlBase, 10_000, extensionId).catch(
      () => null
    );

    if (swTarget?.webSocketDebuggerUrl) {
      const swClient = new CdpClient(swTarget.webSocketDebuggerUrl);

      try {
        await swClient.connect();
        await swClient.send("Runtime.enable");
        reload = await swClient
          .evaluate(
            `
              (() => {
                const chromeApi = typeof chrome === 'object' && chrome !== null ? chrome : null;

                if (typeof chromeApi?.runtime?.reload !== 'function') {
                  return { ok: false, reason: 'service-worker-runtime-reload-unavailable' };
                }

                chromeApi.runtime.reload();
                return { ok: true, via: 'service-worker' };
              })()
            `
          )
          .catch((error) => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error)
          }));
      } finally {
        swClient.close();
      }
    }
  }

  if (!reload.ok) {
    return reload;
  }

  const swTarget = await waitForExtensionServiceWorker(urlBase, 20_000, extensionId);
  return {
    ok: Boolean(swTarget?.id),
    targetId: swTarget?.id ?? null,
    url: swTarget?.url ?? null
  };
}

async function waitForIndicatorText(pageClient, fragment, timeoutMs) {
  return waitFor(
    async () => {
      const text = await pageClient.evaluate(
        `(() => document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null)()`
      );

      return typeof text === "string" && text.includes(fragment) ? text : null;
    },
    timeoutMs,
    250,
    `Indicator not found: ${fragment}`
  );
}

async function waitForPopupUiReady(popupClient, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(`
        (() => {
          const startLite = document.querySelector("[data-action='start-lite']");
          const startFull = document.querySelector("[data-action='start-full']");
          const hasChromeRuntime =
            typeof chrome === "object" &&
            chrome !== null &&
            typeof chrome.runtime === "object" &&
            chrome.runtime !== null &&
            typeof chrome.runtime.id === "string";

          return {
            ready: Boolean(startLite && startFull && hasChromeRuntime),
            hasStartLite: Boolean(startLite),
            hasStartFull: Boolean(startFull),
            hasChromeRuntime
          };
        })()
      `);

      if (snapshot?.ready) {
        return snapshot;
      }

      return null;
    },
    timeoutMs,
    200,
    "Popup UI not ready"
  );
}

async function waitForPopupRuntimeReady(popupClient, timeoutMs) {
  let lastSnapshot = null;

  try {
    return await waitFor(
      async () => {
        const snapshot = await popupClient.evaluate(`
          (() => {
            const hasRuntimeMessaging =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.runtime === "object" &&
              chrome.runtime !== null &&
              typeof chrome.runtime.id === "string" &&
              typeof chrome.runtime.sendMessage === "function";
            const hasTabsQuery =
              typeof chrome === "object" &&
              chrome !== null &&
              typeof chrome.tabs === "object" &&
              chrome.tabs !== null &&
              typeof chrome.tabs.query === "function";

            return {
              url: location.href,
              title: document.title,
              bodyText: (document.body?.textContent ?? "").trim().slice(0, 240),
              readyState: document.readyState,
              hasChrome: typeof chrome === "object" && chrome !== null,
              runtimeId:
                typeof chrome === "object" &&
                chrome !== null &&
                typeof chrome.runtime === "object" &&
                chrome.runtime !== null &&
                typeof chrome.runtime.id === "string"
                  ? chrome.runtime.id
                  : null,
              hasRuntimeMessaging,
              hasTabsQuery
            };
          })()
        `);

        lastSnapshot = snapshot ?? null;

        if (snapshot?.hasRuntimeMessaging) {
          return snapshot;
        }

        return null;
      },
      timeoutMs,
      200,
      "Popup runtime not ready"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; lastSnapshot=${JSON.stringify(lastSnapshot)}`);
  }
}

async function waitForIndicatorGone(pageClient, timeoutMs) {
  return waitFor(
    async () => {
      const text = await pageClient.evaluate(
        `(() => document.querySelector('[data-webblackbox-indicator="true"]')?.textContent ?? null)()`
      );

      return text ? null : true;
    },
    timeoutMs,
    250,
    "Indicator not cleared"
  );
}

async function waitForPlayerReady(playerClient, timeoutMs) {
  return waitFor(
    async () => {
      const ready = await playerClient.evaluate(`
      (() => {
        const input = document.querySelector('#archive-input');
        return !!input;
      })()
    `);

      return ready ? true : null;
    },
    timeoutMs,
    250,
    "Player UI not ready"
  );
}

async function setFileInputFiles(pageClient, selector, files) {
  const runtimeResult = await pageClient.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
    awaitPromise: false
  });

  const objectId = runtimeResult?.result?.objectId;

  if (!objectId) {
    throw new Error(`File input not found: ${selector}`);
  }

  await pageClient.send("DOM.setFileInputFiles", {
    files,
    objectId
  });
}

async function installPlayerArchivePassphraseAutoSubmit(playerClient, passphrase) {
  if (passphrase.length === 0) {
    return;
  }

  await playerClient.evaluate(`
    (() => {
      const passphrase = ${JSON.stringify(passphrase)};
      let submitted = false;
      const globalKey = '__WEBBLACKBOX_E2E_ARCHIVE_PASSPHRASE__';
      const patchKey = '__WEBBLACKBOX_E2E_DIALOG_PATCHED__';

      globalThis[globalKey] = passphrase;

      const submitIfOpen = (targetDialog) => {
        if (submitted) {
          return;
        }

        const dialog = targetDialog ?? document.querySelector('#archive-passphrase-dialog');

        if (!(dialog instanceof HTMLDialogElement) || !dialog.open) {
          return;
        }

        const input = document.querySelector('#archive-passphrase-input');
        const confirm = document.querySelector('#archive-passphrase-confirm');
        const form = document.querySelector('#archive-passphrase-form');

        if (!(input instanceof HTMLInputElement) || !(confirm instanceof HTMLButtonElement)) {
          return;
        }

        input.value = passphrase;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        submitted = true;

        requestAnimationFrame(() => {
          if (form instanceof HTMLFormElement) {
            form.requestSubmit(confirm);
          } else {
            confirm.click();
          }
        });
      };

      if (!globalThis[patchKey]) {
        const originalShowModal = HTMLDialogElement.prototype.showModal;
        const originalClose = HTMLDialogElement.prototype.close;

        HTMLDialogElement.prototype.showModal = function patchedShowModal(...args) {
          const result = originalShowModal.apply(this, args);

          if (this.id === 'archive-passphrase-dialog' && globalThis[globalKey]) {
            requestAnimationFrame(() => submitIfOpen(this));
          }

          return result;
        };

        HTMLDialogElement.prototype.close = function patchedClose(returnValue) {
          if (
            this.id === 'archive-passphrase-dialog' &&
            globalThis[globalKey] &&
            returnValue !== 'confirm'
          ) {
            const input = document.querySelector('#archive-passphrase-input');

            if (input instanceof HTMLInputElement) {
              input.value = String(globalThis[globalKey]);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              submitted = true;
              return originalClose.call(this, 'confirm');
            }
          }

          return originalClose.call(this, returnValue);
        };

        globalThis[patchKey] = true;
      }

      const observer = new MutationObserver(() => submitIfOpen());
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['open']
      });

      const interval = setInterval(() => {
        submitIfOpen();

        if (submitted) {
          clearInterval(interval);
          observer.disconnect();
        }
      }, 50);

      setTimeout(() => {
        clearInterval(interval);
        observer.disconnect();
      }, 30000);

      submitIfOpen();
    })()
  `);
}

async function waitForPlayerLoad(playerClient, timeoutMs, passphrase = "") {
  let lastSnapshot = null;

  return waitFor(
    async () => {
      const snapshot = await playerClient.evaluate(`
      (() => {
        const dialog = document.querySelector('#archive-passphrase-dialog');
        const passphrase = ${JSON.stringify(passphrase)};
        let passphraseSubmitted = false;

        if (passphrase && dialog instanceof HTMLDialogElement && dialog.open) {
          const input = document.querySelector('#archive-passphrase-input');
          const confirm = document.querySelector('#archive-passphrase-confirm');
          const form = document.querySelector('#archive-passphrase-form');

          if (!(input instanceof HTMLInputElement) || !(confirm instanceof HTMLButtonElement)) {
            return { ok: false, reason: 'passphrase-controls-missing' };
          }

          input.value = passphrase;
          input.dispatchEvent(new Event('input', { bubbles: true }));

          if (form instanceof HTMLFormElement) {
            form.requestSubmit(confirm);
          } else {
            confirm.click();
          }

          passphraseSubmitted = true;
        }

        const eventCount = document.querySelectorAll('#timeline-list .event').length;
        const waterfallRows = document.querySelectorAll('#waterfall-body tr').length;
        const feedback = (document.getElementById('feedback')?.textContent ?? '').trim();
        const passphraseDialogOpen =
          dialog instanceof HTMLDialogElement ? dialog.open : false;
        const sampleButtons = Array.from(document.querySelectorAll('#waterfall-body .waterfall-btn'))
          .slice(0, 12)
          .map((el) => ({
            label: (el.textContent ?? '').trim(),
            title: (el.getAttribute('title') ?? '').trim()
          }));
        const samples = sampleButtons.map((sample) => sample.label);
        const sampleUrls = sampleButtons.map((sample) => sample.title);

        if (eventCount === 0) {
          return {
            pending: true,
            eventCount,
            waterfallCount: waterfallRows,
            feedback,
            passphraseDialogOpen,
            passphraseSubmitted
          };
        }

        return {
          eventCount,
          waterfallCount: waterfallRows,
          feedback,
          passphraseDialogOpen,
          passphraseSubmitted,
          waterfallSamples: samples,
          waterfallSampleUrls: sampleUrls
        };
      })()
    `);

      if (snapshot?.ok === false) {
        throw new Error(JSON.stringify(snapshot));
      }

      lastSnapshot = snapshot ?? lastSnapshot;
      return snapshot && !snapshot.pending ? snapshot : null;
    },
    timeoutMs,
    300,
    () =>
      `Player did not load archive in time${
        lastSnapshot ? `; lastSnapshot=${JSON.stringify(lastSnapshot)}` : ""
      }`
  );
}

async function waitForPlayerEventType(playerClient, eventType, timeoutMs) {
  return waitFor(
    async () => {
      const found = await playerClient.evaluate(`
      (() => {
        const tags = Array.from(document.querySelectorAll('#timeline-list .tag'));
        return tags.some((node) => (node.textContent ?? '').trim() === ${JSON.stringify(eventType)});
      })()
    `);

      return found ? true : null;
    },
    timeoutMs,
    250,
    `Timeline did not include event type: ${eventType}`
  );
}

async function verifyPlayerScreenshotMarker(playerClient, timeoutMs) {
  const count = await waitFor(
    async () => {
      const value = await playerClient.evaluate(`
      (() => document.querySelectorAll('#filmstrip-list button[data-shot-event]').length)()
    `);

      return typeof value === "number" && value > 0 ? value : null;
    },
    timeoutMs,
    250,
    "No screenshot in player filmstrip"
  );

  for (let index = count - 1; index >= 0; index -= 1) {
    const clicked = await playerClient.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('#filmstrip-list button[data-shot-event]'));
        const button = buttons[${index}];

        if (!button) {
          return false;
        }

        button.click();
        return true;
      })()
    `);

    if (!clicked) {
      continue;
    }

    try {
      const details = await waitFor(
        async () => {
          const snapshot = await playerClient.evaluate(`
          (() => {
            const meta = (document.getElementById('filmstrip-meta')?.textContent ?? '').trim();
            const cursor = document.getElementById('filmstrip-cursor');
            const visible = !!cursor && !cursor.hasAttribute('hidden');
            const trailSegments = document.querySelectorAll(
              '#filmstrip-trail-svg .preview-trail-line, #filmstrip-trail-svg .preview-trail-point'
            ).length;
            return { meta, visible, trailSegments };
          })()
        `);

          if (!snapshot || !snapshot.visible) {
            return null;
          }

          if (!snapshot.meta.startsWith("Pointer marker:")) {
            return null;
          }

          if (typeof snapshot.trailSegments !== "number" || snapshot.trailSegments <= 0) {
            return null;
          }

          return snapshot;
        },
        2_500,
        150,
        "Marker not visible on this screenshot"
      );

      return {
        ok: true,
        meta: details.meta,
        screenshotIndex: index
      };
    } catch {
      // Continue trying older screenshots.
    }
  }

  return {
    ok: false,
    reason: "no-screenshot-with-pointer-marker"
  };
}

async function verifyPlayerProgressHoverResponse(playerClient, timeoutMs) {
  const hoverReady = await waitFor(
    async () => {
      const snapshot = await playerClient.evaluate(`
      (() => {
        const markers = Array.from(
          document.querySelectorAll('#playback-markers button[data-marker-kind="network"]')
        );
        const hover = document.getElementById('progress-hover');
        const response = document.getElementById('progress-hover-response');
        const body = document.getElementById('progress-hover-response-body');
        const toggle = document.getElementById('progress-hover-response-toggle');
        const copy = document.getElementById('progress-hover-response-copy');
        const progress = document.getElementById('playback-progress');
        const key = '__wbHoverProbeIndex';
        const step = '__wbHoverProbeStep';
        const emptyPreviewKey = '__wbHoverEmptyPreviewCount';

        if (!hover || !response || !body || !toggle || !copy) {
          return null;
        }

        let markerIndex = null;

        if (markers.length > 0) {
          const index =
            typeof window[key] === 'number' && Number.isFinite(window[key]) ? window[key] : 0;
          markerIndex = Math.abs(Math.trunc(index)) % markers.length;
          window[key] = markerIndex + 1;
          const marker = markers[markerIndex];

          if (marker) {
            const rect = marker.getBoundingClientRect();
            marker.dispatchEvent(
              new PointerEvent('pointermove', {
                bubbles: true,
                pointerType: 'mouse',
                clientX: rect.left + Math.max(1, rect.width / 2),
                clientY: rect.top + Math.max(1, rect.height / 2)
              })
            );
          }
        } else if (progress) {
          const rawStep =
            typeof window[step] === 'number' && Number.isFinite(window[step]) ? window[step] : 1;
          const ratio = ((Math.abs(Math.trunc(rawStep)) % 9) + 1) / 10;
          window[step] = rawStep + 1;
          const rect = progress.getBoundingClientRect();
          progress.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerType: 'mouse',
              clientX: rect.left + ratio * rect.width,
              clientY: rect.top + Math.max(1, rect.height / 2)
            })
          );
        }

        if (hover.hidden || response.hidden) {
          return null;
        }

        const text = (body.textContent ?? '').trim();

        if (text.length === 0) {
          const emptyPreviewCount =
            typeof window[emptyPreviewKey] === 'number' && Number.isFinite(window[emptyPreviewKey])
              ? window[emptyPreviewKey] + 1
              : 1;
          window[emptyPreviewKey] = emptyPreviewCount;

          if (emptyPreviewCount >= 8) {
            return {
              markerIndex,
              copyEnabled: !copy.disabled,
              toggleEnabled: !toggle.disabled,
              toggleText: (toggle.textContent ?? '').trim(),
              copyText: (copy.textContent ?? '').trim(),
              textLength: 0,
              emptyPreview: true
            };
          }

          return null;
        }

        window[emptyPreviewKey] = 0;

        return {
          markerIndex,
          copyEnabled: !copy.disabled,
          toggleEnabled: !toggle.disabled,
          toggleText: (toggle.textContent ?? '').trim(),
          copyText: (copy.textContent ?? '').trim(),
          textLength: text.length
        };
      })()
    `);

      return snapshot ?? null;
    },
    timeoutMs,
    250,
    "Hover response preview not found on progress markers"
  );

  if (hoverReady.emptyPreview) {
    return {
      ok: true,
      markerIndex: hoverReady.markerIndex,
      toggleEnabled: hoverReady.toggleEnabled,
      copyEnabled: hoverReady.copyEnabled,
      skipped: "response-preview-empty"
    };
  }

  if (!hoverReady.copyEnabled) {
    return {
      ok: true,
      markerIndex: hoverReady.markerIndex,
      toggleEnabled: hoverReady.toggleEnabled,
      copyEnabled: false,
      skipped: "response-body-not-captured"
    };
  }

  let toggled = null;

  if (hoverReady.toggleEnabled) {
    const toggleClick = await playerClient.evaluate(`
      (() => {
        const toggle = document.getElementById('progress-hover-response-toggle');

        if (!toggle || toggle.disabled) {
          return { ok: false, reason: 'toggle-disabled' };
        }

        const before = (toggle.textContent ?? '').trim();
        toggle.click();
        return { ok: true, before };
      })()
    `);

    if (!toggleClick?.ok) {
      return {
        ok: false,
        reason: toggleClick?.reason ?? "toggle-click-failed",
        hoverReady
      };
    }

    toggled = await waitFor(
      async () => {
        const snapshot = await playerClient.evaluate(`
        (() => {
          const toggle = document.getElementById('progress-hover-response-toggle');
          const body = document.getElementById('progress-hover-response-body');

          if (!toggle || !body) {
            return null;
          }

          const text = (toggle.textContent ?? '').trim();
          return {
            toggleText: text,
            expanded: body.classList.contains('expanded')
          };
        })()
      `);

        if (!snapshot || snapshot.toggleText === toggleClick.before || !snapshot.expanded) {
          return null;
        }

        return snapshot;
      },
      8_000,
      150,
      "Hover response toggle did not switch to expanded mode"
    );
  }

  const copyClick = await playerClient.evaluate(`
    (() => {
      const copy = document.getElementById('progress-hover-response-copy');

      if (!copy || copy.disabled) {
        return { ok: false, reason: 'copy-disabled' };
      }

      copy.click();
      return { ok: true };
    })()
  `);

  if (!copyClick?.ok) {
    return {
      ok: false,
      reason: copyClick?.reason ?? "copy-click-failed",
      hoverReady,
      toggled
    };
  }

  const copied = await waitFor(
    async () => {
      const snapshot = await playerClient.evaluate(`
      (() => {
        const copy = document.getElementById('progress-hover-response-copy');
        const feedback = document.getElementById('feedback');

        if (!copy) {
          return null;
        }

        return {
          copyText: (copy.textContent ?? '').trim(),
          feedback: (feedback?.textContent ?? '').trim()
        };
      })()
    `);

      if (!snapshot) {
        return null;
      }

      const feedbackOk =
        typeof snapshot.feedback === "string" &&
        snapshot.feedback.includes("Copied response preview.");

      if (snapshot.copyText !== "Copied" && !feedbackOk) {
        return null;
      }

      return snapshot;
    },
    8_000,
    150,
    "Hover response copy action did not complete"
  );

  return {
    ok: true,
    markerIndex: hoverReady.markerIndex,
    initialToggleText: hoverReady.toggleText,
    toggleEnabled: hoverReady.toggleEnabled,
    copyEnabled: true,
    toggled,
    copied
  };
}

async function waitForFile(path, timeoutMs) {
  return waitFor(
    async () => {
      try {
        return await stat(path);
      } catch {
        return null;
      }
    },
    timeoutMs,
    250,
    `File not found: ${path}`
  );
}

async function rebuildArchiveFromDataUrl(dataUrl, outputPath) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return false;
  }

  const marker = "base64,";
  const markerIndex = dataUrl.indexOf(marker);

  if (markerIndex === -1) {
    return false;
  }

  const base64 = dataUrl.slice(markerIndex + marker.length);

  if (base64.length === 0) {
    return false;
  }

  const bytes = Buffer.from(base64, "base64");

  if (bytes.byteLength === 0) {
    return false;
  }

  await writeFile(outputPath, bytes);
  return true;
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

  const message = typeof timeoutMessage === "function" ? timeoutMessage() : timeoutMessage;

  if (lastError instanceof Error) {
    throw new Error(`${message}: ${lastError.message}`);
  }

  throw new Error(message);
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cleanup() {
  if (state.browserClient) {
    state.browserClient.close();
    state.browserClient = null;
  }

  if (state.playerClient) {
    state.playerClient.close();
    state.playerClient = null;
  }

  if (state.demoClient) {
    state.demoClient.close();
    state.demoClient = null;
  }

  if (state.popupClient) {
    state.popupClient.close();
    state.popupClient = null;
  }

  if (state.swClient) {
    state.swClient.close();
    state.swClient = null;
  }

  for (const targetId of state.openedTargetIds.splice(0)) {
    if (state.baseUrl) {
      await closeTarget(state.baseUrl, targetId);
    }
  }

  await terminateChromeProcess(state.chromeProcess);

  state.chromeProcess = null;
  state.baseUrl = null;

  if (state.logStream) {
    await new Promise((resolve) => {
      state.logStream.end(resolve);
    });
    state.logStream = null;
  }

  if (state.server) {
    await new Promise((resolve) => {
      state.server.close(() => resolve());
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
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;

      socket.addEventListener("open", () => {
        resolve();
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

      socket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));

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
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(message);
    });
  }

  async evaluate(expression, options = undefined) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(options ?? {})
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
