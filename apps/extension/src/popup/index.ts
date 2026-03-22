import { DEFAULT_EXPORT_POLICY, type ExportPolicy, type FreezeReason } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.popup });
const extensionVersion = chromeApi?.runtime?.getManifest?.().version ?? "dev";

const root = document.getElementById("popup-root");
const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";

type PopupExportPolicyForm = {
  includeScreenshots: boolean;
  maxArchiveMb: string;
  recentMinutes: string;
};

const state: {
  tabId: number | null;
  sessions: SessionListItem[];
  recording: { active: boolean; sid?: string; mode?: string };
  exportPolicyForm: PopupExportPolicyForm;
  exportStatus?: string;
  lastFreeze?: { sid: string; reason: FreezeReason; at: number };
} = {
  tabId: null,
  sessions: [],
  recording: { active: false },
  exportPolicyForm: toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY),
  exportStatus: undefined,
  lastFreeze: undefined
};

if (root) {
  bootstrap(root).catch((error) => {
    renderError(root, error);
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  state.tabId = await getActiveTabId();
  state.exportPolicyForm = loadPopupExportPolicyForm();

  port?.onMessage.addListener((message) => {
    applyMessage(message as ExtensionOutboundMessage);
    render(container);
  });

  render(container);
}

function postUiMessage(message: ExtensionInboundMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    void 0;
  }
}

function render(container: HTMLElement): void {
  const now = Date.now();
  const sortedSessions = [...state.sessions].sort((left, right) => {
    const activeDiff = Number(right.active) - Number(left.active);

    if (activeDiff !== 0) {
      return activeDiff;
    }

    return right.startedAt - left.startedAt;
  });
  const tabSessions = sortedSessions
    .filter((item) => item.tabId === state.tabId)
    .sort((left, right) => right.startedAt - left.startedAt);
  const activeSession =
    tabSessions.find((item) => item.active) ?? sortedSessions.find((item) => item.active);
  const exportSession = activeSession ?? tabSessions[0] ?? sortedSessions[0];
  const activeOnCurrentTab = activeSession && activeSession.tabId === state.tabId;
  const status = activeSession
    ? activeOnCurrentTab
      ? `Recording (${activeSession.mode})`
      : `Recording (${activeSession.mode}) on Tab ${activeSession.tabId}`
    : exportSession
      ? exportSession.tabId === state.tabId
        ? `Idle (Last ${exportSession.mode})`
        : `Idle (Last ${exportSession.mode} on Tab ${exportSession.tabId})`
      : "Idle";
  const summarySession = activeSession ?? exportSession;
  const budgetAlerts = summarySession?.budgetAlertCount ?? 0;
  const ringUsage = summarySession ? describeRingBufferUsage(summarySession, now) : null;
  const captureSummary = summarySession
    ? `${summarySession.eventCount ?? 0} events • ${summarySession.errorCount ?? 0} errors • ${budgetAlerts} budget alerts • ${formatByteSize(summarySession.sizeBytes ?? 0)}`
    : "No captured events";
  const recentFreeze =
    state.lastFreeze && now - state.lastFreeze.at <= 10 * 60 * 1000 ? state.lastFreeze : null;
  const incidentText = recentFreeze
    ? `${recentFreeze.reason} (${formatRelativeTime(recentFreeze.at, now)})`
    : "none";
  const badgeText = recentFreeze ? "ALERT" : activeSession ? "REC" : "IDLE";
  const badgeClass = recentFreeze ? "wb-popup__badge wb-popup__badge--alert" : "wb-popup__badge";
  const exportStatusClass = state.exportStatus?.startsWith("Export failed")
    ? "wb-popup__status wb-popup__status--error"
    : "wb-popup__status";
  const startDisabled = Boolean(activeOnCurrentTab);
  const section = document.createElement("section");
  section.className = "card wb-popup";

  const header = document.createElement("header");
  header.className = "wb-popup__header";
  header.append(createBrandLockup({ tight: true }));

  const badge = document.createElement("span");
  badge.className = badgeClass;
  badge.textContent = badgeText;
  header.append(badge);
  section.append(header);

  const meta = document.createElement("div");
  meta.className = "wb-popup__meta";
  meta.append(
    createMetaLine("Tab", String(state.tabId ?? "n/a")),
    createMetaLine("Status", status),
    createMetaLine("Capture", captureSummary),
    createMetaLine("Incident", incidentText)
  );
  section.append(meta);

  if (ringUsage) {
    section.append(createRingUsageSection(ringUsage));
  }

  const actions = document.createElement("div");
  actions.className = "wb-popup__actions";
  actions.append(
    createActionButton("Start Lite", "wb-btn wb-btn--brand", "start-lite", startDisabled),
    createActionButton("Start Full", "wb-btn wb-btn--brand-alt", "start-full", startDisabled),
    createActionButton("Stop", "wb-btn wb-btn--muted", "stop", !activeSession),
    createActionButton("Export", "wb-btn wb-btn--accent", "export", !exportSession)
  );
  section.append(actions);

  const nav = document.createElement("div");
  nav.className = "wb-popup__nav";
  nav.append(
    createActionButton("Sessions", "wb-btn wb-btn--surface", "open-sessions"),
    createActionButton("Options", "wb-btn wb-btn--surface", "open-options")
  );
  section.append(nav);

  section.append(createArchivePolicySection());

  const exportStatus = document.createElement("p");
  exportStatus.className = exportStatusClass;
  exportStatus.textContent = state.exportStatus ?? "";
  section.append(exportStatus);

  const hint = document.createElement("p");
  hint.className = "wb-popup__hint";
  hint.textContent = "Marker: Ctrl/Cmd + Shift + M";
  section.append(hint);

  container.replaceChildren(section);

  writeExportPolicyFormToContainer(container, state.exportPolicyForm);
  bindActions(container, activeSession, exportSession);
  bindExportPolicyForm(container);
}

function bindActions(
  container: HTMLElement,
  activeSession?: SessionListItem,
  exportSession?: SessionListItem
): void {
  container.querySelector("[data-action='start-lite']")?.addEventListener("click", async () => {
    if (activeSession && activeSession.tabId === state.tabId) {
      return;
    }

    const resolvedTabId = await getActiveTabId();
    const tabId = typeof resolvedTabId === "number" ? resolvedTabId : state.tabId;

    if (typeof tabId !== "number") {
      return;
    }

    state.tabId = tabId;
    postUiMessage({
      kind: "ui.start",
      tabId,
      mode: "lite"
    });
  });

  container.querySelector("[data-action='start-full']")?.addEventListener("click", async () => {
    if (activeSession && activeSession.tabId === state.tabId) {
      return;
    }

    const resolvedTabId = await getActiveTabId();
    const tabId = typeof resolvedTabId === "number" ? resolvedTabId : state.tabId;

    if (typeof tabId !== "number") {
      return;
    }

    state.tabId = tabId;
    postUiMessage({
      kind: "ui.start",
      tabId,
      mode: "full"
    });
  });

  container.querySelector("[data-action='stop']")?.addEventListener("click", () => {
    if (!activeSession) {
      return;
    }

    postUiMessage({
      kind: "ui.stop",
      tabId: activeSession.tabId
    });
  });

  container.querySelector("[data-action='export']")?.addEventListener("click", async () => {
    if (!exportSession) {
      return;
    }

    const passphrase = await openPassphraseDialog();

    if (passphrase === null) {
      return;
    }

    const policy = readExportPolicyFromForm(container);

    postUiMessage({
      kind: "ui.export",
      sid: exportSession.sid,
      passphrase: passphrase.trim() || undefined,
      policy
    });
  });

  container.querySelector("[data-action='open-sessions']")?.addEventListener("click", () => {
    void openExtensionPage("sessions.html");
  });

  container.querySelector("[data-action='open-options']")?.addEventListener("click", () => {
    void openExtensionPage("options.html");
  });
}

async function openExtensionPage(path: string): Promise<void> {
  const url = chromeApi?.runtime?.getURL(path);

  if (!url || typeof chromeApi?.tabs?.create !== "function") {
    return;
  }

  await chromeApi.tabs.create({ url, active: true });
  window.close();
}

function bindExportPolicyForm(container: HTMLElement): void {
  const persistDraft = (): void => {
    state.exportPolicyForm = readPopupExportPolicyFormFromContainer(container);
    savePopupExportPolicyForm(state.exportPolicyForm);
  };

  container
    .querySelector<HTMLInputElement>("#export-include-screenshots")
    ?.addEventListener("change", persistDraft);
  container
    .querySelector<HTMLInputElement>("#export-max-size-mb")
    ?.addEventListener("input", persistDraft);
  container
    .querySelector<HTMLInputElement>("#export-recent-minutes")
    ?.addEventListener("input", persistDraft);
}

function openPassphraseDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "wb-confirm-overlay";
    const form = document.createElement("form");
    form.className = "wb-confirm-card wb-prompt-card";
    form.setAttribute("aria-labelledby", "wb-passphrase-title");

    const title = document.createElement("h2");
    title.id = "wb-passphrase-title";
    title.className = "wb-confirm-title";
    title.textContent = "Export Passphrase";

    const body = document.createElement("p");
    body.className = "wb-confirm-body";
    body.textContent = "Optional AES-GCM passphrase. Leave blank for unencrypted export.";

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.htmlFor = "wb-passphrase-input";
    label.textContent = "Passphrase";

    const input = document.createElement("input");
    input.id = "wb-passphrase-input";
    input.type = "password";
    input.className = "wb-input wb-prompt-field";
    input.autocomplete = "off";

    const actions = document.createElement("div");
    actions.className = "wb-confirm-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wb-btn wb-btn--muted";
    cancelButton.setAttribute("data-passphrase-cancel", "");
    cancelButton.textContent = "Cancel";

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.className = "wb-btn wb-btn--accent";
    submitButton.textContent = "Export";

    actions.append(cancelButton, submitButton);
    form.append(title, body, label, input, actions);
    overlay.append(form);

    const finish = (value: string | null): void => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };

    cancelButton?.addEventListener("click", () => finish(null));
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(input?.value ?? "");
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(null);
      }
    });

    document.addEventListener("keydown", onKeydown);
    document.body.append(overlay);
    input?.focus();
  });
}

