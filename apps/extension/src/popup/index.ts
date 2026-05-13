import {
  DEFAULT_EXPORT_POLICY,
  type CaptureMode,
  type ExportPolicy,
  type FreezeReason
} from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { createExtensionI18n } from "../shared/i18n.js";
import {
  PORT_NAMES,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.popup });
const extensionVersion = chromeApi?.runtime?.getManifest?.().version ?? "dev";
const i18n = createExtensionI18n({
  pageTitleKey: "pageTitlePopup"
});
const {
  t,
  formatMode,
  formatFreezeReason,
  formatRelativeTime: formatLocaleRelativeTime,
  formatByteSize: formatLocaleByteSize
} = i18n;

const root = document.getElementById("popup-root");
const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";
const START_PENDING_TIMEOUT_MS = 45_000;
const EXPORT_ACK_TIMEOUT_MS = 120_000;

type PopupExportPolicyForm = {
  includeScreenshots: boolean;
  alertSensitiveFindings: boolean;
  maxArchiveMb: string;
  recentMinutes: string;
};

const state: {
  tabId: number | null;
  sessions: SessionListItem[];
  recording: { active: boolean; sid?: string; mode?: string };
  pendingStart?: { tabId: number; mode: CaptureMode; requestedAt: number };
  pendingExportSid?: string;
  exportPrivacyWarning?: ExportPrivacyWarning;
  exportPolicyForm: PopupExportPolicyForm;
  exportStatus?: string;
  exportStatusIsError?: boolean;
  lastPrivacyAlertKey?: string;
  lastFreeze?: { sid: string; reason: FreezeReason; at: number };
} = {
  tabId: null,
  sessions: [],
  recording: { active: false },
  pendingStart: undefined,
  pendingExportSid: undefined,
  exportPrivacyWarning: undefined,
  exportPolicyForm: toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY),
  exportStatus: undefined,
  exportStatusIsError: false,
  lastPrivacyAlertKey: undefined,
  lastFreeze: undefined
};

let pendingStartTimeout: ReturnType<typeof setTimeout> | null = null;

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

async function sendUiMessage(message: ExtensionInboundMessage): Promise<unknown> {
  if (typeof chromeApi?.runtime?.sendMessage === "function") {
    const response = await chromeApi.runtime.sendMessage(message);

    if (isRejectedRuntimeResponse(response)) {
      throw new Error(response.error);
    }

    return response;
  }

  postUiMessage(message);
  return undefined;
}

