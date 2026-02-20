import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";

const STORAGE_KEY = "webblackbox.options";

const chromeApi = getChromeApi();
const root = document.getElementById("options-root");

if (root) {
  bootstrap(root).catch((error) => {
    root.innerHTML = `<section class="card"><h1>Settings</h1><p>${String(error)}</p></section>`;
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  const config = await loadConfig();
  render(container, config);
}

function render(container: HTMLElement, config: typeof DEFAULT_RECORDER_CONFIG): void {
  container.innerHTML = `
    <section class="card" style="max-width:760px;">
      <h1>Capture Settings</h1>
      <p>Configure redaction and sampling defaults per browser profile.</p>

      <label style="display:block;margin:12px 0 6px;">Ring Buffer (minutes)</label>
      <input id="ringBufferMinutes" type="number" min="1" max="120" value="${config.ringBufferMinutes}" />

      <label style="display:block;margin:12px 0 6px;">Action Window (ms)</label>
      <input id="actionWindowMs" type="number" min="100" max="10000" value="${config.sampling.actionWindowMs}" />

      <label style="display:block;margin:12px 0 6px;">Mousemove Sampling (Hz)</label>
      <input id="mousemoveHz" type="number" min="1" max="240" value="${config.sampling.mousemoveHz}" />

      <label style="display:block;margin:12px 0 6px;">Scroll Sampling (Hz)</label>
      <input id="scrollHz" type="number" min="1" max="120" value="${config.sampling.scrollHz}" />

      <label style="display:block;margin:12px 0 6px;">DOM Flush Interval (ms)</label>
      <input id="domFlushMs" type="number" min="25" max="10000" value="${config.sampling.domFlushMs}" />

      <label style="display:block;margin:12px 0 6px;">DOM Snapshot Interval (ms)</label>
      <input id="snapshotIntervalMs" type="number" min="500" max="120000" value="${config.sampling.snapshotIntervalMs}" />

      <label style="display:block;margin:12px 0 6px;">Screenshot Idle Interval (ms)</label>
      <input id="screenshotIdleMs" type="number" min="250" max="120000" value="${config.sampling.screenshotIdleMs}" />

      <label style="display:block;margin:12px 0 6px;">Blocked Selectors (one per line)</label>
      <textarea id="blockedSelectors" rows="6" style="width:100%;">${config.redaction.blockedSelectors.join("\n")}</textarea>

      <label style="display:block;margin:12px 0 6px;">Redacted Header Names (one per line)</label>
      <textarea id="redactHeaders" rows="6" style="width:100%;">${config.redaction.redactHeaders.join("\n")}</textarea>

      <label style="display:block;margin:12px 0 6px;">Body Sensitive Patterns (one per line)</label>
      <textarea id="redactBodyPatterns" rows="6" style="width:100%;">${config.redaction.redactBodyPatterns.join("\n")}</textarea>

      <div style="display:flex;align-items:center;gap:8px;margin-top:12px;">
        <input id="hashSensitiveValues" type="checkbox" ${config.redaction.hashSensitiveValues ? "checked" : ""} />
        <label for="hashSensitiveValues">Hash sensitive values</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;">
        <button id="saveConfig">Save</button>
        <button id="resetConfig">Reset Defaults</button>
      </div>

      <p id="statusText" style="margin-top:10px;font-size:12px;opacity:0.8;"></p>
    </section>
  `;

  const saveButton = container.querySelector<HTMLButtonElement>("#saveConfig");
  const resetButton = container.querySelector<HTMLButtonElement>("#resetConfig");

  saveButton?.addEventListener("click", async () => {
    const nextConfig = readConfigFromForm(container);
    await saveConfig(nextConfig);

    const status = container.querySelector<HTMLElement>("#statusText");
    if (status) {
      status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
    }
  });

  resetButton?.addEventListener("click", async () => {
    await saveConfig(DEFAULT_RECORDER_CONFIG);
    render(container, DEFAULT_RECORDER_CONFIG);
  });
}

async function loadConfig(): Promise<typeof DEFAULT_RECORDER_CONFIG> {
  const values = await chromeApi?.storage?.local.get(STORAGE_KEY);
  const stored = values?.[STORAGE_KEY];

  if (!stored || typeof stored !== "object") {
    return DEFAULT_RECORDER_CONFIG;
  }

  return {
    ...DEFAULT_RECORDER_CONFIG,
    ...(stored as Partial<typeof DEFAULT_RECORDER_CONFIG>),
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling,
      ...((stored as Partial<typeof DEFAULT_RECORDER_CONFIG>).sampling ?? {})
    },
    redaction: {
      ...DEFAULT_RECORDER_CONFIG.redaction,
      ...((stored as Partial<typeof DEFAULT_RECORDER_CONFIG>).redaction ?? {})
    }
  };
}

async function saveConfig(config: typeof DEFAULT_RECORDER_CONFIG): Promise<void> {
  await chromeApi?.storage?.local.set({
    [STORAGE_KEY]: config
  });
}

function readConfigFromForm(container: HTMLElement): typeof DEFAULT_RECORDER_CONFIG {
  const ringBufferMinutes = Number(
    container.querySelector<HTMLInputElement>("#ringBufferMinutes")?.value ??
      DEFAULT_RECORDER_CONFIG.ringBufferMinutes
  );
  const actionWindowMs = Number(
    container.querySelector<HTMLInputElement>("#actionWindowMs")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.actionWindowMs
  );
  const mousemoveHz = Number(
    container.querySelector<HTMLInputElement>("#mousemoveHz")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.mousemoveHz
  );
  const scrollHz = Number(
    container.querySelector<HTMLInputElement>("#scrollHz")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.scrollHz
  );
  const domFlushMs = Number(
    container.querySelector<HTMLInputElement>("#domFlushMs")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.domFlushMs
  );
  const snapshotIntervalMs = Number(
    container.querySelector<HTMLInputElement>("#snapshotIntervalMs")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.snapshotIntervalMs
  );
  const screenshotIdleMs = Number(
    container.querySelector<HTMLInputElement>("#screenshotIdleMs")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
  );

  const blockedSelectors = splitLines(
    container.querySelector<HTMLTextAreaElement>("#blockedSelectors")?.value
  );
  const redactHeaders = splitLines(
    container.querySelector<HTMLTextAreaElement>("#redactHeaders")?.value
  );
  const redactBodyPatterns = splitLines(
    container.querySelector<HTMLTextAreaElement>("#redactBodyPatterns")?.value
  );
  const hashSensitiveValues =
    container.querySelector<HTMLInputElement>("#hashSensitiveValues")?.checked ?? true;

  return {
    ...DEFAULT_RECORDER_CONFIG,
    ringBufferMinutes: Number.isFinite(ringBufferMinutes) ? Math.max(1, ringBufferMinutes) : 10,
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling,
      actionWindowMs: Number.isFinite(actionWindowMs) ? Math.max(100, actionWindowMs) : 1500,
      mousemoveHz: Number.isFinite(mousemoveHz)
        ? Math.min(240, Math.max(1, mousemoveHz))
        : DEFAULT_RECORDER_CONFIG.sampling.mousemoveHz,
      scrollHz: Number.isFinite(scrollHz)
        ? Math.min(120, Math.max(1, scrollHz))
        : DEFAULT_RECORDER_CONFIG.sampling.scrollHz,
      domFlushMs: Number.isFinite(domFlushMs)
        ? Math.min(10_000, Math.max(25, domFlushMs))
        : DEFAULT_RECORDER_CONFIG.sampling.domFlushMs,
      snapshotIntervalMs: Number.isFinite(snapshotIntervalMs)
        ? Math.min(120_000, Math.max(500, snapshotIntervalMs))
        : DEFAULT_RECORDER_CONFIG.sampling.snapshotIntervalMs,
      screenshotIdleMs: Number.isFinite(screenshotIdleMs)
        ? Math.min(120_000, Math.max(250, screenshotIdleMs))
        : DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    },
    redaction: {
      ...DEFAULT_RECORDER_CONFIG.redaction,
      blockedSelectors,
      redactHeaders,
      redactBodyPatterns,
      hashSensitiveValues
    }
  };
}

function splitLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