function applyMessage(message: ExtensionOutboundMessage): void {
  if (message.kind === "sw.session-list") {
    state.sessions = message.sessions;
    return;
  }

  if (message.kind === "sw.recording-status") {
    state.recording = {
      active: message.active,
      sid: message.sid,
      mode: message.mode
    };
    return;
  }

  if (message.kind === "sw.export-status") {
    state.exportStatus = message.ok
      ? `Exported: ${message.fileName ?? message.sid}`
      : `Export failed: ${message.error ?? "Unknown error"}`;
    return;
  }

  if (message.kind === "sw.freeze") {
    state.lastFreeze = {
      sid: message.sid,
      reason: message.reason,
      at: Date.now()
    };
  }
}

async function getActiveTabId(): Promise<number | null> {
  const focusedTabs =
    (await chromeApi?.tabs?.query?.({
      active: true,
      lastFocusedWindow: true
    })) ?? [];
  const focusedActiveRecordable = focusedTabs.find(
    (tab) => typeof tab.id === "number" && isRecordableTabUrl(tab.url)
  );

  if (focusedActiveRecordable && typeof focusedActiveRecordable.id === "number") {
    return focusedActiveRecordable.id;
  }

  const allTabs = (await chromeApi?.tabs?.query?.({})) ?? [];
  const activeRecordable = allTabs.find(
    (tab) => tab.active && typeof tab.id === "number" && isRecordableTabUrl(tab.url)
  );

  if (activeRecordable && typeof activeRecordable.id === "number") {
    return activeRecordable.id;
  }

  const recordableByRecency = allTabs
    .filter((tab) => typeof tab.id === "number" && isRecordableTabUrl(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (recordableByRecency.length > 0 && typeof recordableByRecency[0]?.id === "number") {
    return recordableByRecency[0].id;
  }

  const activeAny =
    focusedTabs.find((tab) => tab.active && typeof tab.id === "number") ??
    allTabs.find((tab) => tab.active && typeof tab.id === "number");
  return activeAny && typeof activeAny.id === "number" ? activeAny.id : null;
}

function isRecordableTabUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }

  if (url.startsWith("chrome-extension://")) {
    return false;
  }

  if (url.startsWith("chrome://")) {
    return false;
  }

  if (url === "about:blank") {
    return false;
  }

  return true;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const deltaMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function readExportPolicyFromForm(container: HTMLElement): ExportPolicy {
  state.exportPolicyForm = readPopupExportPolicyFormFromContainer(container);
  savePopupExportPolicyForm(state.exportPolicyForm);

  return toExportPolicy(state.exportPolicyForm);
}

function toPopupExportPolicyForm(policy: ExportPolicy): PopupExportPolicyForm {
  return {
    includeScreenshots: policy.includeScreenshots,
    maxArchiveMb: String(Math.max(1, Math.round(policy.maxArchiveBytes / (1024 * 1024)))),
    recentMinutes: String(Math.max(1, Math.round(policy.recentWindowMs / (60 * 1000))))
  };
}

function loadPopupExportPolicyForm(): PopupExportPolicyForm {
  if (typeof localStorage === "undefined") {
    return toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY);
  }

  try {
    const raw = localStorage.getItem(POPUP_EXPORT_POLICY_STORAGE_KEY);

    if (!raw) {
      return toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY);
    }

    const parsed = JSON.parse(raw) as Partial<PopupExportPolicyForm>;

    return {
      includeScreenshots:
        typeof parsed.includeScreenshots === "boolean"
          ? parsed.includeScreenshots
          : DEFAULT_EXPORT_POLICY.includeScreenshots,
      maxArchiveMb: normalizeStoredBoundedIntText(
        parsed.maxArchiveMb,
        Math.round(DEFAULT_EXPORT_POLICY.maxArchiveBytes / (1024 * 1024)),
        1,
        4096
      ),
      recentMinutes: normalizeStoredBoundedIntText(
        parsed.recentMinutes,
        Math.round(DEFAULT_EXPORT_POLICY.recentWindowMs / (60 * 1000)),
        1,
        43_200
      )
    };
  } catch {
    return toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY);
  }
}

