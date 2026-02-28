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
  const ordered = [...sessions].sort((left, right) => {
    const activeDiff = Number(right.active) - Number(left.active);
    if (activeDiff !== 0) {
      return activeDiff;
    }
    return right.startedAt - left.startedAt;
  });
  const now = Date.now();
  const sessionRows =
    ordered.length === 0
      ? '<p class="wb-sessions-empty">No sessions captured yet.</p>'
      : ordered.map((session) => renderSessionCard(session, now)).join("");
  const activeCount = ordered.filter((session) => session.active).length;

  container.innerHTML = `
    <section class="card wb-sessions-card">
      <header class="wb-sessions-header">
        <h1 class="wb-sessions-title">Sessions</h1>
        <span class="wb-sessions-count">${ordered.length} total · ${activeCount} active</span>
      </header>
      <p class="wb-sessions-subtitle">Recent recordings with source context and quick actions.</p>
      <div class="wb-sessions-list">${sessionRows}</div>
    </section>
  `;

  bindActions(container);
}

function renderSessionCard(session: SessionListItem, now: number): string {
  const page = describeSessionPage(session);
  const startedAt = formatAbsoluteTime(session.startedAt);
  const startedRelative = formatRelativeTime(session.startedAt, now);
  const endedAt =
    typeof session.stoppedAt === "number" ? formatAbsoluteTime(session.stoppedAt) : null;
  const elapsed = formatDuration(session.startedAt, session.stoppedAt ?? now);
  const eventCount = session.eventCount ?? 0;
  const errorCount = session.errorCount ?? 0;
  const sidShort = shortenSessionId(session.sid);
  const statusLabel = session.active ? "LIVE" : "Stopped";
  const statusClass = session.active ? "wb-session-status--live" : "wb-session-status--stopped";
  const stopDisabledAttr = session.active ? "" : "disabled";

  return `
    <article class="wb-session-card">
      <header class="wb-session-card__header">
        <div class="wb-session-card__title-wrap">
          <h2 class="wb-session-card__title" title="${escapeHtml(page.secondary)}">${escapeHtml(page.primary)}</h2>
          <p class="wb-session-card__url mono" title="${escapeHtml(page.secondary)}">${escapeHtml(page.secondary)}</p>
        </div>
        <span class="wb-session-status ${statusClass}">${statusLabel}</span>
      </header>
      <div class="wb-session-card__meta">
        <span class="wb-chip">mode ${escapeHtml(session.mode.toUpperCase())}</span>
        <span class="wb-chip">tab ${session.tabId}</span>
        <span class="wb-chip" title="${escapeHtml(startedAt)}">started ${escapeHtml(startedRelative)}</span>
        <span class="wb-chip">events ${eventCount}</span>
        <span class="wb-chip">errors ${errorCount}</span>
        <span class="wb-chip">duration ${escapeHtml(elapsed)}</span>
        ${endedAt ? `<span class="wb-chip" title="${escapeHtml(endedAt)}">ended</span>` : ""}
      </div>
      <p class="wb-session-card__sid mono" title="${escapeHtml(session.sid)}">sid ${escapeHtml(sidShort)}</p>
      <div class="wb-session-card__actions">
        <button class="wb-btn wb-btn--brand" data-export="${escapeHtml(session.sid)}">Export</button>
        <button class="wb-btn wb-btn--muted" data-stop="${session.tabId}" ${stopDisabledAttr}>Stop</button>
        <button class="wb-btn wb-btn--muted" data-delete="${escapeHtml(session.sid)}">Delete</button>
      </div>
    </article>
  `;
}

function describeSessionPage(session: SessionListItem): { primary: string; secondary: string } {
  const title = typeof session.title === "string" ? session.title.trim() : "";
  const rawUrl =
    typeof session.url === "string" && session.url.trim().length > 0 ? session.url : "";

  if (rawUrl.length === 0) {
    return {
      primary: title || `Tab ${session.tabId}`,
      secondary: `tab:${session.tabId}`
    };
  }

  try {
    const parsed = new URL(rawUrl);
    const compactPath = parsed.pathname.length > 1 ? parsed.pathname : "/";
    const summary = `${parsed.host}${compactPath}`;
    return {
      primary: title || summary,
      secondary: rawUrl
    };
  } catch {
    return {
      primary: title || rawUrl,
      secondary: rawUrl
    };
  }
}

function shortenSessionId(sid: string): string {
  if (sid.length <= 18) {
    return sid;
  }

  return `${sid.slice(0, 9)}...${sid.slice(-6)}`;
}

function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
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

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("button[data-export]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sid = button.getAttribute("data-export");

      if (!sid) {
        return;
      }

      const passphrase = await openPassphraseDialog(sid);

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
    button.addEventListener("click", async () => {
      const sid = button.getAttribute("data-delete");

      if (!sid) {
        return;
      }

      const confirmed = await openConfirmDialog(
        `Delete session ${sid}? This removes local archive data.`
      );

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

function openPassphraseDialog(sid: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "wb-confirm-overlay";
    overlay.innerHTML = `
      <form class="wb-confirm-card wb-prompt-card" aria-labelledby="wb-passphrase-title">
        <h2 id="wb-passphrase-title" class="wb-confirm-title">Export Session</h2>
        <p class="wb-confirm-body mono">${escapeHtml(shortenSessionId(sid))}</p>
        <p class="wb-confirm-body">Optional AES-GCM passphrase. Leave blank for unencrypted export.</p>
        <label class="wb-field-label" for="wb-passphrase-input">Passphrase</label>
        <input id="wb-passphrase-input" type="password" class="wb-input wb-prompt-field" autocomplete="off" />
        <div class="wb-confirm-actions">
          <button type="button" class="wb-btn wb-btn--muted" data-passphrase-cancel>Cancel</button>
          <button type="submit" class="wb-btn wb-btn--accent">Export</button>
        </div>
      </form>
    `;

    const form = overlay.querySelector<HTMLFormElement>("form");
    const input = overlay.querySelector<HTMLInputElement>("#wb-passphrase-input");
    const cancelButton = overlay.querySelector<HTMLButtonElement>("button[data-passphrase-cancel]");

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

function openConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "wb-confirm-overlay";
    overlay.innerHTML = `
      <section class="wb-confirm-card" role="dialog" aria-modal="true" aria-labelledby="wb-confirm-title">
        <h2 id="wb-confirm-title" class="wb-confirm-title">Confirm Delete</h2>
        <p class="wb-confirm-body">${escapeHtml(message)}</p>
        <div class="wb-confirm-actions">
          <button type="button" class="wb-btn wb-btn--muted" data-confirm-cancel>Cancel</button>
          <button type="button" class="wb-btn wb-btn--brand" data-confirm-accept>Delete</button>
        </div>
      </section>
    `;

    const cancelButton = overlay.querySelector<HTMLButtonElement>("button[data-confirm-cancel]");
    const acceptButton = overlay.querySelector<HTMLButtonElement>("button[data-confirm-accept]");

    const finish = (accepted: boolean): void => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(accepted);
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    cancelButton?.addEventListener("click", () => finish(false));
    acceptButton?.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });

    document.addEventListener("keydown", onKeydown);
    document.body.append(overlay);
    cancelButton?.focus();
  });
}
