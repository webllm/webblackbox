#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(extensionRoot, "build");
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9235");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-lite-perf-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-lite-perf-${Date.now()}.log`;
const chromeReadyTimeoutMs = Number(process.env.WB_E2E_CHROME_READY_TIMEOUT_MS ?? "45000");
const chromeLaunchAttempts = Number(process.env.WB_E2E_CHROME_LAUNCH_ATTEMPTS ?? "2");

const perfRequests = Number(process.env.WB_E2E_PERF_REQUESTS ?? "120");
const perfConcurrency = Number(process.env.WB_E2E_PERF_CONCURRENCY ?? "6");
const perfPauseMs = Number(process.env.WB_E2E_PERF_PAUSE_MS ?? "0");
const perfPayloadBytes = Number(process.env.WB_E2E_PERF_PAYLOAD_BYTES ?? "98304");
const perfServerDelayMs = Number(process.env.WB_E2E_PERF_SERVER_DELAY_MS ?? "10");
const perfHoverIntervalMs = Number(process.env.WB_E2E_PERF_HOVER_INTERVAL_MS ?? "16");
const perfSettleMs = Number(process.env.WB_E2E_PERF_SETTLE_MS ?? "1200");
const perfAfterStartSettleMs = Number(process.env.WB_E2E_PERF_AFTER_START_SETTLE_MS ?? "500");
const perfTimeoutMs = Number(process.env.WB_E2E_PERF_TIMEOUT_MS ?? "120000");
const interactionRounds = Number(process.env.WB_E2E_PERF_INTERACTION_ROUNDS ?? "18");
const interactionMutationBatch = Number(process.env.WB_E2E_PERF_INTERACTION_MUTATIONS ?? "180");
const interactionScrollStep = Number(process.env.WB_E2E_PERF_INTERACTION_SCROLL_STEP ?? "240");
const interactionSettleMs = Number(process.env.WB_E2E_PERF_INTERACTION_SETTLE_MS ?? "400");
const iframeCount = Number(process.env.WB_E2E_PERF_IFRAME_COUNT ?? "10");
const iframeInteractionRounds = Number(process.env.WB_E2E_PERF_IFRAME_ROUNDS ?? "12");
const editorRounds = Number(process.env.WB_E2E_PERF_EDITOR_ROUNDS ?? "28");
const navigationRounds = Number(process.env.WB_E2E_PERF_NAV_ROUNDS ?? "6");
const navigationWaitMs = Number(process.env.WB_E2E_PERF_NAV_WAIT_MS ?? "8000");
const warmupRequests = Number(process.env.WB_E2E_PERF_WARMUP_REQUESTS ?? "24");
const warmupPayloadBytes = Number(process.env.WB_E2E_PERF_WARMUP_PAYLOAD_BYTES ?? "16384");
const requestP95RatioLimit = Number(process.env.WB_E2E_PERF_FETCH_P95_RATIO ?? "1.6");
const requestP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_FETCH_P95_DELTA_MS ?? "30");
const durationRatioLimit = Number(process.env.WB_E2E_PERF_DURATION_RATIO ?? "1.45");
const durationDeltaLimitMs = Number(process.env.WB_E2E_PERF_DURATION_DELTA_MS ?? "900");
const hoverP95RatioLimit = Number(process.env.WB_E2E_PERF_HOVER_P95_RATIO ?? "1.8");
const hoverP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_HOVER_P95_DELTA_MS ?? "10");
const hoverOver32DeltaLimit = Number(process.env.WB_E2E_PERF_HOVER_OVER32_DELTA ?? "6");
const rafP95RatioLimit = Number(process.env.WB_E2E_PERF_RAF_P95_RATIO ?? "1.35");
const rafP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_RAF_P95_DELTA_MS ?? "8");
const clickCallP95RatioLimit = Number(process.env.WB_E2E_PERF_CLICK_CALL_P95_RATIO ?? "1.8");
const clickCallP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_CLICK_CALL_P95_DELTA_MS ?? "8");
const clickLagP95RatioLimit = Number(process.env.WB_E2E_PERF_CLICK_LAG_P95_RATIO ?? "1.8");
const clickLagP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_CLICK_LAG_P95_DELTA_MS ?? "8");
const editorInputP95RatioLimit = Number(process.env.WB_E2E_PERF_EDITOR_INPUT_P95_RATIO ?? "1.8");
const editorInputP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_EDITOR_INPUT_P95_DELTA_MS ?? "8");
const editorRafP95RatioLimit = Number(process.env.WB_E2E_PERF_EDITOR_RAF_P95_RATIO ?? "1.5");
const editorRafP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_EDITOR_RAF_P95_DELTA_MS ?? "10");
const navigationP95RatioLimit = Number(process.env.WB_E2E_PERF_NAV_P95_RATIO ?? "1.7");
const navigationP95DeltaLimitMs = Number(process.env.WB_E2E_PERF_NAV_P95_DELTA_MS ?? "80");
const navigationFallbackDeltaLimit = Number(process.env.WB_E2E_PERF_NAV_FALLBACK_DELTA ?? "1");
const clickOver16DeltaLimit = Number(process.env.WB_E2E_PERF_CLICK_OVER16_DELTA ?? "4");
const longTaskTotalDeltaLimitMs = Number(process.env.WB_E2E_PERF_LONGTASK_TOTAL_DELTA_MS ?? "200");
const longTaskCountDeltaLimit = Number(process.env.WB_E2E_PERF_LONGTASK_COUNT_DELTA ?? "4");

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
  baseUrl: null,
  server: null,
  browserClient: null,
  popupClient: null,
  pageClient: null,
  swClient: null,
  openedTargetIds: []
};