function savePopupExportPolicyForm(policy: PopupExportPolicyForm): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(POPUP_EXPORT_POLICY_STORAGE_KEY, JSON.stringify(policy));
  } catch {
    // ignore storage write failures
  }
}

function writeExportPolicyFormToContainer(
  container: HTMLElement,
  form: PopupExportPolicyForm
): void {
  const includeScreenshots = container.querySelector<HTMLInputElement>(
    "#export-include-screenshots"
  );
  const maxArchiveMb = container.querySelector<HTMLInputElement>("#export-max-size-mb");
  const recentMinutes = container.querySelector<HTMLInputElement>("#export-recent-minutes");

  if (includeScreenshots) {
    includeScreenshots.checked = form.includeScreenshots;
  }

  if (maxArchiveMb) {
    maxArchiveMb.value = form.maxArchiveMb;
  }

  if (recentMinutes) {
    recentMinutes.value = form.recentMinutes;
  }
}

function readPopupExportPolicyFormFromContainer(container: HTMLElement): PopupExportPolicyForm {
  return {
    includeScreenshots:
      container.querySelector<HTMLInputElement>("#export-include-screenshots")?.checked ??
      state.exportPolicyForm.includeScreenshots,
    maxArchiveMb:
      container.querySelector<HTMLInputElement>("#export-max-size-mb")?.value ??
      state.exportPolicyForm.maxArchiveMb,
    recentMinutes:
      container.querySelector<HTMLInputElement>("#export-recent-minutes")?.value ??
      state.exportPolicyForm.recentMinutes
  };
}

