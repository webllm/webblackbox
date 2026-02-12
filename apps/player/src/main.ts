import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { type NetworkWaterfallEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";

type PlayerState = {
  player: WebBlackboxPlayer | null;
  comparePlayer: WebBlackboxPlayer | null;
  events: WebBlackboxEvent[];
  selectedEventId: string | null;
  selectedRequestId: string | null;
  textFilter: string;
  typeFilter: "all" | "errors" | "network" | "storage" | "console";
  screenshotUrl: string | null;
  feedback: string;
};

const state: PlayerState = {
  player: null,
  comparePlayer: null,
  events: [],
  selectedEventId: null,
  selectedRequestId: null,
  textFilter: "",
  typeFilter: "all",
  screenshotUrl: null,
  feedback: ""
};

const app = document.getElementById("app");

if (!app) {
  throw new Error("Missing #app root for player.");
}

app.innerHTML = `
  <section class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">WebBlackbox</p>
        <h1>Time-Travel Player</h1>
        <p class="subhead">Load a .webblackbox archive and inspect timeline evidence.</p>
      </div>
      <div class="topbar-actions">
        <label class="upload" for="archive-input">Load Archive</label>
        <input id="archive-input" type="file" accept=".webblackbox,.zip" />
        <label class="upload secondary" for="compare-input">Load Compare</label>
        <input id="compare-input" type="file" accept=".webblackbox,.zip" />
      </div>
    </header>

    <section id="summary" class="summary"></section>

    <section class="actions">
      <button id="export-report">Export Bug Report</button>
      <button id="export-har">Export HAR</button>
      <button id="export-playwright">Export Playwright</button>
      <span id="feedback" class="feedback"></span>
    </section>

    <section class="filters">
      <input id="text-filter" type="search" placeholder="Search timeline payloads" />
      <select id="type-filter">
        <option value="all">All Events</option>
        <option value="errors">Errors</option>
        <option value="network">Network</option>
        <option value="storage">Storage</option>
        <option value="console">Console</option>
      </select>
    </section>

    <section class="grid">
      <article class="card compare-card">
        <h2>Session Compare</h2>
        <pre id="compare-details" class="code"></pre>
      </article>

      <article class="card timeline">
        <h2>Timeline</h2>
        <ul id="timeline-list" class="event-list"></ul>
      </article>

      <article class="card details">
        <h2>Event Details</h2>
        <pre id="event-details" class="code"></pre>
      </article>

      <article class="card">
        <h2>Console & Errors</h2>
        <ul id="console-list" class="signal-list"></ul>
      </article>

      <article class="card network-card">
        <h2>Network Waterfall</h2>
        <div class="waterfall-wrap">
          <table class="waterfall-table">
            <thead>
              <tr>
                <th align="left">Request</th>
                <th align="left">Status</th>
                <th align="left">Duration</th>
                <th align="left">Action</th>
              </tr>
            </thead>
            <tbody id="waterfall-body"></tbody>
          </table>
        </div>
        <div class="inline-actions">
          <button id="copy-curl">Copy cURL</button>
          <button id="copy-fetch">Copy fetch</button>
        </div>
        <pre id="request-details" class="code"></pre>
      </article>

      <article class="card">
        <h2>Storage Timeline</h2>
        <ul id="storage-list" class="signal-list"></ul>
      </article>

      <article class="card">
        <h2>Filmstrip</h2>
        <ul id="filmstrip-list" class="signal-list"></ul>
        <img id="filmstrip-preview" alt="Screenshot preview" class="preview" />
      </article>
    </section>
  </section>
`;

const input = getElement<HTMLInputElement>("archive-input");
const compareInput = getElement<HTMLInputElement>("compare-input");
const textFilter = getElement<HTMLInputElement>("text-filter");
const typeFilter = getElement<HTMLSelectElement>("type-filter");

bindGlobalActions();
void refresh();

function bindGlobalActions(): void {
  input.addEventListener("change", async () => {
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    state.player = await WebBlackboxPlayer.open(bytes);
    state.selectedEventId = null;
    state.selectedRequestId = null;
    setFeedback(`Loaded ${file.name}`);
    await refresh();
  });

  compareInput.addEventListener("change", async () => {
    const file = compareInput.files?.[0];

    if (!file) {
      state.comparePlayer = null;
      await refresh();
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    state.comparePlayer = await WebBlackboxPlayer.open(bytes);
    setFeedback(`Loaded comparison archive: ${file.name}`);
    await refresh();
  });

  textFilter.addEventListener("input", async () => {
    state.textFilter = textFilter.value.trim();
    await refresh();
  });

  typeFilter.addEventListener("change", async () => {
    state.typeFilter = typeFilter.value as PlayerState["typeFilter"];
    await refresh();
  });

  getElement<HTMLButtonElement>("export-report").addEventListener("click", () => {
    if (!state.player) {
      return;
    }

    downloadTextFile("webblackbox-report.md", state.player.generateBugReport(), "text/markdown");
    setFeedback("Bug report exported.");
  });

  getElement<HTMLButtonElement>("export-har").addEventListener("click", () => {
    if (!state.player) {
      return;
    }

    downloadTextFile("webblackbox-session.har", state.player.exportHar(), "application/json");
    setFeedback("HAR exported.");
  });

  getElement<HTMLButtonElement>("export-playwright").addEventListener("click", () => {
    if (!state.player) {
      return;
    }

    downloadTextFile(
      "webblackbox-replay.spec.ts",
      state.player.generatePlaywrightScript({ includeHarReplay: true }),
      "text/plain"
    );
    setFeedback("Playwright script exported.");
  });
}

async function refresh(): Promise<void> {
  const summary = getElement<HTMLElement>("summary");
  const compareDetails = getElement<HTMLElement>("compare-details");
  const timelineList = getElement<HTMLUListElement>("timeline-list");
  const details = getElement<HTMLElement>("event-details");
  const consoleList = getElement<HTMLUListElement>("console-list");
  const storageList = getElement<HTMLUListElement>("storage-list");
  const filmstripList = getElement<HTMLUListElement>("filmstrip-list");
  const preview = getElement<HTMLImageElement>("filmstrip-preview");
  const waterfallBody = getElement<HTMLTableSectionElement>("waterfall-body");
  const requestDetails = getElement<HTMLElement>("request-details");

  if (!state.player) {
    summary.innerHTML = `<p class="empty">No archive loaded.</p>`;
    compareDetails.textContent =
      "Load a primary archive and optional compare archive to view deltas.";
    timelineList.innerHTML = "";
    details.textContent = "Select a timeline event to inspect payload details.";
    consoleList.innerHTML = "";
    waterfallBody.innerHTML = "";
    requestDetails.textContent = "Select a request row to inspect network details.";
    storageList.innerHTML = "";
    filmstripList.innerHTML = "";
    preview.removeAttribute("src");
    setFeedback(state.feedback);
    bindRequestActions();
    return;
  }

  state.events = applyFilters(state.player);
  const derived = state.player.buildDerived();
  const waterfall = state.player.getNetworkWaterfall();
  const comparison = state.comparePlayer ? state.player.compareWith(state.comparePlayer) : null;
  const storageComparison = state.comparePlayer
    ? state.player.compareStorageWith(state.comparePlayer)
    : null;

  if (waterfall.length > 0 && !state.selectedRequestId) {
    state.selectedRequestId = waterfall[0]?.reqId ?? null;
  }

  summary.innerHTML = `
    <div class="pill"><strong>${state.player.archive.manifest.mode.toUpperCase()}</strong> mode</div>
    <div class="pill">${state.events.length} visible events</div>
    <div class="pill">${derived.totals.errors} errors</div>
    <div class="pill">${derived.totals.requests} network requests</div>
    <div class="pill">${derived.actionSpans.length} action spans</div>
    <div class="pill">${waterfall.length} waterfall rows</div>
    ${
      comparison
        ? `<div class="pill">event delta ${comparison.eventDelta >= 0 ? "+" : ""}${comparison.eventDelta}</div>`
        : ""
    }
  `;

  compareDetails.textContent = comparison
    ? JSON.stringify(
        {
          sessionComparison: {
            eventDelta: comparison.eventDelta,
            errorDelta: comparison.errorDelta,
            requestDelta: comparison.requestDelta,
            durationDeltaMs: Number(comparison.durationDeltaMs.toFixed(2)),
            topTypeDeltas: comparison.typeDeltas.slice(0, 8)
          },
          storageComparison: storageComparison
            ? {
                leftEvents: storageComparison.leftEvents,
                rightEvents: storageComparison.rightEvents,
                kindDeltas: storageComparison.kindDeltas,
                hashOnlyLeft: storageComparison.hashOnlyLeft.slice(0, 20),
                hashOnlyRight: storageComparison.hashOnlyRight.slice(0, 20)
              }
            : null
        },
        null,
        2
      )
    : "Load a comparison archive to see event, request, and storage deltas.";

  timelineList.innerHTML = state.events
    .slice(0, 600)
    .map((event) => {
      const selectedClass = state.selectedEventId === event.id ? "selected" : "";
      return `<li><button data-event-id="${event.id}" class="event ${selectedClass}">
        <span class="tag">${event.type}</span>
        <span class="mono">${event.mono.toFixed(2)}ms</span>
        <span class="id">${event.id}</span>
      </button></li>`;
    })
    .join("");

  for (const button of timelineList.querySelectorAll<HTMLButtonElement>("button[data-event-id]")) {
    button.addEventListener("click", async () => {
      state.selectedEventId = button.dataset.eventId ?? null;
      await refresh();
    });
  }

  const selectedEvent =
    state.events.find((event) => event.id === state.selectedEventId) ?? state.events[0] ?? null;
  details.textContent = selectedEvent
    ? JSON.stringify(
        {
          type: selectedEvent.type,
          id: selectedEvent.id,
          mono: selectedEvent.mono,
          ref: selectedEvent.ref,
          data: selectedEvent.data
        },
        null,
        2
      )
    : "No matching events under current filters.";

  renderSignalList(
    consoleList,
    state.events.filter(
      (event) => event.type === "console.entry" || event.type.startsWith("error.")
    )
  );

  renderSignalList(
    storageList,
    state.events.filter((event) => event.type.startsWith("storage."))
  );

  waterfallBody.innerHTML = waterfall
    .slice(0, 300)
    .map((entry) => {
      const selected = state.selectedRequestId === entry.reqId ? "selected-row" : "";
      return `<tr class="${selected}">
        <td><button data-req-id="${entry.reqId}" class="waterfall-btn">${escapeHtml(shortUrl(entry.url))}</button></td>
        <td>${escapeHtml(entry.failed ? "FAILED" : String(entry.status ?? "-"))}</td>
        <td>${entry.durationMs.toFixed(1)}ms</td>
        <td>${escapeHtml(entry.actionId ?? "-")}</td>
      </tr>`;
    })
    .join("");

  for (const button of waterfallBody.querySelectorAll<HTMLButtonElement>("button[data-req-id]")) {
    button.addEventListener("click", async () => {
      state.selectedRequestId = button.dataset.reqId ?? null;
      await refresh();
    });
  }

  const selectedRequest =
    waterfall.find((entry) => entry.reqId === state.selectedRequestId) ?? waterfall[0] ?? null;

  requestDetails.textContent = selectedRequest
    ? JSON.stringify(
        {
          request: selectedRequest,
          linkedEvents: state.player.getRequestEvents(selectedRequest.reqId).map((event) => ({
            id: event.id,
            type: event.type,
            mono: event.mono,
            data: event.data
          }))
        },
        null,
        2
      )
    : "No request selected.";

  const screenshotEvents = state.events.filter((event) => event.type === "screen.screenshot");
  filmstripList.innerHTML = screenshotEvents
    .slice(-30)
    .map(
      (event) =>
        `<li><button data-shot-event="${event.id}" class="signal">${event.id} @ ${event.mono.toFixed(2)}ms</button></li>`
    )
    .join("");

  for (const button of filmstripList.querySelectorAll<HTMLButtonElement>(
    "button[data-shot-event]"
  )) {
    button.addEventListener("click", async () => {
      const shotEvent = state.events.find((event) => event.id === button.dataset.shotEvent);
      const hash = (shotEvent?.data as { shotId?: string } | undefined)?.shotId;

      if (!hash || !state.player) {
        return;
      }

      const blob = await state.player.getBlob(hash);

      if (!blob) {
        return;
      }

      if (state.screenshotUrl) {
        URL.revokeObjectURL(state.screenshotUrl);
      }

      const bytes = new Uint8Array(blob.bytes.byteLength);
      bytes.set(blob.bytes);
      state.screenshotUrl = URL.createObjectURL(new Blob([bytes], { type: blob.mime }));
      preview.src = state.screenshotUrl;
    });
  }

  bindRequestActions(selectedRequest);
  setFeedback(state.feedback);
}

function bindRequestActions(selectedRequest: NetworkWaterfallEntry | null = null): void {
  const copyCurl = getElement<HTMLButtonElement>("copy-curl");
  const copyFetch = getElement<HTMLButtonElement>("copy-fetch");

  copyCurl.disabled = !selectedRequest;
  copyFetch.disabled = !selectedRequest;

  copyCurl.onclick = async () => {
    if (!state.player || !selectedRequest) {
      return;
    }

    const curl = state.player.generateCurl(selectedRequest.reqId);

    if (!curl) {
      return;
    }

    await copyText(curl);
    setFeedback(`Copied cURL for ${selectedRequest.reqId}`);
  };

  copyFetch.onclick = async () => {
    if (!state.player || !selectedRequest) {
      return;
    }

    const snippet = state.player.generateFetch(selectedRequest.reqId);

    if (!snippet) {
      return;
    }

    await copyText(snippet);
    setFeedback(`Copied fetch snippet for ${selectedRequest.reqId}`);
  };
}

function renderSignalList(container: HTMLElement, events: WebBlackboxEvent[]): void {
  container.innerHTML = events
    .slice(-120)
    .map((event) => {
      const payload = JSON.stringify(event.data);
      const text = payload.length > 120 ? `${payload.slice(0, 120)}...` : payload;
      return `<li class="signal"><span class="signal-type">${event.type}</span><span class="signal-text">${escapeHtml(text)}</span></li>`;
    })
    .join("");
}

function applyFilters(player: WebBlackboxPlayer): WebBlackboxEvent[] {
  const queried = player.query({
    text: state.textFilter || undefined
  });

  if (state.typeFilter === "all") {
    return queried;
  }

  if (state.typeFilter === "errors") {
    return queried.filter((event) => event.type.startsWith("error."));
  }

  if (state.typeFilter === "network") {
    return queried.filter((event) => event.type.startsWith("network."));
  }

  if (state.typeFilter === "storage") {
    return queried.filter((event) => event.type.startsWith("storage."));
  }

  return queried.filter((event) => event.type === "console.entry");
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  downloadTextFile("webblackbox-copy.txt", value, "text/plain");
}

function setFeedback(text: string): void {
  state.feedback = text;
  const feedback = document.getElementById("feedback");

  if (feedback) {
    feedback.textContent = text;
  }
}

function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}` || raw;
  } catch {
    return raw;
  }
}

function getElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element: #${id}`);
  }

  return element as TElement;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