main().catch(async (error) => {
  console.error(
    "Lite perf regression failed:",
    error instanceof Error ? error.message : String(error)
  );
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureExtensionBuildReady(extensionDir);
  const chromeBinary = await resolveChromeBinary(chromeCandidates);
  const extensionId = await resolvePreferredExtensionId(extensionDir);

  assert(isLikelyExtensionId(extensionId), "Failed to resolve extension id from manifest key.", {
    extensionDir
  });

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const server = await startStressServer();
  state.server = server.server;

  const stressUrl = `http://127.0.0.1:${server.port}/perf/`;

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
  console.log(`Extension ID: ${extensionId}`);

  const browserWsUrl =
    typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : null;
  assert(browserWsUrl, "Browser websocket debugger URL is unavailable.", { version });

  const browserClient = new CdpClient(browserWsUrl);
  await browserClient.connect();
  state.browserClient = browserClient;

  const pageTarget = await openTarget(baseUrl, stressUrl);
  state.openedTargetIds.push(pageTarget.id);
  const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await pageClient.connect();
  state.pageClient = pageClient;

  await pageClient.send("Runtime.enable");
  await pageClient.send("Page.enable").catch(() => undefined);
  await waitForPerfHarness(pageClient, 20_000);
  await activatePageTarget(browserClient, pageTarget);

  const swExceptions = [];
  const pageExceptions = [];
  pageClient.on("Runtime.exceptionThrown", (params) => {
    pageExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const warmupSummary = await runPerfScenario(pageClient, {
    label: "warmup",
    requests: Math.max(8, Math.floor(warmupRequests)),
    concurrency: Math.max(1, Math.floor(Math.min(perfConcurrency, 4))),
    pauseMs: Math.max(0, Math.floor(perfPauseMs)),
    payloadBytes: Math.max(4096, Math.floor(warmupPayloadBytes)),
    serverDelayMs: Math.max(0, Math.floor(Math.min(perfServerDelayMs, 12))),
    hoverIntervalMs: Math.max(8, Math.floor(perfHoverIntervalMs)),
    settleMs: Math.max(250, Math.floor(Math.min(perfSettleMs, 600))),
    apiBaseUrl: `http://127.0.0.1:${server.port}/api/ping/`,
    seed: `warmup-${Math.random().toString(36).slice(2)}`
  });
  assert(warmupSummary?.ok === true, "Warmup perf scenario failed.", warmupSummary);

  const baseline = await runPerfScenario(pageClient, {
    label: "baseline",
    requests: Math.max(1, Math.floor(perfRequests)),
    concurrency: Math.max(1, Math.floor(perfConcurrency)),
    pauseMs: Math.max(0, Math.floor(perfPauseMs)),
    payloadBytes: Math.max(1024, Math.floor(perfPayloadBytes)),
    serverDelayMs: Math.max(0, Math.floor(perfServerDelayMs)),
    hoverIntervalMs: Math.max(8, Math.floor(perfHoverIntervalMs)),
    settleMs: Math.max(250, Math.floor(perfSettleMs)),
    apiBaseUrl: `http://127.0.0.1:${server.port}/api/ping/`,
    seed: `baseline-${Math.random().toString(36).slice(2)}`
  });
  assert(baseline?.ok === true, "Baseline perf scenario failed.", baseline);
  assert(baseline.state?.errors === 0, "Baseline perf scenario reported request errors.", baseline);

  const baselineInteraction = await runInteractionScenario(pageClient, {
    label: "baseline-interaction",
    rounds: Math.max(4, Math.floor(interactionRounds)),
    mutationBatch: Math.max(24, Math.floor(interactionMutationBatch)),
    scrollStep: Math.max(40, Math.floor(interactionScrollStep)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(
    baselineInteraction?.ok === true,
    "Baseline interaction scenario failed.",
    baselineInteraction
  );

  const baselineIframe = await runIframeScenario(pageClient, {
    label: "baseline-iframe",
    iframeCount: Math.max(4, Math.floor(iframeCount)),
    rounds: Math.max(4, Math.floor(iframeInteractionRounds)),
    mutationBatch: Math.max(24, Math.floor(interactionMutationBatch)),
    scrollStep: Math.max(40, Math.floor(interactionScrollStep)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(baselineIframe?.ok === true, "Baseline iframe scenario failed.", baselineIframe);

  const baselineEditor = await runEditorScenario(pageClient, {
    label: "baseline-editor",
    rounds: Math.max(8, Math.floor(editorRounds)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(baselineEditor?.ok === true, "Baseline editor scenario failed.", baselineEditor);

  const baselineNavigation = await runDocumentNavigationScenario(pageClient, {
    label: "baseline-navigation",
    rounds: Math.max(2, Math.floor(navigationRounds)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs)),
    sourceUrl: stressUrl,
    targetUrl: `http://127.0.0.1:${server.port}/perf/nav-target`
  });
  assert(
    baselineNavigation?.ok === true,
    "Baseline document navigation scenario failed.",
    baselineNavigation
  );

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popupStart = await openPopupRuntimeTarget(popupUrl);
  state.popupClient = popupStart.client;

  const swTarget = await waitForExtensionTarget(
    baseUrl,
    browserClient,
    (target) =>
      target.type === "service_worker" &&
      typeof target.url === "string" &&
      target.url === `chrome-extension://${extensionId}/sw.js`,
    20_000,
    "Extension service worker target not found after popup warmup"
  );

  const swClient = await connectToDiscoveredTarget(swTarget, browserClient);
  state.swClient = swClient;
  await swClient.send("Runtime.enable").catch(() => undefined);
  swClient.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const start = await startSessionFromPopup(popupStart.client, "lite", stressUrl);
  assert(start?.ok === true, "Failed to start lite mode session.", start);

  const indicatorText = await waitForIndicatorText(pageClient, "REC lite", 25_000);
  assert(typeof indicatorText === "string", "Lite mode indicator did not appear.", {
    indicatorText
  });

  const sessionsAfterStart = await readRuntimeSessions(popupStart.client);
  assert(
    Array.isArray(sessionsAfterStart) && sessionsAfterStart.length === 1,
    "Expected exactly one active runtime session after start.",
    { sessionsAfterStart }
  );

  const active = sessionsAfterStart[0];
  assert(typeof active?.sid === "string" && active.sid.length > 0, "Missing active session sid.", {
    sessionsAfterStart
  });

  await closeClient(popupStart.client);
  state.popupClient = null;
  await closeTarget(baseUrl, popupStart.target.id);
  await sleep(Math.max(0, Math.floor(perfAfterStartSettleMs)));
  await activatePageTarget(browserClient, pageTarget);

  const recorded = await runPerfScenario(pageClient, {
    label: "lite-recording",
    requests: Math.max(1, Math.floor(perfRequests)),
    concurrency: Math.max(1, Math.floor(perfConcurrency)),
    pauseMs: Math.max(0, Math.floor(perfPauseMs)),
    payloadBytes: Math.max(1024, Math.floor(perfPayloadBytes)),
    serverDelayMs: Math.max(0, Math.floor(perfServerDelayMs)),
    hoverIntervalMs: Math.max(8, Math.floor(perfHoverIntervalMs)),
    settleMs: Math.max(250, Math.floor(perfSettleMs)),
    apiBaseUrl: `http://127.0.0.1:${server.port}/api/ping/`,
    seed: `recording-${Math.random().toString(36).slice(2)}`
  });
  assert(recorded?.ok === true, "Lite recording perf scenario failed.", recorded);
  assert(recorded.state?.errors === 0, "Lite recording perf scenario reported request errors.", {
    recorded
  });

  const recordedInteraction = await runInteractionScenario(pageClient, {
    label: "lite-recording-interaction",
    rounds: Math.max(4, Math.floor(interactionRounds)),
    mutationBatch: Math.max(24, Math.floor(interactionMutationBatch)),
    scrollStep: Math.max(40, Math.floor(interactionScrollStep)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(
    recordedInteraction?.ok === true,
    "Lite recording interaction scenario failed.",
    recordedInteraction
  );

  const recordedIframe = await runIframeScenario(pageClient, {
    label: "lite-recording-iframe",
    iframeCount: Math.max(4, Math.floor(iframeCount)),
    rounds: Math.max(4, Math.floor(iframeInteractionRounds)),
    mutationBatch: Math.max(24, Math.floor(interactionMutationBatch)),
    scrollStep: Math.max(40, Math.floor(interactionScrollStep)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(recordedIframe?.ok === true, "Lite recording iframe scenario failed.", recordedIframe);

  const recordedEditor = await runEditorScenario(pageClient, {
    label: "lite-recording-editor",
    rounds: Math.max(8, Math.floor(editorRounds)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs))
  });
  assert(recordedEditor?.ok === true, "Lite recording editor scenario failed.", recordedEditor);

  const recordedNavigation = await runDocumentNavigationScenario(pageClient, {
    label: "lite-recording-navigation",
    rounds: Math.max(2, Math.floor(navigationRounds)),
    settleMs: Math.max(100, Math.floor(interactionSettleMs)),
    sourceUrl: stressUrl,
    targetUrl: `http://127.0.0.1:${server.port}/perf/nav-target`
  });
  assert(
    recordedNavigation?.ok === true,
    "Lite recording document navigation scenario failed.",
    recordedNavigation
  );

  const popupStop = await openPopupRuntimeTarget(popupUrl);
  state.popupClient = popupStop.client;

  const stop = await stopActiveSessionFromPopup(popupStop.client);
  assert(stop?.ok === true, "Failed to stop lite mode session.", stop);

  const indicatorGone = await waitForIndicatorGone(pageClient, 15_000);
  assert(indicatorGone === true, "Lite mode indicator did not clear after stop.", {
    indicatorGone
  });

  const sessionsAfterStop =
    (await waitFor(
      async () => {
        const rows = await readRuntimeSessions(popupStop.client);
        return Array.isArray(rows) && rows.length === 0 ? rows : null;
      },
      15_000,
      250,
      "Runtime sessions were not cleared after stop."
    )) ?? [];
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    "Runtime sessions were not cleared after stop.",
    { sessionsAfterStop }
  );

  const deleted = await deleteSessionFromPopup(popupStop.client, active.sid);
  assert(deleted?.ok === true, "Failed to delete stopped session.", deleted);

  assert(swExceptions.length === 0, "Service worker threw runtime exceptions.", {
    swExceptions
  });
  assert(pageExceptions.length === 0, "Page threw runtime exceptions.", {
    pageExceptions
  });

  const comparison = compareSummaries(
    baseline.summary,
    recorded.summary,
    baselineInteraction.summary,
    recordedInteraction.summary,
    baselineIframe.summary,
    recordedIframe.summary,
    baselineEditor.summary,
    recordedEditor.summary,
    baselineNavigation.summary,
    recordedNavigation.summary
  );

  console.log("Warmup summary:", JSON.stringify(warmupSummary.summary));
  console.log("Baseline summary:", JSON.stringify(baseline.summary));
  console.log("Baseline interaction summary:", JSON.stringify(baselineInteraction.summary));
  console.log("Baseline iframe summary:", JSON.stringify(baselineIframe.summary));
  console.log("Baseline editor summary:", JSON.stringify(baselineEditor.summary));
  console.log("Baseline navigation summary:", JSON.stringify(baselineNavigation.summary));
  console.log("Lite recording summary:", JSON.stringify(recorded.summary));
  console.log("Lite recording interaction summary:", JSON.stringify(recordedInteraction.summary));
  console.log("Lite recording iframe summary:", JSON.stringify(recordedIframe.summary));
  console.log("Lite recording editor summary:", JSON.stringify(recordedEditor.summary));
  console.log("Lite recording navigation summary:", JSON.stringify(recordedNavigation.summary));
  console.log("Comparison:", JSON.stringify(comparison));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("Lite perf regression passed.");

  await cleanup();
}

async function ensureExtensionBuildReady(dir) {
  await access(dir, constants.R_OK);
  await access(resolve(dir, "manifest.json"), constants.R_OK);
  await access(resolve(dir, "sw.js"), constants.R_OK);
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
  const resolved = which.status === 0 ? which.stdout.trim() : "";

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
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      proc.once("exit", resolve);
    }),
    sleep(5_000)
  ]);

  if (proc.exitCode === null && !proc.killed) {
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

async function startStressServer() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (
      requestUrl.pathname === "/" ||
      requestUrl.pathname === "/perf" ||
      requestUrl.pathname === "/perf/"
    ) {
      const html = buildStressPageHtml();
      const bytes = Buffer.from(html);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
      return;
    }

    if (requestUrl.pathname === "/perf/nav-target") {
      const html = buildNavigationTargetHtml(requestUrl.searchParams.get("token") ?? "nav");
      const bytes = Buffer.from(html);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
      return;
    }

    if (requestUrl.pathname === "/perf/iframe" || requestUrl.pathname === "/perf/iframe/") {
      const html = buildIframePageHtml(requestUrl.searchParams.get("slot") ?? "0");
      const bytes = Buffer.from(html);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/ping/")) {
      const seq = requestUrl.pathname.slice("/api/ping/".length) || "0";
      const token = requestUrl.searchParams.get("token") ?? "missing-token";
      const payloadBytes = Math.max(
        1024,
        Math.min(Number(requestUrl.searchParams.get("bytes") ?? perfPayloadBytes), 131_072)
      );
      const responseDelayMs = Math.max(
        0,
        Math.min(Number(requestUrl.searchParams.get("delay") ?? perfServerDelayMs), 250)
      );
      const body = buildResponsePayload(seq, token, payloadBytes);
      const bytes = Buffer.from(body);

      setTimeout(() => {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-length": bytes.byteLength
        });
        response.end(bytes);
      }, responseDelayMs);
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ ok: false, error: "not-found", path: requestUrl.pathname }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  assert(address && typeof address !== "string", "Failed to resolve stress server port.");

  return {
    server,
    port: address.port
  };
}

function buildResponsePayload(seq, token, targetBytes) {
  const prefix = `seq=${seq}\ntoken=${token}\n`;
  const padLength = Math.max(0, targetBytes - Buffer.byteLength(prefix));
  return `${prefix}${"x".repeat(padLength)}`;
}

function escapeHtmlForJs(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildNavigationTargetHtml(token) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Navigation Target</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f7f2e9;
        color: #1f2937;
        font: 600 16px/1.5 ui-sans-serif, system-ui, sans-serif;
      }

      main {
        padding: 28px 32px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 18px 48px rgba(31, 41, 55, 0.12);
      }
    </style>
  </head>
  <body data-page="nav-target">
    <main>
      <p id="nav-ready">nav target ready token=${escapeHtmlForJs(token)}</p>
    </main>
  </body>
</html>`;
}

function buildIframePageHtml(slot) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(180deg, #f8fafc 0%, #eff6ff 100%);
        color: #1f2937;
        font: 600 12px/1.4 ui-sans-serif, system-ui, sans-serif;
        display: grid;
        place-items: center;
      }

      main {
        display: grid;
        gap: 10px;
        justify-items: center;
      }

      #frame-link {
        color: #0f4c81;
        text-decoration: none;
        border-bottom: 2px solid rgba(15, 76, 129, 0.18);
      }

      #frame-link:hover {
        color: #9a3412;
        border-bottom-color: rgba(154, 52, 18, 0.35);
      }
    </style>
  </head>
  <body data-page="iframe-target">
    <main>
      <span>iframe slot ${escapeHtmlForJs(slot)}</span>
      <a id="frame-link" href="#frame-target-${escapeHtmlForJs(slot)}">frame action</a>
      <div id="frame-click-log">clicks: 0</div>
      <div id="frame-target-${escapeHtmlForJs(slot)}" hidden></div>
    </main>
    <script>
      (() => {
        const link = document.getElementById("frame-link");
        const clickLogNode = document.getElementById("frame-click-log");
        let clickCount = 0;
        let clickMeasurementStartedAt = 0;
        let lastClickLag = 0;
        let lastCallDuration = 0;

        if (link instanceof HTMLAnchorElement) {
          link.addEventListener("click", (event) => {
            event.preventDefault();
            clickCount += 1;

            if (clickMeasurementStartedAt > 0) {
              lastClickLag = performance.now() - clickMeasurementStartedAt;
            }

            if (clickLogNode instanceof HTMLElement) {
              clickLogNode.textContent = "clicks: " + String(clickCount);
            }
          });
        }

        globalThis.__WB_IFRAME_PERF__ = {
          triggerClick() {
            if (!(link instanceof HTMLAnchorElement)) {
              return {
                ok: false,
                reason: "missing-link"
              };
            }

            clickMeasurementStartedAt = performance.now();
            const startedAt = performance.now();
            link.click();
            lastCallDuration = performance.now() - startedAt;
            clickMeasurementStartedAt = 0;

            return {
              ok: true,
              clickCount,
              clickCallMs: lastCallDuration,
              clickLagMs: lastClickLag
            };
          }
        };
      })();
    </script>
  </body>
</html>`;
}

function buildStressPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>WebBlackbox Lite Perf Stress</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --panel: rgba(255, 250, 241, 0.94);
        --ink: #202834;
        --muted: #5d6671;
        --line: rgba(56, 70, 86, 0.18);
        --accent: #c04a2b;
        --accent-soft: rgba(192, 74, 43, 0.14);
        --ok: #1e7b4d;
        --warn: #975a16;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(192, 74, 43, 0.16), transparent 34%),
          linear-gradient(180deg, #fbf6ef 0%, var(--bg) 100%);
      }

      main {
        width: min(1040px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        line-height: 1.1;
      }

      p {
        margin: 0;
        color: var(--muted);
      }

      .panel {
        margin-top: 18px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        box-shadow: 0 18px 48px rgba(30, 24, 16, 0.07);
        padding: 18px;
      }

      .status-row {
        display: flex;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 999px;
        font-weight: 700;
        letter-spacing: 0.02em;
        border: 1px solid transparent;
      }

      .pill[data-tone="idle"] {
        color: var(--muted);
        border-color: var(--line);
      }

      .pill[data-tone="running"] {
        color: var(--warn);
        border-color: rgba(151, 90, 22, 0.3);
        background: rgba(151, 90, 22, 0.1);
      }

      .pill[data-tone="done"] {
        color: var(--ok);
        border-color: rgba(30, 123, 77, 0.3);
        background: rgba(30, 123, 77, 0.1);
      }

      .pill[data-tone="error"] {
        color: var(--accent);
        border-color: rgba(192, 74, 43, 0.3);
        background: var(--accent-soft);
      }

      #request-log {
        width: 100%;
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.55);
        min-height: 48px;
        color: var(--muted);
        word-break: break-word;
      }

      .action-row {
        margin-top: 18px;
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }

      #action-link,
      #document-link {
        display: inline-flex;
        align-items: center;
        min-height: 40px;
        padding: 0 16px;
        border-radius: 999px;
        border: 1px solid rgba(192, 74, 43, 0.28);
        color: #7f2f1b;
        text-decoration: none;
        font-weight: 700;
        letter-spacing: 0.02em;
        background: linear-gradient(180deg, #fff4ea 0%, #ffe8dc 100%);
      }

      #document-link {
        border-color: rgba(30, 123, 77, 0.26);
        color: #14503a;
        background: linear-gradient(180deg, #eefbf4 0%, #def6e9 100%);
      }

      #action-link:hover,
      #document-link:hover {
        border-color: rgba(192, 74, 43, 0.46);
        background: linear-gradient(180deg, #fff0e2 0%, #ffe1d2 100%);
      }

      #document-link:hover {
        border-color: rgba(30, 123, 77, 0.42);
        background: linear-gradient(180deg, #e5f9ef 0%, #d2f0e0 100%);
      }

      #click-log {
        min-height: 20px;
        color: var(--muted);
      }

      #hover-grid {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: 10px;
      }

      #mutation-grid {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 10px;
      }

      .aux-grid {
        margin-top: 18px;
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
        gap: 14px;
      }

      .aux-panel {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.68);
        padding: 12px;
      }

      .aux-panel h2 {
        margin: 0 0 10px;
        font-size: 14px;
      }

      #editor-surface {
        min-height: 120px;
        border-radius: 12px;
        border: 1px solid rgba(56, 70, 86, 0.16);
        background: linear-gradient(180deg, #fffefc 0%, #f9f5ee 100%);
        padding: 14px;
        outline: none;
        white-space: pre-wrap;
        word-break: break-word;
      }

      #editor-surface:focus {
        border-color: rgba(30, 123, 77, 0.4);
        box-shadow: 0 0 0 3px rgba(30, 123, 77, 0.08);
      }

      #iframe-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      #iframe-grid iframe {
        width: 100%;
        min-height: 96px;
        border: 1px solid rgba(56, 70, 86, 0.16);
        border-radius: 12px;
        background: #fff;
      }

      .cell {
        min-height: 78px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.8);
        padding: 10px;
        transition: transform 80ms linear, background 80ms linear, border-color 80ms linear;
      }

      .cell.active {
        transform: translateY(-1px);
        border-color: rgba(192, 74, 43, 0.35);
        background: linear-gradient(180deg, #fff0e9 0%, #fff8f2 100%);
      }

      .cell-index {
        display: block;
        font-size: 11px;
        color: var(--muted);
      }

      .cell-label {
        display: block;
        margin-top: 6px;
        font-weight: 700;
      }

      .mutation-cell {
        min-height: 64px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
        padding: 10px;
        transition: transform 80ms linear, border-color 80ms linear;
      }

      .mutation-cell.hot {
        transform: translateY(-1px);
        border-color: rgba(30, 123, 77, 0.34);
        background: linear-gradient(180deg, #effdf4 0%, #f8fffb 100%);
      }

      .mutation-cell.warm {
        border-color: rgba(192, 74, 43, 0.32);
        background: linear-gradient(180deg, #fff3ec 0%, #fffaf6 100%);
      }

      .scroll-runway {
        height: 120vh;
      }

      @media (max-width: 900px) {
        #hover-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }

        #mutation-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .aux-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>WebBlackbox Lite Perf Stress</h1>
      <p>The regression runner drives this page and compares idle-vs-recording overhead.</p>
      <section class="panel">
        <div class="status-row">
          <div id="status" class="pill" data-tone="idle">ready</div>
        </div>
        <div id="request-log">idle</div>
        <div class="action-row">
          <a id="action-link" href="#action-target">exercise link</a>
          <a id="document-link" href="/perf/nav-target?token=default">document nav</a>
          <div id="click-log">clicks: 0</div>
        </div>
        <div id="hover-grid"></div>
        <div id="mutation-grid"></div>
        <div class="aux-grid">
          <section class="aux-panel">
            <h2>Editor</h2>
            <div id="editor-surface" contenteditable="true" spellcheck="false"></div>
          </section>
          <section class="aux-panel">
            <h2>Iframes</h2>
            <div id="iframe-grid"></div>
          </section>
        </div>
      </section>
      <section id="action-target" class="panel">
        <p>hash target</p>
      </section>
      <div class="scroll-runway" aria-hidden="true"></div>
    </main>
    <script>
      (() => {
        const statusNode = document.getElementById("status");
        const requestLogNode = document.getElementById("request-log");
        const actionLinkNode = document.getElementById("action-link");
        const documentLinkNode = document.getElementById("document-link");
        const clickLogNode = document.getElementById("click-log");
        const hoverGridNode = document.getElementById("hover-grid");
        const mutationGridNode = document.getElementById("mutation-grid");
        const editorSurfaceNode = document.getElementById("editor-surface");
        const iframeGridNode = document.getElementById("iframe-grid");
        const cells = [];
        const labels = [];
        const mutationCells = [];
        let iframeSetupSignature = "";
        let activeCell = null;
        let clickCount = 0;
        let clickMeasurementStartedAt = 0;
        let activeClickLagSamples = null;

        for (let index = 0; index < 32; index += 1) {
          const cell = document.createElement("div");
          cell.className = "cell";

          const id = document.createElement("span");
          id.className = "cell-index";
          id.textContent = "slot-" + String(index).padStart(2, "0");

          const label = document.createElement("span");
          label.className = "cell-label";
          label.textContent = "idle";

          cell.append(id, label);
          hoverGridNode.appendChild(cell);
          cells.push(cell);
          labels.push(label);
        }

        for (let index = 0; index < 72; index += 1) {
          const cell = document.createElement("div");
          cell.className = "mutation-cell";
          cell.dataset.phase = "idle";

          const id = document.createElement("span");
          id.className = "cell-index";
          id.textContent = "mut-" + String(index).padStart(2, "0");

          const label = document.createElement("span");
          label.className = "cell-label";
          label.textContent = "idle";

          cell.append(id, label);
          mutationGridNode.appendChild(cell);
          mutationCells.push({
            cell,
            label
          });
        }

        function roundMs(value) {
          return Number(value.toFixed(2));
        }

        function clampInt(value, fallback, min, max) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return fallback;
          }

          return Math.max(min, Math.min(max, Math.round(value)));
        }

        function percentile(sorted, ratio) {
          if (!sorted.length) {
            return 0;
          }

          const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
          return sorted[index];
        }

        function summarizeSeries(values) {
          const numeric = values
            .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
            .sort((left, right) => left - right);

          if (numeric.length === 0) {
            return {
              count: 0,
              meanMs: 0,
              p50Ms: 0,
              p95Ms: 0,
              maxMs: 0,
              over16Ms: 0,
              over32Ms: 0,
              over50Ms: 0
            };
          }

          const total = numeric.reduce((sum, value) => sum + value, 0);

          return {
            count: numeric.length,
            meanMs: roundMs(total / numeric.length),
            p50Ms: roundMs(percentile(numeric, 0.5)),
            p95Ms: roundMs(percentile(numeric, 0.95)),
            maxMs: roundMs(numeric[numeric.length - 1]),
            over16Ms: numeric.filter((value) => value > 16).length,
            over32Ms: numeric.filter((value) => value > 32).length,
            over50Ms: numeric.filter((value) => value > 50).length
          };
        }

        function summarizeLongTasks(values, supported) {
          const summary = summarizeSeries(values);
          return {
            supported,
            count: summary.count,
            totalMs: roundMs(values.reduce((sum, value) => sum + value, 0)),
            p95Ms: summary.p95Ms,
            maxMs: summary.maxMs
          };
        }

        function updateClickLog(text) {
          clickLogNode.textContent = text;
        }

        function resetCells() {
          if (activeCell) {
            activeCell.classList.remove("active");
            activeCell = null;
          }

          for (let index = 0; index < labels.length; index += 1) {
            labels[index].textContent = "idle";
          }
        }

        function resetMutationCells() {
          for (let index = 0; index < mutationCells.length; index += 1) {
            mutationCells[index].cell.className = "mutation-cell";
            mutationCells[index].cell.style.transform = "";
            mutationCells[index].cell.style.opacity = "";
            mutationCells[index].label.textContent = "idle";
          }
        }

        function applyMutationWave(wave, updates) {
          if (!mutationCells.length) {
            return;
          }

          const count = Math.max(1, Math.min(updates, mutationCells.length * 3));

          for (let index = 0; index < count; index += 1) {
            const cursor = (wave * 17 + index) % mutationCells.length;
            const entry = mutationCells[cursor];
            const phase = index % 3 === 0 ? "hot" : index % 2 === 0 ? "warm" : "idle";
            entry.cell.className = phase === "idle" ? "mutation-cell" : "mutation-cell " + phase;
            entry.cell.style.transform =
              phase === "hot" ? "translateY(-1px) scale(1.01)" : phase === "warm" ? "scale(1.005)" : "";
            entry.cell.style.opacity = phase === "idle" ? "" : String(0.92 + ((wave + index) % 6) * 0.01);
            entry.label.textContent = phase + "-" + String((wave + index) % 19);
          }
        }

        function setActiveCell(index, label) {
          if (activeCell) {
            activeCell.classList.remove("active");
          }

          if (index < 0 || cells.length === 0) {
            activeCell = null;
            return;
          }

          const nextIndex = index % cells.length;
          const nextCell = cells[nextIndex];
          nextCell.classList.add("active");
          labels[nextIndex].textContent = label;
          activeCell = nextCell;
        }

        function setStatus(text, tone) {
          statusNode.textContent = text;
          statusNode.dataset.tone = tone;
        }

        function resetPageState() {
          resetCells();
          resetMutationCells();
          clickCount = 0;
          clickMeasurementStartedAt = 0;
          activeClickLagSamples = null;
          if (editorSurfaceNode) {
            editorSurfaceNode.textContent = "";
          }
          updateClickLog("clicks: 0");
          requestLogNode.textContent = "idle";
          window.scrollTo(0, 0);
        }

        async function ensureIframeGrid(frameCount) {
          if (!iframeGridNode) {
            return 0;
          }

          const nextCount = clampInt(frameCount, 8, 1, 16);
          const signature = "frames-" + nextCount;

          if (iframeSetupSignature === signature && iframeGridNode.childElementCount === nextCount) {
            return nextCount;
          }

          iframeSetupSignature = signature;
          iframeGridNode.innerHTML = "";

          await Promise.all(
            Array.from({ length: nextCount }, (_, index) => {
              return new Promise((resolve) => {
                const frame = document.createElement("iframe");
                frame.loading = "eager";
                frame.src =
                  "/perf/iframe/?slot=" +
                  encodeURIComponent(String(index)) +
                  "&seed=" +
                  encodeURIComponent(signature);
                frame.addEventListener("load", () => resolve(), { once: true });
                iframeGridNode.appendChild(frame);
              });
            })
          );

          return nextCount;
        }

        actionLinkNode.addEventListener("click", (event) => {
          event.preventDefault();
          clickCount += 1;

          if (clickMeasurementStartedAt > 0 && Array.isArray(activeClickLagSamples)) {
            activeClickLagSamples.push(performance.now() - clickMeasurementStartedAt);
          }

          updateClickLog("clicks: " + String(clickCount));
        });

        async function runScenario(options) {
          if (globalThis.__WB_LITE_PERF_STATE__?.running) {
            return {
              ok: false,
              reason: "already-running"
            };
          }

          resetPageState();

          const label = typeof options?.label === "string" ? options.label : "scenario";
          const requestCount = clampInt(options?.requests, 60, 1, 1200);
          const concurrency = clampInt(options?.concurrency, 4, 1, 32);
          const pauseMs = clampInt(options?.pauseMs, 0, 0, 1000);
          const payloadBytes = clampInt(options?.payloadBytes, 16384, 1024, 131072);
          const serverDelayMs = clampInt(options?.serverDelayMs, 10, 0, 250);
          const hoverIntervalMs = clampInt(options?.hoverIntervalMs, 16, 8, 250);
          const settleMs = clampInt(options?.settleMs, 800, 0, 5000);
          const apiBaseUrl =
            typeof options?.apiBaseUrl === "string" && options.apiBaseUrl.length > 0
              ? options.apiBaseUrl
              : "/api/ping/";
          const seed =
            typeof options?.seed === "string" && options.seed.length > 0
              ? options.seed
              : Math.random().toString(36).slice(2);

          const requestDurations = [];
          const hoverLagSamples = [];
          const rafGapSamples = [];
          const longTaskDurations = [];
          let samplingActive = true;
          let hoverTimer = null;
          let hoverCursor = 0;
          let hoverExpectedAt = performance.now() + hoverIntervalMs;
          let frameSeen = false;
          let lastFrameAt = 0;
          let longTaskSupported = false;
          let longTaskObserver = null;

          const scenarioState = {
            label,
            running: true,
            done: false,
            failed: false,
            count: 0,
            errors: 0,
            error: null,
            requestCount,
            concurrency,
            payloadBytes,
            seed
          };

          globalThis.__WB_LITE_PERF_STATE__ = scenarioState;

          const updateHoverLoop = () => {
            hoverTimer = setTimeout(() => {
              if (!samplingActive) {
                return;
              }

              const now = performance.now();
              hoverLagSamples.push(Math.max(0, now - hoverExpectedAt));
              hoverExpectedAt = now + hoverIntervalMs;
              setActiveCell(hoverCursor, "hover-" + (hoverCursor % cells.length));
              hoverCursor += 1;
              updateHoverLoop();
            }, hoverIntervalMs);
          };

          const frameLoop = (now) => {
            if (!samplingActive) {
              return;
            }

            if (frameSeen) {
              rafGapSamples.push(Math.max(0, now - lastFrameAt));
            } else {
              frameSeen = true;
            }

            lastFrameAt = now;
            requestAnimationFrame(frameLoop);
          };

          if (typeof PerformanceObserver === "function") {
            try {
              longTaskObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();

                for (let index = 0; index < entries.length; index += 1) {
                  const entry = entries[index];

                  if (typeof entry?.duration === "number" && Number.isFinite(entry.duration)) {
                    longTaskDurations.push(entry.duration);
                  }
                }
              });
              longTaskObserver.observe({ entryTypes: ["longtask"] });
              longTaskSupported = true;
            } catch {
              longTaskSupported = false;
              longTaskObserver = null;
            }
          }

          updateHoverLoop();
          requestAnimationFrame(frameLoop);

          let cursor = 0;
          const startedAt = performance.now();
          setStatus(label + " running", "running");

          const workers = Array.from({ length: concurrency }, (_, workerId) => {
            return (async () => {
              while (true) {
                const seq = cursor;

                if (seq >= requestCount) {
                  return;
                }

                cursor += 1;
                const token = seed + "-" + workerId + "-" + seq;
                const startedRequestAt = performance.now();
                requestLogNode.textContent =
                  label +
                  " request " +
                  String(seq + 1) +
                  "/" +
                  String(requestCount) +
                  " token=" +
                  token;
                setActiveCell(seq, "req-" + seq);

                try {
                  const response = await fetch(
                    apiBaseUrl +
                      seq +
                      "?token=" +
                      encodeURIComponent(token) +
                      "&bytes=" +
                      String(payloadBytes) +
                      "&delay=" +
                      String(serverDelayMs),
                    {
                      cache: "no-store",
                      headers: {
                        "x-webblackbox-stress": token
                      }
                    }
                  );

                  const text = await response.text();
                  requestDurations.push(performance.now() - startedRequestAt);

                  if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                  }

                  labels[seq % labels.length].textContent = "ok-" + text.length;
                } catch (error) {
                  requestDurations.push(performance.now() - startedRequestAt);
                  scenarioState.errors += 1;
                  scenarioState.error = String(error instanceof Error ? error.message : error);
                  labels[seq % labels.length].textContent = "err";
                }

                scenarioState.count = Math.max(scenarioState.count, seq + 1);

                if (pauseMs > 0) {
                  await new Promise((resolve) => {
                    setTimeout(resolve, pauseMs);
                  });
                }
              }
            })();
          });

          try {
            await Promise.all(workers);
          } catch (error) {
            scenarioState.failed = true;
            scenarioState.error = String(error instanceof Error ? error.message : error);
          }

          const finishedAt = performance.now();
          samplingActive = false;

          if (hoverTimer) {
            clearTimeout(hoverTimer);
          }

          setActiveCell(-1, "");
          requestLogNode.textContent =
            label +
            " finished count=" +
            String(scenarioState.count) +
            " errors=" +
            String(scenarioState.errors);

          await new Promise((resolve) => {
            setTimeout(resolve, settleMs);
          });

          longTaskObserver?.disconnect();

          const summary = {
            durationMs: roundMs(finishedAt - startedAt),
            pageState: {
              visibilityState: document.visibilityState,
              hasFocus:
                typeof document.hasFocus === "function" ? document.hasFocus() : false
            },
            requests: summarizeSeries(requestDurations),
            hoverLag: summarizeSeries(hoverLagSamples),
            rafGap: summarizeSeries(rafGapSamples),
            longTasks: summarizeLongTasks(longTaskDurations, longTaskSupported)
          };

          scenarioState.running = false;
          scenarioState.done = true;
          scenarioState.summary = summary;
          setStatus(label + (scenarioState.errors > 0 || scenarioState.failed ? " error" : " done"), scenarioState.errors > 0 || scenarioState.failed ? "error" : "done");

          return {
            ok: scenarioState.errors === 0 && scenarioState.failed === false,
            state: {
              count: scenarioState.count,
              errors: scenarioState.errors,
              error: scenarioState.error,
              requestCount,
              concurrency,
              payloadBytes,
              seed
            },
            summary
          };
        }

        async function runInteractionScenario(options) {
          if (globalThis.__WB_LITE_PERF_STATE__?.running) {
            return {
              ok: false,
              reason: "already-running"
            };
          }

          resetPageState();

          const label =
            typeof options?.label === "string" && options.label.length > 0
              ? options.label
              : "interaction";
          const rounds = clampInt(options?.rounds, 16, 4, 80);
          const mutationBatch = clampInt(options?.mutationBatch, 180, 24, 960);
          const scrollStep = clampInt(options?.scrollStep, 240, 40, 1_200);
          const settleMs = clampInt(options?.settleMs, 300, 0, 3_000);
          const clickCallSamples = [];
          const clickLagSamples = [];
          const maxScrollTop = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight
          );

          const scenarioState = {
            label,
            running: true,
            done: false,
            failed: false,
            rounds,
            count: 0,
            error: null
          };

          globalThis.__WB_LITE_PERF_STATE__ = scenarioState;
          activeClickLagSamples = clickLagSamples;
          setStatus(label + " running", "running");
          requestLogNode.textContent = label + " preparing interaction storm";

          try {
            for (let round = 0; round < rounds; round += 1) {
              applyMutationWave(round, mutationBatch);
              setActiveCell(round, "int-" + round);

              if (maxScrollTop > 0) {
                const nextScrollTop = Math.min(
                  maxScrollTop,
                  (round * scrollStep) % (maxScrollTop + scrollStep)
                );
                window.scrollTo(0, nextScrollTop);
              }

              document.dispatchEvent(
                new PointerEvent("pointermove", {
                  bubbles: true,
                  clientX: 24 + ((round * 31) % Math.max(160, window.innerWidth - 24)),
                  clientY: 96 + ((round * 17) % Math.max(160, window.innerHeight - 96))
                })
              );

              clickMeasurementStartedAt = performance.now();
              const startedAt = performance.now();
              actionLinkNode.click();
              clickCallSamples.push(performance.now() - startedAt);
              clickMeasurementStartedAt = 0;
              scenarioState.count = round + 1;

              await new Promise((resolve) => {
                requestAnimationFrame(() => resolve());
              });
            }
          } catch (error) {
            scenarioState.failed = true;
            scenarioState.error = String(error instanceof Error ? error.message : error);
          } finally {
            activeClickLagSamples = null;
            clickMeasurementStartedAt = 0;
          }

          setActiveCell(-1, "");
          requestLogNode.textContent =
            label +
            " finished rounds=" +
            String(scenarioState.count) +
            " clicks=" +
            String(clickCount);

          await new Promise((resolve) => {
            setTimeout(resolve, settleMs);
          });

          const summary = {
            rounds: scenarioState.count,
            clickCount,
            clickCall: summarizeSeries(clickCallSamples),
            clickHandlerLag: summarizeSeries(clickLagSamples)
          };

          scenarioState.running = false;
          scenarioState.done = true;
          scenarioState.summary = summary;
          setStatus(
            label + (scenarioState.failed ? " error" : " done"),
            scenarioState.failed ? "error" : "done"
          );

          return {
            ok: scenarioState.failed === false,
            state: {
              rounds: scenarioState.count,
              error: scenarioState.error,
              clickCount
            },
            summary
          };
        }

        async function runIframeScenario(options) {
          if (globalThis.__WB_LITE_PERF_STATE__?.running) {
            return {
              ok: false,
              reason: "already-running"
            };
          }

          resetPageState();

          const frames = await ensureIframeGrid(options?.iframeCount);
          const label =
            typeof options?.label === "string" && options.label.length > 0
              ? options.label
              : "iframe-interaction";
          const rounds = clampInt(options?.rounds, 12, 4, 96);
          const settleMs = clampInt(options?.settleMs, 300, 0, 3_000);
          const clickCallSamples = [];
          const clickLagSamples = [];
          const frameNodes = Array.from(iframeGridNode?.querySelectorAll("iframe") ?? []);

          const scenarioState = {
            label,
            running: true,
            done: false,
            failed: false,
            rounds,
            count: 0,
            error: null
          };

          globalThis.__WB_LITE_PERF_STATE__ = scenarioState;
          setStatus(label + " running", "running");
          requestLogNode.textContent = label + " exercising iframe interactions";

          try {
            if (frames <= 0 || frameNodes.length === 0) {
              throw new Error("iframe-grid-empty");
            }

            for (let round = 0; round < rounds; round += 1) {
              const frameNode = frameNodes[round % frameNodes.length];
              const frameWindow = frameNode?.contentWindow;
              const framePerf = frameWindow?.__WB_IFRAME_PERF__;

              if (!framePerf || typeof framePerf.triggerClick !== "function") {
                throw new Error("iframe-perf-api-unavailable");
              }

              const result = framePerf.triggerClick();

              if (!result?.ok) {
                throw new Error(String(result?.reason ?? "iframe-click-failed"));
              }

              clickCallSamples.push(
                typeof result.clickCallMs === "number" && Number.isFinite(result.clickCallMs)
                  ? result.clickCallMs
                  : 0
              );
              clickLagSamples.push(
                typeof result.clickLagMs === "number" && Number.isFinite(result.clickLagMs)
                  ? result.clickLagMs
                  : 0
              );

              scenarioState.count = round + 1;
              setActiveCell(round, "if-" + round);

              await new Promise((resolve) => {
                requestAnimationFrame(() => resolve());
              });
            }
          } catch (error) {
            scenarioState.failed = true;
            scenarioState.error = String(error instanceof Error ? error.message : error);
          }

          setActiveCell(-1, "");
          requestLogNode.textContent =
            label +
            " finished rounds=" +
            String(scenarioState.count) +
            " iframeCount=" +
            String(frameNodes.length);

          await new Promise((resolve) => {
            setTimeout(resolve, settleMs);
          });

          const summary = {
            rounds: scenarioState.count,
            iframeCount: frameNodes.length,
            clickCall: summarizeSeries(clickCallSamples),
            clickHandlerLag: summarizeSeries(clickLagSamples)
          };

          scenarioState.running = false;
          scenarioState.done = true;
          scenarioState.summary = summary;
          setStatus(
            label + (scenarioState.failed ? " error" : " done"),
            scenarioState.failed ? "error" : "done"
          );

          return {
            ok: scenarioState.failed === false,
            state: {
              rounds: scenarioState.count,
              error: scenarioState.error,
              iframeCount: frameNodes.length
            },
            summary
          };
        }

        async function runEditorScenario(options) {
          if (globalThis.__WB_LITE_PERF_STATE__?.running) {
            return {
              ok: false,
              reason: "already-running"
            };
          }

          resetPageState();

          const label =
            typeof options?.label === "string" && options.label.length > 0
              ? options.label
              : "editor";
          const rounds = clampInt(options?.rounds, 24, 6, 120);
          const settleMs = clampInt(options?.settleMs, 250, 0, 3_000);
          const inputCallSamples = [];
          const rafGapSamples = [];
          let samplingActive = true;
          let frameSeen = false;
          let lastFrameAt = 0;

          const scenarioState = {
            label,
            running: true,
            done: false,
            failed: false,
            rounds,
            count: 0,
            error: null
          };

          globalThis.__WB_LITE_PERF_STATE__ = scenarioState;
          setStatus(label + " running", "running");
          requestLogNode.textContent = label + " typing";

          const frameLoop = (now) => {
            if (!samplingActive) {
              return;
            }

            if (frameSeen) {
              rafGapSamples.push(Math.max(0, now - lastFrameAt));
            } else {
              frameSeen = true;
            }

            lastFrameAt = now;
            requestAnimationFrame(frameLoop);
          };

          requestAnimationFrame(frameLoop);

          try {
            editorSurfaceNode?.focus();

            for (let round = 0; round < rounds; round += 1) {
              const nextChar = String.fromCharCode(97 + (round % 26));
              const startedAt = performance.now();

              editorSurfaceNode?.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: nextChar,
                  code: "Key" + nextChar.toUpperCase(),
                  bubbles: true
                })
              );

              const span = document.createElement("span");
              span.textContent = nextChar;
              editorSurfaceNode?.appendChild(span);
              editorSurfaceNode?.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertText",
                  data: nextChar
                })
              );

              inputCallSamples.push(performance.now() - startedAt);
              scenarioState.count = round + 1;

              await new Promise((resolve) => {
                requestAnimationFrame(() => resolve());
              });
            }
          } catch (error) {
            scenarioState.failed = true;
            scenarioState.error = String(error instanceof Error ? error.message : error);
          }

          samplingActive = false;
          requestLogNode.textContent =
            label +
            " finished chars=" +
            String(editorSurfaceNode?.textContent?.length ?? 0);

          await new Promise((resolve) => {
            setTimeout(resolve, settleMs);
          });

          const summary = {
            rounds: scenarioState.count,
            textLength: editorSurfaceNode?.textContent?.length ?? 0,
            inputCall: summarizeSeries(inputCallSamples),
            rafGap: summarizeSeries(rafGapSamples)
          };

          scenarioState.running = false;
          scenarioState.done = true;
          scenarioState.summary = summary;
          setStatus(
            label + (scenarioState.failed ? " error" : " done"),
            scenarioState.failed ? "error" : "done"
          );

          return {
            ok: scenarioState.failed === false,
            state: {
              rounds: scenarioState.count,
              error: scenarioState.error,
              textLength: summary.textLength
            },
            summary
          };
        }

        globalThis.__WB_LITE_PERF__ = {
          runScenario,
          runInteractionScenario,
          runIframeScenario,
          runEditorScenario,
          getState() {
            return globalThis.__WB_LITE_PERF_STATE__ ?? null;
          }
        };

        setStatus("ready", "idle");
      })();
    </script>
  </body>