async function withExportAckTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(t("popupExportTimedOut")));
        }, EXPORT_ACK_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function render(container: HTMLElement): void {
  const now = Date.now();
  const pendingStart = getFreshPendingStart(now);
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
  const pendingOnCurrentTab = pendingStart && pendingStart.tabId === state.tabId;
  const exportDisabled = !exportSession || Boolean(state.pendingExportSid);
  const status = activeSession
    ? activeOnCurrentTab
      ? t("popupStatusRecordingCurrent", {
          mode: formatMode(activeSession.mode)
        })
      : t("popupStatusRecordingOtherTab", {
          mode: formatMode(activeSession.mode),
          tabId: activeSession.tabId
        })
    : exportSession
      ? exportSession.tabId === state.tabId
        ? t("popupStatusIdleLastCurrent", {
            mode: formatMode(exportSession.mode)
          })
        : t("popupStatusIdleLastOtherTab", {
            mode: formatMode(exportSession.mode),
            tabId: exportSession.tabId
          })
      : t("popupStatusIdle");
  const summarySession = activeSession ?? exportSession;
  const budgetAlerts = summarySession?.budgetAlertCount ?? 0;
  const ringUsage = summarySession ? describeRingBufferUsage(summarySession, now) : null;
  const captureSummary = summarySession
    ? t("popupCaptureSummary", {
        events: summarySession.eventCount ?? 0,
        errors: summarySession.errorCount ?? 0,
        budgetAlerts,
        size: formatLocaleByteSize(summarySession.sizeBytes ?? 0)
      })
    : t("popupNoCapturedEvents");
  const recentFreeze =
    state.lastFreeze && now - state.lastFreeze.at <= 10 * 60 * 1000 ? state.lastFreeze : null;
  const incidentText = recentFreeze
    ? t("popupRecentFreeze", {
        reason: formatFreezeReason(recentFreeze.reason),
        timeAgo: formatLocaleRelativeTime(recentFreeze.at, now)
      })
    : t("popupIncidentNone");
  const badgeText = recentFreeze
    ? t("popupBadgeAlert")
    : activeSession
      ? t("popupBadgeRecording")
      : t("popupBadgeIdle");
  const badgeClass = recentFreeze ? "wb-popup__badge wb-popup__badge--alert" : "wb-popup__badge";
  const exportStatusClass = state.exportStatusIsError
    ? "wb-popup__status wb-popup__status--error"
    : "wb-popup__status";
  const startDisabled = Boolean(activeOnCurrentTab || pendingOnCurrentTab);
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
    createMetaLine(t("popupLabelTab"), String(state.tabId ?? "n/a")),
    createMetaLine(t("popupLabelStatus"), status),
    createMetaLine(t("popupLabelCapture"), captureSummary),
    createMetaLine(t("popupLabelIncident"), incidentText)
  );
  section.append(meta);

  if (ringUsage) {
    section.append(createRingUsageSection(ringUsage));
  }

  const actions = document.createElement("div");
  actions.className = "wb-popup__actions";
  actions.append(
    createActionButton(t("popupStartLite"), "wb-btn wb-btn--brand", "start-lite", startDisabled),
    createActionButton(
      t("popupStartFull"),
      "wb-btn wb-btn--brand-alt",
      "start-full",
      startDisabled
    ),
    createActionButton(t("popupStop"), "wb-btn wb-btn--muted", "stop", !activeSession),
    createActionButton(t("popupExport"), "wb-btn wb-btn--accent", "export", exportDisabled)
  );
  section.append(actions);

  const nav = document.createElement("div");
  nav.className = "wb-popup__nav";
  nav.append(
    createActionButton(t("popupSessions"), "wb-btn wb-btn--surface", "open-sessions"),
    createActionButton(t("popupOptions"), "wb-btn wb-btn--surface", "open-options")
  );
  section.append(nav);

  section.append(createArchivePolicySection());

  const exportStatus = document.createElement("p");
  exportStatus.className = exportStatusClass;
  exportStatus.textContent = state.exportStatus ?? "";
  section.append(exportStatus);

  if (state.exportPrivacyWarning) {
    section.append(createPrivacyWarningSection(state.exportPrivacyWarning));
  }

  const hint = document.createElement("p");
  hint.className = "wb-popup__hint";
  hint.textContent = t("popupMarkerHint");
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
    await startRecordingFromPopup(container, tabId, "lite");
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
    await startRecordingFromPopup(container, tabId, "full");
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

    await exportSessionFromPopup(container, exportSession.sid, passphrase, policy);
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
  const persistAlertDraft = (): void => {
    persistDraft();

    if (!state.exportPolicyForm.alertSensitiveFindings) {
      state.exportPrivacyWarning = undefined;
      state.lastPrivacyAlertKey = undefined;
      render(container);
    }
  };

  container
    .querySelector<HTMLInputElement>("#export-include-screenshots")
    ?.addEventListener("change", persistDraft);
  container
    .querySelector<HTMLInputElement>("#export-alert-sensitive-findings")
    ?.addEventListener("change", persistAlertDraft);
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
    title.textContent = t("popupExportPassphraseTitle");

    const body = document.createElement("p");
    body.className = "wb-confirm-body";
    body.textContent = t("popupExportPassphraseBody");

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.htmlFor = "wb-passphrase-input";
    label.textContent = t("popupPassphraseLabel");

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
    cancelButton.textContent = t("popupCancel");

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "wb-btn wb-btn--accent";
    submitButton.dataset.passphraseSubmit = "";
    submitButton.textContent = t("popupExport");

    actions.append(cancelButton, submitButton);
    form.append(title, body, label, input, actions);
    overlay.append(form);

    let finished = false;

    const finish = (value: string | null): void => {
      if (finished) {
        return;
      }

      finished = true;
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    };

    const submitPassphrase = (): void => {
      const passphrase = input.value;

      finish(passphrase.trim().length > 0 ? passphrase : "");
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };

    cancelButton?.addEventListener("click", () => finish(null));
    input.addEventListener("input", () => {
      input.setCustomValidity("");
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitPassphrase();
      }
    });
    submitButton.addEventListener("click", submitPassphrase);
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitPassphrase();
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

async function startRecordingFromPopup(
  container: HTMLElement,
  tabId: number,
  mode: CaptureMode
): Promise<void> {
  setPendingStart(container, tabId, mode);

  try {
    await sendUiMessage({
      kind: "ui.start",
      tabId,
      mode
    });
  } catch (error) {
    clearPendingStart();
    state.exportStatusIsError = true;
    state.exportStatus = t("popupStartFailed", {
      error: error instanceof Error ? error.message : String(error)
    });
    render(container);
  }
}

