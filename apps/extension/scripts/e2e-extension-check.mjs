#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(root, "..");

const extensionDir = process.env.WB_E2E_EXTENSION_DIR ?? resolve(appRoot, "build");
const targetUrl = process.env.WB_E2E_TARGET_URL ?? "https://example.com/";
const remotePort = Number(process.env.WB_E2E_REMOTE_PORT ?? "9222");
const headless = (process.env.WB_E2E_HEADLESS ?? "1") !== "0";
const profileDir =
  process.env.WB_E2E_PROFILE_DIR ?? `/tmp/webblackbox-ext-e2e-profile-${Date.now()}`;
const chromeLogPath = process.env.WB_E2E_LOG ?? `/tmp/webblackbox-ext-e2e-${Date.now()}.log`;
const baseUrl = `http://127.0.0.1:${remotePort}`;
const checkExport = (process.env.WB_E2E_CHECK_EXPORT ?? "1") !== "0";

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
  swClient: null,
  popupClient: null,
  pageClient: null,
  openedTargetIds: []
};

main().catch(async (error) => {
  console.error("E2E check failed:", error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
});

async function main() {
  await ensureExtensionBuildReady(extensionDir);
  const chromeBinary = await resolveChromeBinary(chromeCandidates);

  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const { proc, logStream } = startChrome(chromeBinary, {
    extensionDir,
    profileDir,
    remotePort,
    headless,
    logPath: chromeLogPath
  });

  state.chromeProcess = proc;
  state.logStream = logStream;

  const version = await waitForChromeReady(baseUrl, 20_000);
  console.log(`Chrome: ${version.Browser}`);

  const swTarget = await waitForExtensionServiceWorker(baseUrl, 20_000);
  const extensionId = extractExtensionId(swTarget.url);
  console.log(`Extension ID: ${extensionId}`);

  const swClient = new CdpClient(swTarget.webSocketDebuggerUrl);
  await swClient.connect();
  await swClient.send("Runtime.enable");
  state.swClient = swClient;

  const swExceptions = [];
  swClient.on("Runtime.exceptionThrown", (params) => {
    swExceptions.push({
      text: params?.exceptionDetails?.text ?? "unknown",
      line: params?.exceptionDetails?.lineNumber ?? null
    });
  });

  const pageTarget = await openTarget(baseUrl, targetUrl);
  const popupTarget = await openTarget(baseUrl, `chrome-extension://${extensionId}/popup.html`);
  state.openedTargetIds.push(pageTarget.id, popupTarget.id);

  const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
  const popupClient = new CdpClient(popupTarget.webSocketDebuggerUrl);
  await pageClient.connect();
  await popupClient.connect();
  await pageClient.send("Runtime.enable");
  await popupClient.send("Runtime.enable");
  state.pageClient = pageClient;
  state.popupClient = popupClient;

  await sleep(1_200);

  const lite = await runModeCheck({
    popupClient,
    pageClient,
    mode: "lite",
    targetUrl,
    waitStartMs: 20_000,
    waitStopMs: 10_000,
    exportAfterStop: checkExport
  });

  const full = await runModeCheck({
    popupClient,
    pageClient,
    mode: "full",
    targetUrl,
    waitStartMs: 25_000,
    waitStopMs: 12_000,
    exportAfterStop: false
  });

  const finalStorage = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(finalStorage) && finalStorage.length === 0,
    "Final sessions should be empty",
    {
      finalStorage
    }
  );

  if (swExceptions.length > 0) {
    throw new Error(`Service worker threw runtime exceptions: ${JSON.stringify(swExceptions)}`);
  }

  console.log("Lite:", JSON.stringify(lite));
  console.log("Full:", JSON.stringify(full));
  console.log("Final storage:", JSON.stringify(finalStorage));
  console.log("Service worker exceptions:", JSON.stringify(swExceptions));
  console.log(`Chrome log: ${chromeLogPath}`);
  console.log("E2E check passed.");

  await cleanup();
}