</html>`;
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

async function waitForExtensionTarget(urlBase, browserClient, matcher, timeoutMs, timeoutMessage) {
  let lastSummary = "none";

  try {
    return await waitFor(
      async () => {
        const targets = await listTargets(urlBase, browserClient);
        lastSummary = summarizeTargetsForDebug(targets);
        return targets.find(matcher) ?? null;
      },
      timeoutMs,
      250,
      timeoutMessage
    );
  } catch (error) {
    throw new Error(
      `${timeoutMessage}. Targets: ${lastSummary}. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function listTargets(urlBase, browserClient) {
  const merged = new Map();
  const httpTargets = await fetchJson(`${urlBase}/json/list`, 4_000).catch(() => []);

  if (Array.isArray(httpTargets)) {
    for (const target of httpTargets) {
      const normalized = normalizeTargetDescriptor(target);
      merged.set(normalized.key, normalized);
    }
  }

  if (browserClient) {
    const browserTargets = await browserClient
      .send("Target.getTargets")
      .then((result) => (Array.isArray(result?.targetInfos) ? result.targetInfos : []))
      .catch(() => []);

    for (const target of browserTargets) {
      const normalized = normalizeTargetDescriptor(target);
      const existing = merged.get(normalized.key);
      merged.set(normalized.key, {
        ...normalized,
        webSocketDebuggerUrl: existing?.webSocketDebuggerUrl ?? normalized.webSocketDebuggerUrl
      });
    }
  }

  return [...merged.values()];
}

