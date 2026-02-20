import { getChromeApi } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.popup });

const root = document.getElementById("popup-root");

const state: {
  tabId: number | null;
  sessions: SessionListItem[];
  recording: { active: boolean; sid?: string; mode?: string };
  exportStatus?: string;
} = {
  tabId: null,
  sessions: [],
  recording: { active: false },
  exportStatus: undefined
};

if (root) {
  bootstrap(root).catch((error) => {
    root.innerHTML = `<section class="card"><h1>WebBlackbox</h1><p>${String(error)}</p></section>`;
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  const tabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  state.tabId = typeof tabs[0]?.id === "number" ? tabs[0].id : null;

  port?.onMessage.addListener((message) => {
    applyMessage(message as ExtensionOutboundMessage);
    render(container);
  });

  render(container);
}

function render(container: HTMLElement): void {
  const tabSessions = state.sessions
    .filter((item) => item.tabId === state.tabId)
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);

      if (activeDiff !== 0) {
        return activeDiff;
      }

      return right.startedAt - left.startedAt;
    });
  const activeSession = tabSessions.find((item) => item.active);
  const exportSession = activeSession ?? tabSessions[0];
  const status = activeSession
    ? `Recording (${activeSession.mode})`
    : exportSession
      ? `Idle (Last ${exportSession.mode})`
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
  container.querySelector("[data-action='start-lite']")?.addEventListener("click", () => {
    if (typeof state.tabId !== "number") {
      return;
    }

    port?.postMessage({
      kind: "ui.start",
      tabId: state.tabId,
      mode: "lite"
    });
  });

  container.querySelector("[data-action='start-full']")?.addEventListener("click", () => {
    if (typeof state.tabId !== "number") {
      return;
    }

    port?.postMessage({
      kind: "ui.start",
      tabId: state.tabId,
      mode: "full"
    });
  });

  container.querySelector("[data-action='stop']")?.addEventListener("click", () => {
    if (!activeSession || typeof state.tabId !== "number") {
      return;
    }

    port?.postMessage({
      kind: "ui.stop",
      tabId: state.tabId
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

    port?.postMessage({
      kind: "ui.export",
      sid: exportSession.sid,
      passphrase: passphrase.trim() || undefined
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