function setPendingStart(container: HTMLElement, tabId: number, mode: CaptureMode): void {
  clearPendingStart();
  state.pendingStart = {
    tabId,
    mode,
    requestedAt: Date.now()
  };
  pendingStartTimeout = setTimeout(() => {
    if (!state.pendingStart) {
      return;
    }

    clearPendingStart();
    render(container);
  }, START_PENDING_TIMEOUT_MS);
  render(container);
}

function clearPendingStart(): void {
  state.pendingStart = undefined;

  if (pendingStartTimeout !== null) {
    clearTimeout(pendingStartTimeout);
    pendingStartTimeout = null;
  }
}

function getFreshPendingStart(now: number): typeof state.pendingStart {
  if (!state.pendingStart) {
    return undefined;
  }

  if (now - state.pendingStart.requestedAt > START_PENDING_TIMEOUT_MS) {
    clearPendingStart();
    return undefined;
  }

  return state.pendingStart;
}

function clearPendingStartIfActivated(sessions: SessionListItem[]): void {
  const pendingStart = state.pendingStart;

  if (!pendingStart) {
    return;
  }

  const activated = sessions.some(
    (session) =>
      session.active && session.tabId === pendingStart.tabId && session.mode === pendingStart.mode
  );

  if (activated) {
    clearPendingStart();
  }
}