function normalizeTargetDescriptor(target) {
  const targetId =
    typeof target?.targetId === "string"
      ? target.targetId
      : typeof target?.id === "string"
        ? target.id
        : "";
  const url = typeof target?.url === "string" ? target.url : "";
  const type = typeof target?.type === "string" ? target.type : "unknown";
  const webSocketDebuggerUrl =
    typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : undefined;

  return {
    key: targetId || `${type}:${url}`,
    targetId,
    id: typeof target?.id === "string" ? target.id : targetId,
    type,
    url,
    title: typeof target?.title === "string" ? target.title : "",
    webSocketDebuggerUrl
  };
}

function summarizeTargetsForDebug(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return "[]";
  }

  return targets
    .slice(0, 12)
    .map((target) => {
      const url = target.url.length > 120 ? `${target.url.slice(0, 117)}...` : target.url;
      return `${target.type}:${url}`;
    })
    .join(", ");
}

async function resolvePreferredExtensionId(extensionDir) {
  const manifestPath = resolve(extensionDir, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const key = typeof manifest?.key === "string" ? manifest.key.trim() : "";

  if (key.length === 0) {
    return null;
  }

  return computeExtensionIdFromManifestKey(key);
}

function computeExtensionIdFromManifestKey(keyBase64) {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";

  for (let index = 0; index < 16; index += 1) {
    const value = digest[index];
    id += alphabet[(value >> 4) & 0x0f];
    id += alphabet[value & 0x0f];
  }

  return id;
}

function isLikelyExtensionId(value) {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
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

async function openPopupRuntimeTarget(popupUrl) {
  assert(state.baseUrl, "Chrome base URL is unavailable while opening the popup target.");
  const target = await openTarget(state.baseUrl, popupUrl);
  state.openedTargetIds.push(target.id);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await waitForPopupRuntimeReady(client, 20_000);

  return {
    target,
    client
  };
}

async function activatePageTarget(browserClient, target) {
  const targetId =
    typeof target?.targetId === "string"
      ? target.targetId
      : typeof target?.id === "string"
        ? target.id
        : null;

  if (browserClient && targetId) {
    await browserClient.send("Target.activateTarget", { targetId }).catch(() => undefined);
  }

  await state.pageClient?.send("Page.bringToFront").catch(() => undefined);
  await state.pageClient
    ?.send("Page.setWebLifecycleState", { state: "active" })
    .catch(() => undefined);
  await state.pageClient
    ?.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => undefined);
}

async function closeTarget(urlBase, targetId) {
  try {
    await fetchJson(`${urlBase}/json/close/${targetId}`, 4_000);
  } catch {
    void 0;
  }
}

async function connectToDiscoveredTarget(target, browserClient) {
  if (target.webSocketDebuggerUrl) {
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    return client;
  }

  if (!browserClient || !target.targetId) {
    throw new Error(`Target is not directly debuggable: ${target.url || target.type}`);
  }

  return browserClient.attachToTarget(target.targetId);
}

async function waitForPopupRuntimeReady(popupClient, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await popupClient.evaluate(`
        (() => ({
          runtimeId:
            typeof chrome === 'object' &&
            chrome !== null &&
            typeof chrome.runtime === 'object' &&
            chrome.runtime !== null &&
            typeof chrome.runtime.id === 'string'
              ? chrome.runtime.id
              : null,
          canSendMessage:
            typeof chrome === 'object' &&
            chrome !== null &&
            typeof chrome.runtime === 'object' &&
            chrome.runtime !== null &&
            typeof chrome.runtime.sendMessage === 'function'
        }))()
      `);

      return snapshot?.runtimeId && snapshot?.canSendMessage ? snapshot : null;
    },
    timeoutMs,
    250,
    "Popup runtime is not ready"
  );
}

