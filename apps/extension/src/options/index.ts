import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { MODE_PRODUCT_PROFILES } from "../shared/mode-profile.js";
import {
  DEFAULT_PERFORMANCE_BUDGET,
  normalizePerformanceBudget,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";

const STORAGE_KEY = "webblackbox.options";

const chromeApi = getChromeApi();
const root = document.getElementById("options-root");

type OptionsState = {
  recorderConfig: typeof DEFAULT_RECORDER_CONFIG;
  performanceBudget: PerformanceBudgetConfig;
};

if (root) {
  bootstrap(root).catch((error) => {
    root.innerHTML = `<section class="card"><h1>Settings</h1><p>${String(error)}</p></section>`;
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  const options = await loadOptionsState();
  render(container, options);
}

function render(container: HTMLElement, options: OptionsState): void {
  const { recorderConfig: config, performanceBudget } = options;
  container.innerHTML = `
    <section class="card" style="max-width:760px;">
      <h1>Capture Settings</h1>
      <p>Configure redaction and sampling defaults per browser profile.</p>
      <section style="margin-top:14px;padding:10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:rgba(20,33,61,0.02);display:grid;gap:10px;">
        <h2 style="margin:0;font-size:14px;">Runtime Profiles</h2>
        <p style="margin:0;font-size:12px;opacity:0.78;">
          WebBlackbox currently exposes two runtime profiles only: <code>lite</code> and <code>full</code>. There is no <code>balanced</code> mode in the shipped extension build.
        </p>
        ${renderModeProfileMarkup()}
      </section>

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
      <input id="screenshotIdleMs" type="number" min="0" max="120000" value="${config.sampling.screenshotIdleMs}" />
      <p style="margin:6px 0 0;font-size:12px;opacity:0.78;">
        Lite captures idle screenshots by default. Set this to <code>0</code> to disable runtime screenshots. Full mode uses this for browser-side screenshot cadence.
      </p>

      <label style="display:block;margin:12px 0 6px;">Network Body Capture Max Bytes</label>
      <input id="bodyCaptureMaxBytes" type="number" min="0" max="1048576" value="${config.sampling.bodyCaptureMaxBytes}" />
      <p style="margin:6px 0 0;font-size:12px;opacity:0.78;">
        Lite keeps page-side response-body capture disabled. In the extension, this knob only affects the capped browser-side body capture path used by full mode.
      </p>

      <div style="display:flex;align-items:center;gap:8px;margin-top:12px;">
        <input id="freezeOnError" type="checkbox" ${config.freezeOnError ? "checked" : ""} />
        <label for="freezeOnError">Freeze on uncaught errors</label>
      </div>

      <p style="margin:8px 0 0;font-size:12px;opacity:0.78;">
        Runtime safety mode keeps performance-trigger freeze disabled for lite/full recording.
      </p>

      <section style="margin-top:14px;padding:10px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:rgba(20,33,61,0.02);display:grid;gap:8px;">
        <h2 style="margin:0;font-size:14px;">Performance Budget Alerts</h2>
        <label style="display:block;margin:4px 0 4px;">LCP warn threshold (ms)</label>
        <input id="budgetLcpWarnMs" type="number" min="500" max="30000" step="100" value="${performanceBudget.lcpWarnMs}" />

        <label style="display:block;margin:4px 0 4px;">Slow request threshold (ms)</label>
        <input id="budgetRequestWarnMs" type="number" min="100" max="60000" step="100" value="${performanceBudget.requestWarnMs}" />

        <label style="display:block;margin:4px 0 4px;">Error-rate warn threshold (%)</label>
        <input id="budgetErrorRateWarnPct" type="number" min="1" max="100" step="1" value="${performanceBudget.errorRateWarnPct}" />

        <div style="display:flex;align-items:center;gap:8px;">
          <input id="budgetAutoFreezeOnBreach" type="checkbox" ${
            performanceBudget.autoFreezeOnBreach ? "checked" : ""
          } />
          <label for="budgetAutoFreezeOnBreach">Auto-freeze on budget breach</label>
        </div>
      </section>

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
    const nextRecorderConfig = readConfigFromForm(container);
    const nextPerformanceBudget = readPerformanceBudgetFromForm(container);
    await saveOptionsState({
      recorderConfig: nextRecorderConfig,
      performanceBudget: nextPerformanceBudget
    });

    const status = container.querySelector<HTMLElement>("#statusText");
    if (status) {
      status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
    }
  });

  resetButton?.addEventListener("click", async () => {
    await saveOptionsState({
      recorderConfig: DEFAULT_RECORDER_CONFIG,
      performanceBudget: DEFAULT_PERFORMANCE_BUDGET
    });
    render(container, {
      recorderConfig: normalizeOptionsConfig(DEFAULT_RECORDER_CONFIG),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET }
    });
  });
}

function renderModeProfileMarkup(): string {
  return Object.entries(MODE_PRODUCT_PROFILES)
    .map(([mode, profile]) => {
      return `
        <article style="padding:10px;border:1px solid rgba(0,0,0,0.08);border-radius:8px;background:rgba(255,255,255,0.72);display:grid;gap:4px;">
          <strong>${profile.label} <code>${mode}</code></strong>
          <span style="font-size:12px;opacity:0.84;">${profile.summary}</span>
          <span style="font-size:12px;opacity:0.78;">Signals: ${profile.signals}</span>
          <span style="font-size:12px;opacity:0.78;">Heavy capture: ${profile.heavyCapture}</span>
        </article>
      `;
    })
    .join("");
}

async function loadOptionsState(): Promise<OptionsState> {
  const values = await chromeApi?.storage?.local.get(STORAGE_KEY);
  const stored = values?.[STORAGE_KEY];

  if (!stored || typeof stored !== "object") {
    return {
      recorderConfig: normalizeOptionsConfig(DEFAULT_RECORDER_CONFIG),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET }
    };
  }

  const record = stored as Partial<typeof DEFAULT_RECORDER_CONFIG> & {
    performanceBudget?: unknown;
  };

  return {
    recorderConfig: normalizeOptionsConfig({
      ...DEFAULT_RECORDER_CONFIG,
      ...record,
      sampling: {
        ...DEFAULT_RECORDER_CONFIG.sampling,
        ...(record.sampling ?? {})
      },
      redaction: {
        ...DEFAULT_RECORDER_CONFIG.redaction,
        ...(record.redaction ?? {})
      }
    }),
    performanceBudget: normalizePerformanceBudget(record.performanceBudget)
  };
}

async function saveOptionsState(options: OptionsState): Promise<void> {
  const normalizedConfig = normalizeOptionsConfig(options.recorderConfig);
  const normalizedBudget = normalizePerformanceBudget(options.performanceBudget);
  const payload = {
    ...normalizedConfig,
    performanceBudget: normalizedBudget
  };

  await chromeApi?.storage?.local.set({
    [STORAGE_KEY]: payload
  });
}

function readPerformanceBudgetFromForm(container: HTMLElement): PerformanceBudgetConfig {
  const raw = {
    lcpWarnMs: Number(container.querySelector<HTMLInputElement>("#budgetLcpWarnMs")?.value),
    requestWarnMs: Number(container.querySelector<HTMLInputElement>("#budgetRequestWarnMs")?.value),
    errorRateWarnPct: Number(
      container.querySelector<HTMLInputElement>("#budgetErrorRateWarnPct")?.value
    ),
    autoFreezeOnBreach:
      container.querySelector<HTMLInputElement>("#budgetAutoFreezeOnBreach")?.checked ?? false
  };

  return normalizePerformanceBudget(raw);
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
  const bodyCaptureMaxBytes = Number(
    container.querySelector<HTMLInputElement>("#bodyCaptureMaxBytes")?.value ??
      DEFAULT_RECORDER_CONFIG.sampling.bodyCaptureMaxBytes
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
  const freezeOnError =
    container.querySelector<HTMLInputElement>("#freezeOnError")?.checked ??
    DEFAULT_RECORDER_CONFIG.freezeOnError;

  return {
    ...DEFAULT_RECORDER_CONFIG,
    ringBufferMinutes: Number.isFinite(ringBufferMinutes) ? Math.max(1, ringBufferMinutes) : 10,
    freezeOnError,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
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
        ? screenshotIdleMs <= 0
          ? 0
          : Math.min(120_000, Math.max(250, screenshotIdleMs))
        : DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: Number.isFinite(bodyCaptureMaxBytes)
        ? Math.min(1_048_576, Math.max(0, Math.round(bodyCaptureMaxBytes)))
        : DEFAULT_RECORDER_CONFIG.sampling.bodyCaptureMaxBytes
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

function normalizeOptionsConfig(
  config: typeof DEFAULT_RECORDER_CONFIG
): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...config,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...config.sampling,
      bodyCaptureMaxBytes: Number.isFinite(config.sampling.bodyCaptureMaxBytes)
        ? Math.min(1_048_576, Math.max(0, Math.round(config.sampling.bodyCaptureMaxBytes)))
        : DEFAULT_RECORDER_CONFIG.sampling.bodyCaptureMaxBytes
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
