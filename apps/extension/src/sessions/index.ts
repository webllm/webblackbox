import { getChromeApi } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.sessions });
const root = document.getElementById("sessions-root");

let sessions: SessionListItem[] = [];

if (root) {
  render(root);

  port?.onMessage.addListener((message) => {
    const typed = message as ExtensionOutboundMessage;

    if (typed.kind === "sw.session-list") {
      sessions = typed.sessions;
      render(root);
    }
  });
}

function render(container: HTMLElement): void {
  const sessionRows =
    sessions.length === 0
      ? '<tr><td colspan="8">No sessions.</td></tr>'
      : sessions
          .map((session) => {
            return `
              <tr>
                <td>${session.sid}</td>
                <td>${session.tabId}</td>
                <td>${session.mode}</td>
                <td>${new Date(session.startedAt).toLocaleTimeString()}</td>
                <td>${session.active ? "Active" : "Stopped"}</td>
                <td><button data-export="${session.sid}">Export</button></td>
                <td><button data-stop="${session.tabId}" ${
                  session.active ? "" : "disabled"
                }>Stop</button></td>
                <td><button data-delete="${session.sid}">Delete</button></td>
              </tr>
            `;
          })
          .join("");

  container.innerHTML = `
    <section class="card" style="max-width:900px;">
      <h1>Sessions</h1>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th align="left">Session ID</th>
            <th align="left">Tab</th>
            <th align="left">Mode</th>
            <th align="left">Started</th>
            <th align="left">Status</th>
            <th align="left">Export</th>
            <th align="left">Stop</th>
            <th align="left">Delete</th>
          </tr>
        </thead>
        <tbody>${sessionRows}</tbody>
      </table>
    </section>
  `;

  bindActions(container);
}

function bindActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("button[data-export]").forEach((button) => {
    button.addEventListener("click", () => {
      const sid = button.getAttribute("data-export");

      if (!sid) {
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
        sid,
        passphrase: passphrase.trim() || undefined
      });
    });
  });

  container.querySelectorAll<HTMLButtonElement>("button[data-stop]").forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = Number(button.getAttribute("data-stop"));

      if (!Number.isFinite(tabId)) {
        return;
      }

      port?.postMessage({
        kind: "ui.stop",
        tabId
      });
    });
  });

  container.querySelectorAll<HTMLButtonElement>("button[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const sid = button.getAttribute("data-delete");

      if (!sid) {
        return;
      }

      const confirmed = confirm(`Delete session ${sid}? This removes local archive data.`);

      if (!confirmed) {
        return;
      }

      port?.postMessage({
        kind: "ui.delete",
        sid
      });
    });
  });
}