async function waitForPerfHarness(pageClient, timeoutMs) {
  return waitFor(
    async () => {
      const ready = await pageClient.evaluate(`
        (() =>
          Boolean(
            globalThis.__WB_LITE_PERF__ &&
              typeof globalThis.__WB_LITE_PERF__.runScenario === 'function'
          ))()
      `);

      return ready ? true : null;
    },
    timeoutMs,
    250,
    "Lite perf harness is not ready"
  );
}

async function runPerfScenario(pageClient, options) {
  return withTimeout(
    pageClient.evaluate(`
      globalThis.__WB_LITE_PERF__.runScenario(${JSON.stringify(options)})
    `),
    perfTimeoutMs,
    `Perf scenario timed out: ${options?.label ?? "scenario"}`
  );
}

async function runInteractionScenario(pageClient, options) {
  return withTimeout(
    pageClient.evaluate(`
      globalThis.__WB_LITE_PERF__.runInteractionScenario(${JSON.stringify(options)})
    `),
    perfTimeoutMs,
    `Interaction scenario timed out: ${options?.label ?? "interaction"}`
  );
}

async function runIframeScenario(pageClient, options) {
  return withTimeout(
    pageClient.evaluate(`
      globalThis.__WB_LITE_PERF__.runIframeScenario(${JSON.stringify(options)})
    `),
    perfTimeoutMs,
    `Iframe scenario timed out: ${options?.label ?? "iframe"}`
  );
}

