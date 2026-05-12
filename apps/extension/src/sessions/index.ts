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
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.sessions });
const i18n = createExtensionI18n({
  pageTitleKey: "pageTitleSessions"
});
const { locale, t, formatMode, formatRelativeTime, formatDuration, formatByteSize } = i18n;
const root = document.getElementById("sessions-root");

let sessions: SessionListItem[] = [];

if (root) {
  render(root);

  port?.onMessage.addListener((message) => {
    const typed = message as ExtensionOutboundMessage;

    if (typed.kind === "sw.session-list") {
      sessions = typed.sessions;
      render(root);
      return;
    }

    if (typed.kind === "sw.export-status" && typed.ok && typed.privacyWarning) {
      window.alert(formatExportPrivacyWarning(typed.privacyWarning));
    }
  });
}

function postUiMessage(message: ExtensionInboundMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    void 0;
  }
}

function formatExportPrivacyWarning(warning: ExportPrivacyWarning): string {
  return t("popupExportPrivacyWarningAlert", {
    count: warning.findingCount,
    summary: warning.summary || t("unknownError")
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
  const activeCount = ordered.filter((session) => session.active).length;

  const section = document.createElement("section");
  section.className = "card wb-sessions-card";

  const header = document.createElement("header");
  header.className = "wb-sessions-header";
  header.append(createBrandLockup());

  const count = document.createElement("span");
  count.className = "wb-sessions-count";
  count.textContent = t("sessionsCountSummary", {
    total: ordered.length,
    active: activeCount
  });
  header.append(count);
  section.append(header);

  const subtitle = document.createElement("p");
  subtitle.className = "wb-sessions-subtitle";
  subtitle.textContent = t("sessionsSubtitle");
  section.append(subtitle);

  const list = document.createElement("div");
  list.className = "wb-sessions-list";

  if (ordered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wb-sessions-empty";
    empty.textContent = t("sessionsEmpty");
    list.append(empty);
  } else {
    list.append(...ordered.map((session) => renderSessionCard(session, now)));
  }

  section.append(list);
  container.replaceChildren(section);
  bindActions(container);
}

function renderSessionCard(session: SessionListItem, now: number): HTMLElement {
  const page = describeSessionPage(session);
  const startedAt = formatAbsoluteTime(session.startedAt);
  const startedRelative = formatRelativeTime(session.startedAt, now);
  const endedAt =
    typeof session.stoppedAt === "number" ? formatAbsoluteTime(session.stoppedAt) : null;
  const elapsed = formatDuration(session.startedAt, session.stoppedAt ?? now);
  const eventCount = session.eventCount ?? 0;
  const errorCount = session.errorCount ?? 0;
  const budgetAlertCount = session.budgetAlertCount ?? 0;
  const sizeBytes = session.sizeBytes ?? 0;
  const tags = session.tags ?? [];
  const note = typeof session.note === "string" ? session.note : "";
  const tagsValue = formatTagInputValue(tags);
  const sidShort = shortenSessionId(session.sid);
  const statusLabel = session.active ? t("sessionsStatusLive") : t("sessionsStatusStopped");
  const statusClass = session.active ? "wb-session-status--live" : "wb-session-status--stopped";

  const article = document.createElement("article");
  article.className = "wb-session-card";

  const header = document.createElement("header");
  header.className = "wb-session-card__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "wb-session-card__title-wrap";

  const title = document.createElement("h2");
  title.className = "wb-session-card__title";
  title.title = page.secondary;
  title.textContent = page.primary;

  const url = document.createElement("p");
  url.className = "wb-session-card__url mono";
  url.title = page.secondary;
  url.textContent = page.secondary;

  titleWrap.append(title, url);

  const status = document.createElement("span");
  status.className = `wb-session-status ${statusClass}`;
  status.textContent = statusLabel;

  header.append(titleWrap, status);
  article.append(header);

  const meta = document.createElement("div");
  meta.className = "wb-session-card__meta";
  meta.append(
    createChip(t("sessionsChipMode", { mode: formatMode(session.mode) })),
    createChip(t("sessionsChipTab", { tabId: session.tabId })),
    createChip(t("sessionsChipStarted", { timeAgo: startedRelative }), startedAt),
    createChip(t("sessionsChipEvents", { count: eventCount })),
    createChip(t("sessionsChipErrors", { count: errorCount })),
    createChip(t("sessionsChipBudgetAlerts", { count: budgetAlertCount })),
    createChip(t("sessionsChipSize", { size: formatByteSize(sizeBytes) })),
    createChip(t("sessionsChipDuration", { duration: elapsed }))
  );

  if (endedAt) {
    meta.append(createChip(t("sessionsChipEnded"), endedAt));
  }

  article.append(meta);

  const sid = document.createElement("p");
  sid.className = "wb-session-card__sid mono";
  sid.title = session.sid;
  sid.textContent = t("sessionsSid", {
    sid: sidShort
  });
  article.append(sid);

  if (note) {
    const noteText = document.createElement("p");
    noteText.className = "wb-session-card__note";
    noteText.title = note;
    noteText.textContent = note;
    article.append(noteText);
  }

  if (tags.length > 0) {
    const tagsContainer = document.createElement("div");
    tagsContainer.className = "wb-session-card__tags";
    tagsContainer.append(
      ...tags.map((tag) => createChip(`#${tag}`, undefined, "wb-chip wb-chip--tag"))
    );
    article.append(tagsContainer);
  }

  const actions = document.createElement("div");
  actions.className = "wb-session-card__actions";
  actions.append(
    createActionButton(t("sessionsActionExport"), "wb-btn wb-btn--brand", { export: session.sid }),
    createActionButton(
      t("sessionsActionStop"),
      "wb-btn wb-btn--muted",
      { stop: String(session.tabId) },
      !session.active
    ),
    createActionButton(t("sessionsActionDelete"), "wb-btn wb-btn--muted", { delete: session.sid })
  );
  article.append(actions);

  const form = document.createElement("form");
  form.className = "wb-session-annotation";
  form.dataset.annotate = session.sid;

  const tagsLabel = document.createElement("label");
  tagsLabel.className = "wb-field-label";
  tagsLabel.append(t("sessionsTagsLabel"));

  const tagsInput = document.createElement("input");
  tagsInput.className = "wb-input";
  tagsInput.dataset.annotateTags = "";
  tagsInput.value = tagsValue;
  tagsLabel.append(tagsInput);

  const noteLabel = document.createElement("label");
  noteLabel.className = "wb-field-label";
  noteLabel.append(t("sessionsNotesLabel"));

  const noteInput = document.createElement("textarea");
  noteInput.className = "wb-session-note-input";
  noteInput.dataset.annotateNote = "";
  noteInput.rows = 2;
  noteInput.value = note;
  noteLabel.append(noteInput);

  const saveButton = document.createElement("button");
  saveButton.className = "wb-btn wb-btn--muted";
  saveButton.type = "submit";
  saveButton.textContent = t("sessionsSaveContext");

  form.append(tagsLabel, noteLabel, saveButton);
  article.append(form);

  return article;
}

function describeSessionPage(session: SessionListItem): { primary: string; secondary: string } {
  const title = typeof session.title === "string" ? session.title.trim() : "";
  const rawUrl =
    typeof session.url === "string" && session.url.trim().length > 0 ? session.url : "";

  if (rawUrl.length === 0) {
    return {
      primary:
        title ||
        t("sessionsFallbackTab", {
          tabId: session.tabId
        }),
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
  return new Date(timestamp).toLocaleString(locale);
}

function parseTagInput(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const fragment of value.split(",")) {
    const tag = fragment.trim();

    if (tag.length === 0 || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    tags.push(tag);

    if (tags.length >= 12) {
      break;
    }
  }

  return tags;
}

function normalizeNoteInput(value: string): string | undefined {
  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 500);
}

function formatTagInputValue(tags: string[]): string {
  return tags.join(", ");
}

function bindActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("button[data-export]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sid = button.dataset.export;

      if (!sid) {
        return;
      }

      const passphrase = await openPassphraseDialog(sid);

      if (passphrase === null) {
        return;
      }

      postUiMessage({
        kind: "ui.export",
        sid,
        passphrase,
        saveAs: false
      });
    });
  });

  container.querySelectorAll<HTMLButtonElement>("button[data-stop]").forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = Number(button.dataset.stop);

      if (!Number.isFinite(tabId)) {
        return;
      }

      postUiMessage({
        kind: "ui.stop",
        tabId
      });
    });
  });

  container.querySelectorAll<HTMLButtonElement>("button[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sid = button.dataset.delete;

      if (!sid) {
        return;
      }

      const confirmed = await openConfirmDialog(
        t("sessionsDeletePrompt", {
          sid
        })
      );

      if (!confirmed) {
        return;
      }

      postUiMessage({
        kind: "ui.delete",
        sid
      });
    });
  });

  container.querySelectorAll<HTMLFormElement>("form[data-annotate]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const sid = form.dataset.annotate;

      if (!sid) {
        return;
      }

      const tagsInput = form.querySelector<HTMLInputElement>("[data-annotate-tags]");
      const noteInput = form.querySelector<HTMLTextAreaElement>("[data-annotate-note]");

      postUiMessage({
        kind: "ui.annotate",
        sid,
        tags: parseTagInput(tagsInput?.value ?? ""),
        note: normalizeNoteInput(noteInput?.value ?? "")
      });
    });
  });
}

