import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { MODE_PRODUCT_PROFILES } from "../shared/mode-profile.js";
import { migrateStoredRecorderConfig, OPTIONS_STORAGE_VERSION } from "../shared/options-storage.js";
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
    renderError(root, error);
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  const options = await loadOptionsState();
  render(container, options);
}

function render(container: HTMLElement, options: OptionsState): void {
  const { recorderConfig: config, performanceBudget } = options;
  const section = document.createElement("section");
  section.className = "card";
  section.style.maxWidth = "760px";

  const header = document.createElement("header");
  header.className = "wb-page-header";
  header.append(createBrandLockup());

  const subtitle = document.createElement("p");
  subtitle.className = "wb-page-header__subtitle";
  subtitle.textContent = "Configure redaction and sampling defaults per browser profile.";
  header.append(subtitle);
  section.append(header);

  section.append(createRuntimeProfilesSection());
  section.append(
    ...createNumberField("Ring Buffer (minutes)", "ringBufferMinutes", config.ringBufferMinutes, {
      min: 1,
      max: 120
    })
  );
  section.append(
    ...createNumberField("Action Window (ms)", "actionWindowMs", config.sampling.actionWindowMs, {
      min: 100,
      max: 10_000
    })
  );
  section.append(
    ...createNumberField("Mousemove Sampling (Hz)", "mousemoveHz", config.sampling.mousemoveHz, {
      min: 1,
      max: 240
    })
  );
  section.append(
    ...createNumberField("Scroll Sampling (Hz)", "scrollHz", config.sampling.scrollHz, {
      min: 1,
      max: 120
    })
  );
  section.append(
    ...createNumberField("DOM Flush Interval (ms)", "domFlushMs", config.sampling.domFlushMs, {
      min: 25,
      max: 10_000
    })
  );
  section.append(
    ...createNumberField(
      "DOM Snapshot Interval (ms)",
      "snapshotIntervalMs",
      config.sampling.snapshotIntervalMs,
      { min: 500, max: 120_000 }
    )
  );
  section.append(
    ...createNumberField(
      "Screenshot Idle Interval (ms)",
      "screenshotIdleMs",
      config.sampling.screenshotIdleMs,
      { min: 0, max: 120_000 }
    )
  );
  section.append(
    createHelpText([
      "Lite captures idle screenshots by default. Set this to ",
      createCode("0"),
      " to disable runtime screenshots. Full mode uses this for browser-side screenshot cadence."
    ])
  );
  section.append(
    ...createNumberField(
      "Network Body Capture Max Bytes",
      "bodyCaptureMaxBytes",
      config.sampling.bodyCaptureMaxBytes,
      { min: 0, max: 1_048_576 }
    )
  );
  section.append(
    createHelpText([
      "Lite keeps page-side response-body capture disabled. In the extension, this knob only affects the capped browser-side body capture path used by full mode."
    ])
  );
  section.append(
    createCheckboxRow("freezeOnError", "Freeze on uncaught errors", config.freezeOnError, {
      marginTop: "12px"
    })
  );
  section.append(
    createHelpText(
      ["Runtime safety mode keeps performance-trigger freeze disabled for lite/full recording."],
      { marginTop: "8px" }
    )
  );
  section.append(createPerformanceBudgetSection(performanceBudget));
  section.append(
    ...createTextareaField(
      "Blocked Selectors (one per line)",
      "blockedSelectors",
      config.redaction.blockedSelectors.join("\n")
    )
  );
  section.append(
    ...createTextareaField(
      "Redacted Header Names (one per line)",
      "redactHeaders",
      config.redaction.redactHeaders.join("\n")
    )
  );
  section.append(
    ...createTextareaField(
      "Body Sensitive Patterns (one per line)",
      "redactBodyPatterns",
      config.redaction.redactBodyPatterns.join("\n")
    )
  );
  section.append(
    createCheckboxRow(
      "hashSensitiveValues",
      "Hash sensitive values",
      config.redaction.hashSensitiveValues,
      { marginTop: "12px" }
    )
  );

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.marginTop = "14px";

  const saveConfigButton = document.createElement("button");
  saveConfigButton.id = "saveConfig";
  saveConfigButton.type = "button";
  saveConfigButton.textContent = "Save";

  const resetConfigButton = document.createElement("button");
  resetConfigButton.id = "resetConfig";
  resetConfigButton.type = "button";
  resetConfigButton.textContent = "Reset Defaults";

  actions.append(saveConfigButton, resetConfigButton);
  section.append(actions);

  const statusText = document.createElement("p");
  statusText.id = "statusText";
  statusText.style.marginTop = "10px";
  statusText.style.fontSize = "12px";
  statusText.style.opacity = "0.8";
  section.append(statusText);

  container.replaceChildren(section);

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

async function loadOptionsState(): Promise<OptionsState> {
  const values = await chromeApi?.storage?.local.get(STORAGE_KEY);
  const stored = values?.[STORAGE_KEY];

  if (!stored || typeof stored !== "object") {
    return {
      recorderConfig: normalizeOptionsConfig(DEFAULT_RECORDER_CONFIG),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET }
    };
  }

  const record = migrateStoredRecorderConfig(
    stored as Partial<typeof DEFAULT_RECORDER_CONFIG> & {
      optionsVersion?: unknown;
      performanceBudget?: unknown;
    }
  );

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
    optionsVersion: OPTIONS_STORAGE_VERSION,
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

function renderError(container: HTMLElement, error: unknown): void {
  const section = document.createElement("section");
  section.className = "card";
  section.style.maxWidth = "760px";
  section.append(createBrandLockup());

  const message = document.createElement("p");
  message.textContent = String(error);
  section.append(message);

  container.replaceChildren(section);
}

function createBrandLockup(): HTMLElement {
  const lockup = document.createElement("div");
  lockup.className = "wb-brand-lockup";

  const icon = document.createElement("img");
  icon.className = "wb-brand-lockup__icon";
  icon.src = "./icon/32.png";
  icon.alt = "";
  icon.width = 32;
  icon.height = 32;

  const copy = document.createElement("div");
  copy.className = "wb-brand-lockup__copy";

  const eyebrow = document.createElement("p");
  eyebrow.className = "wb-brand-lockup__eyebrow";
  eyebrow.textContent = "Chrome Extension";

  const title = document.createElement("h1");
  title.style.margin = "0";
  title.textContent = "Capture Settings";

  copy.append(eyebrow, title);
  lockup.append(icon, copy);
  return lockup;
}

function createRuntimeProfilesSection(): HTMLElement {
  const section = createInsetSection({ gap: "10px" });

  const title = document.createElement("h2");
  title.style.margin = "0";
  title.style.fontSize = "14px";
  title.textContent = "Runtime Profiles";

  const summary = createHelpText([
    "WebBlackbox currently exposes two runtime profiles only: ",
    createCode("lite"),
    " and ",
    createCode("full"),
    ". There is no ",
    createCode("balanced"),
    " mode in the shipped extension build."
  ]);
  summary.style.marginTop = "0";

  section.append(title, summary, ...createModeProfileCards());
  return section;
}

function createModeProfileCards(): HTMLElement[] {
  return Object.entries(MODE_PRODUCT_PROFILES).map(([mode, profile]) => {
    const card = document.createElement("article");
    card.style.padding = "10px";
    card.style.border = "1px solid rgba(0,0,0,0.08)";
    card.style.borderRadius = "8px";
    card.style.background = "rgba(255,255,255,0.72)";
    card.style.display = "grid";
    card.style.gap = "4px";

    const title = document.createElement("strong");
    title.append(profile.label, " ", createCode(mode));

    const summary = document.createElement("span");
    summary.style.fontSize = "12px";
    summary.style.opacity = "0.84";
    summary.textContent = profile.summary;

    const signals = document.createElement("span");
    signals.style.fontSize = "12px";
    signals.style.opacity = "0.78";
    signals.textContent = `Signals: ${profile.signals}`;

    const heavyCapture = document.createElement("span");
    heavyCapture.style.fontSize = "12px";
    heavyCapture.style.opacity = "0.78";
    heavyCapture.textContent = `Heavy capture: ${profile.heavyCapture}`;

    card.append(title, summary, signals, heavyCapture);
    return card;
  });
}

function createPerformanceBudgetSection(performanceBudget: PerformanceBudgetConfig): HTMLElement {
  const section = createInsetSection({ gap: "8px", marginTop: "14px" });

  const title = document.createElement("h2");
  title.style.margin = "0";
  title.style.fontSize = "14px";
  title.textContent = "Performance Budget Alerts";

  section.append(
    title,
    ...createNumberField(
      "LCP warn threshold (ms)",
      "budgetLcpWarnMs",
      performanceBudget.lcpWarnMs,
      {
        min: 500,
        max: 30_000,
        step: 100,
        marginTop: "4px"
      }
    ),
    ...createNumberField(
      "Slow request threshold (ms)",
      "budgetRequestWarnMs",
      performanceBudget.requestWarnMs,
      {
        min: 100,
        max: 60_000,
        step: 100,
        marginTop: "4px"
      }
    ),
    ...createNumberField(
      "Error-rate warn threshold (%)",
      "budgetErrorRateWarnPct",
      performanceBudget.errorRateWarnPct,
      {
        min: 1,
        max: 100,
        step: 1,
        marginTop: "4px"
      }
    ),
    createCheckboxRow(
      "budgetAutoFreezeOnBreach",
      "Auto-freeze on budget breach",
      performanceBudget.autoFreezeOnBreach
    )
  );

  return section;
}

function createInsetSection(styles: { gap: string; marginTop?: string }): HTMLElement {
  const section = document.createElement("section");
  section.style.marginTop = styles.marginTop ?? "14px";
  section.style.padding = "10px";
  section.style.border = "1px solid rgba(0,0,0,0.12)";
  section.style.borderRadius = "10px";
  section.style.background = "rgba(20,33,61,0.02)";
  section.style.display = "grid";
  section.style.gap = styles.gap;
  return section;
}

function createNumberField(
  labelText: string,
  id: string,
  value: number,
  options: { min: number; max: number; step?: number; marginTop?: string }
): [HTMLLabelElement, HTMLInputElement] {
  const label = document.createElement("label");
  label.style.display = "block";
  label.style.margin = `${options.marginTop ?? "12px"} 0 6px`;
  label.textContent = labelText;

  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.min = String(options.min);
  input.max = String(options.max);
  input.value = String(value);

  if (typeof options.step === "number") {
    input.step = String(options.step);
  }

  return [label, input];
}

function createTextareaField(
  labelText: string,
  id: string,
  value: string
): [HTMLLabelElement, HTMLTextAreaElement] {
  const label = document.createElement("label");
  label.style.display = "block";
  label.style.margin = "12px 0 6px";
  label.textContent = labelText;

  const textarea = document.createElement("textarea");
  textarea.id = id;
  textarea.rows = 6;
  textarea.style.width = "100%";
  textarea.value = value;

  return [label, textarea];
}

function createCheckboxRow(
  id: string,
  labelText: string,
  checked: boolean,
  options: { marginTop?: string } = {}
): HTMLElement {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "8px";
  row.style.marginTop = options.marginTop ?? "0";

  const input = document.createElement("input");
  input.id = id;
  input.type = "checkbox";
  input.checked = checked;

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;

  row.append(input, label);
  return row;
}

function createHelpText(
  parts: Array<string | HTMLElement>,
  options: { marginTop?: string } = {}
): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.style.margin = `${options.marginTop ?? "6px"} 0 0`;
  paragraph.style.fontSize = "12px";
  paragraph.style.opacity = "0.78";

  for (const part of parts) {
    if (typeof part === "string") {
      paragraph.append(part);
      continue;
    }

    paragraph.append(part);
  }

  return paragraph;
}

function createCode(text: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = text;
  return code;
}