async function runEditorScenario(pageClient, options) {
  return withTimeout(
    pageClient.evaluate(`
      globalThis.__WB_LITE_PERF__.runEditorScenario(${JSON.stringify(options)})
    `),
    perfTimeoutMs,
    `Editor scenario timed out: ${options?.label ?? "editor"}`
  );
}

async function runDocumentNavigationScenario(pageClient, options) {
  const label =
    typeof options?.label === "string" && options.label.length > 0 ? options.label : "navigation";
  const rounds = Math.max(1, Math.floor(options?.rounds ?? navigationRounds));
  const settleMs = Math.max(0, Math.floor(options?.settleMs ?? interactionSettleMs));
  const sourceUrl = String(options?.sourceUrl ?? "");
  const targetUrl = String(options?.targetUrl ?? "");
  const targetWaitMs = Math.max(1_500, Math.min(perfTimeoutMs, Math.floor(navigationWaitMs)));
  const mouseTargetWaitMs = Math.max(500, Math.min(targetWaitMs, 1_500));
  const latencies = [];
  const mouseLatencies = [];
  const fallbackLatencies = [];
  const strategies = {
    mouse: 0,
    jsClick: 0,
    locationAssign: 0
  };

  const waitForTargetPage = async (timeoutMs = targetWaitMs) =>
    waitFor(
      async () => {
        const snapshot = await pageClient.evaluate(`(() => ({
          pageType: document.body?.dataset?.page ?? document.documentElement?.dataset?.page ?? null,
          readyState: document.readyState,
          href: location.href
        }))()`);
        return snapshot?.pageType === "nav-target" ? snapshot : null;
      },
      timeoutMs,
      100,
      `Document navigation target did not load: ${label}`
    );

  for (let round = 0; round < rounds; round += 1) {
    const token = `${label}-${round}`;
    const href = await pageClient.evaluate(`
      (() => {
        const link = document.getElementById("document-link");
        if (link instanceof HTMLAnchorElement) {
          const nextHref = ${JSON.stringify(targetUrl)} + "?token=" + ${JSON.stringify(token)};
          link.href = nextHref;
          const status = document.getElementById("status");
          const requestLog = document.getElementById("request-log");

          if (status instanceof HTMLElement) {
            status.textContent =
              ${JSON.stringify(label)} +
              " nav " +
              String(${round} + 1) +
              "/" +
              String(${rounds});
            status.dataset.tone = "running";
          }

          if (requestLog instanceof HTMLElement) {
            requestLog.textContent = "navigate " + nextHref;
          }

          return nextHref;
        }

        return null;
      })()
    `);

    assert(
      typeof href === "string" && href.length > 0,
      "Document navigation href is unavailable.",
      {
        label,
        round,
        href
      }
    );

    const point = await pageClient.evaluate(`
      (() => {
        const link = document.getElementById("document-link");
        if (!(link instanceof HTMLElement)) {
          return null;
        }

        const rect = link.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()
    `);

    assert(
      point &&
        typeof point.x === "number" &&
        Number.isFinite(point.x) &&
        typeof point.y === "number" &&
        Number.isFinite(point.y),
      "Document navigation link bounds are unavailable.",
      { point, label, round }
    );

    const startedAt = Date.now();
    let fallbackStartedAt = 0;
    try {
      await pageClient.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none"
      });
      await pageClient.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1
      });
      await pageClient.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1
      });
      await waitForTargetPage(mouseTargetWaitMs);
      strategies.mouse += 1;
      mouseLatencies.push(Date.now() - startedAt);
    } catch {
      fallbackStartedAt = Date.now();
      await pageClient.evaluate(`
        (() => {
          const link = document.getElementById("document-link");

          if (link instanceof HTMLAnchorElement) {
            link.click();
            return true;
          }

          return false;
        })()
      `);

      try {
        await waitForTargetPage();
        strategies.jsClick += 1;
      } catch {
        await pageClient.evaluate(`
          (() => {
            const link = document.getElementById("document-link");

            if (link instanceof HTMLAnchorElement) {
              window.location.href = link.href;
              return link.href;
            }

            return null;
          })()
        `);
        await waitForTargetPage();
        strategies.locationAssign += 1;
      }

      fallbackLatencies.push(Date.now() - fallbackStartedAt);
    }

    latencies.push(Date.now() - startedAt);

    await pageClient.send("Page.navigate", {
      url: sourceUrl
    });
    await waitForPerfHarness(pageClient, 20_000);

    if (settleMs > 0) {
      await sleep(settleMs);
    }
  }

  return {
    ok: true,
    state: {
      rounds
    },
    summary: {
      rounds,
      navigationLatency: summarizeSeries(latencies),
      mouseNavigationLatency: summarizeSeries(mouseLatencies),
      fallbackNavigationLatency: summarizeSeries(fallbackLatencies),
      strategies
    }
  };
}

