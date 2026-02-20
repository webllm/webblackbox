import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { type NetworkWaterfallEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";

type ScreenshotMarker = {
  x: number;
  y: number;
  viewportWidth?: number;
  viewportHeight?: number;
  reason?: string;
};

type ScreenshotTrailPoint = {
  x: number;
  y: number;
  mono: number;
  click: boolean;
};

type ScreenshotRenderContext = {
  mono: number | null;
  viewportWidth?: number;
  viewportHeight?: number;
};

type PlayerState = {
  player: WebBlackboxPlayer | null;
  comparePlayer: WebBlackboxPlayer | null;
  events: WebBlackboxEvent[];
  selectedEventId: string | null;
  selectedRequestId: string | null;
  textFilter: string;
  typeFilter: "all" | "errors" | "network" | "storage" | "console";
  screenshotUrl: string | null;
  screenshotMarker: ScreenshotMarker | null;
  screenshotContext: ScreenshotRenderContext | null;
  screenshotTrail: ScreenshotTrailPoint[];
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
  screenshotMarker: null,
  screenshotContext: null,
  screenshotTrail: [],
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
      <button id="export-playwright-mocks">Export Playwright Mocks</button>
      <button id="export-github-issue">Export GitHub Issue</button>
      <button id="export-jira-issue">Export Jira Issue</button>
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

      <article class="card domdiff-card">
        <h2>DOM Diff Browser</h2>
        <pre id="domdiff-details" class="code"></pre>
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

      <article class="card realtime-card">
        <h2>WS / SSE Timeline</h2>
        <ul id="realtime-list" class="signal-list"></ul>
      </article>

      <article class="card">
        <h2>Storage Timeline</h2>
        <ul id="storage-list" class="signal-list"></ul>
      </article>

      <article class="card perf-card">
        <h2>Performance Artifacts</h2>
        <ul id="perf-list" class="signal-list"></ul>
      </article>

      <article class="card">
        <h2>Filmstrip</h2>
        <ul id="filmstrip-list" class="signal-list"></ul>
        <div id="filmstrip-preview-wrap" class="preview-wrap">
          <img id="filmstrip-preview" alt="Screenshot preview" class="preview" />
          <svg id="filmstrip-trail-svg" class="preview-trail" aria-hidden="true"></svg>
          <div id="filmstrip-cursor" class="preview-cursor" hidden></div>
        </div>
        <p id="filmstrip-meta" class="mono"></p>
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

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      state.player = await openArchiveWithPassphraseFallback(bytes, file.name);
      state.selectedEventId = null;
      state.selectedRequestId = null;
      state.screenshotMarker = null;
      setFeedback(`Loaded ${file.name}`);
      await refresh();
    } catch (error) {
      setFeedback(`Failed to load ${file.name}: ${String(error)}`);
    }
  });

  compareInput.addEventListener("change", async () => {
    const file = compareInput.files?.[0];

    if (!file) {
      state.comparePlayer = null;
      await refresh();
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      state.comparePlayer = await openArchiveWithPassphraseFallback(bytes, file.name);
      setFeedback(`Loaded comparison archive: ${file.name}`);
      await refresh();
    } catch (error) {
      setFeedback(`Failed to load comparison archive ${file.name}: ${String(error)}`);
    }
  });

  textFilter.addEventListener("input", async () => {
    state.textFilter = textFilter.value.trim();
    await refresh();
  });

  typeFilter.addEventListener("change", async () => {
    state.typeFilter = typeFilter.value as PlayerState["typeFilter"];
    await refresh();
  });

  const filmstripPreview = getElement<HTMLImageElement>("filmstrip-preview");
  filmstripPreview.addEventListener("load", () => {
    renderScreenshotOverlay();
  });

  window.addEventListener("resize", () => {
    renderScreenshotOverlay();
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

  getElement<HTMLButtonElement>("export-playwright-mocks").addEventListener("click", async () => {
    if (!state.player) {
      return;
    }

    const script = await state.player.generatePlaywrightMockScript({ maxMocks: 25 });
    downloadTextFile("webblackbox-replay-mocks.spec.ts", script, "text/plain");
    setFeedback("Playwright mock script exported.");
  });

  getElement<HTMLButtonElement>("export-github-issue").addEventListener("click", () => {
    if (!state.player) {
      return;
    }

    const payload = state.player.generateGitHubIssueTemplate();
    downloadTextFile(
      "webblackbox-github-issue.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    setFeedback("GitHub issue template exported.");
  });

  getElement<HTMLButtonElement>("export-jira-issue").addEventListener("click", () => {
    if (!state.player) {
      return;
    }

    const payload = state.player.generateJiraIssueTemplate();
    downloadTextFile(
      "webblackbox-jira-issue.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    setFeedback("Jira issue template exported.");
  });
}

async function refresh(): Promise<void> {
  const summary = getElement<HTMLElement>("summary");
  const compareDetails = getElement<HTMLElement>("compare-details");
  const timelineList = getElement<HTMLUListElement>("timeline-list");
  const details = getElement<HTMLElement>("event-details");
  const domDiffDetails = getElement<HTMLElement>("domdiff-details");
  const consoleList = getElement<HTMLUListElement>("console-list");
  const storageList = getElement<HTMLUListElement>("storage-list");
  const perfList = getElement<HTMLUListElement>("perf-list");
  const filmstripList = getElement<HTMLUListElement>("filmstrip-list");
  const preview = getElement<HTMLImageElement>("filmstrip-preview");
  const filmstripMeta = getElement<HTMLElement>("filmstrip-meta");
  const waterfallBody = getElement<HTMLTableSectionElement>("waterfall-body");
  const requestDetails = getElement<HTMLElement>("request-details");
  const realtimeList = getElement<HTMLUListElement>("realtime-list");

  if (!state.player) {
    summary.innerHTML = `<p class="empty">No archive loaded.</p>`;
    compareDetails.textContent =
      "Load a primary archive and optional compare archive to view deltas.";
    timelineList.innerHTML = "";
    details.textContent = "Select a timeline event to inspect payload details.";
    domDiffDetails.textContent =
      "Load an archive with DOM snapshots to inspect tree-level changes.";
    consoleList.innerHTML = "";
    waterfallBody.innerHTML = "";
    requestDetails.textContent = "Select a request row to inspect network details.";
    realtimeList.innerHTML = "";
    storageList.innerHTML = "";
    perfList.innerHTML = "";
    filmstripList.innerHTML = "";
    preview.removeAttribute("src");
    state.screenshotMarker = null;
    state.screenshotContext = null;
    state.screenshotTrail = [];
    filmstripMeta.textContent = "";
    renderScreenshotOverlay();
    setFeedback(state.feedback);
    bindRequestActions();
    return;
  }

  state.events = applyFilters(state.player);
  const derived = state.player.buildDerived();
  const waterfall = state.player.getNetworkWaterfall();
  const domSnapshots = state.player.getDomSnapshots();
  const domDiffs = await state.player.getDomDiffTimeline({ limit: 24 });
  const latestDomDiff = domDiffs[domDiffs.length - 1] ?? null;
  const perfArtifacts = state.player.getPerformanceArtifacts();
  const realtimeTimeline = state.player.getRealtimeNetworkTimeline();
  const comparison = state.comparePlayer ? state.player.compareWith(state.comparePlayer) : null;
  const storageComparison = state.comparePlayer
    ? state.player.compareStorageWith(state.comparePlayer)
    : null;
  const compareDomDiff = state.comparePlayer
    ? await state.player.compareLatestDomSnapshotWith(state.comparePlayer)
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
    <div class="pill">${realtimeTimeline.length} ws/sse entries</div>
    <div class="pill">${domSnapshots.length} dom snapshots</div>
    <div class="pill">${perfArtifacts.length} perf artifacts</div>
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

  domDiffDetails.textContent =
    latestDomDiff || compareDomDiff
      ? JSON.stringify(
          {
            timeline: {
              snapshots: domSnapshots.length,
              diffSteps: domDiffs.length,
              latest: latestDomDiff
                ? {
                    fromEventId: latestDomDiff.previous.eventId,
                    toEventId: latestDomDiff.current.eventId,
                    summary: latestDomDiff.summary,
                    addedPaths: latestDomDiff.addedPaths.slice(0, 40),
                    removedPaths: latestDomDiff.removedPaths.slice(0, 40),
                    changedPaths: latestDomDiff.changedPaths.slice(0, 40)
                  }
                : null
            },
            crossSession: compareDomDiff
              ? {
                  leftEventId: compareDomDiff.previous.eventId,
                  rightEventId: compareDomDiff.current.eventId,
                  summary: compareDomDiff.summary,
                  addedPaths: compareDomDiff.addedPaths.slice(0, 40),
                  removedPaths: compareDomDiff.removedPaths.slice(0, 40),
                  changedPaths: compareDomDiff.changedPaths.slice(0, 40)
                }
              : null
          },
          null,
          2
        )
      : "No DOM snapshots captured for the selected archives.";

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

  perfList.innerHTML = perfArtifacts
    .slice(-60)
    .map((entry) => {
      const sizeText = typeof entry.size === "number" ? `${entry.size} bytes` : "size n/a";
      const reasonText = entry.reason ? ` (${entry.reason})` : "";
      return `<li class="signal"><span class="signal-type">${entry.eventType}</span><span class="signal-text">${entry.eventId} @ ${entry.mono.toFixed(2)}ms - ${sizeText}${reasonText}</span></li>`;
    })
    .join("");

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

  realtimeList.innerHTML = realtimeTimeline
    .slice(-120)
    .map((entry) => {
      const direction = entry.direction ? `${entry.direction} ` : "";
      const preview = entry.payloadPreview
        ? entry.payloadPreview.length > 120
          ? `${entry.payloadPreview.slice(0, 120)}...`
          : entry.payloadPreview
        : "(no payload)";
      return `<li class="signal"><span class="signal-type">${entry.eventType}</span><span class="signal-text">${direction}${entry.streamId ?? "-"} @ ${entry.mono.toFixed(2)}ms ${escapeHtml(preview)}</span></li>`;
    })
    .join("");

  const screenshotEvents = state.events.filter((event) => event.type === "screen.screenshot");
  filmstripList.innerHTML = screenshotEvents
    .slice(-30)
    .map(
      (event) =>
        `<li><button data-shot-event="${event.id}" class="signal">${event.id} @ ${event.mono.toFixed(2)}ms</button></li>`
    )
    .join("");

  if (screenshotEvents.length === 0) {
    state.screenshotMarker = null;
    state.screenshotContext = null;
    state.screenshotTrail = [];
    filmstripMeta.textContent = "No screenshot events available.";
    renderScreenshotOverlay();
  } else if (!state.screenshotMarker) {
    filmstripMeta.textContent = "Select a screenshot to inspect pointer marker.";
  }

  for (const button of filmstripList.querySelectorAll<HTMLButtonElement>(
    "button[data-shot-event]"
  )) {
    button.addEventListener("click", async () => {
      const shotEvent = state.events.find((event) => event.id === button.dataset.shotEvent);
      const shotData = asRecord(shotEvent?.data);
      const hash = typeof shotData?.shotId === "string" ? shotData.shotId : undefined;

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
      state.screenshotMarker = readScreenshotMarker(shotData);
      state.screenshotContext = readScreenshotContext(shotData, shotEvent);
      state.screenshotTrail = buildScreenshotTrail(
        state.events,
        state.screenshotContext?.mono ?? null
      );
      filmstripMeta.textContent = describeScreenshotMeta(
        state.screenshotMarker,
        state.screenshotTrail
      );
      preview.src = state.screenshotUrl;
      renderScreenshotOverlay();
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

async function openArchiveWithPassphraseFallback(
  bytes: Uint8Array,
  fileName: string
): Promise<WebBlackboxPlayer> {
  try {
    return await WebBlackboxPlayer.open(bytes);
  } catch (error) {
    const message = String(error).toLowerCase();

    if (!message.includes("encrypted")) {
      throw error;
    }

    const passphrase = prompt(`Archive '${fileName}' is encrypted. Enter passphrase:`);

    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error("Passphrase is required for encrypted archive.");
    }

    return WebBlackboxPlayer.open(bytes, {
      passphrase: passphrase.trim()
    });
  }
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

function renderScreenshotOverlay(): void {
  renderScreenshotTrail();
  renderScreenshotMarker();
}

function renderScreenshotMarker(): void {
  const preview = document.getElementById("filmstrip-preview") as HTMLImageElement | null;
  const cursor = document.getElementById("filmstrip-cursor") as HTMLDivElement | null;

  if (!preview || !cursor || !state.screenshotMarker || !preview.src) {
    if (cursor) {
      cursor.hidden = true;
    }

    return;
  }

  const marker = state.screenshotMarker;
  const imageWidth = preview.clientWidth;
  const imageHeight = preview.clientHeight;
  const sourceWidth =
    marker.viewportWidth ?? state.screenshotContext?.viewportWidth ?? preview.naturalWidth;
  const sourceHeight =
    marker.viewportHeight ?? state.screenshotContext?.viewportHeight ?? preview.naturalHeight;

  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    preview.naturalWidth <= 0 ||
    preview.naturalHeight <= 0
  ) {
    cursor.hidden = true;
    return;
  }

  const scale = Math.min(imageWidth / sourceWidth, imageHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (imageWidth - renderedWidth) / 2;
  const offsetY = (imageHeight - renderedHeight) / 2;
  const markerX = offsetX + (marker.x / sourceWidth) * renderedWidth;
  const markerY = offsetY + (marker.y / sourceHeight) * renderedHeight;

  cursor.style.left = `${markerX}px`;
  cursor.style.top = `${markerY}px`;
  cursor.hidden = false;
}

function renderScreenshotTrail(): void {
  const preview = document.getElementById("filmstrip-preview") as HTMLImageElement | null;
  const trailSvg = document.getElementById("filmstrip-trail-svg") as SVGSVGElement | null;

  if (!preview || !trailSvg || !preview.src || state.screenshotTrail.length === 0) {
    if (trailSvg) {
      trailSvg.innerHTML = "";
    }
    return;
  }

  const imageWidth = preview.clientWidth;
  const imageHeight = preview.clientHeight;
  const sourceWidth = state.screenshotContext?.viewportWidth ?? preview.naturalWidth;
  const sourceHeight = state.screenshotContext?.viewportHeight ?? preview.naturalHeight;

  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    preview.naturalWidth <= 0 ||
    preview.naturalHeight <= 0
  ) {
    trailSvg.innerHTML = "";
    return;
  }

  const scale = Math.min(imageWidth / sourceWidth, imageHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (imageWidth - renderedWidth) / 2;
  const offsetY = (imageHeight - renderedHeight) / 2;

  const projected = state.screenshotTrail.map((point) => ({
    x: offsetX + (point.x / sourceWidth) * renderedWidth,
    y: offsetY + (point.y / sourceHeight) * renderedHeight,
    click: point.click
  }));

  if (projected.length === 0) {
    trailSvg.innerHTML = "";
    return;
  }

  const polylinePoints = projected
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const clickDots = projected
    .filter((point) => point.click)
    .map(
      (point) =>
        `<circle class="preview-trail-point preview-trail-point-click" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4"></circle>`
    )
    .join("");
  const endPoint = projected[projected.length - 1];
  const endDot =
    endPoint !== undefined
      ? `<circle class="preview-trail-point preview-trail-point-tail" cx="${endPoint.x.toFixed(2)}" cy="${endPoint.y.toFixed(2)}" r="3"></circle>`
      : "";

  trailSvg.setAttribute("viewBox", `0 0 ${imageWidth} ${imageHeight}`);
  trailSvg.innerHTML = `<polyline class="preview-trail-line" points="${polylinePoints}"></polyline>${clickDots}${endDot}`;
}

function readScreenshotMarker(data: Record<string, unknown> | null): ScreenshotMarker | null {
  const pointer = asRecord(data?.pointer);

  if (!pointer) {
    return null;
  }

  const x = asFiniteNumber(pointer.x);
  const y = asFiniteNumber(pointer.y);

  if (x === null || y === null) {
    return null;
  }

  const viewport = asRecord(data?.viewport);
  const widthFromViewport = asFiniteNumber(viewport?.width);
  const heightFromViewport = asFiniteNumber(viewport?.height);
  const widthFromLegacy = asFiniteNumber(data?.w);
  const heightFromLegacy = asFiniteNumber(data?.h);

  return {
    x,
    y,
    viewportWidth: widthFromViewport ?? widthFromLegacy ?? undefined,
    viewportHeight: heightFromViewport ?? heightFromLegacy ?? undefined,
    reason: typeof data?.reason === "string" ? data.reason : undefined
  };
}

function readScreenshotContext(
  data: Record<string, unknown> | null,
  event: WebBlackboxEvent | undefined
): ScreenshotRenderContext | null {
  const viewport = asRecord(data?.viewport);
  const widthFromViewport = asFiniteNumber(viewport?.width);
  const heightFromViewport = asFiniteNumber(viewport?.height);
  const widthFromLegacy = asFiniteNumber(data?.w);
  const heightFromLegacy = asFiniteNumber(data?.h);
  const mono = typeof event?.mono === "number" ? event.mono : null;

  if (
    mono === null &&
    widthFromViewport === null &&
    heightFromViewport === null &&
    widthFromLegacy === null &&
    heightFromLegacy === null
  ) {
    return null;
  }

  return {
    mono,
    viewportWidth: widthFromViewport ?? widthFromLegacy ?? undefined,
    viewportHeight: heightFromViewport ?? heightFromLegacy ?? undefined
  };
}

function buildScreenshotTrail(
  events: WebBlackboxEvent[],
  screenshotMono: number | null
): ScreenshotTrailPoint[] {
  if (typeof screenshotMono !== "number") {
    return [];
  }

  const windowMs = 3_500;
  const startMono = screenshotMono - windowMs;
  const points: ScreenshotTrailPoint[] = [];

  for (const event of events) {
    if (event.mono < startMono || event.mono > screenshotMono) {
      continue;
    }

    const isMove = event.type === "user.mousemove";
    const isClick = event.type === "user.click" || event.type === "user.dblclick";

    if (!isMove && !isClick) {
      continue;
    }

    const payload = asRecord(event.data);
    const x = asFiniteNumber(payload?.x);
    const y = asFiniteNumber(payload?.y);

    if (x === null || y === null) {
      continue;
    }

    points.push({
      x,
      y,
      mono: event.mono,
      click: isClick
    });
  }

  points.sort((left, right) => left.mono - right.mono);

  const maxPoints = 90;

  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

function describeScreenshotMeta(
  marker: ScreenshotMarker | null,
  trail: ScreenshotTrailPoint[]
): string {
  const markerText = describeScreenshotMarker(marker);
  const trailText = trail.length > 0 ? `Trail points: ${trail.length}` : "No trail points.";
  return `${markerText} | ${trailText}`;
}

function describeScreenshotMarker(marker: ScreenshotMarker | null): string {
  if (!marker) {
    return "No pointer marker on this screenshot.";
  }

  const base = `Pointer marker: (${Math.round(marker.x)}, ${Math.round(marker.y)})`;
  return marker.reason ? `${base} [${marker.reason}]` : base;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
