import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  type NetworkWaterfallEntry,
  type PerformanceArtifactEntry,
  type PlayerComparison,
  type RealtimeNetworkEntry,
  type StorageTimelineEntry,
  WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { PlayerShell } from "./shell.js";

type TimelineFilter = "all" | "errors" | "network" | "storage" | "console";
type LogPanelKey =
  | "timeline"
  | "details"
  | "network"
  | "compare"
  | "console"
  | "realtime"
  | "storage"
  | "perf";

const PANEL_LABELS: Record<LogPanelKey, string> = {
  timeline: "Timeline",
  details: "Event",
  network: "Network",
  compare: "Compare",
  console: "Console",
  realtime: "Realtime",
  storage: "Storage",
  perf: "Performance"
};

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

type ProgressMarkerKind = "error" | "network" | "screenshot" | "action";

type ProgressMarker = {
  mono: number;
  kind: ProgressMarkerKind;
};

type ProgressHoverTagTone = "error" | "network" | "screenshot" | "action" | "neutral";

type ProgressHoverTag = {
  label: string;
  tone: ProgressHoverTagTone;
  mono?: number;
  eventId?: string;
  panel?: LogPanelKey;
  reqId?: string;
};

type ProgressHoverSummary = {
  text: string;
  tags: ProgressHoverTag[];
  requestEntry: NetworkWaterfallEntry | null;
};

type RequestHoverContext = {
  entry: NetworkWaterfallEntry;
  tag: ProgressHoverTag;
};

type ResponsePreview = {
  mime: string;
  sizeBytes: number;
  text: string;
  isJson: boolean;
};

type PointerSample = {
  mono: number;
  x: number;
  y: number;
  click: boolean;
  reason?: string;
};

type ScreenshotRecord = {
  eventId: string;
  mono: number;
  shotId: string;
  marker: ScreenshotMarker | null;
  context: ScreenshotRenderContext | null;
};

type ArchiveModel = {
  events: WebBlackboxEvent[];
  eventById: Map<string, WebBlackboxEvent>;
  eventSearchText: string[];
  errorPrefix: number[];
  requestPrefix: number[];
  screenshots: ScreenshotRecord[];
  shotByEventId: Map<string, ScreenshotRecord>;
  pointers: PointerSample[];
  waterfall: NetworkWaterfallEntry[];
  waterfallByReqId: Map<string, NetworkWaterfallEntry>;
  realtime: RealtimeNetworkEntry[];
  storage: StorageTimelineEntry[];
  perf: PerformanceArtifactEntry[];
  progressMarkers: ProgressMarker[];
  minMono: number;
  maxMono: number;
  durationMono: number;
  totals: {
    events: number;
    errors: number;
    requests: number;
    actionSpans: number;
  };
};

type PlayerState = {
  player: WebBlackboxPlayer | null;
  comparePlayer: WebBlackboxPlayer | null;
  compareSummary: PlayerComparison | null;
  model: ArchiveModel | null;
  selectedEventId: string | null;
  selectedRequestId: string | null;
  textFilter: string;
  typeFilter: TimelineFilter;
  activePanel: LogPanelKey;
  playheadMono: number;
  isPlaying: boolean;
  playbackRate: number;
  rafId: number | null;
  lastTickTs: number;
  lastPanelBucket: number;
  feedback: string;
  screenshotShotId: string | null;
  screenshotContext: ScreenshotRenderContext | null;
  screenshotMarker: ScreenshotMarker | null;
  screenshotTrail: ScreenshotTrailPoint[];
  screenshotUrlCache: Map<string, string>;
  screenshotLoadToken: number;
  timelineRows: WebBlackboxEvent[];
  progressMarkerSource: ArchiveModel | null;
  progressHoverToken: number;
  progressHoverShotId: string | null;
  progressHoverContext: {
    mono: number;
    ratio: number;
    markerKind?: ProgressMarkerKind;
  } | null;
  maskResponsePreview: boolean;
  responsePreviewByHash: Map<string, ResponsePreview | null>;
  responseJsonExpanded: boolean;
  responseCopyText: string;
};

type SetPlayheadOptions = {
  fromPlayback?: boolean;
  forcePanels?: boolean;
};

const MAX_TIMELINE_ROWS = 20_000;
const MAX_WATERFALL_ROWS = 180;
const MAX_SIGNAL_ROWS = 120;
const MAX_SHOT_BUTTONS = 180;
const MAX_TRAIL_POINTS = 110;
const TIMELINE_VIRTUALIZE_AFTER = 1200;
const TIMELINE_ROW_HEIGHT = 38;
const TIMELINE_OVERSCAN = 8;
const MAX_PROGRESS_MARKERS_PER_KIND = 120;
const TRAIL_WINDOW_MS = 3_500;
const PANEL_RENDER_BUCKET_MS = 120;
const PLAYBACK_STEP_MS = 1_000;
const RESPONSE_PREVIEW_COLLAPSED_CHARS = 900;
const RESPONSE_PREVIEW_EXPANDED_CHARS = 10_000;
const ACTION_MARKER_TYPES = new Set([
  "user.click",
  "user.dblclick",
  "user.keydown",
  "user.submit",
  "user.marker"
]);

const state: PlayerState = {
  player: null,
  comparePlayer: null,
  compareSummary: null,
  model: null,
  selectedEventId: null,
  selectedRequestId: null,
  textFilter: "",
  typeFilter: "all",
  activePanel: "timeline",
  playheadMono: 0,
  isPlaying: false,
  playbackRate: 1,
  rafId: null,
  lastTickTs: 0,
  lastPanelBucket: Number.NEGATIVE_INFINITY,
  feedback: "",
  screenshotShotId: null,
  screenshotContext: null,
  screenshotMarker: null,
  screenshotTrail: [],
  screenshotUrlCache: new Map<string, string>(),
  screenshotLoadToken: 0,
  timelineRows: [],
  progressMarkerSource: null,
  progressHoverToken: 0,
  progressHoverShotId: null,
  progressHoverContext: null,
  maskResponsePreview: true,
  responsePreviewByHash: new Map<string, ResponsePreview | null>(),
  responseJsonExpanded: false,
  responseCopyText: ""
};

function mountPlayerShell(): void {
  const app = document.getElementById("app");

  if (!app) {
    throw new Error("Missing #app root for player.");
  }

  const root = createRoot(app);
  flushSync(() => {
    root.render(createElement(PlayerShell));
  });
}

mountPlayerShell();

const refs = {
  archiveInput: getElement<HTMLInputElement>("archive-input"),
  compareInput: getElement<HTMLInputElement>("compare-input"),
  summary: getElement<HTMLElement>("summary"),
  compareDetails: getElement<HTMLElement>("compare-details"),
  feedback: getElement<HTMLElement>("feedback"),
  textFilter: getElement<HTMLInputElement>("text-filter"),
  typeFilter: getElement<HTMLSelectElement>("type-filter"),
  panelTabs: getElement<HTMLElement>("panel-tabs"),
  playbackToggle: getElement<HTMLButtonElement>("playback-toggle"),
  playbackBack: getElement<HTMLButtonElement>("playback-back"),
  playbackForward: getElement<HTMLButtonElement>("playback-forward"),
  playbackRate: getElement<HTMLSelectElement>("playback-rate"),
  maskResponsePreview: getElement<HTMLInputElement>("mask-response-preview"),
  progressShell: getElement<HTMLElement>("progress-shell"),
  playbackProgress: getElement<HTMLInputElement>("playback-progress"),
  playbackMarkers: getElement<HTMLElement>("playback-markers"),
  playbackPlayhead: getElement<HTMLElement>("playback-playhead"),
  progressHover: getElement<HTMLElement>("progress-hover"),
  progressHoverImage: getElement<HTMLImageElement>("progress-hover-image"),
  progressHoverTime: getElement<HTMLElement>("progress-hover-time"),
  progressHoverTags: getElement<HTMLElement>("progress-hover-tags"),
  progressHoverText: getElement<HTMLElement>("progress-hover-text"),
  progressHoverResponse: getElement<HTMLElement>("progress-hover-response"),
  progressHoverResponseBadge: getElement<HTMLElement>("progress-hover-response-badge"),
  progressHoverResponseMeta: getElement<HTMLElement>("progress-hover-response-meta"),
  progressHoverResponseToggle: getElement<HTMLButtonElement>("progress-hover-response-toggle"),
  progressHoverResponseCopy: getElement<HTMLButtonElement>("progress-hover-response-copy"),
  progressHoverResponseBody: getElement<HTMLElement>("progress-hover-response-body"),
  playbackCurrent: getElement<HTMLElement>("playback-current"),
  playbackTotal: getElement<HTMLElement>("playback-total"),
  playbackWindowLabel: getElement<HTMLElement>("playback-window-label"),
  playbackWindowEvents: getElement<HTMLElement>("playback-window-events"),
  playbackWindowPanel: getElement<HTMLElement>("playback-window-panel"),
  preview: getElement<HTMLImageElement>("filmstrip-preview"),
  stagePlaceholder: getElement<HTMLElement>("stage-placeholder"),
  filmstripMeta: getElement<HTMLElement>("filmstrip-meta"),
  filmstripList: getElement<HTMLUListElement>("filmstrip-list"),
  timelineList: getElement<HTMLUListElement>("timeline-list"),
  eventDetails: getElement<HTMLElement>("event-details"),
  waterfallBody: getElement<HTMLTableSectionElement>("waterfall-body"),
  requestDetails: getElement<HTMLElement>("request-details"),
  copyCurl: getElement<HTMLButtonElement>("copy-curl"),
  copyFetch: getElement<HTMLButtonElement>("copy-fetch"),
  consoleList: getElement<HTMLUListElement>("console-list"),
  realtimeList: getElement<HTMLUListElement>("realtime-list"),
  storageList: getElement<HTMLUListElement>("storage-list"),
  perfList: getElement<HTMLUListElement>("perf-list"),
  exportReport: getElement<HTMLButtonElement>("export-report"),
  exportHar: getElement<HTMLButtonElement>("export-har"),
  exportPlaywright: getElement<HTMLButtonElement>("export-playwright"),
  exportPlaywrightMocks: getElement<HTMLButtonElement>("export-playwright-mocks"),
  exportGitHubIssue: getElement<HTMLButtonElement>("export-github-issue"),
  exportJiraIssue: getElement<HTMLButtonElement>("export-jira-issue")
};