async function startSessionFromPopup(popupClient, mode, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const target =
        tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          tab.url.startsWith(${JSON.stringify(expectedUrl)})
        ) ??
        tabs.find((tab) =>
          typeof tab.id === 'number' &&
          typeof tab.url === 'string' &&
          !tab.url.startsWith('chrome-extension://') &&
          tab.url !== 'about:blank'
        );

      if (!target || typeof target.id !== 'number') {
        return {
          ok: false,
          reason: 'target-tab-not-found',
          tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active }))
        };
      }

      await chrome.runtime.sendMessage({
        kind: 'ui.start',
        tabId: target.id,
        mode: ${JSON.stringify(mode)}
      });

      return {
        ok: true,
        tabId: target.id,
        mode: ${JSON.stringify(mode)}
      };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function stopActiveSessionFromPopup(popupClient) {
  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      const active = Array.isArray(rows) ? rows[0] : undefined;

      if (!active || typeof active.tabId !== 'number') {
        return { ok: false, reason: 'no-active-session', rows };
      }

      await chrome.runtime.sendMessage({ kind: 'ui.stop', tabId: active.tabId });
      return { ok: true, tabId: active.tabId };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function deleteSessionFromPopup(popupClient, sid) {
  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({ kind: 'ui.delete', sid: ${JSON.stringify(sid)} });
      return { ok: true, sid: ${JSON.stringify(sid)} };
    })()
  `;

  return popupClient.evaluate(expression);
}

async function readRuntimeSessions(popupClient) {
  const expression = `
    (async () => {
      const store = await chrome.storage.local.get('webblackbox.runtime.sessions');
      const rows = store['webblackbox.runtime.sessions'];
      return Array.isArray(rows) ? rows : [];
    })()
  `;

  return popupClient.evaluate(expression);
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

function roundMetric(value) {
  return Number(value.toFixed(2));
}

function percentile(sorted, ratio) {
  if (!sorted.length) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeSeries(values) {
  const numeric = values
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (numeric.length === 0) {
    return {
      count: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      over16Ms: 0,
      over32Ms: 0,
      over50Ms: 0
    };
  }

  const total = numeric.reduce((sum, value) => sum + value, 0);

  return {
    count: numeric.length,
    meanMs: roundMetric(total / numeric.length),
    p50Ms: roundMetric(percentile(numeric, 0.5)),
    p95Ms: roundMetric(percentile(numeric, 0.95)),
    maxMs: roundMetric(numeric[numeric.length - 1]),
    over16Ms: numeric.filter((value) => value > 16).length,
    over32Ms: numeric.filter((value) => value > 32).length,
    over50Ms: numeric.filter((value) => value > 50).length
  };
}

function compareSummaries(
  baselineSummary,
  recordedSummary,
  baselineInteractionSummary,
  recordedInteractionSummary,
  baselineIframeSummary,
  recordedIframeSummary,
  baselineEditorSummary,
  recordedEditorSummary,
  baselineNavigationSummary,
  recordedNavigationSummary
) {
  const normalizedBaselineNavigationSummary = summarizeNavigation(baselineNavigationSummary);
  const normalizedRecordedNavigationSummary = summarizeNavigation(recordedNavigationSummary);

  assert(
    typeof baselineSummary?.requests?.count === "number" &&
      baselineSummary.requests.count >= perfRequests,
    "Baseline summary captured too few requests.",
    { baselineSummary, perfRequests }
  );
  assert(
    typeof recordedSummary?.requests?.count === "number" &&
      recordedSummary.requests.count >= perfRequests,
    "Lite recording summary captured too few requests.",
    { recordedSummary, perfRequests }
  );
  assert(
    typeof baselineInteractionSummary?.rounds === "number" &&
      baselineInteractionSummary.rounds >= interactionRounds,
    "Baseline interaction summary captured too few rounds.",
    { baselineInteractionSummary, interactionRounds }
  );
  assert(
    typeof recordedInteractionSummary?.rounds === "number" &&
      recordedInteractionSummary.rounds >= interactionRounds,
    "Lite recording interaction summary captured too few rounds.",
    { recordedInteractionSummary, interactionRounds }
  );
  assert(
    typeof baselineIframeSummary?.rounds === "number" &&
      baselineIframeSummary.rounds >= iframeInteractionRounds,
    "Baseline iframe scenario captured too few rounds.",
    { baselineIframeSummary, iframeInteractionRounds }
  );
  assert(
    typeof recordedIframeSummary?.rounds === "number" &&
      recordedIframeSummary.rounds >= iframeInteractionRounds,
    "Lite recording iframe scenario captured too few rounds.",
    { recordedIframeSummary, iframeInteractionRounds }
  );
  assert(
    typeof baselineEditorSummary?.rounds === "number" &&
      baselineEditorSummary.rounds >= editorRounds,
    "Baseline editor scenario captured too few rounds.",
    { baselineEditorSummary, editorRounds }
  );
  assert(
    typeof recordedEditorSummary?.rounds === "number" &&
      recordedEditorSummary.rounds >= editorRounds,
    "Lite recording editor scenario captured too few rounds.",
    { recordedEditorSummary, editorRounds }
  );
  assert(
    typeof normalizedBaselineNavigationSummary?.rounds === "number" &&
      normalizedBaselineNavigationSummary.rounds >= navigationRounds,
    "Baseline navigation scenario captured too few rounds.",
    { baselineNavigationSummary: normalizedBaselineNavigationSummary, navigationRounds }
  );
  assert(
    typeof normalizedRecordedNavigationSummary?.rounds === "number" &&
      normalizedRecordedNavigationSummary.rounds >= navigationRounds,
    "Lite recording navigation scenario captured too few rounds.",
    { recordedNavigationSummary: normalizedRecordedNavigationSummary, navigationRounds }
  );

  const budgets = [
    assertBudget("durationMs", baselineSummary.durationMs, recordedSummary.durationMs, {
      ratioLimit: durationRatioLimit,
      deltaLimit: durationDeltaLimitMs
    }),
    assertBudget("requests.p95Ms", baselineSummary.requests.p95Ms, recordedSummary.requests.p95Ms, {
      ratioLimit: requestP95RatioLimit,
      deltaLimit: requestP95DeltaLimitMs
    }),
    assertBudget("hoverLag.p95Ms", baselineSummary.hoverLag.p95Ms, recordedSummary.hoverLag.p95Ms, {
      ratioLimit: hoverP95RatioLimit,
      deltaLimit: hoverP95DeltaLimitMs
    }),
    assertBudget("rafGap.p95Ms", baselineSummary.rafGap.p95Ms, recordedSummary.rafGap.p95Ms, {
      ratioLimit: rafP95RatioLimit,
      deltaLimit: rafP95DeltaLimitMs
    }),
    assertCountDelta(
      "hoverLag.over32Ms",
      baselineSummary.hoverLag.over32Ms,
      recordedSummary.hoverLag.over32Ms,
      hoverOver32DeltaLimit
    ),
    assertBudget(
      "clickCall.p95Ms",
      baselineInteractionSummary.clickCall.p95Ms,
      recordedInteractionSummary.clickCall.p95Ms,
      {
        ratioLimit: clickCallP95RatioLimit,
        deltaLimit: clickCallP95DeltaLimitMs
      }
    ),
    assertBudget(
      "clickHandlerLag.p95Ms",
      baselineInteractionSummary.clickHandlerLag.p95Ms,
      recordedInteractionSummary.clickHandlerLag.p95Ms,
      {
        ratioLimit: clickLagP95RatioLimit,
        deltaLimit: clickLagP95DeltaLimitMs
      }
    ),
    assertCountDelta(
      "clickCall.over16Ms",
      baselineInteractionSummary.clickCall.over16Ms,
      recordedInteractionSummary.clickCall.over16Ms,
      clickOver16DeltaLimit
    ),
    assertBudget(
      "iframe.clickCall.p95Ms",
      baselineIframeSummary.clickCall.p95Ms,
      recordedIframeSummary.clickCall.p95Ms,
      {
        ratioLimit: clickCallP95RatioLimit,
        deltaLimit: clickCallP95DeltaLimitMs
      }
    ),
    assertBudget(
      "iframe.clickHandlerLag.p95Ms",
      baselineIframeSummary.clickHandlerLag.p95Ms,
      recordedIframeSummary.clickHandlerLag.p95Ms,
      {
        ratioLimit: clickLagP95RatioLimit,
        deltaLimit: clickLagP95DeltaLimitMs
      }
    ),
    assertBudget(
      "editor.inputCall.p95Ms",
      baselineEditorSummary.inputCall.p95Ms,
      recordedEditorSummary.inputCall.p95Ms,
      {
        ratioLimit: editorInputP95RatioLimit,
        deltaLimit: editorInputP95DeltaLimitMs
      }
    ),
    assertBudget(
      "editor.rafGap.p95Ms",
      baselineEditorSummary.rafGap.p95Ms,
      recordedEditorSummary.rafGap.p95Ms,
      {
        ratioLimit: editorRafP95RatioLimit,
        deltaLimit: editorRafP95DeltaLimitMs
      }
    ),
    assertBudget(
      "navigation.mouse.p95Ms",
      normalizedBaselineNavigationSummary.mouseNavigationLatency.p95Ms,
      normalizedRecordedNavigationSummary.mouseNavigationLatency.p95Ms,
      {
        ratioLimit: navigationP95RatioLimit,
        deltaLimit: navigationP95DeltaLimitMs
      }
    ),
    assertCountDelta(
      "navigation.fallbackCount",
      normalizedBaselineNavigationSummary.fallbackCount,
      normalizedRecordedNavigationSummary.fallbackCount,
      navigationFallbackDeltaLimit
    )
  ];

  if (baselineSummary.longTasks?.supported && recordedSummary.longTasks?.supported) {
    budgets.push(
      assertCountDelta(
        "longTasks.count",
        baselineSummary.longTasks.count,
        recordedSummary.longTasks.count,
        longTaskCountDeltaLimit
      )
    );
    budgets.push(
      assertCountDelta(
        "longTasks.totalMs",
        baselineSummary.longTasks.totalMs,
        recordedSummary.longTasks.totalMs,
        longTaskTotalDeltaLimitMs
      )
    );
  }

  return {
    budgets
  };
}

function summarizeNavigation(summary) {
  const fallbackCount =
    Number(summary?.strategies?.jsClick ?? 0) + Number(summary?.strategies?.locationAssign ?? 0);

  return {
    ...(summary && typeof summary === "object" ? summary : {}),
    fallbackCount
  };
}

function assertBudget(metric, baseline, recorded, { ratioLimit, deltaLimit }) {
  assert(
    typeof baseline === "number" && Number.isFinite(baseline),
    `Baseline metric is unavailable: ${metric}`,
    { baseline }
  );
  assert(
    typeof recorded === "number" && Number.isFinite(recorded),
    `Recorded metric is unavailable: ${metric}`,
    { recorded }
  );

  const threshold = Math.max(
    baseline * Math.max(1, ratioLimit),
    baseline + Math.max(0, deltaLimit),
    Math.max(0, deltaLimit)
  );

  assert(recorded <= threshold, `Lite recording regressed ${metric}.`, {
    metric,
    baseline,
    recorded,
    threshold,
    ratioLimit,
    deltaLimit
  });

  return {
    metric,
    baseline,
    recorded,
    threshold
  };
}

function assertCountDelta(metric, baseline, recorded, deltaLimit) {
  assert(
    typeof baseline === "number" && Number.isFinite(baseline),
    `Baseline metric is unavailable: ${metric}`,
    { baseline }
  );
  assert(
    typeof recorded === "number" && Number.isFinite(recorded),
    `Recorded metric is unavailable: ${metric}`,
    { recorded }
  );

  const threshold = baseline + Math.max(0, deltaLimit);
  assert(recorded <= threshold, `Lite recording regressed ${metric}.`, {
    metric,
    baseline,
    recorded,
    threshold,
    deltaLimit
  });

  return {
    metric,
    baseline,
    recorded,
    threshold
  };
}

function assert(condition, message, details) {
  if (condition) {
    return;
  }

  const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
  throw new Error(`${message}${suffix}`);
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

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closeClient(client) {
  if (!client || typeof client.close !== "function") {
    return;
  }

  await Promise.resolve(client.close()).catch(() => undefined);
}

async function cleanup() {
  await closeClient(state.swClient);
  state.swClient = null;

  await closeClient(state.pageClient);
  state.pageClient = null;

  await closeClient(state.popupClient);
  state.popupClient = null;

  await closeClient(state.browserClient);
  state.browserClient = null;

  for (const targetId of state.openedTargetIds.splice(0)) {
    if (state.baseUrl) {
      await closeTarget(state.baseUrl, targetId);
    }
  }

  if (state.chromeProcess && !state.chromeProcess.killed) {
    state.chromeProcess.kill("SIGTERM");
    await sleep(700);

    if (!state.chromeProcess.killed) {
      state.chromeProcess.kill("SIGKILL");
    }
  }

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
    this.sessionEventHandlers = new Map();
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

        if (typeof payload.method !== "string") {
          return;
        }

        const handlers = this.eventHandlers.get(payload.method) ?? [];

        for (const handler of handlers) {
          handler(payload.params ?? {});
        }

        if (typeof payload.sessionId === "string") {
          const sessionHandlers =
            this.sessionEventHandlers.get(`${payload.sessionId}:${payload.method}`) ?? [];

          for (const handler of sessionHandlers) {
            handler(payload.params ?? {});
          }
        }
      });
    });
  }

  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    const source = sessionId ? this.sessionEventHandlers : this.eventHandlers;
    const handlers = source.get(key) ?? [];
    handlers.push(handler);
    source.set(key, handlers);
  }

  send(method, params = {}, sessionId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    const id = ++this.sequence;
    const payload = {
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {})
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  async evaluate(expression, sessionId) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true
      },
      sessionId
    );

    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.text ?? "Runtime.evaluate failed";
      throw new Error(message);
    }

    return result?.result?.value;
  }

  async attachToTarget(targetId) {
    const attached = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : null;

    if (!sessionId) {
      throw new Error(`Failed to attach to target: ${targetId}`);
    }

    return new CdpSessionClient(this, sessionId);
  }

  async detachFromTarget(sessionId) {
    await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    this.removeSessionHandlers(sessionId);
  }

  removeSessionHandlers(sessionId) {
    for (const key of this.sessionEventHandlers.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.sessionEventHandlers.delete(key);
      }
    }
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}

class CdpSessionClient {
  constructor(rootClient, sessionId) {
    this.rootClient = rootClient;
    this.sessionId = sessionId;
  }

  on(method, handler) {
    this.rootClient.on(method, handler, this.sessionId);
  }

  send(method, params = {}) {
    return this.rootClient.send(method, params, this.sessionId);
  }

  evaluate(expression) {
    return this.rootClient.evaluate(expression, this.sessionId);
  }

  close() {
    return this.rootClient.detachFromTarget(this.sessionId);
  }
}