function toExportPolicy(form: PopupExportPolicyForm): ExportPolicy {
  const defaultPolicyForm = toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY);
  const maxArchiveMb = normalizeBoundedInt(
    Number(form.maxArchiveMb),
    Number(defaultPolicyForm.maxArchiveMb),
    1,
    4096
  );
  const recentMinutes = normalizeBoundedInt(
    Number(form.recentMinutes),
    Number(defaultPolicyForm.recentMinutes),
    1,
    43_200
  );

  return {
    includeScreenshots: form.includeScreenshots,
    maxArchiveBytes: maxArchiveMb * 1024 * 1024,
    recentWindowMs: recentMinutes * 60 * 1000
  };
}

function normalizeStoredBoundedIntText(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return "";
    }

    const numeric = Number(trimmed);

    if (Number.isFinite(numeric) && numeric > 0) {
      return String(Math.max(min, Math.min(max, Math.round(numeric))));
    }
  }

  return String(normalizeBoundedInt(value, fallback, min, max));
}

function normalizeBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function describeRingBufferUsage(
  session: SessionListItem,
  now: number
): {
  usedMinutes: number;
  capacityMinutes: number;
  ratioPercent: number;
  windowLabel: string;
} {
  const capacityMinutes = Math.max(
    1,
    Number.isFinite(session.ringBufferMinutes) ? Number(session.ringBufferMinutes) : 10
  );
  const endedAt = typeof session.stoppedAt === "number" ? session.stoppedAt : now;
  const elapsedMinutes = Math.max(0, (endedAt - session.startedAt) / 60_000);
  const usedMinutes = Math.min(capacityMinutes, elapsedMinutes);
  const ratioPercent = Math.max(0, Math.min(100, (usedMinutes / capacityMinutes) * 100));
  const windowLabel = `${usedMinutes.toFixed(1)}m / ${capacityMinutes.toFixed(1)}m`;

  return {
    usedMinutes,
    capacityMinutes,
    ratioPercent,
    windowLabel
  };
}