const panelTabButtons = Array.from(
  refs.panelTabs.querySelectorAll<HTMLButtonElement>("button[data-log-panel]")
);
const panelCards = Array.from(document.querySelectorAll<HTMLElement>("[data-log-panel-target]"));

bindGlobalActions();
void renderAll({ forcePanels: true, forceScreenshot: true });

function bindGlobalActions(): void {
  refs.archiveInput.addEventListener("change", () => {
    void handlePrimaryArchiveChange();
  });

  refs.compareInput.addEventListener("change", () => {
    void handleCompareArchiveChange();
  });

  refs.textFilter.addEventListener("input", () => {
    state.textFilter = refs.textFilter.value.trim();
    renderPanels();
    renderSummary();
  });

  refs.typeFilter.addEventListener("change", () => {
    state.typeFilter = refs.typeFilter.value as TimelineFilter;
    renderPanels();
    renderSummary();
  });

  refs.panelTabs.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-log-panel]");

    if (!button) {
      return;
    }

    const panel = button.dataset.logPanel as LogPanelKey | undefined;

    if (!panel || state.activePanel === panel) {
      return;
    }

    state.activePanel = panel;
    renderPanelTabs();
  });

  refs.playbackToggle.addEventListener("click", () => {
    togglePlayback();
  });

  refs.playbackBack.addEventListener("click", () => {
    pausePlayback();
    setPlayhead(state.playheadMono - PLAYBACK_STEP_MS, { forcePanels: true });
  });

  refs.playbackForward.addEventListener("click", () => {
    pausePlayback();
    setPlayhead(state.playheadMono + PLAYBACK_STEP_MS, { forcePanels: true });
  });

  refs.playbackRate.addEventListener("change", () => {
    const next = Number(refs.playbackRate.value);

    if (Number.isFinite(next) && next > 0) {
      state.playbackRate = next;
    }
  });

  refs.maskResponsePreview.addEventListener("change", () => {
    state.maskResponsePreview = refs.maskResponsePreview.checked;

    if (state.progressHoverContext) {
      const context = state.progressHoverContext;
      void showProgressHover(context.mono, context.ratio, context.markerKind);
    }
  });

  refs.progressHoverResponseToggle.addEventListener("click", () => {
    state.responseJsonExpanded = !state.responseJsonExpanded;

    if (state.progressHoverContext) {
      const context = state.progressHoverContext;
      void showProgressHover(context.mono, context.ratio, context.markerKind);
    }
  });

  refs.progressHoverResponseCopy.addEventListener("click", () => {
    void copyProgressHoverResponse();
  });

  refs.playbackProgress.addEventListener("input", () => {
    const model = state.model;

    if (!model) {
      return;
    }

    pausePlayback();
    const offset = Number(refs.playbackProgress.value);

    if (!Number.isFinite(offset)) {
      return;
    }

    setPlayhead(model.minMono + offset, { forcePanels: true });
  });

  refs.playbackProgress.addEventListener("pointermove", (event) => {
    void handleProgressHoverFromPointer(event);
  });

  refs.playbackMarkers.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const marker = target.closest<HTMLButtonElement>("button[data-marker-mono]");

    if (!marker || !state.model) {
      return;
    }

    const mono = Number(marker.dataset.markerMono);

    if (!Number.isFinite(mono)) {
      return;
    }

    const kind = marker.dataset.markerKind as ProgressMarkerKind | undefined;
    const panel = markerKindToPanel(kind);

    if (panel && panel !== state.activePanel) {
      state.activePanel = panel;
      renderPanelTabs();
    }

    pausePlayback();
    setPlayhead(mono, { forcePanels: true });
  });

  refs.playbackMarkers.addEventListener("pointermove", (event) => {
    const target = event.target as HTMLElement;
    const marker = target.closest<HTMLButtonElement>("button[data-marker-mono]");

    if (!marker || !state.model) {
      return;
    }

    const mono = Number(marker.dataset.markerMono);

    if (!Number.isFinite(mono)) {
      return;
    }

    const kind = marker.dataset.markerKind as ProgressMarkerKind | undefined;
    const ratio = readPointerRatio(event, refs.progressShell);
    void showProgressHover(mono, ratio, kind);
  });

  refs.progressShell.addEventListener("pointerleave", () => {
    hideProgressHover();
  });

  refs.progressHoverTags.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>(
      "button[data-hover-mono], button[data-hover-event-id]"
    );

    if (!button || !state.model) {
      return;
    }

    const panel = button.dataset.hoverPanel as LogPanelKey | undefined;

    if (panel && panel !== state.activePanel) {
      state.activePanel = panel;
      renderPanelTabs();
    }

    const reqId = button.dataset.hoverReqId;

    if (reqId) {
      state.selectedRequestId = reqId;
    }

    const eventId = button.dataset.hoverEventId;

    if (eventId) {
      state.selectedEventId = eventId;
    }

    const mono = Number(button.dataset.hoverMono);

    pausePlayback();
    hideProgressHover();

    if (Number.isFinite(mono)) {
      setPlayhead(mono, { forcePanels: true });
      return;
    }

    renderPanels();
    renderSummary();
  });

  refs.timelineList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-event-id]");

    if (!button) {
      return;
    }

    const eventId = button.dataset.eventId;

    if (!eventId) {
      return;
    }

    pausePlayback();
    state.selectedEventId = eventId;
    renderEventDetails();
    renderTimeline();
  });

  refs.timelineList.addEventListener("scroll", () => {
    if (state.timelineRows.length > TIMELINE_VIRTUALIZE_AFTER) {
      renderTimelineWindow();
    }
  });

  refs.waterfallBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-req-id]");

    if (!button) {
      return;
    }

    const reqId = button.dataset.reqId;

    if (!reqId) {
      return;
    }

    pausePlayback();
    state.selectedRequestId = reqId;
    renderWaterfall();
  });

  refs.filmstripList.addEventListener("click", (event) => {
    const model = state.model;

    if (!model) {
      return;
    }

    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-shot-event]");

    if (!button) {
      return;
    }

    const eventId = button.dataset.shotEvent;

    if (!eventId) {
      return;
    }

    const shot = model.shotByEventId.get(eventId);

    if (!shot) {
      return;
    }

    pausePlayback();
    setPlayhead(shot.mono, { forcePanels: true });
  });

  refs.preview.addEventListener("load", () => {
    updateStagePlaceholder();
    renderScreenshotOverlay();
  });

  refs.preview.addEventListener("error", () => {
    clearScreenshotView("Failed to decode screenshot.");
  });

  window.addEventListener("resize", () => {
    renderScreenshotOverlay();
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;

    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
      return;
    }

    if (event.code === "ArrowLeft") {
      event.preventDefault();
      pausePlayback();
      setPlayhead(state.playheadMono - PLAYBACK_STEP_MS, { forcePanels: true });
      return;
    }

    if (event.code === "ArrowRight") {
      event.preventDefault();
      pausePlayback();
      setPlayhead(state.playheadMono + PLAYBACK_STEP_MS, { forcePanels: true });
    }
  });

  refs.copyCurl.addEventListener("click", () => {
    void copySelectedRequestAsCurl();
  });

  refs.copyFetch.addEventListener("click", () => {
    void copySelectedRequestAsFetch();
  });

  refs.exportReport.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    downloadTextFile("webblackbox-report.md", player.generateBugReport(), "text/markdown");
    setFeedback("Bug report exported.");
  });

  refs.exportHar.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    downloadTextFile("webblackbox-session.har", player.exportHar(), "application/json");
    setFeedback("HAR exported.");
  });

  refs.exportPlaywright.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    downloadTextFile(
      "webblackbox-replay.spec.ts",
      player.generatePlaywrightScript({ includeHarReplay: true }),
      "text/plain"
    );
    setFeedback("Playwright script exported.");
  });

  refs.exportPlaywrightMocks.addEventListener("click", () => {
    void exportPlaywrightMocks();
  });

  refs.exportGitHubIssue.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    const payload = player.generateGitHubIssueTemplate();
    downloadTextFile(
      "webblackbox-github-issue.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    setFeedback("GitHub issue template exported.");
  });

  refs.exportJiraIssue.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    const payload = player.generateJiraIssueTemplate();
    downloadTextFile(
      "webblackbox-jira-issue.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
    setFeedback("Jira issue template exported.");
  });
}