function openPassphraseDialog(sid: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "wb-confirm-overlay";

    const form = document.createElement("form");
    form.className = "wb-confirm-card wb-prompt-card";
    form.setAttribute("aria-labelledby", "wb-passphrase-title");

    const title = document.createElement("h2");
    title.id = "wb-passphrase-title";
    title.className = "wb-confirm-title";
    title.textContent = t("sessionsExportDialogTitle");

    const sidText = document.createElement("p");
    sidText.className = "wb-confirm-body mono";
    sidText.textContent = shortenSessionId(sid);

    const body = document.createElement("p");
    body.className = "wb-confirm-body";
    body.textContent = t("sessionsExportDialogBody");

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.htmlFor = "wb-passphrase-input";
    label.textContent = t("popupPassphraseLabel");

    const input = document.createElement("input");
    input.id = "wb-passphrase-input";
    input.type = "password";
    input.className = "wb-input wb-prompt-field";
    input.autocomplete = "off";
    input.required = true;

    const actions = document.createElement("div");
    actions.className = "wb-confirm-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wb-btn wb-btn--muted";
    cancelButton.dataset.passphraseCancel = "";
    cancelButton.textContent = t("popupCancel");

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.className = "wb-btn wb-btn--accent";
    submitButton.dataset.passphraseSubmit = "";
    submitButton.textContent = t("sessionsActionExport");

    actions.append(cancelButton, submitButton);
    form.append(title, sidText, body, label, input, actions);
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

      if (!passphrase.trim()) {
        input.setCustomValidity(t("popupPassphraseRequired"));
        input.reportValidity();
        input.focus();
        return;
      }

      finish(passphrase);
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };

    cancelButton.addEventListener("click", () => finish(null));
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
    form.addEventListener("submit", (event) => {
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
    input.focus();
  });
}

function openConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "wb-confirm-overlay";

    const dialog = document.createElement("section");
    dialog.className = "wb-confirm-card";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "wb-confirm-title");

    const title = document.createElement("h2");
    title.id = "wb-confirm-title";
    title.className = "wb-confirm-title";
    title.textContent = t("sessionsConfirmDeleteTitle");

    const body = document.createElement("p");
    body.className = "wb-confirm-body";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "wb-confirm-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "wb-btn wb-btn--muted";
    cancelButton.dataset.confirmCancel = "";
    cancelButton.textContent = t("popupCancel");

    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "wb-btn wb-btn--brand";
    acceptButton.dataset.confirmAccept = "";
    acceptButton.textContent = t("sessionsActionDelete");

    actions.append(cancelButton, acceptButton);
    dialog.append(title, body, actions);
    overlay.append(dialog);

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

    cancelButton.addEventListener("click", () => finish(false));
    acceptButton.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });

    document.addEventListener("keydown", onKeydown);
    document.body.append(overlay);
    cancelButton.focus();
  });
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
  title.className = "wb-sessions-title";
  title.textContent = t("sessionsTitle");

  copy.append(eyebrow, title);
  lockup.append(icon, copy);
  return lockup;
}

function createChip(text: string, title?: string, className = "wb-chip"): HTMLElement {
  const chip = document.createElement("span");
  chip.className = className;
  chip.textContent = text;

  if (title) {
    chip.title = title;
  }

  return chip;
}

function createActionButton(
  label: string,
  className: string,
  dataset: Record<string, string>,
  disabled = false
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.disabled = disabled;
  button.textContent = label;
  Object.assign(button.dataset, dataset);
  return button;
}
