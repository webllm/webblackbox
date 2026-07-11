import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { MODE_PRODUCT_PROFILES } from "../shared/mode-profile.js";
import { createExtensionI18n } from "../shared/i18n.js";
import { migrateStoredRecorderConfig, OPTIONS_STORAGE_VERSION } from "../shared/options-storage.js";
import {
  DEFAULT_PERFORMANCE_BUDGET,
  normalizePerformanceBudget,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";
import { resolveInstalledRuntimeCapabilities } from "../shared/runtime-capabilities.js";

const STORAGE_KEY = "webblackbox.options";

const chromeApi = getChromeApi();
const runtimeCapabilities = resolveInstalledRuntimeCapabilities(chromeApi);
const i18n = createExtensionI18n({
  pageTitleKey: "pageTitleOptions"
});
const { locale, t } = i18n;
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
  const hasFullCapture = runtimeCapabilities.fullMode;
  const hasNetworkCapture =
    hasFullCapture ||
    (runtimeCapabilities.pageInjection && runtimeCapabilities.browserNetwork === "webRequest");
  const section = document.createElement("section");
  section.className = "card wb-options-card";

  const header = document.createElement("header");
  header.className = "wb-page-header";
  header.append(createBrandLockup());

  const subtitle = document.createElement("p");
  subtitle.className = "wb-page-header__subtitle";
  subtitle.textContent = t("optionsSubtitle");
  header.append(subtitle);
  section.append(header);

  section.append(createRuntimeProfilesSection());
  section.append(
    ...createNumberField(
      t("optionsRingBufferMinutes"),
      "ringBufferMinutes",
      config.ringBufferMinutes,
      {
        min: 1,
        max: 120
      }
    )
  );
  section.append(
    ...createNumberField(
      t("optionsActionWindowMs"),
      "actionWindowMs",
      config.sampling.actionWindowMs,
      {
        min: 100,
        max: 10_000
      }
    )
  );
  section.append(
    ...createNumberField(t("optionsMousemoveHz"), "mousemoveHz", config.sampling.mousemoveHz, {
      min: 1,
      max: 240
    })
  );
  section.append(
    ...createNumberField(t("optionsScrollHz"), "scrollHz", config.sampling.scrollHz, {
      min: 1,
      max: 120
    })
  );
  section.append(
    ...createNumberField(t("optionsDomFlushMs"), "domFlushMs", config.sampling.domFlushMs, {
      min: 25,
      max: 10_000
    })
  );
  section.append(
    ...createNumberField(
      t("optionsSnapshotIntervalMs"),
      "snapshotIntervalMs",
      config.sampling.snapshotIntervalMs,
      { min: 500, max: 120_000 }
    )
  );
  section.append(createHelpText([t("optionsSnapshotIntervalHelp")]));
  if (hasFullCapture) {
    section.append(
      ...createNumberField(
        t("optionsScreenshotIdleMs"),
        "screenshotIdleMs",
        config.sampling.screenshotIdleMs,
        { min: 0, max: 120_000 }
      )
    );
    section.append(createHelpText([t("optionsScreenshotIdleHelp")]));
    section.append(
      ...createNumberField(
        t("optionsBodyCaptureMaxBytes"),
        "bodyCaptureMaxBytes",
        config.sampling.bodyCaptureMaxBytes,
        { min: 0, max: 1_048_576 }
      )
    );
    section.append(createHelpText([t("optionsBodyCaptureHelp")]));
  }
  section.append(
    createCheckboxRow("freezeOnError", t("optionsFreezeOnError"), config.freezeOnError, {
      spacious: true
    })
  );
  section.append(createHelpText([t("optionsFreezeHelp")], { variant: "spacious" }));
  section.append(createPerformanceBudgetSection(performanceBudget, hasNetworkCapture));
  section.append(
    ...createTextareaField(
      t("optionsBlockedSelectors"),
      "blockedSelectors",
      config.redaction.blockedSelectors.join("\n")
    )
  );
  if (hasNetworkCapture) {
    section.append(
      ...createTextareaField(
        t("optionsRedactedHeaders"),
        "redactHeaders",
        config.redaction.redactHeaders.join("\n")
      )
    );
  }
  section.append(
    ...createTextareaField(
      t("optionsBodySensitivePatterns"),
      "redactBodyPatterns",
      config.redaction.redactBodyPatterns.join("\n")
    )
  );
  section.append(
    createCheckboxRow(
      "hashSensitiveValues",
      t("optionsHashSensitiveValues"),
      config.redaction.hashSensitiveValues,
      { spacious: true }
    )
  );

  const actions = document.createElement("div");
  actions.className = "wb-options-actions";

  const saveConfigButton = document.createElement("button");
  saveConfigButton.id = "saveConfig";
  saveConfigButton.type = "button";
  saveConfigButton.className = "wb-btn wb-btn--brand";
  saveConfigButton.textContent = t("optionsSave");

  const resetConfigButton = document.createElement("button");
  resetConfigButton.id = "resetConfig";
  resetConfigButton.type = "button";
  resetConfigButton.className = "wb-btn wb-btn--muted";
  resetConfigButton.textContent = t("optionsResetDefaults");

  actions.append(saveConfigButton, resetConfigButton);
  section.append(actions);

  const statusText = document.createElement("p");
  statusText.id = "statusText";
  statusText.className = "wb-options-status";
  section.append(statusText);

  container.replaceChildren(section);

  const saveButton = container.querySelector<HTMLButtonElement>("#saveConfig");
  const resetButton = container.querySelector<HTMLButtonElement>("#resetConfig");

  saveButton?.addEventListener("click", async () => {
    const nextRecorderConfig = readConfigFromForm(container, config);
    const nextPerformanceBudget = readPerformanceBudgetFromForm(container, performanceBudget);
    await saveOptionsState({
      recorderConfig: nextRecorderConfig,
      performanceBudget: nextPerformanceBudget
    });

    const status = container.querySelector<HTMLElement>("#statusText");
    if (status) {
      status.textContent = t("optionsSavedAt", {
        time: new Date().toLocaleTimeString(locale)
      });
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

function readPerformanceBudgetFromForm(
  container: HTMLElement,
  loaded: PerformanceBudgetConfig
): PerformanceBudgetConfig {
  const raw = {
    lcpWarnMs: readNumberInput(container, "budgetLcpWarnMs", loaded.lcpWarnMs),
    requestWarnMs: readNumberInput(container, "budgetRequestWarnMs", loaded.requestWarnMs),
    errorRateWarnPct: readNumberInput(container, "budgetErrorRateWarnPct", loaded.errorRateWarnPct),
    autoFreezeOnBreach: readCheckboxInput(
      container,
      "budgetAutoFreezeOnBreach",
      loaded.autoFreezeOnBreach
    )
  };

  return normalizePerformanceBudget(raw);
}

function readConfigFromForm(
  container: HTMLElement,
  loaded: typeof DEFAULT_RECORDER_CONFIG
): typeof DEFAULT_RECORDER_CONFIG {
  const ringBufferMinutes = readNumberInput(
    container,
    "ringBufferMinutes",
    loaded.ringBufferMinutes
  );
  const actionWindowMs = readNumberInput(
    container,
    "actionWindowMs",
    loaded.sampling.actionWindowMs
  );
  const mousemoveHz = readNumberInput(container, "mousemoveHz", loaded.sampling.mousemoveHz);
  const scrollHz = readNumberInput(container, "scrollHz", loaded.sampling.scrollHz);
  const domFlushMs = readNumberInput(container, "domFlushMs", loaded.sampling.domFlushMs);
  const snapshotIntervalMs = readNumberInput(
    container,
    "snapshotIntervalMs",
    loaded.sampling.snapshotIntervalMs
  );
  const screenshotIdleMs = readNumberInput(
    container,
    "screenshotIdleMs",
    loaded.sampling.screenshotIdleMs
  );
  const bodyCaptureMaxBytes = readNumberInput(
    container,
    "bodyCaptureMaxBytes",
    loaded.sampling.bodyCaptureMaxBytes
  );

  const blockedSelectors = splitLines(
    container.querySelector<HTMLTextAreaElement>("#blockedSelectors")?.value
  );
  const redactHeadersInput = container.querySelector<HTMLTextAreaElement>("#redactHeaders");
  const redactHeaders = redactHeadersInput
    ? splitLines(redactHeadersInput.value)
    : [...loaded.redaction.redactHeaders];
  const redactBodyPatterns = splitLines(
    container.querySelector<HTMLTextAreaElement>("#redactBodyPatterns")?.value
  );
  const hashSensitiveValues = readCheckboxInput(
    container,
    "hashSensitiveValues",
    loaded.redaction.hashSensitiveValues
  );
  const freezeOnError = readCheckboxInput(container, "freezeOnError", loaded.freezeOnError);

  return {
    ...loaded,
    ringBufferMinutes: Number.isFinite(ringBufferMinutes) ? Math.max(1, ringBufferMinutes) : 10,
    freezeOnError,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...loaded.sampling,
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
      ...loaded.redaction,
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
  section.className = "card wb-options-card";
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
  eyebrow.textContent = t("brandEyebrowChromeExtension");

  const title = document.createElement("h1");
  title.className = "wb-options-title";
  title.textContent = t("optionsTitle");

  copy.append(eyebrow, title);
  lockup.append(icon, copy);
  return lockup;
}

function createRuntimeProfilesSection(): HTMLElement {
  const section = createInsetSection();

  const title = document.createElement("h2");
  title.className = "wb-options-section-title";
  title.textContent = t("optionsRuntimeProfilesTitle");

  const summary = createHelpText([t("optionsRuntimeProfilesSummary")], { variant: "flush" });

  section.append(title, summary, ...createModeProfileCards());
  return section;
}

function createModeProfileCards(): HTMLElement[] {
  const liteHasBrowserNetwork = runtimeCapabilities.browserNetwork === "webRequest";

  return Object.keys(MODE_PRODUCT_PROFILES)
    .filter((mode) =>
      mode === "full" ? runtimeCapabilities.fullMode : runtimeCapabilities.pageInjection
    )
    .map((mode) => {
      const card = document.createElement("article");
      card.className = "wb-options-profile-card";
      card.dataset.modeProfile = mode;

      const title = document.createElement("strong");
      title.append(mode === "full" ? t("modeFull") : t("modeLite"), " ", createCode(mode));

      const summary = document.createElement("span");
      summary.className = "wb-options-profile-summary";
      summary.textContent =
        mode === "full"
          ? t("optionsFullProfileSummary")
          : t(
              liteHasBrowserNetwork
                ? "optionsLiteProfileSummary"
                : "optionsLiteProfileSummaryNoBrowserNetwork"
            );

      const signals = document.createElement("span");
      signals.className = "wb-options-profile-meta";
      signals.textContent = t("optionsProfileSignals", {
        value:
          mode === "full"
            ? t("optionsFullProfileSignals")
            : t(
                liteHasBrowserNetwork
                  ? "optionsLiteProfileSignals"
                  : "optionsLiteProfileSignalsNoBrowserNetwork"
              )
      });

      const heavyCapture = document.createElement("span");
      heavyCapture.className = "wb-options-profile-meta";
      heavyCapture.textContent = t("optionsProfileHeavyCapture", {
        value:
          mode === "full"
            ? t("optionsFullProfileHeavyCapture")
            : t("optionsLiteProfileHeavyCapture")
      });

      card.append(title, summary, signals, heavyCapture);
      return card;
    });
}

function createPerformanceBudgetSection(
  performanceBudget: PerformanceBudgetConfig,
  includeNetworkBudgets: boolean
): HTMLElement {
  const section = createInsetSection("dense");

  const title = document.createElement("h2");
  title.className = "wb-options-section-title";
  title.textContent = t("optionsPerformanceBudgetTitle");

  section.append(
    title,
    ...createNumberField(t("optionsLcpWarnMs"), "budgetLcpWarnMs", performanceBudget.lcpWarnMs, {
      min: 500,
      max: 30_000,
      step: 100,
      compact: true
    })
  );

  if (includeNetworkBudgets) {
    section.append(
      ...createNumberField(
        t("optionsRequestWarnMs"),
        "budgetRequestWarnMs",
        performanceBudget.requestWarnMs,
        {
          min: 100,
          max: 60_000,
          step: 100,
          compact: true
        }
      ),
      ...createNumberField(
        t("optionsErrorRateWarnPct"),
        "budgetErrorRateWarnPct",
        performanceBudget.errorRateWarnPct,
        {
          min: 1,
          max: 100,
          step: 1,
          compact: true
        }
      )
    );
  }

  section.append(
    createCheckboxRow(
      "budgetAutoFreezeOnBreach",
      t("optionsAutoFreezeOnBreach"),
      performanceBudget.autoFreezeOnBreach
    )
  );

  return section;
}

function readNumberInput(container: HTMLElement, id: string, fallback: number): number {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  return input ? Number(input.value) : fallback;
}

function readCheckboxInput(container: HTMLElement, id: string, fallback: boolean): boolean {
  return container.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? fallback;
}

function createInsetSection(variant: "default" | "dense" = "default"): HTMLElement {
  const section = document.createElement("section");
  section.className =
    variant === "dense" ? "wb-options-inset wb-options-inset--dense" : "wb-options-inset";
  return section;
}

function createNumberField(
  labelText: string,
  id: string,
  value: number,
  options: { min: number; max: number; step?: number; compact?: boolean }
): [HTMLLabelElement, HTMLInputElement] {
  const label = document.createElement("label");
  label.className = options.compact
    ? "wb-options-field-label wb-options-field-label--compact"
    : "wb-options-field-label";
  label.textContent = labelText;

  const input = document.createElement("input");
  input.id = id;
  input.type = "number";
  input.className = "wb-input";
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
  label.className = "wb-options-field-label";
  label.textContent = labelText;

  const textarea = document.createElement("textarea");
  textarea.id = id;
  textarea.rows = 6;
  textarea.className = "wb-options-textarea";
  textarea.value = value;

  return [label, textarea];
}

function createCheckboxRow(
  id: string,
  labelText: string,
  checked: boolean,
  options: { spacious?: boolean } = {}
): HTMLElement {
  const row = document.createElement("div");
  row.className = options.spacious
    ? "wb-options-checkbox-row wb-options-checkbox-row--spacious"
    : "wb-options-checkbox-row";

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
  options: { variant?: "default" | "flush" | "spacious" } = {}
): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.className =
    options.variant === "flush"
      ? "wb-options-help wb-options-help--flush"
      : options.variant === "spacious"
        ? "wb-options-help wb-options-help--spacious"
        : "wb-options-help";

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