async function handlePrimaryArchiveChange(): Promise<void> {
  const file = refs.archiveInput.files?.[0];

  if (!file) {
    return;
  }

  pausePlayback();
  hideProgressHover();
  state.lastPanelBucket = Number.NEGATIVE_INFINITY;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const player = await openArchiveWithPassphraseFallback(bytes, file.name);
    const model = buildArchiveModel(player);

    resetScreenshotResources();
    state.responsePreviewByHash.clear();

    state.player = player;
    state.model = model;
    state.selectedEventId = model.events[model.events.length - 1]?.id ?? null;
    state.selectedRequestId = model.waterfall[model.waterfall.length - 1]?.reqId ?? null;
    state.playheadMono = model.maxMono;

    refreshCompareSummary();

    await renderAll({ forcePanels: true, forceScreenshot: true });
    setFeedback(`Loaded ${file.name}`);
  } catch (error) {
    setFeedback(`Failed to load ${file.name}: ${String(error)}`);
  }
}

async function handleCompareArchiveChange(): Promise<void> {
  const file = refs.compareInput.files?.[0];

  if (!file) {
    state.comparePlayer = null;
    refreshCompareSummary();
    renderSummary();
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.comparePlayer = await openArchiveWithPassphraseFallback(bytes, file.name);
    refreshCompareSummary();
    renderSummary();
    setFeedback(`Loaded comparison archive: ${file.name}`);
  } catch (error) {
    setFeedback(`Failed to load comparison archive ${file.name}: ${String(error)}`);
  }
}

function refreshCompareSummary(): void {
  if (state.player && state.comparePlayer) {
    state.compareSummary = state.player.compareWith(state.comparePlayer);
    return;
  }

  state.compareSummary = null;
}

async function exportPlaywrightMocks(): Promise<void> {
  const player = state.player;

  if (!player) {
    return;
  }

  const script = await player.generatePlaywrightMockScript({ maxMocks: 25 });
  downloadTextFile("webblackbox-replay-mocks.spec.ts", script, "text/plain");
  setFeedback("Playwright mock script exported.");
}

function togglePlayback(): void {
  if (!state.model) {
    return;
  }

  if (state.isPlaying) {
    pausePlayback();
    return;
  }

  if (state.playheadMono >= state.model.maxMono - 1) {
    setPlayhead(state.model.minMono, { forcePanels: true });
  }

  startPlayback();
}

function startPlayback(): void {
  if (!state.model || state.isPlaying) {
    return;
  }

  state.isPlaying = true;
  state.lastTickTs = 0;
  renderPlaybackChrome();
  state.rafId = window.requestAnimationFrame(playbackTick);
}