function isRejectedRuntimeResponse(value: unknown): value is { ok: false; error: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

async function exportSessionFromPopup(
  container: HTMLElement,
  sid: string,
  passphrase: string,
  policy: ExportPolicy
): Promise<void> {
  state.pendingExportSid = sid;
  state.exportPrivacyWarning = undefined;
  state.lastPrivacyAlertKey = undefined;
  state.exportStatusIsError = false;
  state.exportStatus = t("popupExporting");
  render(container);

  try {
    const response = await withExportAckTimeout(
      sendUiMessage({
        kind: "ui.export",
        sid,
        ...(hasDialogPassphrase(passphrase) ? { passphrase } : {}),
        saveAs: false,
        policy
      })
    );
    state.pendingExportSid = undefined;

    if (isSuccessfulExportResponse(response)) {
      state.exportStatusIsError = false;
      state.exportStatus = t("popupExported", {
        name: response.fileName ?? sid
      });
      applyExportPrivacyWarning(response.privacyWarning);
      render(container);
      return;
    }

    render(container);
  } catch (error) {
    state.pendingExportSid = undefined;
    state.exportStatusIsError = true;
    state.exportStatus = t("popupExportFailed", {
      error: error instanceof Error ? error.message : String(error)
    });
    render(container);
  }
}

function hasDialogPassphrase(passphrase: string): boolean {
  return passphrase.length > 0;
}

function isSuccessfulExportResponse(value: unknown): value is {
  ok: true;
  fileName?: string;
  privacyWarning?: ExportPrivacyWarning;
} {
  return value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

function applyExportPrivacyWarning(warning: ExportPrivacyWarning | undefined): void {
  if (!warning || !state.exportPolicyForm.alertSensitiveFindings) {
    state.exportPrivacyWarning = undefined;
    return;
  }

  state.exportPrivacyWarning = warning;
  const alertKey = `${warning.findingCount}:${warning.summary}`;

  if (state.lastPrivacyAlertKey === alertKey) {
    return;
  }

  state.lastPrivacyAlertKey = alertKey;
  window.alert(formatExportPrivacyWarning(warning));
}

function formatExportPrivacyWarning(warning: ExportPrivacyWarning): string {
  return t("popupExportPrivacyWarningAlert", {
    count: warning.findingCount,
    summary: warning.summary || t("unknownError")
  });
}

function applyMessage(message: ExtensionOutboundMessage): void {
  if (message.kind === "sw.session-list") {
    state.sessions = message.sessions;
    clearPendingStartIfActivated(message.sessions);
    return;
  }

  if (message.kind === "sw.recording-status") {
    state.recording = {
      active: message.active,
      sid: message.sid,
      mode: message.mode
    };

    if (message.active && state.pendingStart && message.mode === state.pendingStart.mode) {
      clearPendingStart();
    }

    return;
  }

  if (message.kind === "sw.export-status") {
    if (state.pendingExportSid === message.sid) {
      state.pendingExportSid = undefined;
    }

    state.exportStatusIsError = !message.ok;
    state.exportPrivacyWarning = undefined;
    state.exportStatus = message.ok
      ? t("popupExported", {
          name: message.fileName ?? message.sid
        })
      : t("popupExportFailed", {
          error: message.error ?? t("unknownError")
        });

    if (message.ok) {
      applyExportPrivacyWarning(message.privacyWarning);
    }

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

function createPrivacyWarningSection(warning: ExportPrivacyWarning): HTMLElement {
  const section = document.createElement("section");
  section.className = "wb-popup__privacy-warning";
  section.setAttribute("role", "alert");

  const title = document.createElement("strong");
  title.textContent = t("popupExportPrivacyWarningTitle");

  const body = document.createElement("p");
  body.textContent = formatExportPrivacyWarning(warning);

  section.append(title, body);
  return section;
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

function readExportPolicyFromForm(container: HTMLElement): ExportPolicy {
  state.exportPolicyForm = readPopupExportPolicyFormFromContainer(container);
  savePopupExportPolicyForm(state.exportPolicyForm);

  return toExportPolicy(state.exportPolicyForm);
}

function toPopupExportPolicyForm(policy: ExportPolicy): PopupExportPolicyForm {
  return {
    includeScreenshots: policy.includeScreenshots,
    alertSensitiveFindings: true,
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
      alertSensitiveFindings:
        typeof parsed.alertSensitiveFindings === "boolean" ? parsed.alertSensitiveFindings : true,
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
  const alertSensitiveFindings = container.querySelector<HTMLInputElement>(
    "#export-alert-sensitive-findings"
  );
  const maxArchiveMb = container.querySelector<HTMLInputElement>("#export-max-size-mb");
  const recentMinutes = container.querySelector<HTMLInputElement>("#export-recent-minutes");

  if (includeScreenshots) {
    includeScreenshots.checked = form.includeScreenshots;
  }

  if (alertSensitiveFindings) {
    alertSensitiveFindings.checked = form.alertSensitiveFindings;
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
    alertSensitiveFindings:
      container.querySelector<HTMLInputElement>("#export-alert-sensitive-findings")?.checked ??
      state.exportPolicyForm.alertSensitiveFindings,
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
  windowLabel: string;
} {
  const capacityMinutes = Math.max(
    1,
    Number.isFinite(session.ringBufferMinutes) ? Number(session.ringBufferMinutes) : 10
  );
  const endedAt = typeof session.stoppedAt === "number" ? session.stoppedAt : now;
  const elapsedMinutes = Math.max(0, (endedAt - session.startedAt) / 60_000);
  const usedMinutes = Math.min(capacityMinutes, elapsedMinutes);
  const windowLabel = `${usedMinutes.toFixed(1)}m / ${capacityMinutes.toFixed(1)}m`;

  return {
    usedMinutes,
    capacityMinutes,
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
  windowLabel: string;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = "wb-popup__buffer";

  const label = document.createElement("p");
  label.className = "wb-popup__buffer-label";

  const labelText = document.createElement("span");
  labelText.textContent = t("popupRingBuffer");

  const labelValue = document.createElement("strong");
  labelValue.textContent = ringUsage.windowLabel;

  label.append(labelText, labelValue);

  const meter = document.createElement("progress");
  meter.className = "wb-popup__buffer-meter";
  meter.max = Math.round(ringUsage.capacityMinutes * 100);
  meter.value = Math.round(ringUsage.usedMinutes * 100);
  meter.setAttribute("aria-valuetext", ringUsage.windowLabel);

  section.append(label, meter);
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
  title.textContent = t("popupArchivePolicyTitle");

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "wb-toggle";

  const includeScreenshots = document.createElement("input");
  includeScreenshots.id = "export-include-screenshots";
  includeScreenshots.type = "checkbox";

  const toggleText = document.createElement("span");
  toggleText.textContent = t("popupIncludeScreenshots");
  toggleLabel.append(includeScreenshots, toggleText);

  const sensitiveToggleLabel = document.createElement("label");
  sensitiveToggleLabel.className = "wb-toggle";

  const alertSensitiveFindings = document.createElement("input");
  alertSensitiveFindings.id = "export-alert-sensitive-findings";
  alertSensitiveFindings.type = "checkbox";

  const sensitiveToggleText = document.createElement("span");
  sensitiveToggleText.textContent = t("popupAlertSensitiveFindings");
  sensitiveToggleLabel.append(alertSensitiveFindings, sensitiveToggleText);

  const sizeLabel = document.createElement("label");
  sizeLabel.className = "wb-field-label";
  sizeLabel.htmlFor = "export-max-size-mb";
  sizeLabel.textContent = t("popupMaxArchiveSizeMb");

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
  recentLabel.textContent = t("popupRecentWindowMinutes");

  const recentInput = document.createElement("input");
  recentInput.id = "export-recent-minutes";
  recentInput.type = "number";
  recentInput.min = "1";
  recentInput.max = "43200";
  recentInput.step = "1";
  recentInput.className = "wb-input";

  section.append(
    title,
    toggleLabel,
    sensitiveToggleLabel,
    sizeLabel,
    sizeInput,
    recentLabel,
    recentInput
  );
  return section;
}