function renderError(container: HTMLElement, error: unknown): void {
  const section = document.createElement("section");
  section.className = "card";
  section.append(createBrandLockup({ tight: true }));

  const message = document.createElement("p");
  message.textContent = String(error);
  section.append(message);

  container.replaceChildren(section);
}

function createBrandLockup({ tight = false }: { tight?: boolean } = {}): HTMLElement {
  const lockup = document.createElement("div");
  lockup.className = tight ? "wb-brand-lockup wb-brand-lockup--tight" : "wb-brand-lockup";

  const icon = document.createElement("img");
  icon.className = "wb-brand-lockup__icon";
  icon.src = "./icon/32.png";
  icon.alt = "";
  icon.width = 32;
  icon.height = 32;

  const copy = document.createElement("div");
  copy.className = "wb-brand-lockup__copy";

  const title = document.createElement("h1");
  title.className = "wb-popup__title";
  title.textContent = "WebBlackbox";

  const version = document.createElement("p");
  version.className = "wb-popup__version";
  version.textContent = `v${extensionVersion}`;

  copy.append(title, version);
  lockup.append(icon, copy);
  return lockup;
}

function createMetaLine(label: string, value: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "wb-popup__meta-line";

  const labelNode = document.createElement("span");
  labelNode.textContent = label;

  const valueNode = document.createElement("strong");
  valueNode.textContent = value;

  line.append(labelNode, valueNode);
  return line;
}

function createRingUsageSection(ringUsage: {
  usedMinutes: number;
  capacityMinutes: number;
  ratioPercent: number;
  windowLabel: string;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = "wb-popup__buffer";

  const label = document.createElement("p");
  label.className = "wb-popup__buffer-label";

  const labelText = document.createElement("span");
  labelText.textContent = "Ring buffer";

  const labelValue = document.createElement("strong");
  labelValue.textContent = ringUsage.windowLabel;

  label.append(labelText, labelValue);

  const track = document.createElement("div");
  track.className = "wb-popup__buffer-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(Math.round(ringUsage.capacityMinutes * 100)));
  track.setAttribute("aria-valuenow", String(Math.round(ringUsage.usedMinutes * 100)));
  track.setAttribute("aria-valuetext", ringUsage.windowLabel);

  const fill = document.createElement("span");
  fill.className = "wb-popup__buffer-fill";
  fill.style.width = `${Math.max(0, Math.min(100, ringUsage.ratioPercent)).toFixed(1)}%`;
  track.append(fill);

  section.append(label, track);
  return section;
}

function createActionButton(
  label: string,
  className: string,
  action: string,
  disabled = false
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = action;
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function createArchivePolicySection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "wb-popup__policy";

  const title = document.createElement("p");
  title.className = "wb-popup__policy-title";
  title.textContent = "Archive Policy";

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "wb-toggle";

  const includeScreenshots = document.createElement("input");
  includeScreenshots.id = "export-include-screenshots";
  includeScreenshots.type = "checkbox";

  const toggleText = document.createElement("span");
  toggleText.textContent = "Include screenshots in export";
  toggleLabel.append(includeScreenshots, toggleText);

  const sizeLabel = document.createElement("label");
  sizeLabel.className = "wb-field-label";
  sizeLabel.htmlFor = "export-max-size-mb";
  sizeLabel.textContent = "Max archive size (MB)";

  const sizeInput = document.createElement("input");
  sizeInput.id = "export-max-size-mb";
  sizeInput.type = "number";
  sizeInput.min = "1";
  sizeInput.max = "4096";
  sizeInput.step = "1";
  sizeInput.className = "wb-input";

  const recentLabel = document.createElement("label");
  recentLabel.className = "wb-field-label";
  recentLabel.htmlFor = "export-recent-minutes";
  recentLabel.textContent = "Recent window (minutes)";

  const recentInput = document.createElement("input");
  recentInput.id = "export-recent-minutes";
  recentInput.type = "number";
  recentInput.min = "1";
  recentInput.max = "43200";
  recentInput.step = "1";
  recentInput.className = "wb-input";

  section.append(title, toggleLabel, sizeLabel, sizeInput, recentLabel, recentInput);
  return section;
}