function pausePlayback(): void {
  if (state.rafId !== null) {
    window.cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  if (!state.isPlaying) {
    return;
  }

  state.isPlaying = false;
  state.lastTickTs = 0;
  renderPlaybackChrome();
}

function playbackTick(timestamp: number): void {
  const model = state.model;

  if (!model || !state.isPlaying) {
    return;
  }

  if (state.lastTickTs <= 0) {
    state.lastTickTs = timestamp;
  }

  const elapsed = Math.max(0, timestamp - state.lastTickTs);
  state.lastTickTs = timestamp;
  setPlayhead(state.playheadMono + elapsed * state.playbackRate, { fromPlayback: true });

  if (!state.isPlaying) {
    return;
  }

  state.rafId = window.requestAnimationFrame(playbackTick);
}

function setPlayhead(nextMono: number, options: SetPlayheadOptions = {}): void {
  const model = state.model;

  if (!model) {
    return;
  }

  const clamped = Math.min(model.maxMono, Math.max(model.minMono, nextMono));
  const unchanged = Math.abs(clamped - state.playheadMono) < 0.001;

  if (unchanged && !options.forcePanels) {
    return;
  }

  state.playheadMono = clamped;
  renderPlaybackChrome();

  const bucket = Math.floor((clamped - model.minMono) / PANEL_RENDER_BUCKET_MS);
  const shouldRenderPanels =
    options.forcePanels === true ||
    options.fromPlayback !== true ||
    bucket !== state.lastPanelBucket;

  if (shouldRenderPanels) {
    state.lastPanelBucket = bucket;
    renderPanels();
    renderSummary();
  }

  void syncScreenshotForPlayhead(false);

  if (clamped >= model.maxMono - 0.001 && state.isPlaying) {
    pausePlayback();
  }
}

async function renderAll(
  options: {
    forcePanels?: boolean;
    forceScreenshot?: boolean;
  } = {}
): Promise<void> {
  renderPanelTabs();
  renderPlaybackChrome();
  renderPanels();
  renderSummary();
  await syncScreenshotForPlayhead(Boolean(options.forceScreenshot));

  if (options.forcePanels) {
    state.lastPanelBucket = Number.NEGATIVE_INFINITY;
    renderPanels();
  }
}

function renderPlaybackChrome(): void {
  const model = state.model;
  const hasModel = Boolean(model);

  refs.playbackToggle.disabled = !hasModel;
  refs.playbackBack.disabled = !hasModel;
  refs.playbackForward.disabled = !hasModel;
  refs.playbackRate.disabled = !hasModel;
  refs.maskResponsePreview.disabled = !hasModel;
  refs.playbackProgress.disabled = !hasModel;

  refs.playbackToggle.textContent = state.isPlaying ? "Pause" : "Play";

  if (!model) {
    state.progressMarkerSource = null;
    refs.playbackProgress.max = "1";
    refs.playbackProgress.value = "0";
    refs.playbackMarkers.innerHTML = "";
    refs.playbackPlayhead.style.left = "0%";
    hideProgressHover();
    refs.playbackCurrent.textContent = "0.00s";
    refs.playbackTotal.textContent = "0.00s";
    renderPlaybackReadout();
    return;
  }

  const max = Math.max(1, Math.round(model.durationMono));
  const currentOffset = Math.round(state.playheadMono - model.minMono);

  refs.playbackProgress.max = String(max);
  refs.playbackProgress.value = String(Math.min(max, Math.max(0, currentOffset)));
  renderProgressMarkers(model);
  const ratio =
    model.durationMono > 0 ? (state.playheadMono - model.minMono) / model.durationMono : 0;
  refs.playbackPlayhead.style.left = `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(3)}%`;
  refs.playbackCurrent.textContent = formatMono(state.playheadMono - model.minMono);
  refs.playbackTotal.textContent = formatMono(model.durationMono);
  renderPlaybackReadout();
}

function renderPanelTabs(): void {
  for (const button of panelTabButtons) {
    const panel = button.dataset.logPanel as LogPanelKey | undefined;
    const active = panel === state.activePanel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }

  for (const card of panelCards) {
    const panel = card.dataset.logPanelTarget as LogPanelKey | undefined;
    const isTimeline = panel === "timeline";
    const active = panel === state.activePanel;

    if (isTimeline) {
      card.classList.toggle("panel-hidden", state.activePanel === "timeline" ? !active : false);
      card.classList.toggle("panel-primary", state.activePanel === "timeline");
      card.classList.toggle("panel-secondary", state.activePanel !== "timeline");
      continue;
    }

    card.classList.toggle("panel-hidden", !active);
    card.classList.toggle("panel-primary", false);
    card.classList.toggle("panel-secondary", active);
  }

  renderPlaybackReadout();
}

function renderPlaybackReadout(): void {
  const model = state.model;

  if (!model || !state.player) {
    refs.playbackWindowLabel.textContent = "0.00s / 0.00s";
    refs.playbackWindowEvents.textContent = "0 events | 0 errors | 0 requests";
    refs.playbackWindowPanel.textContent = "Timeline panel";
    return;
  }

  const visibleEventCount = upperBoundByMono(
    model.events,
    state.playheadMono,
    (event) => event.mono
  );
  const visibleErrorCount = prefixValue(model.errorPrefix, visibleEventCount - 1);
  const visibleRequestCount = upperBoundByMono(
    model.waterfall,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const panelLabel = PANEL_LABELS[state.activePanel];
  const selection = [
    state.selectedEventId ? `event ${truncateId(state.selectedEventId)}` : null,
    state.selectedRequestId ? `request ${truncateId(state.selectedRequestId)}` : null
  ]
    .filter((item): item is string => Boolean(item))
    .join(" | ");

  refs.playbackWindowLabel.textContent = `${formatMono(state.playheadMono - model.minMono)} / ${formatMono(
    model.durationMono
  )}`;
  refs.playbackWindowEvents.textContent = `${visibleEventCount} events | ${visibleErrorCount} errors | ${visibleRequestCount} requests`;
  refs.playbackWindowPanel.textContent = selection
    ? `${panelLabel} panel | ${selection}`
    : `${panelLabel} panel`;
}

function renderProgressMarkers(model: ArchiveModel): void {
  if (state.progressMarkerSource === model) {
    return;
  }

  state.progressMarkerSource = model;

  if (model.progressMarkers.length === 0 || model.durationMono <= 0) {
    refs.playbackMarkers.innerHTML = "";
    return;
  }

  refs.playbackMarkers.innerHTML = model.progressMarkers
    .map((marker) => {
      const ratio = (marker.mono - model.minMono) / model.durationMono;
      const left = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(3);
      const tip = `${marker.kind} @ ${formatMono(marker.mono - model.minMono)}`;
      return `<button type="button" class="progress-marker progress-marker-${marker.kind}" data-marker-mono="${marker.mono}" data-marker-kind="${marker.kind}" style="left:${left}%;" title="${escapeHtml(tip)}"></button>`;
    })
    .join("");
}

async function handleProgressHoverFromPointer(event: PointerEvent): Promise<void> {
  const model = state.model;

  if (!model) {
    return;
  }

  const ratio = readPointerRatio(event, refs.progressShell);
  const mono = model.minMono + ratio * model.durationMono;
  await showProgressHover(mono, ratio);
}

async function showProgressHover(
  mono: number,
  ratio: number,
  markerKind?: ProgressMarkerKind
): Promise<void> {
  const model = state.model;

  if (!model) {
    return;
  }

  const clampedMono = Math.max(model.minMono, Math.min(model.maxMono, mono));
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const token = ++state.progressHoverToken;
  state.progressHoverContext = {
    mono: clampedMono,
    ratio: clampedRatio,
    markerKind
  };

  positionProgressHover(clampedRatio);

  refs.progressHover.hidden = false;
  refs.progressHoverTime.textContent = formatMono(clampedMono - model.minMono);
  const summary = buildProgressHoverSummary(model, clampedMono, markerKind);
  refs.progressHoverText.textContent = summary.text;
  renderProgressHoverTags(summary.tags);
  void renderProgressHoverResponse(summary.requestEntry, token);

  const shot = resolveShotForMono(model.screenshots, clampedMono);

  if (!shot) {
    state.progressHoverShotId = null;
    refs.progressHoverImage.hidden = true;
    refs.progressHoverImage.removeAttribute("src");
    return;
  }

  if (state.progressHoverShotId === shot.shotId && refs.progressHoverImage.getAttribute("src")) {
    refs.progressHoverImage.hidden = false;
    return;
  }

  state.progressHoverShotId = shot.shotId;
  refs.progressHoverImage.hidden = true;
  const url = await getScreenshotUrlByShotId(shot.shotId);

  if (token !== state.progressHoverToken || state.progressHoverShotId !== shot.shotId) {
    return;
  }

  if (!url) {
    refs.progressHoverImage.hidden = true;
    refs.progressHoverImage.removeAttribute("src");
    return;
  }

  refs.progressHoverImage.src = url;
  refs.progressHoverImage.hidden = false;
}

async function renderProgressHoverResponse(
  entry: NetworkWaterfallEntry | null,
  token: number
): Promise<void> {
  if (!entry) {
    hideProgressHoverResponse();
    return;
  }

  const status = entry.failed ? "FAILED" : String(entry.status ?? "PENDING");
  const isError = entry.failed || (typeof entry.status === "number" && entry.status >= 400);
  const isWarn =
    !isError && typeof entry.status === "number" && entry.status >= 300 && entry.status < 400;
  const badgeTone = isError ? "error" : isWarn ? "warn" : "ok";
  refs.progressHoverResponse.hidden = false;
  refs.progressHoverResponseBadge.className = `progress-hover-response-badge progress-hover-response-badge-${badgeTone}`;
  refs.progressHoverResponseBadge.textContent = status;
  refs.progressHoverResponseMeta.textContent = `${entry.method.toUpperCase()} ${shortUrl(entry.url)}`;
  refs.progressHoverResponseBody.classList.remove("expanded");
  refs.progressHoverResponseToggle.disabled = true;
  refs.progressHoverResponseToggle.textContent = "Expand JSON";
  refs.progressHoverResponseCopy.disabled = true;
  refs.progressHoverResponseCopy.textContent = "Copy";
  state.responseCopyText = "";

  if (!entry.responseBodyHash) {
    refs.progressHoverResponseBody.textContent = "(no response body captured)";
    return;
  }

  const preview = await getResponsePreviewByHash(entry.responseBodyHash);

  if (token !== state.progressHoverToken) {
    return;
  }

  if (!preview) {
    refs.progressHoverResponseBody.textContent = "(response body unavailable)";
    return;
  }

  refs.progressHoverResponseMeta.textContent = `${entry.method.toUpperCase()} ${shortUrl(entry.url)} · ${preview.mime} · ${preview.sizeBytes}B`;

  const visibleText = state.maskResponsePreview ? redactPreviewText(preview.text) : preview.text;

  if (preview.isJson) {
    const jsonPreview = compactText(
      visibleText,
      state.responseJsonExpanded
        ? RESPONSE_PREVIEW_EXPANDED_CHARS
        : RESPONSE_PREVIEW_COLLAPSED_CHARS
    );
    refs.progressHoverResponseBody.classList.toggle("expanded", state.responseJsonExpanded);
    refs.progressHoverResponseBody.innerHTML = highlightJsonPreview(jsonPreview);
    refs.progressHoverResponseToggle.disabled = false;
    refs.progressHoverResponseToggle.textContent = state.responseJsonExpanded
      ? "Collapse JSON"
      : "Expand JSON";
    refs.progressHoverResponseCopy.disabled = false;
    state.responseCopyText = jsonPreview;
    refs.progressHoverResponseBody.scrollTop = 0;
    return;
  }

  const compact = compactText(visibleText, RESPONSE_PREVIEW_COLLAPSED_CHARS);
  refs.progressHoverResponseBody.textContent = compact;
  refs.progressHoverResponseCopy.disabled = false;
  state.responseCopyText = compact;
  refs.progressHoverResponseBody.scrollTop = 0;
}

function hideProgressHoverResponse(): void {
  refs.progressHoverResponse.hidden = true;
  refs.progressHoverResponseBadge.className = "progress-hover-response-badge";
  refs.progressHoverResponseBadge.textContent = "";
  refs.progressHoverResponseMeta.textContent = "";
  refs.progressHoverResponseBody.textContent = "";
  refs.progressHoverResponseBody.classList.remove("expanded");
  refs.progressHoverResponseToggle.disabled = true;
  refs.progressHoverResponseToggle.textContent = "Expand JSON";
  refs.progressHoverResponseCopy.disabled = true;
  refs.progressHoverResponseCopy.textContent = "Copy";
  state.responseCopyText = "";
}

function renderProgressHoverTags(tags: ProgressHoverTag[]): void {
  refs.progressHoverTags.innerHTML = tags
    .map((tag) => {
      const className = `progress-hover-tag progress-hover-tag-${tag.tone}`;
      const panelAttr = tag.panel ? ` data-hover-panel="${tag.panel}"` : "";
      const eventAttr = tag.eventId ? ` data-hover-event-id="${escapeHtml(tag.eventId)}"` : "";
      const reqAttr = tag.reqId ? ` data-hover-req-id="${escapeHtml(tag.reqId)}"` : "";
      const monoAttr = typeof tag.mono === "number" ? ` data-hover-mono="${tag.mono}"` : "";
      const clickable = Boolean(tag.panel || tag.eventId || tag.reqId || monoAttr.length > 0);

      if (!clickable) {
        return `<span class="${className}">${escapeHtml(tag.label)}</span>`;
      }

      return `<button type="button" class="${className} progress-hover-tag-button"${panelAttr}${eventAttr}${reqAttr}${monoAttr}>${escapeHtml(tag.label)}</button>`;
    })
    .join("");
}

function hideProgressHover(): void {
  state.progressHoverToken += 1;
  state.progressHoverShotId = null;
  state.progressHoverContext = null;
  refs.progressHoverImage.hidden = true;
  refs.progressHoverText.textContent = "";
  refs.progressHoverTags.innerHTML = "";
  hideProgressHoverResponse();
  refs.progressHover.hidden = true;
}

function positionProgressHover(ratio: number): void {
  const width = refs.progressShell.clientWidth;

  if (width <= 0) {
    refs.progressHover.style.left = "0px";
    return;
  }

  const left = Math.min(width - 14, Math.max(14, ratio * width));
  refs.progressHover.style.left = `${left}px`;
}

function buildProgressHoverSummary(
  model: ArchiveModel,
  mono: number,
  markerKind?: ProgressMarkerKind
): ProgressHoverSummary {
  const index = upperBoundByMono(model.events, mono, (event) => event.mono) - 1;
  const latest = index >= 0 ? (model.events[index] ?? null) : null;
  const windowStart = Math.max(model.minMono, mono - 1000);
  const startIndex = lowerBoundByMono(model.events, windowStart, (event) => event.mono);
  const endIndex = upperBoundByMono(model.events, mono, (event) => event.mono);
  let errors = 0;
  let network = 0;

  for (let row = startIndex; row < endIndex; row += 1) {
    const event = model.events[row];

    if (!event) {
      continue;
    }

    if (event.type.startsWith("error.")) {
      errors += 1;
    }

    if (event.type === "network.request") {
      network += 1;
    }
  }

  const markerText = markerKind ? `${markerKind} marker · ` : "";
  const eventText = latest ? `${latest.type} (${latest.id})` : "No event at this time";
  const { tags, requestEntry } = buildProgressHoverTags(model, mono, markerKind, latest);

  return {
    text: `${markerText}${eventText} · ${endIndex - startIndex} ev/1s · ${network} net · ${errors} err`,
    tags,
    requestEntry
  };
}

function buildProgressHoverTags(
  model: ArchiveModel,
  mono: number,
  markerKind: ProgressMarkerKind | undefined,
  latestEvent: WebBlackboxEvent | null
): {
  tags: ProgressHoverTag[];
  requestEntry: NetworkWaterfallEntry | null;
} {
  const tags: ProgressHoverTag[] = [];
  let requestEntry: NetworkWaterfallEntry | null = null;

  if (markerKind) {
    const panel = markerKindToPanel(markerKind);
    tags.push({
      label: `${markerKind} marker`,
      tone: markerKind === "error" ? "error" : markerKind,
      panel: panel ?? undefined,
      mono
    });
  }

  const requestContext = buildRequestHoverContext(model, mono);

  if (requestContext) {
    requestEntry = requestContext.entry;
    tags.push(requestContext.tag);
  }

  const errorTag = buildErrorHoverTag(model, mono);

  if (errorTag) {
    tags.push(errorTag);
  }

  if (latestEvent?.type.startsWith("user.")) {
    tags.push({
      label: latestEvent.type,
      tone: "action",
      panel: "timeline",
      mono: latestEvent.mono,
      eventId: latestEvent.id
    });
  }

  return {
    tags: tags.slice(0, 4),
    requestEntry
  };
}

function buildRequestHoverContext(model: ArchiveModel, mono: number): RequestHoverContext | null {
  const end = upperBoundByMono(model.waterfall, mono, (entry) => entry.startMono) - 1;

  for (let index = end; index >= 0; index -= 1) {
    const entry = model.waterfall[index];

    if (!entry) {
      continue;
    }

    if (mono - entry.startMono > 3_000) {
      break;
    }

    const status = entry.failed ? "FAILED" : String(entry.status ?? "PENDING");
    const method = entry.method.toUpperCase();
    const path = compactText(shortUrl(entry.url), 44);
    const failed = entry.failed || (typeof entry.status === "number" && entry.status >= 400);
    const requestEventId =
      entry.eventIds
        .map((eventId) => model.eventById.get(eventId))
        .find((event) => event?.type === "network.request")?.id ?? entry.eventIds[0];

    return {
      entry,
      tag: {
        label: `${method} ${status} ${path}`,
        tone: failed ? "error" : "network",
        panel: "network",
        mono: entry.startMono,
        reqId: entry.reqId,
        eventId: requestEventId
      }
    };
  }

  return null;
}

function buildErrorHoverTag(model: ArchiveModel, mono: number): ProgressHoverTag | null {
  const end = upperBoundByMono(model.events, mono, (event) => event.mono) - 1;

  for (let index = end; index >= 0; index -= 1) {
    const event = model.events[index];

    if (!event) {
      continue;
    }

    if (mono - event.mono > 3_000) {
      break;
    }

    if (!event.type.startsWith("error.")) {
      continue;
    }

    const details = compactText(readEventSummaryText(event), 56);
    return {
      label: details ? `${event.type}: ${details}` : event.type,
      tone: "error",
      panel: "console",
      mono: event.mono,
      eventId: event.id
    };
  }

  return null;
}

function readEventSummaryText(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  const first = asString(data?.message) ?? asString(data?.text) ?? asString(data?.error);

  if (first) {
    return first;
  }

  const payload = JSON.stringify(event.data);
  return payload.length > 120 ? payload.slice(0, 120) : payload;
}

async function getResponsePreviewByHash(hash: string): Promise<ResponsePreview | null> {
  if (state.responsePreviewByHash.has(hash)) {
    return state.responsePreviewByHash.get(hash) ?? null;
  }

  const player = state.player;

  if (!player) {
    return null;
  }

  const blob = await player.getBlob(hash);

  if (!blob) {
    state.responsePreviewByHash.set(hash, null);
    return null;
  }

  const preview = decodeResponsePreview(blob.mime, blob.bytes);
  state.responsePreviewByHash.set(hash, preview);
  return preview;
}

function decodeResponsePreview(mime: string, bytes: Uint8Array): ResponsePreview | null {
  const normalizedMime = mime.toLowerCase();

  if (bytes.byteLength === 0) {
    return {
      mime: normalizedMime || "unknown",
      sizeBytes: 0,
      text: "(empty body)",
      isJson: false
    };
  }

  const isTextual =
    normalizedMime.startsWith("text/") ||
    normalizedMime.includes("json") ||
    normalizedMime.includes("xml") ||
    normalizedMime.includes("javascript") ||
    normalizedMime.includes("form-urlencoded");

  if (!isTextual) {
    return {
      mime: normalizedMime || "unknown",
      sizeBytes: bytes.byteLength,
      text: `[binary ${normalizedMime || "unknown"} ${bytes.byteLength}B]`,
      isJson: false
    };
  }

  const slice = bytes.subarray(0, Math.min(bytes.byteLength, 12_000));
  const decoded = new TextDecoder().decode(slice).trim();

  if (!decoded) {
    return {
      mime: normalizedMime || "text/plain",
      sizeBytes: bytes.byteLength,
      text: "(empty body)",
      isJson: false
    };
  }

  const maybeJson =
    normalizedMime.includes("json") || decoded.startsWith("{") || decoded.startsWith("[");

  if (maybeJson) {
    try {
      const parsed = JSON.parse(decoded) as unknown;
      const pretty = JSON.stringify(parsed, null, 2);
      return {
        mime: normalizedMime || "application/json",
        sizeBytes: bytes.byteLength,
        text: pretty,
        isJson: true
      };
    } catch {
      // Fallback to plain text.
    }
  }

  return {
    mime: normalizedMime || "text/plain",
    sizeBytes: bytes.byteLength,
    text: compactText(decoded, RESPONSE_PREVIEW_EXPANDED_CHARS),
    isJson: false
  };
}

function highlightJsonPreview(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replaceAll(/(&quot;[^&]*&quot;)(\s*:)/g, '<span class="json-key">$1</span>$2');
}

function redactPreviewText(value: string): string {
  return value
    .replaceAll(
      /("?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)"?\s*[:=]\s*"?)[^",\s}]+("?)/gi,
      "$1***$2"
    )
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***")
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
}

function renderSummary(): void {
  const model = state.model;

  if (!model || !state.player) {
    refs.summary.innerHTML = `<p class="empty">Load an archive to inspect playback.</p>`;
    refs.compareDetails.textContent = "Load a comparison archive to inspect deltas.";
    return;
  }

  const visibleEventCount = upperBoundByMono(
    model.events,
    state.playheadMono,
    (event) => event.mono
  );
  const visibleErrorCount = prefixValue(model.errorPrefix, visibleEventCount - 1);
  const visibleRequestCount = upperBoundByMono(
    model.waterfall,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visibleShotCount = upperBoundByMono(
    model.screenshots,
    state.playheadMono,
    (entry) => entry.mono
  );

  const compareDelta = state.compareSummary
    ? `<div class="pill">compare event delta ${formatDelta(state.compareSummary.eventDelta)}</div>`
    : "";

  refs.summary.innerHTML = `
    <div class="pill"><strong>${state.player.archive.manifest.mode.toUpperCase()}</strong> mode</div>
    <div class="pill">origin ${escapeHtml(state.player.archive.manifest.site.origin)}</div>
    <div class="pill">playhead ${formatMono(state.playheadMono - model.minMono)}</div>
    <div class="pill">visible events ${visibleEventCount}</div>
    <div class="pill">visible errors ${visibleErrorCount}</div>
    <div class="pill">visible requests ${visibleRequestCount}</div>
    <div class="pill">visible screenshots ${visibleShotCount}</div>
    <div class="pill">all actions ${model.totals.actionSpans}</div>
    ${compareDelta}
  `;

  refs.compareDetails.textContent = state.compareSummary
    ? JSON.stringify(
        {
          eventDelta: state.compareSummary.eventDelta,
          errorDelta: state.compareSummary.errorDelta,
          requestDelta: state.compareSummary.requestDelta,
          durationDeltaMs: Number(state.compareSummary.durationDeltaMs.toFixed(2)),
          topTypeDeltas: state.compareSummary.typeDeltas.slice(0, 10)
        },
        null,
        2
      )
    : "Load a comparison archive to inspect event deltas.";
}

function renderPanels(): void {
  renderPanelTabs();

  if (!state.model) {
    state.timelineRows = [];
    refs.timelineList.innerHTML = "";
    refs.eventDetails.textContent = "Select a timeline event to inspect payload details.";
    refs.waterfallBody.innerHTML = "";
    refs.requestDetails.textContent = "Select a request row to inspect network details.";
    refs.consoleList.innerHTML = "";
    refs.realtimeList.innerHTML = "";
    refs.storageList.innerHTML = "";
    refs.perfList.innerHTML = "";
    refs.filmstripList.innerHTML = "";
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    return;
  }

  renderTimeline();
  renderEventDetails();
  renderWaterfall();
  renderConsoleSignals();
  renderRealtimeSignals();
  renderStorageSignals();
  renderPerfSignals();
  renderFilmstripList();
}

function renderTimeline(): void {
  const model = state.model;

  if (!model) {
    state.timelineRows = [];
    refs.timelineList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.events, state.playheadMono, (event) => event.mono);
  const filtered = applyTimelineFilters(model, visibleCount);

  if (filtered.length === 0) {
    state.timelineRows = [];
    state.selectedEventId = null;
    refs.timelineList.innerHTML = `<li class="empty">No timeline events at current filters.</li>`;
    return;
  }

  if (!state.selectedEventId || !filtered.some((event) => event.id === state.selectedEventId)) {
    state.selectedEventId = filtered[filtered.length - 1]?.id ?? null;
  }

  state.timelineRows =
    filtered.length > MAX_TIMELINE_ROWS ? filtered.slice(-MAX_TIMELINE_ROWS) : filtered;
  renderTimelineWindow();
}

function renderTimelineWindow(): void {
  const rows = state.timelineRows;

  if (rows.length === 0) {
    return;
  }

  if (rows.length <= TIMELINE_VIRTUALIZE_AFTER) {
    refs.timelineList.innerHTML = rows.map((event) => renderTimelineRow(event)).join("");
    return;
  }

  if (state.isPlaying) {
    const viewport = Math.max(refs.timelineList.clientHeight, TIMELINE_ROW_HEIGHT * 8);
    const maxScrollTop = Math.max(0, rows.length * TIMELINE_ROW_HEIGHT - viewport);
    refs.timelineList.scrollTop = maxScrollTop;
  }

  const viewportHeight = Math.max(refs.timelineList.clientHeight, TIMELINE_ROW_HEIGHT * 8);
  const start = Math.max(
    0,
    Math.floor(refs.timelineList.scrollTop / TIMELINE_ROW_HEIGHT) - TIMELINE_OVERSCAN
  );
  const visibleCount = Math.ceil(viewportHeight / TIMELINE_ROW_HEIGHT) + TIMELINE_OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);
  const topPad = start * TIMELINE_ROW_HEIGHT;
  const bottomPad = Math.max(0, (rows.length - end) * TIMELINE_ROW_HEIGHT);
  const fragment = rows
    .slice(start, end)
    .map((event) => renderTimelineRow(event))
    .join("");
  const topSpacer = topPad > 0 ? `<li class="virtual-spacer" style="height:${topPad}px"></li>` : "";
  const bottomSpacer =
    bottomPad > 0 ? `<li class="virtual-spacer" style="height:${bottomPad}px"></li>` : "";

  refs.timelineList.innerHTML = `${topSpacer}${fragment}${bottomSpacer}`;
}

function renderTimelineRow(event: WebBlackboxEvent): string {
  const selectedClass = state.selectedEventId === event.id ? "selected" : "";
  return `<li class="event-row"><button data-event-id="${escapeHtml(event.id)}" class="event ${selectedClass}">
        <span class="tag">${escapeHtml(event.type)}</span>
        <span class="mono">${event.mono.toFixed(2)}ms</span>
        <span class="id">${escapeHtml(event.id)}</span>
      </button></li>`;
}

function renderEventDetails(): void {
  const model = state.model;

  if (!model) {
    refs.eventDetails.textContent = "Select a timeline event to inspect payload details.";
    return;
  }

  const eventId = state.selectedEventId;

  if (!eventId) {
    refs.eventDetails.textContent = "Select a timeline event to inspect payload details.";
    return;
  }

  const selected = model.eventById.get(eventId);

  if (!selected || selected.mono > state.playheadMono) {
    refs.eventDetails.textContent = "Selected event is outside the current playhead range.";
    return;
  }

  refs.eventDetails.textContent = JSON.stringify(selected, null, 2);
}

function renderWaterfall(): void {
  const model = state.model;
  const player = state.player;

  if (!model || !player) {
    refs.waterfallBody.innerHTML = "";
    refs.requestDetails.textContent = "Select a request row to inspect network details.";
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    return;
  }

  const visibleCount = upperBoundByMono(
    model.waterfall,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visible = model.waterfall.slice(0, visibleCount);

  if (visible.length === 0) {
    state.selectedRequestId = null;
    refs.waterfallBody.innerHTML = "";
    refs.requestDetails.textContent = "No requests at current playhead.";
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    return;
  }

  if (
    !state.selectedRequestId ||
    !visible.some((entry) => entry.reqId === state.selectedRequestId)
  ) {
    state.selectedRequestId = visible[visible.length - 1]?.reqId ?? null;
  }

  const rendered = visible.slice(-MAX_WATERFALL_ROWS);

  refs.waterfallBody.innerHTML = rendered
    .map((entry) => {
      const status = entry.failed ? "FAILED" : String(entry.status ?? "-");
      const selectedClass = state.selectedRequestId === entry.reqId ? "selected" : "";
      return `<tr class="${selectedClass}">
        <td><button class="waterfall-btn" data-req-id="${escapeHtml(entry.reqId)}">${escapeHtml(shortUrl(entry.url))}</button></td>
        <td>${escapeHtml(status)}</td>
        <td>${entry.durationMs.toFixed(1)}ms</td>
        <td>${escapeHtml(entry.actionId ?? "-")}</td>
      </tr>`;
    })
    .join("");

  const selectedReqId = state.selectedRequestId;
  const selectedEntry = selectedReqId ? (model.waterfallByReqId.get(selectedReqId) ?? null) : null;

  if (!selectedEntry) {
    refs.requestDetails.textContent = "No request selected.";
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    return;
  }

  const linkedEvents = player
    .getRequestEvents(selectedEntry.reqId)
    .filter((event) => event.mono <= state.playheadMono)
    .map((event) => ({
      id: event.id,
      type: event.type,
      mono: event.mono,
      data: event.data
    }));

  refs.requestDetails.textContent = JSON.stringify(
    {
      request: selectedEntry,
      linkedEvents
    },
    null,
    2
  );

  refs.copyCurl.disabled = false;
  refs.copyFetch.disabled = false;
}

function renderConsoleSignals(): void {
  const model = state.model;

  if (!model) {
    refs.consoleList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.events, state.playheadMono, (event) => event.mono);
  const scoped = model.events
    .slice(0, visibleCount)
    .filter((event) => event.type.startsWith("error.") || event.type.startsWith("console."));

  renderSignalEvents(refs.consoleList, scoped);
}

function renderRealtimeSignals(): void {
  const model = state.model;

  if (!model) {
    refs.realtimeList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.realtime, state.playheadMono, (event) => event.mono);
  const scoped = model.realtime.slice(Math.max(0, visibleCount - MAX_SIGNAL_ROWS), visibleCount);

  refs.realtimeList.innerHTML = scoped
    .map((entry) => {
      const direction = entry.direction ? `${entry.direction} ` : "";
      const preview = entry.payloadPreview
        ? entry.payloadPreview.length > 120
          ? `${entry.payloadPreview.slice(0, 120)}...`
          : entry.payloadPreview
        : "(no payload)";

      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="signal-text">${escapeHtml(direction)}${escapeHtml(entry.streamId ?? "-")} @ ${entry.mono.toFixed(2)}ms ${escapeHtml(preview)}</span></li>`;
    })
    .join("");
}

function renderStorageSignals(): void {
  const model = state.model;

  if (!model) {
    refs.storageList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.storage, state.playheadMono, (entry) => entry.mono);
  const scoped = model.storage.slice(Math.max(0, visibleCount - MAX_SIGNAL_ROWS), visibleCount);

  refs.storageList.innerHTML = scoped
    .map((entry) => {
      const operation = entry.operation ? `${entry.operation} ` : "";
      const hash = entry.hash ? ` hash=${entry.hash}` : "";
      const summary = `${entry.kind} ${operation}@ ${entry.mono.toFixed(2)}ms${hash}`;
      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="signal-text">${escapeHtml(summary)}</span></li>`;
    })
    .join("");
}

function renderPerfSignals(): void {
  const model = state.model;

  if (!model) {
    refs.perfList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.perf, state.playheadMono, (entry) => entry.mono);
  const scoped = model.perf.slice(Math.max(0, visibleCount - MAX_SIGNAL_ROWS), visibleCount);

  refs.perfList.innerHTML = scoped
    .map((entry) => {
      const size = typeof entry.size === "number" ? ` size=${entry.size}` : "";
      const hash = entry.hash ? ` hash=${entry.hash}` : "";
      const summary = `${entry.kind} @ ${entry.mono.toFixed(2)}ms${size}${hash}`;
      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="signal-text">${escapeHtml(summary)}</span></li>`;
    })
    .join("");
}

function renderFilmstripList(): void {
  const model = state.model;

  if (!model || model.screenshots.length === 0) {
    refs.filmstripList.innerHTML = `<li class="empty">No screenshot events in this archive.</li>`;
    return;
  }

  const currentShot = resolveShotForMono(model.screenshots, state.playheadMono);
  const rendered = model.screenshots.slice(-MAX_SHOT_BUTTONS);

  refs.filmstripList.innerHTML = rendered
    .map((shot) => {
      const selected = currentShot && currentShot.eventId === shot.eventId ? "active" : "";
      return `<li><button data-shot-event="${escapeHtml(shot.eventId)}" class="shot-btn ${selected}">${formatMono(shot.mono - model.minMono)}</button></li>`;
    })
    .join("");
}

async function syncScreenshotForPlayhead(forceReload: boolean): Promise<void> {
  const model = state.model;
  const player = state.player;

  if (!model || !player) {
    clearScreenshotView("Load an archive to start playback.");
    return;
  }

  const shot = resolveShotForMono(model.screenshots, state.playheadMono);

  if (!shot) {
    clearScreenshotView("No screenshot available before this playhead.");
    return;
  }

  const shotChanged = forceReload || state.screenshotShotId !== shot.shotId;
  state.screenshotContext = shot.context;

  if (shotChanged) {
    state.screenshotShotId = shot.shotId;
    refs.stagePlaceholder.hidden = false;
    refs.stagePlaceholder.textContent = "Loading screenshot...";

    const token = ++state.screenshotLoadToken;
    const url = await getScreenshotUrlByShotId(shot.shotId);

    if (token !== state.screenshotLoadToken || state.screenshotShotId !== shot.shotId) {
      return;
    }

    if (!url) {
      clearScreenshotView(`Missing screenshot blob: ${shot.shotId}`);
      return;
    }

    refs.preview.src = url;
    updateStagePlaceholder();
  }

  state.screenshotTrail = buildScreenshotTrail(model.pointers, state.playheadMono);
  state.screenshotMarker = resolveScreenshotMarker(model.pointers, state.playheadMono, shot.marker);
  refs.filmstripMeta.textContent = describeScreenshotMeta(
    state.screenshotMarker,
    state.screenshotTrail
  );
  renderScreenshotOverlay();
}

function renderScreenshotOverlay(): void {
  renderScreenshotTrail();
  renderScreenshotMarker();
}

function renderScreenshotMarker(): void {
  const cursor = document.getElementById("filmstrip-cursor") as HTMLDivElement | null;

  if (!cursor || !state.screenshotMarker || !refs.preview.getAttribute("src")) {
    if (cursor) {
      cursor.hidden = true;
    }

    return;
  }

  const marker = state.screenshotMarker;
  const imageWidth = refs.preview.clientWidth;
  const imageHeight = refs.preview.clientHeight;
  const sourceWidth =
    marker.viewportWidth ?? state.screenshotContext?.viewportWidth ?? refs.preview.naturalWidth;
  const sourceHeight =
    marker.viewportHeight ?? state.screenshotContext?.viewportHeight ?? refs.preview.naturalHeight;

  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    refs.preview.naturalWidth <= 0 ||
    refs.preview.naturalHeight <= 0
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
  const trailSvg = document.getElementById("filmstrip-trail-svg") as SVGSVGElement | null;

  if (!trailSvg || !refs.preview.getAttribute("src") || state.screenshotTrail.length === 0) {
    if (trailSvg) {
      trailSvg.innerHTML = "";
    }

    return;
  }

  const imageWidth = refs.preview.clientWidth;
  const imageHeight = refs.preview.clientHeight;
  const sourceWidth = state.screenshotContext?.viewportWidth ?? refs.preview.naturalWidth;
  const sourceHeight = state.screenshotContext?.viewportHeight ?? refs.preview.naturalHeight;

  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    refs.preview.naturalWidth <= 0 ||
    refs.preview.naturalHeight <= 0
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

  const tailPoint = projected[projected.length - 1];
  const tailDot = tailPoint
    ? `<circle class="preview-trail-point preview-trail-point-tail" cx="${tailPoint.x.toFixed(2)}" cy="${tailPoint.y.toFixed(2)}" r="3"></circle>`
    : "";

  trailSvg.setAttribute("viewBox", `0 0 ${imageWidth} ${imageHeight}`);
  trailSvg.innerHTML = `<polyline class="preview-trail-line" points="${polylinePoints}"></polyline>${clickDots}${tailDot}`;
}

function clearScreenshotView(message: string): void {
  state.screenshotShotId = null;
  state.screenshotContext = null;
  state.screenshotMarker = null;
  state.screenshotTrail = [];
  refs.preview.removeAttribute("src");
  refs.filmstripMeta.textContent = message;
  refs.stagePlaceholder.hidden = false;
  refs.stagePlaceholder.textContent = message;
  renderScreenshotOverlay();
}

function updateStagePlaceholder(): void {
  const hasSource = Boolean(refs.preview.getAttribute("src") || refs.preview.currentSrc);
  const hasRenderedImage =
    hasSource &&
    refs.preview.complete &&
    refs.preview.naturalWidth > 0 &&
    refs.preview.naturalHeight > 0;

  refs.stagePlaceholder.hidden = hasRenderedImage;

  if (hasRenderedImage) {
    return;
  }

  if (hasSource) {
    refs.stagePlaceholder.textContent = "Loading screenshot...";
    return;
  }

  if (!refs.stagePlaceholder.textContent) {
    refs.stagePlaceholder.textContent = "No screenshot loaded.";
  }
}

function resetScreenshotResources(): void {
  state.screenshotLoadToken += 1;
  hideProgressHover();

  for (const url of state.screenshotUrlCache.values()) {
    URL.revokeObjectURL(url);
  }

  state.screenshotUrlCache.clear();
  clearScreenshotView("Load an archive to start playback.");
}

function applyTimelineFilters(model: ArchiveModel, visibleCount: number): WebBlackboxEvent[] {
  const text = state.textFilter.trim().toLowerCase();
  const filterType = state.typeFilter;

  if (!text && filterType === "all") {
    return model.events.slice(0, visibleCount);
  }

  const filtered: WebBlackboxEvent[] = [];

  for (let index = 0; index < visibleCount; index += 1) {
    const event = model.events[index];

    if (!event) {
      continue;
    }

    if (!matchesTypeFilter(event, filterType)) {
      continue;
    }

    if (text && !model.eventSearchText[index]?.includes(text)) {
      continue;
    }

    filtered.push(event);
  }

  return filtered;
}

function matchesTypeFilter(event: WebBlackboxEvent, filterType: TimelineFilter): boolean {
  if (filterType === "all") {
    return true;
  }

  if (filterType === "errors") {
    return event.type.startsWith("error.");
  }

  if (filterType === "network") {
    return event.type.startsWith("network.");
  }

  if (filterType === "storage") {
    return event.type.startsWith("storage.");
  }

  if (filterType === "console") {
    return event.type.startsWith("console.") || event.type.startsWith("error.");
  }

  return true;
}

function buildArchiveModel(player: WebBlackboxPlayer): ArchiveModel {
  const events = [...player.events].sort(
    (left, right) => left.mono - right.mono || left.t - right.t
  );
  const eventById = new Map<string, WebBlackboxEvent>();
  const eventSearchText: string[] = [];
  const errorPrefix: number[] = [];
  const requestPrefix: number[] = [];
  const screenshots: ScreenshotRecord[] = [];
  const shotByEventId = new Map<string, ScreenshotRecord>();
  const pointers: PointerSample[] = [];

  let errorCount = 0;
  let requestCount = 0;

  for (const event of events) {
    eventById.set(event.id, event);

    if (event.type.startsWith("error.")) {
      errorCount += 1;
    }

    if (event.type === "network.request") {
      requestCount += 1;
    }

    errorPrefix.push(errorCount);
    requestPrefix.push(requestCount);
    eventSearchText.push(buildEventSearchText(event));

    const data = asRecord(event.data);

    if (event.type === "screen.screenshot") {
      const shotId = asString(data?.shotId);

      if (shotId) {
        const shot: ScreenshotRecord = {
          eventId: event.id,
          mono: event.mono,
          shotId,
          marker: readScreenshotMarker(data),
          context: readScreenshotContext(data, event)
        };

        screenshots.push(shot);
        shotByEventId.set(shot.eventId, shot);
      }
    }

    if (
      event.type === "user.mousemove" ||
      event.type === "user.click" ||
      event.type === "user.dblclick"
    ) {
      const x = asFiniteNumber(data?.x);
      const y = asFiniteNumber(data?.y);

      if (x === null || y === null) {
        continue;
      }

      const click = event.type === "user.click" || event.type === "user.dblclick";
      pointers.push({
        mono: event.mono,
        x,
        y,
        click,
        reason: click ? "action:click" : "pointer:move"
      });
    }
  }

  screenshots.sort((left, right) => left.mono - right.mono);
  pointers.sort((left, right) => left.mono - right.mono);

  const waterfall = player
    .getNetworkWaterfall()
    .sort((left, right) => left.startMono - right.startMono);
  const waterfallByReqId = new Map<string, NetworkWaterfallEntry>();

  for (const entry of waterfall) {
    waterfallByReqId.set(entry.reqId, entry);
  }

  const derived = player.buildDerived();
  const minMono = events[0]?.mono ?? 0;
  const maxMono = events[events.length - 1]?.mono ?? 0;
  const progressMarkers = buildProgressMarkers(events, minMono, maxMono);

  return {
    events,
    eventById,
    eventSearchText,
    errorPrefix,
    requestPrefix,
    screenshots,
    shotByEventId,
    pointers,
    waterfall,
    waterfallByReqId,
    realtime: player.getRealtimeNetworkTimeline(),
    storage: player.getStorageTimeline(),
    perf: player.getPerformanceArtifacts(),
    progressMarkers,
    minMono,
    maxMono,
    durationMono: Math.max(0, maxMono - minMono),
    totals: {
      events: derived.totals.events,
      errors: derived.totals.errors,
      requests: derived.totals.requests,
      actionSpans: derived.actionSpans.length
    }
  };
}

function buildEventSearchText(event: WebBlackboxEvent): string {
  const refText = event.ref ? JSON.stringify(event.ref) : "";
  const dataText = event.data ? JSON.stringify(event.data) : "";
  return `${event.id} ${event.type} ${refText} ${dataText}`.toLowerCase();
}

function buildProgressMarkers(
  events: WebBlackboxEvent[],
  minMono: number,
  maxMono: number
): ProgressMarker[] {
  if (events.length === 0) {
    return [];
  }

  const buckets: Record<ProgressMarkerKind, number[]> = {
    error: [],
    network: [],
    screenshot: [],
    action: []
  };

  for (const event of events) {
    if (event.type.startsWith("error.")) {
      buckets.error.push(event.mono);
      continue;
    }

    if (event.type === "network.request") {
      buckets.network.push(event.mono);
      continue;
    }

    if (event.type === "screen.screenshot") {
      buckets.screenshot.push(event.mono);
      continue;
    }

    if (ACTION_MARKER_TYPES.has(event.type)) {
      buckets.action.push(event.mono);
    }
  }

  const durationMono = Math.max(0, maxMono - minMono);
  const markers: ProgressMarker[] = [];

  for (const kind of Object.keys(buckets) as ProgressMarkerKind[]) {
    const sampled = compactMarkerMonos(buckets[kind], durationMono);

    for (const mono of sampled) {
      markers.push({
        mono,
        kind
      });
    }
  }

  return markers.sort((left, right) => left.mono - right.mono);
}

function compactMarkerMonos(monos: number[], durationMono: number): number[] {
  if (monos.length === 0) {
    return [];
  }

  const sorted = [...monos].sort((left, right) => left - right);
  const minGap = durationMono > 0 ? Math.max(40, durationMono / 500) : 40;
  const compacted: number[] = [];

  for (const mono of sorted) {
    const last = compacted[compacted.length - 1];

    if (last === undefined || mono - last >= minGap) {
      compacted.push(mono);
    }
  }

  if (compacted.length <= MAX_PROGRESS_MARKERS_PER_KIND) {
    return compacted;
  }

  const step = Math.ceil(compacted.length / MAX_PROGRESS_MARKERS_PER_KIND);
  return compacted.filter((_, index) => index % step === 0 || index === compacted.length - 1);
}

function buildScreenshotTrail(
  points: PointerSample[],
  playheadMono: number
): ScreenshotTrailPoint[] {
  if (points.length === 0) {
    return [];
  }

  const startMono = playheadMono - TRAIL_WINDOW_MS;
  const startIndex = lowerBoundByMono(points, startMono, (point) => point.mono);
  const endIndex = upperBoundByMono(points, playheadMono, (point) => point.mono);
  const scoped = points.slice(startIndex, endIndex);

  if (scoped.length === 0) {
    return [];
  }

  const mapped = scoped.map((point) => ({
    x: point.x,
    y: point.y,
    mono: point.mono,
    click: point.click
  }));

  if (mapped.length <= MAX_TRAIL_POINTS) {
    return mapped;
  }

  const step = Math.ceil(mapped.length / MAX_TRAIL_POINTS);

  return mapped.filter((_, index) => index % step === 0 || index === mapped.length - 1);
}

function resolveScreenshotMarker(
  points: PointerSample[],
  playheadMono: number,
  fallback: ScreenshotMarker | null
): ScreenshotMarker | null {
  const index = upperBoundByMono(points, playheadMono, (point) => point.mono) - 1;
  const latest = index >= 0 ? points[index] : undefined;

  if (latest) {
    return {
      x: latest.x,
      y: latest.y,
      reason: latest.reason
    };
  }

  return fallback
    ? {
        ...fallback
      }
    : null;
}

function resolveShotForMono(
  screenshots: ScreenshotRecord[],
  mono: number
): ScreenshotRecord | null {
  if (screenshots.length === 0) {
    return null;
  }

  const end = upperBoundByMono(screenshots, mono, (entry) => entry.mono) - 1;

  if (end < 0) {
    return null;
  }

  return screenshots[end] ?? null;
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
    reason: asString(data?.reason) ?? undefined
  };
}

function readScreenshotContext(
  data: Record<string, unknown> | null,
  event: WebBlackboxEvent
): ScreenshotRenderContext | null {
  const viewport = asRecord(data?.viewport);
  const widthFromViewport = asFiniteNumber(viewport?.width);
  const heightFromViewport = asFiniteNumber(viewport?.height);
  const widthFromLegacy = asFiniteNumber(data?.w);
  const heightFromLegacy = asFiniteNumber(data?.h);

  if (
    widthFromViewport === null &&
    heightFromViewport === null &&
    widthFromLegacy === null &&
    heightFromLegacy === null
  ) {
    return {
      mono: event.mono
    };
  }

  return {
    mono: event.mono,
    viewportWidth: widthFromViewport ?? widthFromLegacy ?? undefined,
    viewportHeight: heightFromViewport ?? heightFromLegacy ?? undefined
  };
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

function renderSignalEvents(container: HTMLElement, events: WebBlackboxEvent[]): void {
  const scoped = events.slice(-MAX_SIGNAL_ROWS);

  container.innerHTML = scoped
    .map((event) => {
      const payload = JSON.stringify(event.data);
      const text = payload.length > 120 ? `${payload.slice(0, 120)}...` : payload;
      return `<li class="signal"><span class="signal-type">${escapeHtml(event.type)}</span><span class="signal-text">${escapeHtml(text)}</span></li>`;
    })
    .join("");
}

async function getScreenshotUrlByShotId(shotId: string): Promise<string | null> {
  const cached = state.screenshotUrlCache.get(shotId);

  if (cached) {
    return cached;
  }

  const player = state.player;

  if (!player) {
    return null;
  }

  const blob = await player.getBlob(shotId);

  if (!blob) {
    return null;
  }

  const bytes = new Uint8Array(blob.bytes.byteLength);
  bytes.set(blob.bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: blob.mime }));
  state.screenshotUrlCache.set(shotId, url);
  return url;
}

async function copySelectedRequestAsCurl(): Promise<void> {
  const player = state.player;
  const reqId = state.selectedRequestId;

  if (!player || !reqId) {
    return;
  }

  const curl = player.generateCurl(reqId);

  if (!curl) {
    return;
  }

  await copyText(curl);
  setFeedback(`Copied cURL for ${reqId}`);
}

async function copySelectedRequestAsFetch(): Promise<void> {
  const player = state.player;
  const reqId = state.selectedRequestId;

  if (!player || !reqId) {
    return;
  }

  const fetchSnippet = player.generateFetch(reqId);

  if (!fetchSnippet) {
    return;
  }

  await copyText(fetchSnippet);
  setFeedback(`Copied fetch snippet for ${reqId}`);
}

async function copyProgressHoverResponse(): Promise<void> {
  const payload = state.responseCopyText;

  if (!payload) {
    return;
  }

  try {
    await copyText(payload);
  } catch {
    setFeedback("Failed to copy response preview.");
    return;
  }

  refs.progressHoverResponseCopy.textContent = "Copied";
  setFeedback("Copied response preview.");
  const token = state.progressHoverToken;

  window.setTimeout(() => {
    if (token !== state.progressHoverToken || refs.progressHoverResponseCopy.disabled) {
      return;
    }

    refs.progressHoverResponseCopy.textContent = "Copy";
  }, 1200);
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

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function setFeedback(text: string): void {
  state.feedback = text;
  refs.feedback.textContent = text;
}

function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}` || raw;
  } catch {
    return raw;
  }
}

function truncateId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 9)}...${value.slice(-8)}` : value;
}

function prefixValue(prefix: number[], index: number): number {
  if (index < 0) {
    return 0;
  }

  const value = prefix[index];
  return typeof value === "number" ? value : 0;
}

function upperBoundByMono<T>(items: T[], mono: number, pickMono: (item: T) => number): number {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];

    if (!item) {
      high = mid;
      continue;
    }

    if (pickMono(item) <= mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function lowerBoundByMono<T>(items: T[], mono: number, pickMono: (item: T) => number): number {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];

    if (!item) {
      high = mid;
      continue;
    }

    if (pickMono(item) < mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function formatMono(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDelta(delta: number): string {
  if (delta > 0) {
    return `+${delta}`;
  }

  return String(delta);
}

function markerKindToPanel(kind: ProgressMarkerKind | undefined): LogPanelKey | null {
  if (!kind) {
    return null;
  }

  if (kind === "error") {
    return "console";
  }

  if (kind === "network") {
    return "network";
  }

  if (kind === "screenshot") {
    return "timeline";
  }

  if (kind === "action") {
    return "timeline";
  }

  return null;
}

function compactText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function readPointerRatio(event: PointerEvent, container: HTMLElement): number {
  const rect = container.getBoundingClientRect();

  if (rect.width <= 0) {
    return 0;
  }

  const offset = event.clientX - rect.left;
  return Math.max(0, Math.min(1, offset / rect.width));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
