import { DEFAULT_EXPORT_POLICY, type ExportPolicy } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.popup });

const root = document.getElementById("popup-root");
const POPUP_EXPORT_POLICY_STORAGE_KEY = "webblackbox.popup.export-policy";

type PopupExportPolicyForm = {
  includeScreenshots: boolean;
  maxArchiveMb: number;
  recentMinutes: number;
};

const state: {
  tabId: number | null;
  sessions: SessionListItem[];
  recording: { active: boolean; sid?: string; mode?: string };
  exportPolicyForm: PopupExportPolicyForm;
  exportStatus?: string;
} = {
  tabId: null,
  sessions: [],
  recording: { active: false },
  exportPolicyForm: toPopupExportPolicyForm(DEFAULT_EXPORT_POLICY),
  exportStatus: undefined
};

if (root) {
  bootstrap(root).catch((error) => {
    root.innerHTML = `<section class="card"><h1>WebBlackbox</h1><p>${String(error)}</p></section>`;
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

function render(container: HTMLElement): void {
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

  container.innerHTML = `
    <section class="card">
      <h1>WebBlackbox</h1>
      <p>Tab: ${state.tabId ?? "n/a"}</p>
      <p>Status: ${status}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button data-action="start-lite">Start Lite</button>
        <button data-action="start-full">Start Full</button>
        <button data-action="stop" ${activeSession ? "" : "disabled"}>Stop</button>
        <button data-action="export" ${exportSession ? "" : "disabled"}>Export</button>
      </div>
      <section style="margin-top:10px;padding:10px;border:1px solid rgba(0,0,0,0.12);border-radius:8px;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;opacity:0.9;">Archive Policy</p>
        <label style="display:flex;align-items:center;gap:8px;margin:0 0 8px;">
          <input id="export-include-screenshots" type="checkbox" ${
            state.exportPolicyForm.includeScreenshots ? "checked" : ""
          } />
          <span style="font-size:12px;">Include screenshots</span>
        </label>
        <label style="display:block;font-size:12px;margin:0 0 4px;">Max archive size (MB)</label>
        <input id="export-max-size-mb" type="number" min="1" max="4096" step="1" value="${
          state.exportPolicyForm.maxArchiveMb
        }" style="width:100%;" />
        <label style="display:block;font-size:12px;margin:8px 0 4px;">Recent window (minutes)</label>
        <input id="export-recent-minutes" type="number" min="1" max="43200" step="1" value="${
          state.exportPolicyForm.recentMinutes
        }" style="width:100%;" />
      </section>
      <p style="margin-top:8px;font-size:12px;opacity:0.85;min-height:1.2em;">${state.exportStatus ?? ""}</p>
      <p style="margin-top:10px;font-size:12px;opacity:0.75;">Marker: Ctrl/Cmd + Shift + M</p>
    </section>
  `;

  bindActions(container, activeSession, exportSession);
}

function bindActions(
  container: HTMLElement,
  activeSession?: SessionListItem,
  exportSession?: SessionListItem
): void {
  container.querySelector("[data-action='start-lite']")?.addEventListener("click", async () => {
    const resolvedTabId = await getActiveTabId();
    const tabId = typeof resolvedTabId === "number" ? resolvedTabId : state.tabId;

    if (typeof tabId !== "number") {
      return;
    }

    state.tabId = tabId;
    port?.postMessage({
      kind: "ui.start",
      tabId,
      mode: "lite"
    });
  });

  container.querySelector("[data-action='start-full']")?.addEventListener("click", async () => {
    const resolvedTabId = await getActiveTabId();
    const tabId = typeof resolvedTabId === "number" ? resolvedTabId : state.tabId;

    if (typeof tabId !== "number") {
      return;
    }

    state.tabId = tabId;
    port?.postMessage({
      kind: "ui.start",
      tabId,
      mode: "full"
    });
  });

  container.querySelector("[data-action='stop']")?.addEventListener("click", () => {
    if (!activeSession) {
      return;
    }

    port?.postMessage({
      kind: "ui.stop",
      tabId: activeSession.tabId
    });
  });

  container.querySelector("[data-action='export']")?.addEventListener("click", () => {
    if (!exportSession) {
      return;
    }

    const passphrase = prompt(
      "Optional export passphrase (AES-GCM). Leave empty for unencrypted export."
    );

    if (passphrase === null) {
      return;
    }

    const policy = readExportPolicyFromForm(container);

    port?.postMessage({
      kind: "ui.export",
      sid: exportSession.sid,
      passphrase: passphrase.trim() || undefined,
      policy
    });
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

function readExportPolicyFromForm(container: HTMLElement): ExportPolicy {
  const includeScreenshots =
    container.querySelector<HTMLInputElement>("#export-include-screenshots")?.checked ??
    state.exportPolicyForm.includeScreenshots;
  const maxArchiveMb = normalizeBoundedInt(
    Number(container.querySelector<HTMLInputElement>("#export-max-size-mb")?.value),
    state.exportPolicyForm.maxArchiveMb,
    1,
    4096
  );
  const recentMinutes = normalizeBoundedInt(
    Number(container.querySelector<HTMLInputElement>("#export-recent-minutes")?.value),
    state.exportPolicyForm.recentMinutes,
    1,
    43_200
  );

  state.exportPolicyForm = {
    includeScreenshots,
    maxArchiveMb,
    recentMinutes
  };
  savePopupExportPolicyForm(state.exportPolicyForm);

  return {
    includeScreenshots,
    maxArchiveBytes: maxArchiveMb * 1024 * 1024,
    recentWindowMs: recentMinutes * 60 * 1000
  };
}

function toPopupExportPolicyForm(policy: ExportPolicy): PopupExportPolicyForm {
  return {
    includeScreenshots: policy.includeScreenshots,
    maxArchiveMb: Math.max(1, Math.round(policy.maxArchiveBytes / (1024 * 1024))),
    recentMinutes: Math.max(1, Math.round(policy.recentWindowMs / (60 * 1000)))
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
      maxArchiveMb: normalizeBoundedInt(
        parsed.maxArchiveMb,
        Math.round(DEFAULT_EXPORT_POLICY.maxArchiveBytes / (1024 * 1024)),
        1,
        4096
      ),
      recentMinutes: normalizeBoundedInt(
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

function normalizeBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