async function runModeCheck({
  popupClient,
  pageClient,
  mode,
  targetUrl,
  waitStartMs,
  waitStopMs,
  exportAfterStop
}) {
  const start = await startSessionFromPopup(popupClient, mode, targetUrl);
  assert(start?.ok === true, `Failed to start ${mode} mode`, start);

  const indicatorText = await waitForIndicatorText(pageClient, `REC ${mode}`, waitStartMs);
  assert(typeof indicatorText === "string", `${mode} indicator not found`, {
    indicatorText,
    start
  });

  const sessionsAfterStart = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStart) && sessionsAfterStart.length === 1,
    `${mode} did not persist exactly one session`,
    {
      sessionsAfterStart
    }
  );

  const active = sessionsAfterStart[0];
  assert(active?.mode === mode, `${mode} session mode mismatch`, {
    expected: mode,
    actual: active?.mode,
    sessionsAfterStart
  });

  const stop = await stopActiveSessionFromPopup(popupClient);
  assert(stop?.ok === true, `Failed to stop ${mode} mode`, stop);

  const gone = await waitForIndicatorGone(pageClient, waitStopMs);
  assert(gone, `${mode} indicator did not clear`, { gone, stop });

  const sessionsAfterStop = await readRuntimeSessions(popupClient);
  assert(
    Array.isArray(sessionsAfterStop) && sessionsAfterStop.length === 0,
    `${mode} sessions were not cleared`,
    {
      sessionsAfterStop
    }
  );

  let exportStatus = undefined;

  if (exportAfterStop) {
    const statusBefore = await readExportStatusLine(popupClient);
    await exportSessionFromPopup(popupClient, active.sid);
    exportStatus = await waitForExportStatus(popupClient, statusBefore, 30_000);
    assert(exportStatus.ok, `${mode} export failed`, exportStatus);
  }

  return {
    start,
    indicatorText,
    stop,
    exportStatus
  };
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` | details=${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
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
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    `--disable-extensions-except=${options.extensionDir}`,
    `--load-extension=${options.extensionDir}`,
    "--enable-logging=stderr",
    "--v=1",
    "about:blank"
  ];

  if (options.headless) {
    args.unshift("--headless=new");
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

async function waitForChromeReady(urlBase, timeoutMs) {
  return waitFor(
    async () => {
      const version = await fetchJson(`${urlBase}/json/version`, 4_000);
      return version?.Browser ? version : null;
    },
    timeoutMs,
    250,
    "Chrome DevTools endpoint not ready"
  );
}

async function waitForExtensionServiceWorker(urlBase, timeoutMs) {
  return waitFor(
    async () => {
      const targets = await fetchJson(`${urlBase}/json/list`, 4_000);
      if (!Array.isArray(targets)) {
        return null;
      }

      return (
        targets.find(
          (target) =>
            target?.type === "service_worker" &&
            typeof target?.url === "string" &&
            target.url.startsWith("chrome-extension://") &&
            target.url.endsWith("/sw.js")
        ) ?? null
      );
    },
    timeoutMs,
    250,
    "Extension service worker target not found"
  );
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
    // ignored during cleanup
  }
}

async function startSessionFromPopup(popupClient, mode, expectedUrl) {
  const expression = `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const exact = tabs.find((tab) =>
        typeof tab.id === 'number' && typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(
          expectedUrl
        )})
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
      return { ok: true, tabId: target.id, mode: ${JSON.stringify(mode)} };
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

async function exportSessionFromPopup(popupClient, sid) {
  const expression = `
    (async () => {
      await chrome.runtime.sendMessage({ kind: 'ui.export', sid: ${JSON.stringify(sid)} });
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
  if (state.pageClient) {
    state.pageClient.close();
    state.pageClient = null;
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
    await closeTarget(baseUrl, targetId);
  }

  if (state.chromeProcess && !state.chromeProcess.killed) {
    state.chromeProcess.kill("SIGTERM");
    await sleep(500);

    if (!state.chromeProcess.killed) {
      state.chromeProcess.kill("SIGKILL");
    }
  }

  state.chromeProcess = null;

  if (state.logStream) {
    await new Promise((resolve) => {
      state.logStream.end(resolve);
    });
    state.logStream = null;
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
