import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

type PlayerState = {
  player: WebBlackboxPlayer | null;
  events: WebBlackboxEvent[];
  selectedEventId: string | null;
  textFilter: string;
  typeFilter: "all" | "errors" | "network" | "storage" | "console";
  screenshotUrl: string | null;
};

const state: PlayerState = {
  player: null,
  events: [],
  selectedEventId: null,
  textFilter: "",
  typeFilter: "all",
  screenshotUrl: null
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
      <label class="upload" for="archive-input">Load Archive</label>
      <input id="archive-input" type="file" accept=".webblackbox,.zip" />
    </header>

    <section id="summary" class="summary"></section>

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

      <article class="card">
        <h2>Network</h2>
        <ul id="network-list" class="signal-list"></ul>
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
const textFilter = getElement<HTMLInputElement>("text-filter");
const typeFilter = getElement<HTMLSelectElement>("type-filter");

input.addEventListener("change", async () => {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  state.player = await WebBlackboxPlayer.open(bytes);
  state.selectedEventId = null;
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

void refresh();

async function refresh(): Promise<void> {
  const summary = getElement<HTMLElement>("summary");
  const timelineList = getElement<HTMLUListElement>("timeline-list");
  const details = getElement<HTMLElement>("event-details");
  const consoleList = getElement<HTMLUListElement>("console-list");
  const networkList = getElement<HTMLUListElement>("network-list");
  const storageList = getElement<HTMLUListElement>("storage-list");
  const filmstripList = getElement<HTMLUListElement>("filmstrip-list");
  const preview = getElement<HTMLImageElement>("filmstrip-preview");

  if (!state.player) {
    summary.innerHTML = `<p class="empty">No archive loaded.</p>`;
    timelineList.innerHTML = "";
    details.textContent = "Select a timeline event to inspect payload details.";
    consoleList.innerHTML = "";
    networkList.innerHTML = "";
    storageList.innerHTML = "";
    filmstripList.innerHTML = "";
    preview.removeAttribute("src");
    return;
  }

  state.events = applyFilters(state.player);
  const derived = state.player.buildDerived();

  summary.innerHTML = `
    <div class="pill"><strong>${state.player.archive.manifest.mode.toUpperCase()}</strong> mode</div>
    <div class="pill">${state.events.length} visible events</div>
    <div class="pill">${derived.totals.errors} errors</div>
    <div class="pill">${derived.totals.requests} network requests</div>
    <div class="pill">${derived.actionSpans.length} action spans</div>
  `;

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

  const selected =
    state.events.find((event) => event.id === state.selectedEventId) ?? state.events[0] ?? null;
  details.textContent = selected
    ? JSON.stringify(
        {
          type: selected.type,
          id: selected.id,
          mono: selected.mono,
          ref: selected.ref,
          data: selected.data
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
    networkList,
    state.events.filter((event) => event.type.startsWith("network."))
  );
  renderSignalList(
    storageList,
    state.events.filter((event) => event.type.startsWith("storage."))
  );

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
