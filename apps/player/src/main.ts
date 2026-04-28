import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  type ActionSpan,
  type ActionTimelineEntry,
  type NetworkWaterfallEntry,
  type PerformanceArtifactEntry,
  type PlayerComparison,
  type RealtimeNetworkEntry,
  type StorageTimelineEntry,
  WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { hasFilePayload, pickArchiveFile } from "./lib/archive-files.js";
import { toArrayBuffer } from "./lib/binary.js";
import { formatCompareSummary } from "./lib/compare-summary.js";
import { escapeHtml, getElement } from "./lib/dom.js";
import { copyText, downloadTextFile } from "./lib/export.js";
import { formatDelta, formatMono, formatTimelineEventLabel } from "./lib/format.js";
import { openDialog } from "./lib/dialog.js";
import {
  applyPlayerDocumentLocale,
  createPlayerI18n,
  detectPlayerLocale,
  storePlayerLocale
} from "./lib/i18n.js";
import { describeRequestName, resolveNetworkInitiator } from "./lib/network-labels.js";
import { clamp, readPointerRatio } from "./lib/math.js";
import { sha256HexFromText } from "./lib/hash.js";
import { formatByteSize, formatNetworkSize, sumNetworkTransferBytes } from "./lib/network-size.js";
import {
  applyNetworkViewFilters,
  describeNetworkStatus,
  resolveNetworkStatusClass,
  resolveNetworkTypeLabel,
  sortNetworkEntries,
  type NetworkSortDirection,
  type NetworkSortKey,
  type NetworkStatusFilter,
  type NetworkTypeFilter
} from "./lib/network-view.js";
import { asFiniteNumber, asRecord } from "./lib/parsing.js";
import { markerKindToPanel } from "./lib/progress.js";
import { normalizePlaybackEvents, type PlaybackTimeNormalization } from "./lib/playback-time.js";
import { generatePlaywrightScriptFromEvents } from "./lib/playwright-script.js";
import { lowerBoundByMono, prefixValue, upperBoundByMono } from "./lib/range.js";
import { createReplayHeaders as buildReplayHeaders, shouldAttachReplayBody } from "./lib/replay.js";
import { decodeResponsePreview, type ResponsePreview } from "./lib/response-decoder.js";
import { highlightJsonPreview, redactPreviewText } from "./lib/response-preview.js";
import {
  buildActionScopeIndex,
  extractReqIdFromEvent,
  inferEventScope,
  mergeEventScopes,
  matchesScopeFilter,
  type EventScope,
  type ScopeFilter
} from "./lib/scope.js";
import {
  bindShareApiKeyInputToTargetOrigin,
  getShareServerApiKeyForBaseUrl,
  setShareServerApiKeyForBaseUrl
} from "./lib/share-api-key.js";
import {
  normalizeShareServerBaseUrl,
  resolveShareArchiveRequest,
  resolveShareServerOrigin
} from "./lib/share.js";
import {
  readScreenshotContext,
  readScreenshotMarker,
  readScreenshotShotId
} from "./lib/screenshot-data.js";
import { describeScreenshotMeta } from "./lib/screenshot-description.js";
import { buildActionSearchText, buildEventSearchText } from "./lib/search-text.js";
import { uploadArchiveWithProgress } from "./lib/share-upload.js";
import {
  buildConsoleSignalSearchText,
  readEventSummaryText,
  stringifySignalPayload
} from "./lib/signal-text.js";
import {
  readStoredNumber,
  readStoredText,
  removeStoredItem,
  writeStoredNumber,
  writeStoredText
} from "./lib/storage.js";
import { compactText, shortUrl, truncateId } from "./lib/text.js";
import { computeTriageStats, findFirstErrorEvent, findSlowestRequest } from "./lib/triage.js";
import { PlayerShell, type PlayerShellProps } from "./shell.js";

type TimelineFilter = "all" | "errors" | "network" | "storage" | "console";
type LogPanelKey =
  | "timeline"
  | "details"
  | "actions"
  | "network"
  | "compare"
  | "console"
  | "realtime"
  | "storage"
  | "perf";

const locale = detectPlayerLocale();
const i18n = createPlayerI18n(locale);

applyPlayerDocumentLocale(locale);

const PANEL_LABELS: Record<LogPanelKey, string> = {
  timeline: i18n.formatPanelLabel("timeline"),
  details: i18n.formatPanelLabel("details"),
  actions: i18n.formatPanelLabel("actions"),
  network: i18n.formatPanelLabel("network"),
  compare: i18n.formatPanelLabel("compare"),
  console: i18n.formatPanelLabel("console"),
  realtime: i18n.formatPanelLabel("realtime"),
  storage: i18n.formatPanelLabel("storage"),
  perf: i18n.formatPanelLabel("perf")
};

const PANEL_SHORTCUT_BY_CODE: Record<string, LogPanelKey> = {
  Digit1: "details",
  Digit2: "actions",
  Digit3: "network",
  Digit4: "compare",
  Digit5: "console",
  Digit6: "realtime",
  Digit7: "storage",
  Digit8: "perf"
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
  reason: string | null;
  format: string | null;
  size: number | null;
  marker: ScreenshotMarker | null;
  context: ScreenshotRenderContext | null;
};

type ArchiveModel = {
  events: WebBlackboxEvent[];
  eventScopeById: Map<string, EventScope>;
  actionTimeline: ActionTimelineEntry[];
  actionScopeByActId: Map<string, EventScope>;
  actionSearchText: string[];
  consoleSignals: WebBlackboxEvent[];
  consoleSignalSearchText: string[];
  eventById: Map<string, WebBlackboxEvent>;
  eventSearchText: string[];
  errorPrefix: number[];
  requestPrefix: number[];
  screenshots: ScreenshotRecord[];
  shotByEventId: Map<string, ScreenshotRecord>;
  pointers: PointerSample[];
  waterfall: NetworkWaterfallEntry[];
  waterfallByReqId: Map<string, NetworkWaterfallEntry>;
  requestScopeByReqId: Map<string, EventScope>;
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
  compareModel: ArchiveModel | null;
  compareSummary: PlayerComparison | null;
  model: ArchiveModel | null;
  loadedArchiveBytes: Uint8Array | null;
  loadedArchiveName: string | null;
  shareServerBaseUrl: string;
  shareServerApiKeysByOrigin: Record<string, string>;
  selectedEventId: string | null;
  selectedActionId: string | null;
  selectedRequestId: string | null;
  textFilter: string;
  typeFilter: TimelineFilter;
  scopeFilter: ScopeFilter;
  consoleFilter: string;
  networkView: {
    query: string;
    method: string;
    status: NetworkStatusFilter;
    type: NetworkTypeFilter;
    scope: ScopeFilter;
    sortKey: NetworkSortKey;
    sortDirection: NetworkSortDirection;
  };
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
  quickTriageAutoDismissMs: number;
  preflightDismissTimer: number | null;
};

type SetPlayheadOptions = {
  fromPlayback?: boolean;
  forcePanels?: boolean;
};

const MAX_TIMELINE_ROWS = 20_000;
const MAX_ACTION_ROWS = 2_000;
const MAX_WATERFALL_ROWS = 360;
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
const TRIAGE_SLOW_REQUEST_MS = 1_000;
const QUICK_TRIAGE_AUTO_DISMISS_DEFAULT_SECONDS = 10;
const QUICK_TRIAGE_AUTO_DISMISS_MIN_SECONDS = 1;
const QUICK_TRIAGE_AUTO_DISMISS_MAX_SECONDS = 120;
const RESPONSE_PREVIEW_COLLAPSED_CHARS = 900;
const RESPONSE_PREVIEW_EXPANDED_CHARS = 10_000;
const LOG_GRID_SPLIT_MIN = 26;
const LOG_GRID_SPLIT_MAX = 74;
const LOG_GRID_SPLIT_KEY_STEP = 2;
const LOG_GRID_SPLIT_STORAGE_KEY = "webblackbox.player.logGridSplit";
const QUICK_TRIAGE_AUTO_DISMISS_SECONDS_STORAGE_KEY =
  "webblackbox.player.quickTriageAutoDismissSeconds";
const SHARE_SERVER_BASE_URL_STORAGE_KEY = "webblackbox.player.shareServerBaseUrl";
const SHARE_SERVER_API_KEYS_STORAGE_KEY = "webblackbox.player.shareServerApiKeysByOrigin";
const LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY = "webblackbox.player.shareServerApiKey";
const DEFAULT_SHARE_SERVER_BASE_URL = "http://localhost:8787";
const STAGE_HEIGHT_MIN_PX = 220;
const STAGE_HEIGHT_BOTTOM_GUARD_PX = 280;
const STAGE_HEIGHT_KEY_STEP = 24;
const STAGE_HEIGHT_STORAGE_KEY = "webblackbox.player.stageHeightPx";
const ACTION_MARKER_TYPES = new Set([
  "user.click",
  "user.dblclick",
  "user.keydown",
  "user.submit",
  "user.marker"
]);

const initialShareServerBaseUrl =
  readStoredText(SHARE_SERVER_BASE_URL_STORAGE_KEY) ?? DEFAULT_SHARE_SERVER_BASE_URL;
const initialShareServerApiKeysByOrigin = readStoredShareServerApiKeys(initialShareServerBaseUrl);

const state: PlayerState = {
  player: null,
  comparePlayer: null,
  compareModel: null,
  compareSummary: null,
  model: null,
  loadedArchiveBytes: null,
  loadedArchiveName: null,
  shareServerBaseUrl: initialShareServerBaseUrl,
  shareServerApiKeysByOrigin: initialShareServerApiKeysByOrigin,
  selectedEventId: null,
  selectedActionId: null,
  selectedRequestId: null,
  textFilter: "",
  typeFilter: "all",
  scopeFilter: "all",
  consoleFilter: "",
  networkView: {
    query: "",
    method: "all",
    status: "all",
    type: "all",
    scope: "all",
    sortKey: "start",
    sortDirection: "asc"
  },
  activePanel: "details",
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
  responseCopyText: "",
  quickTriageAutoDismissMs: readQuickTriageAutoDismissMs(),
  preflightDismissTimer: null
};

function mountPlayerShell(): void {
  const app = document.getElementById("app");

  if (!app) {
    throw new Error("Missing #app root for player.");
  }

  const root = createRoot(app);
  const shellProps: PlayerShellProps = {
    locale
  };
  flushSync(() => {
    root.render(PlayerShell(shellProps));
  });
}

mountPlayerShell();

const refs = {
  playerShell: getElement<HTMLElement>("player-shell"),
  stageCard: getElement<HTMLElement>("stage-card"),
  stageDivider: getElement<HTMLElement>("stage-divider"),
  archiveDropOverlay: getElement<HTMLElement>("archive-drop-overlay"),
  archiveInput: getElement<HTMLInputElement>("archive-input"),
  compareInput: getElement<HTMLInputElement>("compare-input"),
  playerLocale: getElement<HTMLSelectElement>("player-locale"),
  summary: getElement<HTMLElement>("summary"),
  compareDetails: getElement<HTMLElement>("compare-details"),
  compareRegressions: getElement<HTMLElement>("compare-regressions"),
  feedback: getElement<HTMLElement>("feedback"),
  preflightPanel: getElement<HTMLElement>("preflight-panel"),
  preflightMeta: getElement<HTMLElement>("preflight-meta"),
  preflightErrors: getElement<HTMLElement>("preflight-errors"),
  preflightFailedRequests: getElement<HTMLElement>("preflight-failed-requests"),
  preflightSlowRequests: getElement<HTMLElement>("preflight-slow-requests"),
  preflightShots: getElement<HTMLElement>("preflight-shots"),
  preflightActions: getElement<HTMLElement>("preflight-actions"),
  preflightDismiss: getElement<HTMLButtonElement>("preflight-dismiss"),
  preflightOpenPlayer: getElement<HTMLButtonElement>("preflight-open-player"),
  preflightCopyReport: getElement<HTMLButtonElement>("preflight-copy-report"),
  preflightJumpError: getElement<HTMLButtonElement>("preflight-jump-error"),
  preflightJumpSlowest: getElement<HTMLButtonElement>("preflight-jump-slowest"),
  logGrid: getElement<HTMLElement>("log-grid"),
  logGridDivider: getElement<HTMLElement>("log-grid-divider"),
  textFilter: getElement<HTMLInputElement>("text-filter"),
  typeFilter: getElement<HTMLSelectElement>("type-filter"),
  scopeFilter: getElement<HTMLSelectElement>("scope-filter"),
  networkFilter: getElement<HTMLInputElement>("network-filter"),
  networkMethodFilter: getElement<HTMLSelectElement>("network-method-filter"),
  networkStatusFilter: getElement<HTMLSelectElement>("network-status-filter"),
  networkTypeFilter: getElement<HTMLSelectElement>("network-type-filter"),
  networkScopeFilter: getElement<HTMLSelectElement>("network-scope-filter"),
  consoleFilter: getElement<HTMLInputElement>("console-filter"),
  networkScopeSummary: getElement<HTMLElement>("network-scope-summary"),
  networkSummary: getElement<HTMLElement>("network-summary"),
  panelTabs: getElement<HTMLElement>("panel-tabs"),
  playbackToggle: getElement<HTMLButtonElement>("playback-toggle"),
  playbackBack: getElement<HTMLButtonElement>("playback-back"),
  playbackForward: getElement<HTMLButtonElement>("playback-forward"),
  playbackRate: getElement<HTMLSelectElement>("playback-rate"),
  maskResponsePreview: getElement<HTMLInputElement>("mask-response-preview"),
  quickTriageDismissSeconds: getElement<HTMLInputElement>("quick-triage-dismiss-seconds"),
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
  previewWrap: getElement<HTMLElement>("filmstrip-preview-wrap"),
  preview: getElement<HTMLImageElement>("filmstrip-preview"),
  stagePlaceholder: getElement<HTMLElement>("stage-placeholder"),
  filmstripMeta: getElement<HTMLElement>("filmstrip-meta"),
  filmstripList: getElement<HTMLUListElement>("filmstrip-list"),
  timelineList: getElement<HTMLUListElement>("timeline-list"),
  actionsList: getElement<HTMLUListElement>("actions-list"),
  eventDetails: getElement<HTMLElement>("event-details"),
  waterfallBody: getElement<HTMLTableSectionElement>("waterfall-body"),
  requestDetails: getElement<HTMLElement>("request-details"),
  copyCurl: getElement<HTMLButtonElement>("copy-curl"),
  copyFetch: getElement<HTMLButtonElement>("copy-fetch"),
  replayRequest: getElement<HTMLButtonElement>("replay-request"),
  consoleList: getElement<HTMLUListElement>("console-list"),
  realtimeList: getElement<HTMLUListElement>("realtime-list"),
  storageList: getElement<HTMLUListElement>("storage-list"),
  perfList: getElement<HTMLUListElement>("perf-list"),
  exportReport: getElement<HTMLButtonElement>("export-report"),
  exportHar: getElement<HTMLButtonElement>("export-har"),
  exportPlaywright: getElement<HTMLButtonElement>("export-playwright"),
  exportPlaywrightMocks: getElement<HTMLButtonElement>("export-playwright-mocks"),
  exportGitHubIssue: getElement<HTMLButtonElement>("export-github-issue"),
  exportJiraIssue: getElement<HTMLButtonElement>("export-jira-issue"),
  shareUpload: getElement<HTMLButtonElement>("share-upload"),
  loadShareUrl: getElement<HTMLButtonElement>("load-share-url"),
  shareUploadDialog: getElement<HTMLDialogElement>("share-upload-dialog"),
  shareUploadBaseUrl: getElement<HTMLInputElement>("share-upload-base-url"),
  shareUploadPassphrase: getElement<HTMLInputElement>("share-upload-passphrase"),
  shareUploadApiKey: getElement<HTMLInputElement>("share-upload-api-key"),
  shareUploadShowPassphrase: getElement<HTMLInputElement>("share-upload-show-passphrase"),
  shareLoadDialog: getElement<HTMLDialogElement>("share-load-dialog"),
  shareLoadReference: getElement<HTMLInputElement>("share-load-reference"),
  shareLoadApiKey: getElement<HTMLInputElement>("share-load-api-key"),
  archivePassphraseDialog: getElement<HTMLDialogElement>("archive-passphrase-dialog"),
  archivePassphraseContext: getElement<HTMLElement>("archive-passphrase-context"),
  archivePassphraseInput: getElement<HTMLInputElement>("archive-passphrase-input"),
  playwrightPreviewDialog: getElement<HTMLDialogElement>("playwright-preview-dialog"),
  playwrightRangeStart: getElement<HTMLInputElement>("playwright-range-start"),
  playwrightRangeEnd: getElement<HTMLInputElement>("playwright-range-end"),
  playwrightMaxActions: getElement<HTMLInputElement>("playwright-max-actions"),
  playwrightIncludeHar: getElement<HTMLInputElement>("playwright-include-har"),
  playwrightScriptPreview: getElement<HTMLTextAreaElement>("playwright-script-preview"),
  playwrightRefresh: getElement<HTMLButtonElement>("playwright-refresh"),
  playwrightCopy: getElement<HTMLButtonElement>("playwright-copy"),
  playwrightDownload: getElement<HTMLButtonElement>("playwright-download")
};

refs.quickTriageDismissSeconds.value = String(Math.round(state.quickTriageAutoDismissMs / 1_000));

const panelTabButtons = Array.from(
  refs.panelTabs.querySelectorAll<HTMLButtonElement>("button[data-log-panel]")
);
const networkSortButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-wf-sort-key]")
);
const panelCards = Array.from(document.querySelectorAll<HTMLElement>("[data-log-panel-target]"));

bindGlobalActions();
void renderAll({ forcePanels: true, forceScreenshot: true });
void maybeAutoLoadSharedArchiveFromLocation();

function bindGlobalActions(): void {
  bindStageSplitter();
  bindLogGridSplitter();
  bindArchiveDropTarget();

  refs.playerLocale.addEventListener("change", () => {
    const nextLocale = refs.playerLocale.value === "zh-CN" ? "zh-CN" : "en";

    if (nextLocale === locale) {
      return;
    }

    storePlayerLocale(nextLocale);
    window.location.reload();
  });

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

  refs.scopeFilter.addEventListener("change", () => {
    state.scopeFilter = refs.scopeFilter.value as ScopeFilter;
    renderPanels();
    renderSummary();
  });

  refs.networkFilter.addEventListener("input", () => {
    state.networkView.query = refs.networkFilter.value.trim();
    renderWaterfall();
  });

  refs.networkMethodFilter.addEventListener("change", () => {
    state.networkView.method = refs.networkMethodFilter.value;
    renderWaterfall();
  });

  refs.networkStatusFilter.addEventListener("change", () => {
    state.networkView.status = refs.networkStatusFilter.value as NetworkStatusFilter;
    renderWaterfall();
  });

  refs.networkTypeFilter.addEventListener("change", () => {
    state.networkView.type = refs.networkTypeFilter.value as NetworkTypeFilter;
    renderWaterfall();
  });

  refs.networkScopeFilter.addEventListener("change", () => {
    state.networkView.scope = refs.networkScopeFilter.value as ScopeFilter;
    renderWaterfall();
  });

  refs.consoleFilter.addEventListener("input", () => {
    state.consoleFilter = refs.consoleFilter.value.trim().toLowerCase();
    renderConsoleSignals();
  });

  for (const button of networkSortButtons) {
    button.addEventListener("click", () => {
      const sortKey = button.dataset.wfSortKey as NetworkSortKey | undefined;

      if (!sortKey) {
        return;
      }

      if (state.networkView.sortKey === sortKey) {
        state.networkView.sortDirection =
          state.networkView.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.networkView.sortKey = sortKey;
        state.networkView.sortDirection = sortKey === "start" ? "asc" : "desc";
      }

      renderWaterfall();
    });
  }

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

  refs.previewWrap.addEventListener("click", () => {
    if (!state.model) {
      return;
    }

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

  refs.quickTriageDismissSeconds.addEventListener("change", () => {
    const rawSeconds = Number(refs.quickTriageDismissSeconds.value);
    setQuickTriageAutoDismissSeconds(rawSeconds);
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
    state.selectedActionId = null;
    state.selectedEventId = eventId;

    if (state.activePanel !== "details") {
      state.activePanel = "details";
      renderPanelTabs();
    }

    renderEventDetails();
    renderTimeline();
  });

  refs.actionsList.addEventListener("click", (event) => {
    const model = state.model;

    if (!model) {
      return;
    }

    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-action-id]");

    if (!button) {
      return;
    }

    const actionId = button.dataset.actionId;

    if (!actionId) {
      return;
    }

    const action = model.actionTimeline.find((entry) => entry.actId === actionId);

    if (!action) {
      return;
    }

    const firstRequestId = action.requests[0]?.reqId ?? null;
    const targetMono = action.screenshot?.mono ?? action.endMono ?? action.startMono;

    pausePlayback();
    state.selectedActionId = action.actId;
    state.selectedEventId = action.triggerEventId;
    state.selectedRequestId = firstRequestId;

    if (state.activePanel !== "actions") {
      state.activePanel = "actions";
    }

    setPlayhead(targetMono, { forcePanels: true });
  });

  refs.timelineList.addEventListener("scroll", () => {
    if (state.timelineRows.length > TIMELINE_VIRTUALIZE_AFTER) {
      renderTimelineWindow();
    }
  });

  refs.waterfallBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-req-id]");

    if (!row) {
      return;
    }

    const reqId = row.dataset.reqId;

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
    refs.preview.hidden = false;
    updateStagePlaceholder();
    renderScreenshotOverlay();
  });

  refs.preview.addEventListener("error", () => {
    refs.preview.hidden = true;
    clearScreenshotView(i18n.messages.screenshotDecodeFailed);
  });

  window.addEventListener("resize", () => {
    applyStageHeight(getStageHeightPx(), {
      persist: false
    });
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

    if (event.code === "Home" || event.code === "End") {
      const model = state.model;

      if (!model) {
        return;
      }

      event.preventDefault();
      pausePlayback();
      setPlayhead(event.code === "Home" ? model.minMono : model.maxMono, {
        forcePanels: true
      });
      return;
    }

    const shortcutPanel = PANEL_SHORTCUT_BY_CODE[event.code];

    if (shortcutPanel) {
      event.preventDefault();

      if (shortcutPanel !== state.activePanel) {
        state.activePanel = shortcutPanel;
        renderPanels();
        renderSummary();
      }

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

  refs.replayRequest.addEventListener("click", () => {
    void replaySelectedRequest();
  });

  refs.exportReport.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    downloadTextFile("webblackbox-report.md", player.generateBugReport(), "text/markdown");
    setFeedback(i18n.messages.feedbackBugReportExported);
  });

  refs.exportHar.addEventListener("click", () => {
    const player = state.player;

    if (!player) {
      return;
    }

    downloadTextFile("webblackbox-session.har", player.exportHar(), "application/json");
    setFeedback(i18n.messages.feedbackHarExported);
  });

  refs.exportPlaywright.addEventListener("click", () => {
    void openPlaywrightPreviewDialog();
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
    setFeedback(i18n.messages.feedbackGitHubIssueExported);
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
    setFeedback(i18n.messages.feedbackJiraIssueExported);
  });

  refs.shareUpload.addEventListener("click", () => {
    void shareLoadedArchive();
  });

  refs.loadShareUrl.addEventListener("click", () => {
    void loadArchiveFromSharePrompt();
  });

  refs.shareUploadShowPassphrase.addEventListener("change", () => {
    refs.shareUploadPassphrase.type = refs.shareUploadShowPassphrase.checked ? "text" : "password";
  });

  refs.summary.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-summary-jump]");

    if (!button || !state.model) {
      return;
    }

    const jump = button.dataset.summaryJump;

    if (jump === "first-error") {
      jumpToFirstError();
      return;
    }

    if (jump === "slowest-request") {
      jumpToSlowestRequest();
    }
  });

  refs.preflightDismiss.addEventListener("click", () => {
    hideQuickTriagePanel();
  });

  refs.preflightOpenPlayer.addEventListener("click", () => {
    hideQuickTriagePanel();
    setFeedback(i18n.messages.feedbackQuickTriageDismissed);
  });

  refs.preflightCopyReport.addEventListener("click", () => {
    void copyBugReportFromQuickTriage();
  });

  refs.preflightJumpError.addEventListener("click", () => {
    hideQuickTriagePanel();
    jumpToFirstError();
  });

  refs.preflightJumpSlowest.addEventListener("click", () => {
    hideQuickTriagePanel();
    jumpToSlowestRequest();
  });

  refs.playwrightRefresh.addEventListener("click", () => {
    regeneratePlaywrightPreview();
  });

  refs.playwrightCopy.addEventListener("click", () => {
    void copyPlaywrightPreview();
  });

  refs.playwrightDownload.addEventListener("click", () => {
    downloadPlaywrightPreview();
  });

  refs.playwrightRangeStart.addEventListener("change", () => {
    regeneratePlaywrightPreview();
  });

  refs.playwrightRangeEnd.addEventListener("change", () => {
    regeneratePlaywrightPreview();
  });

  refs.playwrightMaxActions.addEventListener("change", () => {
    regeneratePlaywrightPreview();
  });

  refs.playwrightIncludeHar.addEventListener("change", () => {
    regeneratePlaywrightPreview();
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-dialog-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      button.closest("dialog")?.close("cancel");
    });
  });
}

function bindArchiveDropTarget(): void {
  let dragDepth = 0;

  const showOverlay = (): void => {
    refs.archiveDropOverlay.hidden = false;
  };

  const hideOverlay = (): void => {
    refs.archiveDropOverlay.hidden = true;
  };

  window.addEventListener("dragenter", (event) => {
    if (!hasFilePayload(event)) {
      return;
    }

    event.preventDefault();
    dragDepth += 1;
    showOverlay();
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFilePayload(event)) {
      return;
    }

    event.preventDefault();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }

    showOverlay();
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFilePayload(event)) {
      return;
    }

    dragDepth = Math.max(0, dragDepth - 1);

    if (dragDepth === 0) {
      hideOverlay();
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasFilePayload(event)) {
      return;
    }

    event.preventDefault();
    dragDepth = 0;
    hideOverlay();

    const file = pickArchiveFile(event.dataTransfer?.files ?? null);

    if (!file) {
      setFeedback(i18n.messages.feedbackNoSupportedArchive);
      return;
    }

    refs.archiveInput.value = "";
    void loadPrimaryArchiveFile(file);
  });
}

function bindStageSplitter(): void {
  const savedHeight = readStoredNumber(STAGE_HEIGHT_STORAGE_KEY);
  const initialHeight = savedHeight ?? refs.stageCard.getBoundingClientRect().height;
  applyStageHeight(initialHeight, {
    persist: false
  });

  let dragging = false;

  refs.stageDivider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    refs.stageDivider.classList.add("dragging");
    refs.stageDivider.setPointerCapture(event.pointerId);
    updateStageHeightByClientY(event.clientY);
  });

  refs.stageDivider.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }

    updateStageHeightByClientY(event.clientY);
  });

  const stopDragging = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }

    dragging = false;
    refs.stageDivider.classList.remove("dragging");

    if (refs.stageDivider.hasPointerCapture(event.pointerId)) {
      refs.stageDivider.releasePointerCapture(event.pointerId);
    }
  };

  refs.stageDivider.addEventListener("pointerup", (event) => {
    stopDragging(event);
  });

  refs.stageDivider.addEventListener("pointercancel", (event) => {
    stopDragging(event);
  });

  refs.stageDivider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    const current = getStageHeightPx();
    const delta = event.key === "ArrowUp" ? STAGE_HEIGHT_KEY_STEP : -STAGE_HEIGHT_KEY_STEP;
    applyStageHeight(current + delta);
  });
}

function getStageHeightPx(): number {
  const styled = Number.parseFloat(refs.playerShell.style.getPropertyValue("--stage-card-height"));

  if (Number.isFinite(styled) && styled > 0) {
    return styled;
  }

  const measured = refs.stageCard.getBoundingClientRect().height;
  return Number.isFinite(measured) && measured > 0 ? measured : STAGE_HEIGHT_MIN_PX;
}

function applyStageHeight(
  value: number,
  options: {
    persist?: boolean;
  } = {}
): void {
  const clamped = clamp(value, STAGE_HEIGHT_MIN_PX, getStageHeightMaxPx());
  refs.playerShell.style.setProperty("--stage-card-height", `${clamped.toFixed(0)}px`);
  refs.stageDivider.setAttribute("aria-valuemin", String(STAGE_HEIGHT_MIN_PX));
  refs.stageDivider.setAttribute("aria-valuemax", String(Math.round(getStageHeightMaxPx())));
  refs.stageDivider.setAttribute("aria-valuenow", String(Math.round(clamped)));

  if (options.persist !== false) {
    writeStoredNumber(STAGE_HEIGHT_STORAGE_KEY, clamped);
  }
}

function updateStageHeightByClientY(clientY: number): void {
  const bounds = refs.stageCard.getBoundingClientRect();

  if (bounds.height <= 0) {
    return;
  }

  applyStageHeight(clientY - bounds.top);
}

function getStageHeightMaxPx(): number {
  const shellBounds = refs.playerShell.getBoundingClientRect();
  const stageBounds = refs.stageCard.getBoundingClientRect();
  const relativeTop = stageBounds.top - shellBounds.top;
  const maxByViewport = shellBounds.height - relativeTop - STAGE_HEIGHT_BOTTOM_GUARD_PX;
  return Math.max(STAGE_HEIGHT_MIN_PX + STAGE_HEIGHT_KEY_STEP, Math.floor(maxByViewport));
}

function bindLogGridSplitter(): void {
  refs.logGridDivider.setAttribute("aria-valuemin", String(LOG_GRID_SPLIT_MIN));
  refs.logGridDivider.setAttribute("aria-valuemax", String(LOG_GRID_SPLIT_MAX));

  const savedSplit = readStoredNumber(LOG_GRID_SPLIT_STORAGE_KEY);

  if (savedSplit !== null) {
    applyLogGridSplit(savedSplit);
  } else {
    applyLogGridSplit(48);
  }

  let dragging = false;

  refs.logGridDivider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    refs.logGridDivider.classList.add("dragging");
    refs.logGridDivider.setPointerCapture(event.pointerId);
    updateLogGridSplitByClientX(event.clientX);
  });

  refs.logGridDivider.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }

    updateLogGridSplitByClientX(event.clientX);
  });

  const stopDragging = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }

    dragging = false;
    refs.logGridDivider.classList.remove("dragging");

    if (refs.logGridDivider.hasPointerCapture(event.pointerId)) {
      refs.logGridDivider.releasePointerCapture(event.pointerId);
    }
  };

  refs.logGridDivider.addEventListener("pointerup", (event) => {
    stopDragging(event);
  });

  refs.logGridDivider.addEventListener("pointercancel", (event) => {
    stopDragging(event);
  });

  refs.logGridDivider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const current = getLogGridSplit();
    const delta = event.key === "ArrowLeft" ? -LOG_GRID_SPLIT_KEY_STEP : LOG_GRID_SPLIT_KEY_STEP;
    applyLogGridSplit(current + delta);
  });
}

function getLogGridSplit(): number {
  const value = Number.parseFloat(refs.logGrid.style.getPropertyValue("--log-grid-primary"));

  if (!Number.isFinite(value)) {
    return 50;
  }

  return value;
}

function applyLogGridSplit(value: number): void {
  const clamped = clamp(value, LOG_GRID_SPLIT_MIN, LOG_GRID_SPLIT_MAX);
  refs.logGrid.style.setProperty("--log-grid-primary", `${clamped.toFixed(2)}%`);
  refs.logGridDivider.setAttribute("aria-valuenow", String(Math.round(clamped)));
  writeStoredNumber(LOG_GRID_SPLIT_STORAGE_KEY, clamped);
}

function updateLogGridSplitByClientX(clientX: number): void {
  const bounds = refs.logGrid.getBoundingClientRect();

  if (bounds.width <= 0) {
    return;
  }

  const relativeX = clientX - bounds.left;
  const ratio = (relativeX / bounds.width) * 100;
  applyLogGridSplit(ratio);
}

async function handlePrimaryArchiveChange(): Promise<void> {
  const file = refs.archiveInput.files?.[0];

  if (!file) {
    return;
  }

  await loadPrimaryArchiveFile(file);
}

async function loadPrimaryArchiveFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadPrimaryArchiveBytes(bytes, file.name);
}

async function loadPrimaryArchiveBytes(bytes: Uint8Array, sourceName: string): Promise<void> {
  pausePlayback();
  hideProgressHover();
  hideQuickTriagePanel();
  state.lastPanelBucket = Number.NEGATIVE_INFINITY;

  try {
    const player = await openArchiveWithPassphraseFallback(bytes, sourceName);
    const model = buildArchiveModel(player);

    resetScreenshotResources();
    state.responsePreviewByHash.clear();

    state.player = player;
    state.model = model;
    state.loadedArchiveBytes = Uint8Array.from(bytes);
    state.loadedArchiveName = sourceName;
    state.selectedEventId = model.events[model.events.length - 1]?.id ?? null;
    state.selectedActionId = model.actionTimeline[model.actionTimeline.length - 1]?.actId ?? null;
    state.selectedRequestId = model.waterfall[model.waterfall.length - 1]?.reqId ?? null;
    state.playheadMono = model.maxMono;

    refreshCompareSummary();

    await renderAll({ forcePanels: true, forceScreenshot: true });
    showQuickTriagePanel(model, sourceName);
    setFeedback(i18n.t("feedbackArchiveLoaded", { sourceName }));
  } catch (error) {
    hideQuickTriagePanel();
    setFeedback(
      i18n.t("feedbackArchiveLoadFailed", {
        sourceName,
        error: String(error)
      })
    );
  }
}

async function handleCompareArchiveChange(): Promise<void> {
  const file = refs.compareInput.files?.[0];

  if (!file) {
    state.comparePlayer = null;
    state.compareModel = null;
    refreshCompareSummary();
    renderSummary();
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const comparePlayer = await openArchiveWithPassphraseFallback(bytes, file.name);
    state.comparePlayer = comparePlayer;
    state.compareModel = buildArchiveModel(comparePlayer);
    refreshCompareSummary();
    renderSummary();
    setFeedback(i18n.t("feedbackCompareLoaded", { fileName: file.name }));
  } catch (error) {
    state.comparePlayer = null;
    state.compareModel = null;
    setFeedback(
      i18n.t("feedbackCompareLoadFailed", {
        fileName: file.name,
        error: String(error)
      })
    );
  }
}

function refreshCompareSummary(): void {
  if (state.player && state.comparePlayer) {
    state.compareSummary = state.player.compareWith(state.comparePlayer);
    return;
  }

  state.compareModel = null;
  state.compareSummary = null;
}

function showQuickTriagePanel(model: ArchiveModel, archiveName: string): void {
  const player = state.player;

  if (!player) {
    return;
  }

  const triage = computeTriageStats(model.events, model.waterfall, TRIAGE_SLOW_REQUEST_MS);
  const origin = player.archive.manifest.site.origin;
  refs.preflightMeta.textContent = `${archiveName} • ${formatMono(model.durationMono)} • ${origin}`;
  refs.preflightErrors.textContent = String(model.totals.errors);
  refs.preflightFailedRequests.textContent = String(triage.failedRequests);
  refs.preflightSlowRequests.textContent = String(triage.slowRequests);
  refs.preflightShots.textContent = String(model.screenshots.length);
  refs.preflightActions.textContent = String(model.totals.actionSpans);
  refs.preflightJumpError.disabled = !triage.firstError;
  refs.preflightJumpSlowest.disabled = !triage.slowestRequest;
  refs.preflightPanel.hidden = false;

  if (state.preflightDismissTimer !== null) {
    window.clearTimeout(state.preflightDismissTimer);
    state.preflightDismissTimer = null;
  }

  state.preflightDismissTimer = window.setTimeout(() => {
    state.preflightDismissTimer = null;
    refs.preflightPanel.hidden = true;
  }, state.quickTriageAutoDismissMs);
}

function hideQuickTriagePanel(): void {
  if (state.preflightDismissTimer !== null) {
    window.clearTimeout(state.preflightDismissTimer);
    state.preflightDismissTimer = null;
  }

  refs.preflightPanel.hidden = true;
}

function readQuickTriageAutoDismissMs(): number {
  const savedSeconds = readStoredNumber(QUICK_TRIAGE_AUTO_DISMISS_SECONDS_STORAGE_KEY);
  const normalizedSeconds = normalizeQuickTriageAutoDismissSeconds(savedSeconds);
  return normalizedSeconds * 1_000;
}

function normalizeQuickTriageAutoDismissSeconds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return QUICK_TRIAGE_AUTO_DISMISS_DEFAULT_SECONDS;
  }

  return clamp(
    Math.round(value),
    QUICK_TRIAGE_AUTO_DISMISS_MIN_SECONDS,
    QUICK_TRIAGE_AUTO_DISMISS_MAX_SECONDS
  );
}

function setQuickTriageAutoDismissSeconds(value: number): void {
  const normalizedSeconds = normalizeQuickTriageAutoDismissSeconds(value);
  state.quickTriageAutoDismissMs = normalizedSeconds * 1_000;
  refs.quickTriageDismissSeconds.value = String(normalizedSeconds);
  writeStoredNumber(QUICK_TRIAGE_AUTO_DISMISS_SECONDS_STORAGE_KEY, normalizedSeconds);
}

async function copyBugReportFromQuickTriage(): Promise<void> {
  const player = state.player;

  if (!player) {
    return;
  }

  await copyText(player.generateBugReport());
  setFeedback(i18n.messages.feedbackBugReportCopied);
}

async function openPlaywrightPreviewDialog(): Promise<void> {
  const model = state.model;
  const player = state.player;

  if (!model || !player) {
    setFeedback(i18n.messages.feedbackLoadArchiveBeforePlaywright);
    return;
  }

  const durationSeconds = Math.max(0, model.durationMono / 1000);
  refs.playwrightRangeStart.value = "0";
  refs.playwrightRangeEnd.value = durationSeconds.toFixed(1);
  refs.playwrightMaxActions.value = "40";
  refs.playwrightIncludeHar.checked = true;
  regeneratePlaywrightPreview();
  await openDialog(refs.playwrightPreviewDialog, refs.playwrightRangeStart);
}

function regeneratePlaywrightPreview(): void {
  const player = state.player;
  const model = state.model;
  const options = readPlaywrightPreviewOptions();

  if (!player || !model || !options) {
    refs.playwrightScriptPreview.value = "";
    return;
  }

  const range = options.range;
  const events = range
    ? model.events.filter((event) => event.mono >= range.monoStart && event.mono <= range.monoEnd)
    : model.events;
  const script = generatePlaywrightScriptFromEvents(events, {
    maxActions: options.maxActions,
    includeHarReplay: options.includeHarReplay,
    startUrl: player.archive.manifest.site.origin
  });
  refs.playwrightScriptPreview.value = script;
}

function readPlaywrightPreviewOptions(): {
  range?: { monoStart: number; monoEnd: number };
  maxActions: number;
  includeHarReplay: boolean;
} | null {
  const model = state.model;

  if (!model) {
    return null;
  }

  const durationMs = Math.max(0, model.durationMono);
  const maxSeconds = durationMs / 1000;
  const startSecondsRaw = asFiniteNumber(Number.parseFloat(refs.playwrightRangeStart.value)) ?? 0;
  const endSecondsRaw =
    asFiniteNumber(Number.parseFloat(refs.playwrightRangeEnd.value)) ?? maxSeconds;
  const startSeconds = clamp(startSecondsRaw, 0, maxSeconds);
  const endSeconds = clamp(Math.max(startSeconds, endSecondsRaw), 0, maxSeconds);
  const maxActionsRaw = asFiniteNumber(Number.parseFloat(refs.playwrightMaxActions.value)) ?? 40;
  const maxActions = Math.max(1, Math.min(500, Math.round(maxActionsRaw)));
  const includeHarReplay = refs.playwrightIncludeHar.checked;
  refs.playwrightRangeStart.value = startSeconds.toFixed(1);
  refs.playwrightRangeEnd.value = endSeconds.toFixed(1);
  refs.playwrightMaxActions.value = String(maxActions);
  const monoStart = model.minMono + startSeconds * 1000;
  const monoEnd = model.minMono + endSeconds * 1000;
  const isFullRange = startSeconds <= 0 && Math.abs(endSeconds - maxSeconds) < 0.05;

  return {
    range: isFullRange ? undefined : { monoStart, monoEnd },
    maxActions,
    includeHarReplay
  };
}

async function copyPlaywrightPreview(): Promise<void> {
  if (!refs.playwrightScriptPreview.value.trim()) {
    regeneratePlaywrightPreview();
  }

  const content = refs.playwrightScriptPreview.value.trim();

  if (!content) {
    return;
  }

  await copyText(content);
  setFeedback(i18n.messages.feedbackPlaywrightPreviewCopied);
}

function downloadPlaywrightPreview(): void {
  if (!refs.playwrightScriptPreview.value.trim()) {
    regeneratePlaywrightPreview();
  }

  const content = refs.playwrightScriptPreview.value.trim();

  if (!content) {
    return;
  }

  downloadTextFile("webblackbox-replay.spec.ts", `${content}\n`, "text/plain");
  setFeedback(i18n.messages.feedbackPlaywrightScriptExported);
}

async function exportPlaywrightMocks(): Promise<void> {
  const player = state.player;

  if (!player) {
    return;
  }

  const script = await player.generatePlaywrightMockScript({ maxMocks: 25 });
  downloadTextFile("webblackbox-replay-mocks.spec.ts", script, "text/plain");
  setFeedback(i18n.messages.feedbackPlaywrightMocksExported);
}

async function shareLoadedArchive(): Promise<void> {
  const bytes = state.loadedArchiveBytes;

  if (!bytes) {
    setFeedback(i18n.messages.feedbackLoadArchiveBeforeSharing);
    return;
  }

  const shareConfig = await promptShareUploadConfig();

  if (!shareConfig) {
    return;
  }

  const normalizedBaseUrl = normalizeShareServerBaseUrl(shareConfig.baseUrl);

  if (!normalizedBaseUrl) {
    setFeedback(i18n.messages.feedbackInvalidShareServerUrl);
    return;
  }

  state.shareServerBaseUrl = normalizedBaseUrl;
  writeStoredText(SHARE_SERVER_BASE_URL_STORAGE_KEY, normalizedBaseUrl);
  rememberShareServerApiKey(normalizedBaseUrl, shareConfig.apiKey);

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-webblackbox-filename": state.loadedArchiveName ?? "session.webblackbox"
  };
  const passphrase = shareConfig.passphrase.trim();

  if (passphrase.length > 0) {
    headers["x-webblackbox-passphrase"] = passphrase;
  }
  if (shareConfig.apiKey.length > 0) {
    headers["x-webblackbox-api-key"] = shareConfig.apiKey;
  }

  try {
    const totalBytes = bytes.byteLength;
    let lastProgressUpdate = 0;
    const payload = (await uploadArchiveWithProgress(
      `${normalizedBaseUrl}/api/share/upload`,
      headers,
      toArrayBuffer(bytes),
      (loadedBytes, uploadTotalBytes) => {
        const targetTotal =
          uploadTotalBytes && uploadTotalBytes > 0 ? uploadTotalBytes : totalBytes;
        const now = Date.now();

        if (now - lastProgressUpdate < 150 && loadedBytes < targetTotal) {
          return;
        }

        lastProgressUpdate = now;
        const percent = targetTotal > 0 ? Math.min(100, (loadedBytes / targetTotal) * 100) : 0;
        setFeedback(
          i18n.formatShareUploadProgress(
            percent.toFixed(1),
            formatByteSize(loadedBytes),
            formatByteSize(targetTotal)
          )
        );
      },
      locale
    )) as {
      shareId?: unknown;
      shareUrl?: unknown;
    };
    const shareId =
      typeof payload.shareId === "string" && payload.shareId.length > 0 ? payload.shareId : null;
    const shareUrl =
      typeof payload.shareUrl === "string" && payload.shareUrl.length > 0
        ? payload.shareUrl
        : shareId
          ? `${normalizedBaseUrl}/share/${shareId}`
          : null;

    if (!shareUrl) {
      throw new Error(i18n.messages.feedbackShareMissingUrl);
    }

    await copyText(shareUrl);
    setFeedback(i18n.t("feedbackShareSucceeded", { shareUrl }));
  } catch (error) {
    setFeedback(i18n.t("feedbackShareFailed", { error: String(error) }));
  }
}

async function loadArchiveFromSharePrompt(): Promise<void> {
  const shareInput = await promptShareReferenceInput();

  if (!shareInput) {
    return;
  }

  await loadArchiveFromShareReference(shareInput.reference, shareInput.apiKey);
}

async function loadArchiveFromShareReference(reference: string, apiKey: string): Promise<void> {
  const trimmedReference = reference.trim();
  const trimmedApiKey = apiKey.trim();

  const resolved = resolveShareArchiveRequest(trimmedReference, state.shareServerBaseUrl);

  if (!resolved) {
    setFeedback(i18n.messages.feedbackInvalidShareReference);
    return;
  }

  state.shareServerBaseUrl = resolved.baseUrl;
  writeStoredText(SHARE_SERVER_BASE_URL_STORAGE_KEY, resolved.baseUrl);
  rememberShareServerApiKey(resolved.baseUrl, trimmedApiKey);

  try {
    const headers: Record<string, string> = {};
    if (trimmedApiKey.length > 0) {
      headers["x-webblackbox-api-key"] = trimmedApiKey;
    }

    const response = await fetch(resolved.archiveUrl, {
      headers
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    await loadPrimaryArchiveBytes(bytes, `shared-${resolved.shareId}.webblackbox`);
    setFeedback(i18n.t("feedbackSharedArchiveLoaded", { shareId: resolved.shareId }));
  } catch (error) {
    setFeedback(i18n.t("feedbackSharedArchiveLoadFailed", { error: String(error) }));
  }
}

async function maybeAutoLoadSharedArchiveFromLocation(): Promise<void> {
  let shareRef: string | null = null;

  try {
    shareRef = new URL(window.location.href).searchParams.get("share");
  } catch {
    return;
  }

  if (!shareRef || shareRef.trim().length === 0) {
    return;
  }

  setFeedback(i18n.messages.feedbackSharedArchiveLoadingFromUrl);
  await loadArchiveFromShareReference(shareRef, "");
}

async function promptShareUploadConfig(): Promise<{
  baseUrl: string;
  passphrase: string;
  apiKey: string;
} | null> {
  refs.shareUploadBaseUrl.value = state.shareServerBaseUrl;
  refs.shareUploadPassphrase.value = "";
  refs.shareUploadShowPassphrase.checked = false;
  refs.shareUploadPassphrase.type = "password";

  const detachBinding = bindShareApiKeyInputToTargetOrigin(
    refs.shareUploadBaseUrl,
    refs.shareUploadApiKey,
    (value) => normalizeShareServerBaseUrl(value.trim()),
    (baseUrl) => getShareServerApiKeyForBaseUrl(state.shareServerApiKeysByOrigin, baseUrl)
  );

  let result: string;

  try {
    result = await openDialog(refs.shareUploadDialog, refs.shareUploadBaseUrl);
  } finally {
    detachBinding();
  }

  if (result !== "confirm") {
    return null;
  }

  return {
    baseUrl: refs.shareUploadBaseUrl.value.trim(),
    passphrase: refs.shareUploadPassphrase.value,
    apiKey: refs.shareUploadApiKey.value.trim()
  };
}

async function promptShareReferenceInput(): Promise<{ reference: string; apiKey: string } | null> {
  refs.shareLoadReference.value = `${state.shareServerBaseUrl}/share/`;
  const detachBinding = bindShareApiKeyInputToTargetOrigin(
    refs.shareLoadReference,
    refs.shareLoadApiKey,
    (value) => resolveShareArchiveRequest(value.trim(), state.shareServerBaseUrl)?.baseUrl ?? null,
    (baseUrl) => getShareServerApiKeyForBaseUrl(state.shareServerApiKeysByOrigin, baseUrl)
  );

  let result: string;

  try {
    result = await openDialog(refs.shareLoadDialog, refs.shareLoadReference);
  } finally {
    detachBinding();
  }

  if (result !== "confirm") {
    return null;
  }

  const reference = refs.shareLoadReference.value.trim();
  if (reference.length === 0) {
    return null;
  }

  return {
    reference,
    apiKey: refs.shareLoadApiKey.value.trim()
  };
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
  refs.shareUpload.disabled = state.loadedArchiveBytes === null;

  refs.playbackToggle.textContent = state.isPlaying
    ? i18n.messages.playbackPause
    : i18n.messages.playbackPlay;

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
  const activeSecondaryPanel: LogPanelKey =
    state.activePanel === "timeline" ? "details" : state.activePanel;

  for (const button of panelTabButtons) {
    const panel = button.dataset.logPanel as LogPanelKey | undefined;
    const active = panel === activeSecondaryPanel;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }

  for (const card of panelCards) {
    const panel = card.dataset.logPanelTarget as LogPanelKey | undefined;
    const showAsTimeline = panel === "timeline";
    const showAsSecondary = panel === activeSecondaryPanel;

    card.classList.toggle("panel-hidden", !showAsTimeline && !showAsSecondary);
    card.classList.toggle("panel-primary", showAsTimeline);
    card.classList.toggle("panel-secondary", showAsSecondary);
  }

  renderPanelTabCounts();
  renderPlaybackReadout();
}

function renderPanelTabCounts(): void {
  const model = state.model;

  if (!model) {
    for (const button of panelTabButtons) {
      button.dataset.count = "0";
    }

    return;
  }

  const visibleEventCount = upperBoundByMono(
    model.events,
    state.playheadMono,
    (event) => event.mono
  );
  const visibleNetworkTotalCount = upperBoundByMono(
    model.waterfall,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visibleActionTotalCount = upperBoundByMono(
    model.actionTimeline,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visibleConsoleTotalCount = upperBoundByMono(
    model.consoleSignals,
    state.playheadMono,
    (event) => event.mono
  );
  const visibleRealtimeTotalCount = upperBoundByMono(
    model.realtime,
    state.playheadMono,
    (entry) => entry.mono
  );
  const visibleStorageTotalCount = upperBoundByMono(
    model.storage,
    state.playheadMono,
    (entry) => entry.mono
  );
  const visiblePerfTotalCount = upperBoundByMono(
    model.perf,
    state.playheadMono,
    (entry) => entry.mono
  );
  const visibleCompareCount = state.compareSummary ? 1 : 0;
  const selectedEvent = state.selectedEventId
    ? (model.eventById.get(state.selectedEventId) ?? null)
    : null;
  const visibleDetailsCount =
    selectedEvent &&
    selectedEvent.mono <= state.playheadMono &&
    matchesScopeFilter(resolveEventScope(model, selectedEvent), state.scopeFilter)
      ? 1
      : 0;
  const visibleTimelineCount = model.events
    .slice(0, visibleEventCount)
    .filter((event) =>
      matchesScopeFilter(resolveEventScope(model, event), state.scopeFilter)
    ).length;
  const visibleActionCount = model.actionTimeline
    .slice(0, visibleActionTotalCount)
    .filter((action) =>
      matchesScopeFilter(resolveActionScope(model, action), state.scopeFilter)
    ).length;
  const visibleNetworkCount = model.waterfall
    .slice(0, visibleNetworkTotalCount)
    .filter((entry) =>
      matchesScopeFilter(resolveRequestScope(model, entry.reqId), state.networkView.scope)
    ).length;
  const visibleConsoleCount = model.consoleSignals
    .slice(0, visibleConsoleTotalCount)
    .filter((event) =>
      matchesScopeFilter(resolveEventScope(model, event), state.scopeFilter)
    ).length;
  const visibleRealtimeCount = model.realtime
    .slice(0, visibleRealtimeTotalCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    ).length;
  const visibleStorageCount = model.storage
    .slice(0, visibleStorageTotalCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    ).length;
  const visiblePerfCount = model.perf
    .slice(0, visiblePerfTotalCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    ).length;

  const counts: Record<LogPanelKey, number> = {
    timeline: visibleTimelineCount,
    details: visibleDetailsCount,
    actions: visibleActionCount,
    network: visibleNetworkCount,
    compare: visibleCompareCount,
    console: visibleConsoleCount,
    realtime: visibleRealtimeCount,
    storage: visibleStorageCount,
    perf: visiblePerfCount
  };

  for (const button of panelTabButtons) {
    const panel = button.dataset.logPanel as LogPanelKey | undefined;
    const count = panel ? (counts[panel] ?? 0) : 0;
    button.dataset.count = String(count);
    button.title = `${PANEL_LABELS[panel ?? "timeline"]}: ${count}`;
  }
}

function renderPlaybackReadout(): void {
  const model = state.model;

  if (!model || !state.player) {
    refs.playbackWindowLabel.textContent = "0.00s / 0.00s";
    refs.playbackWindowEvents.textContent = i18n.formatStatusCounts(0, 0, 0);
    refs.playbackWindowPanel.textContent = i18n.formatStatusPanel("details");
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
  const panelKey = state.activePanel === "timeline" ? "details" : state.activePanel;
  const selection = [
    state.selectedActionId
      ? i18n.formatSelection("action", truncateId(state.selectedActionId))
      : null,
    state.selectedEventId ? i18n.formatSelection("event", truncateId(state.selectedEventId)) : null,
    state.selectedRequestId
      ? i18n.formatSelection("request", truncateId(state.selectedRequestId))
      : null
  ]
    .filter((item): item is string => Boolean(item))
    .join(" | ");

  refs.playbackWindowLabel.textContent = `${formatMono(state.playheadMono - model.minMono)} / ${formatMono(
    model.durationMono
  )}`;
  refs.playbackWindowEvents.textContent = i18n.formatStatusCounts(
    visibleEventCount,
    visibleErrorCount,
    visibleRequestCount
  );
  refs.playbackWindowPanel.textContent = i18n.formatStatusPanel(panelKey, selection);
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
      const tip = `${i18n.formatMarkerKind(marker.kind)} @ ${formatMono(marker.mono - model.minMono)}`;
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

  const status = entry.failed
    ? i18n.messages.networkStatusFailed
    : typeof entry.status === "number"
      ? String(entry.status)
      : i18n.messages.networkStatusPendingPlain;
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
  refs.progressHoverResponseToggle.textContent = i18n.messages.responseExpandJson;
  refs.progressHoverResponseCopy.disabled = true;
  refs.progressHoverResponseCopy.textContent = i18n.messages.copy;
  state.responseCopyText = "";

  if (!entry.responseBodyHash) {
    refs.progressHoverResponseBody.textContent = i18n.messages.responseNoBodyCaptured;
    return;
  }

  const preview = await getResponsePreviewByHash(entry.responseBodyHash);

  if (token !== state.progressHoverToken) {
    return;
  }

  if (!preview) {
    refs.progressHoverResponseBody.textContent = i18n.messages.responseUnavailable;
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
      ? i18n.messages.responseCollapseJson
      : i18n.messages.responseExpandJson;
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
  refs.progressHoverResponseToggle.textContent = i18n.messages.responseExpandJson;
  refs.progressHoverResponseCopy.disabled = true;
  refs.progressHoverResponseCopy.textContent = i18n.messages.copy;
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

  const eventText = latest ? `${latest.type} (${latest.id})` : i18n.messages.noEventAtTime;
  const { tags, requestEntry } = buildProgressHoverTags(model, mono, markerKind, latest);

  return {
    text: i18n.formatProgressSummary({
      markerKind,
      eventText,
      eventCount: endIndex - startIndex,
      networkCount: network,
      errorCount: errors
    }),
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
      label: i18n.t("progressMarkerLabel", {
        kind: i18n.formatMarkerKind(markerKind)
      }),
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
      panel: "actions",
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

    const status = entry.failed
      ? i18n.messages.networkStatusFailed
      : typeof entry.status === "number"
        ? String(entry.status)
        : i18n.messages.networkStatusPendingPlain;
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

  const preview = decodeResponsePreview(
    blob.mime,
    blob.bytes,
    RESPONSE_PREVIEW_EXPANDED_CHARS,
    locale
  );
  state.responsePreviewByHash.set(hash, preview);
  return preview;
}

function jumpToFirstError(): void {
  const model = state.model;

  if (!model) {
    return;
  }

  const firstError = findFirstErrorEvent(model.events);

  if (!firstError) {
    setFeedback(i18n.messages.jumpNoErrorEvents);
    return;
  }

  pausePlayback();
  state.selectedActionId = null;
  state.selectedEventId = firstError.id;
  state.activePanel = "details";
  setPlayhead(firstError.mono, { forcePanels: true });
  setFeedback(
    i18n.t("jumpedFirstError", {
      time: formatMono(firstError.mono - model.minMono)
    })
  );
}

function jumpToSlowestRequest(): void {
  const model = state.model;

  if (!model) {
    setFeedback(i18n.messages.jumpNoNetworkRequests);
    return;
  }

  const slowest = findSlowestRequest(model.waterfall);

  if (!slowest) {
    setFeedback(i18n.messages.jumpNoNetworkRequests);
    return;
  }

  pausePlayback();
  state.selectedRequestId = slowest.reqId;
  state.selectedEventId = slowest.eventIds[0] ?? state.selectedEventId;
  state.activePanel = "network";
  setPlayhead(slowest.startMono, { forcePanels: true });
  setFeedback(
    i18n.t("jumpedSlowestRequest", {
      durationMs: slowest.durationMs.toFixed(0)
    })
  );
}

function renderSummary(): void {
  const model = state.model;

  if (!model || !state.player) {
    refs.summary.innerHTML = `<p class="empty">${escapeHtml(i18n.messages.summaryEmptyLoadArchive)}</p>`;
    refs.compareDetails.textContent = i18n.messages.compareDetailsEmpty;
    refs.compareRegressions.innerHTML = "";
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
  const visibleActionCount = upperBoundByMono(
    model.actionTimeline,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visibleShotCount = upperBoundByMono(
    model.screenshots,
    state.playheadMono,
    (entry) => entry.mono
  );
  let visibleMainEventCount = 0;
  let visibleIframeEventCount = 0;

  for (let index = 0; index < visibleEventCount; index += 1) {
    const event = model.events[index];

    if (!event) {
      continue;
    }

    if (resolveEventScope(model, event) === "iframe") {
      visibleIframeEventCount += 1;
    } else {
      visibleMainEventCount += 1;
    }
  }

  const visibleNetworkEntries = model.waterfall.slice(0, visibleRequestCount);
  const visibleNetworkMainCount = visibleNetworkEntries.filter(
    (entry) => resolveRequestScope(model, entry.reqId) === "main"
  ).length;
  const visibleNetworkIframeCount = Math.max(0, visibleRequestCount - visibleNetworkMainCount);
  const triage = computeTriageStats(model.events, model.waterfall, TRIAGE_SLOW_REQUEST_MS);

  const compareDelta = state.compareSummary
    ? `<div class="pill">${escapeHtml(
        i18n.t("summaryCompareEventDelta", {
          delta: formatDelta(state.compareSummary.eventDelta)
        })
      )}</div>`
    : "";

  refs.summary.innerHTML = `
    <div class="summary-triage">
      <span class="summary-triage__label">${escapeHtml(i18n.messages.summaryLabelTriage)}</span>
      <div class="pill">${escapeHtml(i18n.t("summaryPillErrors", { count: model.totals.errors }))}</div>
      <div class="pill">${escapeHtml(
        i18n.t("summaryPillFailedRequests", { count: triage.failedRequests })
      )}</div>
      <div class="pill">${escapeHtml(
        i18n.t("summaryPillSlowRequests", {
          count: triage.slowRequests,
          thresholdMs: TRIAGE_SLOW_REQUEST_MS
        })
      )}</div>
      <button class="summary-jump-btn" type="button" data-summary-jump="first-error" ${
        triage.firstError ? "" : "disabled"
      }>
        ${escapeHtml(i18n.messages.preflightJumpFirstError)}
      </button>
      <button class="summary-jump-btn" type="button" data-summary-jump="slowest-request" ${
        triage.slowestRequest ? "" : "disabled"
      }>
        ${escapeHtml(i18n.messages.preflightJumpSlowestRequest)}
      </button>
    </div>
    <div class="pill">${escapeHtml(
      i18n.t("summaryMode", {
        mode: i18n.formatMode(state.player.archive.manifest.mode)
      })
    )}</div>
    <div class="pill">${escapeHtml(
      i18n.t("summaryOrigin", { origin: state.player.archive.manifest.site.origin })
    )}</div>
    <div class="pill">${escapeHtml(
      i18n.t("summaryPlayhead", {
        time: formatMono(state.playheadMono - model.minMono)
      })
    )}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryVisibleEvents", { count: visibleEventCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryMainEvents", { count: visibleMainEventCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryIframeEvents", { count: visibleIframeEventCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryVisibleErrors", { count: visibleErrorCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryVisibleRequests", { count: visibleRequestCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryMainRequests", { count: visibleNetworkMainCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryIframeRequests", { count: visibleNetworkIframeCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryVisibleActions", { count: visibleActionCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryVisibleScreenshots", { count: visibleShotCount }))}</div>
    <div class="pill">${escapeHtml(i18n.t("summaryAllActions", { count: model.totals.actionSpans }))}</div>
    ${compareDelta}
  `;

  refs.compareDetails.textContent = state.compareSummary
    ? formatCompareSummary(state.compareSummary, locale)
    : i18n.messages.compareDetailsEmpty;
  refs.compareRegressions.innerHTML = renderCompareRegressions(
    state.compareSummary,
    model,
    state.compareModel
  );
}

function renderCompareRegressions(
  summary: PlayerComparison | null,
  leftModel: ArchiveModel | null,
  rightModel: ArchiveModel | null
): string {
  if (!summary || !leftModel || !rightModel) {
    return `<p class="empty compare-empty">${escapeHtml(i18n.messages.compareNoArchiveLoaded)}</p>`;
  }

  const regressionRows = summary.endpointRegressions.slice(0, 8);
  const timelineRows = renderCompareTimelineRows(leftModel, rightModel);
  const waterfallRows = renderCompareWaterfallRows(leftModel, rightModel);
  const endpointSection =
    regressionRows.length === 0
      ? `<p class="empty compare-empty">${escapeHtml(i18n.messages.compareNoEndpointDeltas)}</p>`
      : `
      <table class="compare-regressions-table">
        <thead>
          <tr>
            <th>${escapeHtml(i18n.messages.compareColumnEndpoint)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnCountDelta)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnFailRateDelta)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnP95Delta)}</th>
          </tr>
        </thead>
        <tbody>
          ${regressionRows
            .map((entry) => {
              const endpointLabel = `${entry.method} ${entry.endpoint}`;
              const failRateDelta = `${formatDelta(
                Number((entry.failureRateDelta * 100).toFixed(2))
              )}%`;
              const p95Delta = `${formatDelta(Number(entry.p95DurationDeltaMs.toFixed(1)))}ms`;

              return `<tr>
                <td title="${escapeHtml(endpointLabel)}">${escapeHtml(endpointLabel)}</td>
                <td class="mono">${formatDelta(entry.countDelta)}</td>
                <td class="mono">${escapeHtml(failRateDelta)}</td>
                <td class="mono">${escapeHtml(p95Delta)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;

  return `
    <section class="compare-dual-block">
      <header class="compare-dual-head">
        <h3>${escapeHtml(i18n.messages.compareHeadingTimelineAB)}</h3>
      </header>
      <div class="compare-dual-grid">
        ${timelineRows}
      </div>
    </section>
    <section class="compare-dual-block">
      <header class="compare-dual-head">
        <h3>${escapeHtml(i18n.messages.compareHeadingWaterfallAlignment)}</h3>
      </header>
      <table class="compare-waterfall-table">
        <thead>
          <tr>
            <th>${escapeHtml(i18n.messages.compareColumnEndpoint)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnSessionA)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnSessionB)}</th>
            <th>${escapeHtml(i18n.messages.compareColumnSignal)}</th>
          </tr>
        </thead>
        <tbody>${waterfallRows}</tbody>
      </table>
    </section>
    <section class="compare-dual-block">
      <header class="compare-dual-head">
        <h3>${escapeHtml(i18n.messages.compareHeadingEndpointRegressions)}</h3>
      </header>
      ${endpointSection}
    </section>
  `;
}

function renderCompareTimelineRows(leftModel: ArchiveModel, rightModel: ArchiveModel): string {
  const leftRows = leftModel.events.slice(Math.max(0, leftModel.events.length - 10));
  const rightRows = rightModel.events.slice(Math.max(0, rightModel.events.length - 10));
  const rowCount = Math.max(leftRows.length, rightRows.length);
  const rows: string[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    const left = leftRows[index] ?? null;
    const right = rightRows[index] ?? null;

    rows.push(`
      <div class="compare-timeline-col">
        <span class="compare-timeline-label">A</span>
        <span class="mono">${left ? formatMono(left.mono - leftModel.minMono) : "—"}</span>
        <span title="${left ? escapeHtml(left.id) : ""}">${left ? escapeHtml(left.type) : "—"}</span>
      </div>
      <div class="compare-timeline-col">
        <span class="compare-timeline-label">B</span>
        <span class="mono">${right ? formatMono(right.mono - rightModel.minMono) : "—"}</span>
        <span title="${right ? escapeHtml(right.id) : ""}">${right ? escapeHtml(right.type) : "—"}</span>
      </div>
    `);
  }

  return rows.join("");
}

type CompareEndpointSummary = {
  key: string;
  firstStartMono: number;
  count: number;
  failureCount: number;
  p95Ms: number;
};

function renderCompareWaterfallRows(leftModel: ArchiveModel, rightModel: ArchiveModel): string {
  const leftSummary = summarizeWaterfallByEndpoint(leftModel.waterfall);
  const rightSummary = summarizeWaterfallByEndpoint(rightModel.waterfall);
  const keys = new Set<string>([...leftSummary.keys(), ...rightSummary.keys()]);
  const rows = [...keys]
    .map((key) => {
      const left = leftSummary.get(key) ?? null;
      const right = rightSummary.get(key) ?? null;
      const rank = Math.min(
        left?.firstStartMono ?? Number.POSITIVE_INFINITY,
        right?.firstStartMono ?? Number.POSITIVE_INFINITY
      );
      return { key, left, right, rank };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 12);

  return rows
    .map((row) => {
      const leftCell = row.left ? formatEndpointSummaryCell(row.left) : "—";
      const rightCell = row.right ? formatEndpointSummaryCell(row.right) : "—";
      const signal =
        row.left && row.right
          ? row.right.failureCount > row.left.failureCount
            ? "regressed"
            : "stable"
          : row.right
            ? "new"
            : "missing";
      const signalClass =
        signal === "regressed"
          ? "compare-signal compare-signal-regressed"
          : signal === "new"
            ? "compare-signal compare-signal-new"
            : signal === "missing"
              ? "compare-signal compare-signal-missing"
              : "compare-signal";

      return `<tr>
        <td title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</td>
        <td class="mono">${escapeHtml(leftCell)}</td>
        <td class="mono">${escapeHtml(rightCell)}</td>
        <td><span class="${signalClass}">${escapeHtml(i18n.formatCompareSignal(signal))}</span></td>
      </tr>`;
    })
    .join("");
}

function summarizeWaterfallByEndpoint(
  entries: NetworkWaterfallEntry[]
): Map<string, CompareEndpointSummary> {
  const grouped = new Map<string, NetworkWaterfallEntry[]>();

  for (const entry of entries) {
    const key = `${entry.method.toUpperCase()} ${shortUrl(entry.url)}`;
    const bucket = grouped.get(key);

    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }

  const summary = new Map<string, CompareEndpointSummary>();

  for (const [key, bucket] of grouped.entries()) {
    const durations = bucket
      .map((entry) => entry.durationMs)
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.floor((durations.length - 1) * 0.95));
    const p95Ms = durations[p95Index] ?? 0;
    const failureCount = bucket.reduce((count, entry) => {
      const status = typeof entry.status === "number" ? entry.status : 0;
      return count + (entry.failed || status >= 400 ? 1 : 0);
    }, 0);
    const firstStartMono = bucket.reduce(
      (minMono, entry) => Math.min(minMono, entry.startMono),
      bucket[0]?.startMono ?? Number.POSITIVE_INFINITY
    );

    summary.set(key, {
      key,
      firstStartMono,
      count: bucket.length,
      failureCount,
      p95Ms
    });
  }

  return summary;
}

function formatEndpointSummaryCell(entry: CompareEndpointSummary): string {
  const failRate = entry.count > 0 ? (entry.failureCount / entry.count) * 100 : 0;
  return i18n.formatCompareEndpointSummary(entry.count, failRate, entry.p95Ms);
}

function renderPanels(): void {
  renderPanelTabs();

  if (!state.model) {
    state.timelineRows = [];
    state.selectedActionId = null;
    refs.timelineList.innerHTML = "";
    refs.actionsList.innerHTML = "";
    refs.eventDetails.textContent = i18n.messages.eventDetailsEmpty;
    refs.waterfallBody.innerHTML = "";
    refs.networkScopeSummary.textContent = i18n.formatScopeSummary(0, 0);
    refs.networkSummary.textContent = i18n.messages.networkSummaryEmpty;
    refs.requestDetails.textContent = i18n.messages.requestDetailsEmpty;
    renderNetworkSortButtons();
    refs.consoleList.innerHTML = "";
    refs.realtimeList.innerHTML = "";
    refs.storageList.innerHTML = "";
    refs.perfList.innerHTML = "";
    refs.filmstripList.innerHTML = "";
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    refs.replayRequest.disabled = true;
    return;
  }

  renderTimeline();
  renderActionTimeline();
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
    refs.timelineList.innerHTML = `<li class="empty">${escapeHtml(i18n.messages.timelineEmpty)}</li>`;
    return;
  }

  if (!state.selectedEventId || !filtered.some((event) => event.id === state.selectedEventId)) {
    state.selectedEventId = filtered[filtered.length - 1]?.id ?? null;
  }

  state.timelineRows =
    filtered.length > MAX_TIMELINE_ROWS ? filtered.slice(-MAX_TIMELINE_ROWS) : filtered;
  renderTimelineWindow();
}

function renderActionTimeline(): void {
  const model = state.model;

  if (!model) {
    refs.actionsList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(
    model.actionTimeline,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const filtered = applyActionFilters(model, visibleCount);

  if (filtered.length === 0) {
    state.selectedActionId = null;
    refs.actionsList.innerHTML = `<li class="empty">${escapeHtml(i18n.messages.actionsEmpty)}</li>`;
    return;
  }

  if (
    !state.selectedActionId ||
    !filtered.some((entry) => entry.actId === state.selectedActionId)
  ) {
    state.selectedActionId = filtered[filtered.length - 1]?.actId ?? null;
  }

  const rows = filtered.length > MAX_ACTION_ROWS ? filtered.slice(-MAX_ACTION_ROWS) : filtered;
  refs.actionsList.innerHTML = rows.map((entry) => renderActionCard(entry, model)).join("");
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
  const model = state.model;
  const relativeMono = Math.max(0, event.mono - (model?.minMono ?? 0));
  const buttonClass = selectedClass ? `event ${selectedClass}` : "event";
  const eventLabel = formatTimelineEventLabel(event.id);
  const scope = model ? resolveEventScope(model, event) : inferEventScope(event);
  const scopeTagClass =
    scope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";
  const scopeLabel = i18n.formatScopeTag(scope);
  const sessionLabel = event.cdp ? truncateId(event.cdp) : "";
  const frameLabel = event.frame ? truncateId(event.frame) : "";
  const sourceLabel =
    sessionLabel && frameLabel ? `${sessionLabel} · ${frameLabel}` : sessionLabel || frameLabel;
  const sourceTag = sourceLabel
    ? `<span class="scope-session mono" title="${escapeHtml(event.cdp ?? event.frame ?? "")}">${escapeHtml(sourceLabel)}</span>`
    : "";

  return `<li class="event-row"><button data-event-id="${escapeHtml(event.id)}" class="${buttonClass}">
        <span class="id" title="${escapeHtml(event.id)}">${escapeHtml(eventLabel)}</span>
        <span class="tag-wrap">
          <span class="tag">${escapeHtml(event.type)}</span>
          <span class="${scopeTagClass}">${scopeLabel}</span>
          ${sourceTag}
        </span>
        <span class="mono">${formatMono(relativeMono)}</span>
      </button></li>`;
}

function renderActionCard(action: ActionTimelineEntry, model: ArchiveModel): string {
  const selectedClass = state.selectedActionId === action.actId ? "selected" : "";
  const triggerType = action.triggerType ?? "unknown";
  const relativeStart = Math.max(0, action.startMono - model.minMono);
  const relativeEnd = Math.max(relativeStart, action.endMono - model.minMono);
  const screenshotMeta = action.screenshot
    ? i18n.t("actionMetricShot", {
        time: formatMono(Math.max(0, action.screenshot.mono - model.minMono))
      })
    : i18n.messages.actionMetricNoShot;
  const requestPreview = action.requests
    .slice(0, 2)
    .map((entry) => {
      const status = entry.failed
        ? i18n.messages.networkStatusFailed
        : entry.status === null
          ? i18n.messages.networkStatusPending
          : String(entry.status);
      return `${entry.method.toUpperCase()} ${shortUrl(entry.url)} ${status}`;
    })
    .join(" | ");
  const errorPreview = action.errors
    .slice(0, 2)
    .map((entry) => `${entry.type}${entry.message ? `: ${entry.message}` : ""}`)
    .join(" | ");
  const cardClass = selectedClass ? `action-card ${selectedClass}` : "action-card";

  return `<li class="action-card-row"><button class="${cardClass}" data-action-id="${escapeHtml(action.actId)}">
      <div class="action-card-head">
        <span class="action-card-trigger">${escapeHtml(triggerType)}</span>
        <span class="action-card-time mono">${formatMono(relativeStart)} - ${formatMono(relativeEnd)}</span>
      </div>
      <div class="action-card-metrics mono">
        ${i18n
          .formatActionMetrics({
            durationMs: Number(action.durationMs.toFixed(1)),
            eventCount: action.eventCount,
            requestCount: action.requestCount,
            errorCount: action.errorCount,
            screenshotMeta
          })
          .map((label) => `<span>${escapeHtml(label)}</span>`)
          .join("")}
      </div>
      ${
        requestPreview
          ? `<div class="action-card-section"><span class="action-card-label">${escapeHtml(i18n.messages.actionSectionNetwork)}</span><span>${escapeHtml(requestPreview)}</span></div>`
          : ""
      }
      ${
        errorPreview
          ? `<div class="action-card-section"><span class="action-card-label">${escapeHtml(i18n.messages.actionSectionErrors)}</span><span>${escapeHtml(errorPreview)}</span></div>`
          : ""
      }
    </button></li>`;
}

function renderEventDetails(): void {
  const model = state.model;

  if (!model) {
    refs.eventDetails.textContent = i18n.messages.eventDetailsEmpty;
    return;
  }

  if (state.activePanel === "actions") {
    renderActionRootCauseDetails(model);
    return;
  }

  const eventId = state.selectedEventId;

  if (!eventId) {
    refs.eventDetails.textContent = i18n.messages.eventDetailsEmpty;
    return;
  }

  const selected = model.eventById.get(eventId);

  if (!selected || selected.mono > state.playheadMono) {
    refs.eventDetails.textContent = i18n.messages.eventDetailsOutOfRange;
    return;
  }

  refs.eventDetails.textContent = JSON.stringify(
    {
      scope: resolveEventScope(model, selected),
      cdpSession: selected.cdp ?? null,
      frame: selected.frame ?? null,
      event: selected
    },
    null,
    2
  );
}

function renderActionRootCauseDetails(model: ArchiveModel): void {
  const actionId = state.selectedActionId;

  if (!actionId) {
    refs.eventDetails.textContent = i18n.messages.actionDetailsEmpty;
    return;
  }

  const action = model.actionTimeline.find((entry) => entry.actId === actionId);

  if (!action || action.startMono > state.playheadMono) {
    refs.eventDetails.textContent = i18n.messages.actionDetailsOutOfRange;
    return;
  }

  const triggerEvent = model.eventById.get(action.triggerEventId) ?? null;
  const errorEvents = action.errors
    .map((entry) => model.eventById.get(entry.eventId))
    .filter((event): event is WebBlackboxEvent => Boolean(event))
    .map((event) => ({
      id: event.id,
      type: event.type,
      mono: Number(event.mono.toFixed(2)),
      level: event.lvl ?? null,
      data: event.data
    }));
  const requestContext = action.requests.map((entry) => ({
    reqId: entry.reqId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    failed: entry.failed,
    durationMs: Number(entry.durationMs.toFixed(2)),
    scope: resolveRequestScope(model, entry.reqId),
    linked: model.waterfallByReqId.get(entry.reqId) ?? null
  }));

  refs.eventDetails.textContent = JSON.stringify(
    {
      action: {
        actId: action.actId,
        triggerEventId: action.triggerEventId,
        triggerType: action.triggerType,
        startMono: Number(action.startMono.toFixed(2)),
        endMono: Number(action.endMono.toFixed(2)),
        durationMs: Number(action.durationMs.toFixed(2)),
        eventCount: action.eventCount,
        requestCount: action.requestCount,
        errorCount: action.errorCount
      },
      scope: resolveActionScope(model, action),
      triggerEvent,
      screenshot: action.screenshot,
      nearbyNetwork: requestContext,
      nearbyErrors: errorEvents
    },
    null,
    2
  );
}

function renderNetworkSortButtons(): void {
  for (const button of networkSortButtons) {
    const sortKey = button.dataset.wfSortKey as NetworkSortKey | undefined;
    const active = sortKey === state.networkView.sortKey;
    const descending = active && state.networkView.sortDirection === "desc";
    const ascending = active && state.networkView.sortDirection === "asc";
    button.classList.toggle("is-active", active);
    button.classList.toggle("is-desc", descending);
    button.classList.toggle("is-asc", ascending);
    button.setAttribute("aria-pressed", String(active));
    button.title = active
      ? i18n.t("sortedByColumn", {
          column: button.textContent?.trim() ?? i18n.messages.sortColumnFallback,
          direction: i18n.formatSortDirection(descending ? "desc" : "asc")
        })
      : i18n.t("sortByColumn", {
          column: button.textContent?.trim() ?? i18n.messages.sortColumnFallback
        });
  }
}

function renderWaterfall(): void {
  const model = state.model;
  const player = state.player;

  renderNetworkSortButtons();

  if (!model || !player) {
    refs.waterfallBody.innerHTML = "";
    refs.networkScopeSummary.textContent = i18n.formatScopeSummary(0, 0);
    refs.networkSummary.textContent = i18n.messages.networkSummaryEmpty;
    refs.requestDetails.textContent = i18n.messages.requestDetailsEmpty;
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    refs.replayRequest.disabled = true;
    return;
  }

  const visibleCount = upperBoundByMono(
    model.waterfall,
    state.playheadMono,
    (entry) => entry.startMono
  );
  const visibleEntries = model.waterfall.slice(0, visibleCount);
  const queryFilteredEntries = applyNetworkViewFilters(visibleEntries, state.networkView, locale);
  const filteredEntries = queryFilteredEntries.filter((entry) =>
    matchesScopeFilter(resolveRequestScope(model, entry.reqId), state.networkView.scope)
  );
  const sortedEntries = sortNetworkEntries(
    filteredEntries,
    state.networkView.sortKey,
    state.networkView.sortDirection,
    locale
  );
  const renderedEntries = sortedEntries.slice(0, MAX_WATERFALL_ROWS);

  renderNetworkSummary(model, visibleEntries, filteredEntries, renderedEntries);

  if (renderedEntries.length === 0) {
    state.selectedRequestId = null;
    refs.waterfallBody.innerHTML = "";
    refs.requestDetails.textContent = filteredEntries.length
      ? i18n.messages.requestWindowEmpty
      : i18n.messages.requestFilterEmpty;
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    refs.replayRequest.disabled = true;
    return;
  }

  if (
    !state.selectedRequestId ||
    !sortedEntries.some((entry) => entry.reqId === state.selectedRequestId)
  ) {
    state.selectedRequestId = renderedEntries[0]?.reqId ?? null;
  }

  const timelineStart = visibleEntries[0]?.startMono ?? 0;
  const timelineEnd = visibleEntries.reduce(
    (maxMono, entry) => Math.max(maxMono, entry.endMono),
    timelineStart + 1
  );
  const timelineSpan = Math.max(1, timelineEnd - timelineStart);

  refs.waterfallBody.innerHTML = renderedEntries
    .map((entry) => {
      const status = describeNetworkStatus(entry, locale);
      const selectedClass = state.selectedRequestId === entry.reqId ? "selected" : "";
      const statusClass = resolveNetworkStatusClass(entry);
      const requestName = describeRequestName(entry.url);
      const method = entry.method.toUpperCase();
      const type = resolveNetworkTypeLabel(entry.mimeType, locale);
      const initiator = resolveNetworkInitiator(entry, locale);
      const size = formatNetworkSize(entry);
      const elapsed = `${entry.durationMs.toFixed(1)} ms`;
      const scope = resolveRequestScope(model, entry.reqId);
      const scopeClass =
        scope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";
      const scopeLabel = i18n.formatScopeTag(scope);
      const offset = Math.max(0, entry.startMono - timelineStart);
      const left = clamp((offset / timelineSpan) * 100, 0, 100);
      const width = clamp((Math.max(entry.durationMs, 1) / timelineSpan) * 100, 0.8, 100 - left);

      return `<tr class="${selectedClass}" data-req-id="${escapeHtml(entry.reqId)}">
        <td class="waterfall-col-name">
          <button class="waterfall-btn" data-req-id="${escapeHtml(entry.reqId)}" title="${escapeHtml(entry.url)}">${escapeHtml(requestName.name)}</button>
          <span class="waterfall-host">
            ${escapeHtml(requestName.host)}
            <span class="${scopeClass}">${scopeLabel}</span>
          </span>
        </td>
        <td class="waterfall-col-method mono">${escapeHtml(method)}</td>
        <td class="waterfall-col-status ${statusClass} mono">${escapeHtml(status)}</td>
        <td class="waterfall-col-type">${escapeHtml(type)}</td>
        <td class="waterfall-col-initiator mono">${escapeHtml(initiator)}</td>
        <td class="waterfall-col-size mono">${escapeHtml(size)}</td>
        <td class="waterfall-col-time mono">${escapeHtml(elapsed)}</td>
        <td class="waterfall-col-bar">
          <div class="wf-track">
            <span class="wf-bar ${statusClass}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;"></span>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  const selectedReqId = state.selectedRequestId;
  const selectedEntry = selectedReqId ? (model.waterfallByReqId.get(selectedReqId) ?? null) : null;

  if (!selectedEntry) {
    refs.requestDetails.textContent = i18n.messages.requestNoneSelected;
    refs.copyCurl.disabled = true;
    refs.copyFetch.disabled = true;
    refs.replayRequest.disabled = true;
    return;
  }

  const linkedEvents = player
    .getRequestEvents(selectedEntry.reqId)
    .filter((event) => (model.eventById.get(event.id)?.mono ?? event.mono) <= state.playheadMono)
    .map((event) => ({
      id: event.id,
      type: event.type,
      mono: model.eventById.get(event.id)?.mono ?? event.mono,
      scope: resolveEventScope(model, event),
      frame: event.frame ?? null,
      cdp: event.cdp ?? null,
      data: event.data
    }));

  refs.requestDetails.textContent = JSON.stringify(
    {
      requestScope: resolveRequestScope(model, selectedEntry.reqId),
      request: selectedEntry,
      linkedEvents
    },
    null,
    2
  );

  refs.copyCurl.disabled = false;
  refs.copyFetch.disabled = false;
  refs.replayRequest.disabled = false;
}

function renderNetworkSummary(
  model: ArchiveModel,
  visibleEntries: NetworkWaterfallEntry[],
  filteredEntries: NetworkWaterfallEntry[],
  renderedEntries: NetworkWaterfallEntry[]
): void {
  if (visibleEntries.length === 0) {
    refs.networkScopeSummary.textContent = i18n.formatScopeSummary(0, 0);
    refs.networkSummary.textContent = i18n.messages.networkSummaryEmpty;
    return;
  }

  const filteredMainCount = filteredEntries.filter(
    (entry) => resolveRequestScope(model, entry.reqId) === "main"
  ).length;
  const filteredIframeCount = Math.max(0, filteredEntries.length - filteredMainCount);
  const filteredBytes = sumNetworkTransferBytes(filteredEntries);
  const totalBytes = sumNetworkTransferBytes(visibleEntries);
  refs.networkScopeSummary.textContent = i18n.formatScopeSummary(
    filteredMainCount,
    filteredIframeCount
  );
  refs.networkSummary.textContent = i18n.formatNetworkSummary(
    filteredEntries.length,
    visibleEntries.length,
    formatByteSize(filteredBytes),
    formatByteSize(totalBytes),
    renderedEntries.length
  );
}

function renderConsoleSignals(): void {
  const model = state.model;

  if (!model) {
    refs.consoleList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(
    model.consoleSignals,
    state.playheadMono,
    (event) => event.mono
  );
  const query = state.consoleFilter.trim();
  const visibleSignals = model.consoleSignals
    .slice(0, visibleCount)
    .filter((event) => matchesScopeFilter(resolveEventScope(model, event), state.scopeFilter));

  if (!query) {
    const scoped = visibleSignals.slice(Math.max(0, visibleSignals.length - MAX_SIGNAL_ROWS));
    renderSignalEvents(refs.consoleList, scoped, model);
    return;
  }

  const filtered: WebBlackboxEvent[] = [];

  for (let index = 0; index < visibleCount; index += 1) {
    if (model.consoleSignalSearchText[index]?.includes(query)) {
      const event = model.consoleSignals[index];

      if (event && matchesScopeFilter(resolveEventScope(model, event), state.scopeFilter)) {
        filtered.push(event);
      }
    }
  }

  const scoped = filtered.slice(Math.max(0, filtered.length - MAX_SIGNAL_ROWS));
  renderSignalEvents(refs.consoleList, scoped, model);
}

function renderRealtimeSignals(): void {
  const model = state.model;

  if (!model) {
    refs.realtimeList.innerHTML = "";
    return;
  }

  const visibleCount = upperBoundByMono(model.realtime, state.playheadMono, (event) => event.mono);
  const filteredByScope = model.realtime
    .slice(0, visibleCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    );
  const scoped = filteredByScope.slice(Math.max(0, filteredByScope.length - MAX_SIGNAL_ROWS));

  refs.realtimeList.innerHTML = scoped
    .map((entry) => {
      const direction = entry.direction ? `${entry.direction} ` : "";
      const preview = entry.payloadPreview
        ? entry.payloadPreview.length > 120
          ? `${entry.payloadPreview.slice(0, 120)}...`
          : entry.payloadPreview
        : i18n.messages.realtimeNoPayload;
      const scope = resolveScopeByEventId(model, entry.eventId);
      const scopeLabel = i18n.formatScopeTag(scope);
      const scopeClass =
        scope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";

      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="${scopeClass}">${scopeLabel}</span><span class="signal-text">${escapeHtml(direction)}${escapeHtml(entry.streamId ?? "-")} @ ${entry.mono.toFixed(2)}ms ${escapeHtml(preview)}</span></li>`;
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
  const filteredByScope = model.storage
    .slice(0, visibleCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    );
  const scoped = filteredByScope.slice(Math.max(0, filteredByScope.length - MAX_SIGNAL_ROWS));

  refs.storageList.innerHTML = scoped
    .map((entry) => {
      const operation = entry.operation ? `${entry.operation} ` : "";
      const hash = entry.hash ? ` hash=${entry.hash}` : "";
      const summary = `${entry.kind} ${operation}@ ${entry.mono.toFixed(2)}ms${hash}`;
      const scope = resolveScopeByEventId(model, entry.eventId);
      const scopeLabel = i18n.formatScopeTag(scope);
      const scopeClass =
        scope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";
      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="${scopeClass}">${scopeLabel}</span><span class="signal-text">${escapeHtml(summary)}</span></li>`;
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
  const filteredByScope = model.perf
    .slice(0, visibleCount)
    .filter((entry) =>
      matchesScopeFilter(resolveScopeByEventId(model, entry.eventId), state.scopeFilter)
    );
  const scoped = filteredByScope.slice(Math.max(0, filteredByScope.length - MAX_SIGNAL_ROWS));

  refs.perfList.innerHTML = scoped
    .map((entry) => {
      const size = typeof entry.size === "number" ? ` size=${entry.size}` : "";
      const hash = entry.hash ? ` hash=${entry.hash}` : "";
      const summary = `${entry.kind} @ ${entry.mono.toFixed(2)}ms${size}${hash}`;
      const scope = resolveScopeByEventId(model, entry.eventId);
      const scopeLabel = i18n.formatScopeTag(scope);
      const scopeClass =
        scope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";
      return `<li class="signal"><span class="signal-type">${escapeHtml(entry.eventType)}</span><span class="${scopeClass}">${scopeLabel}</span><span class="signal-text">${escapeHtml(summary)}</span></li>`;
    })
    .join("");
}

function renderFilmstripList(): void {
  const model = state.model;

  if (!model || model.screenshots.length === 0) {
    refs.filmstripList.innerHTML = `<li class="empty">${escapeHtml(i18n.messages.noScreenshotEvents)}</li>`;
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
    clearScreenshotView(i18n.messages.stagePlaceholderLoadArchive);
    return;
  }

  const shot = resolveShotForMono(model.screenshots, state.playheadMono);

  if (!shot) {
    clearScreenshotView(i18n.messages.screenshotBeforePlayhead);
    return;
  }

  const shotChanged = forceReload || state.screenshotShotId !== shot.shotId;
  state.screenshotContext = shot.context;

  if (shotChanged) {
    state.screenshotShotId = shot.shotId;
    refs.preview.hidden = true;
    refs.stagePlaceholder.hidden = false;
    refs.stagePlaceholder.textContent = i18n.messages.screenshotLoading;

    const token = ++state.screenshotLoadToken;
    const url = await getScreenshotUrlByShotId(shot.shotId);

    if (token !== state.screenshotLoadToken || state.screenshotShotId !== shot.shotId) {
      return;
    }

    if (!url) {
      clearScreenshotView(i18n.t("screenshotMissingBlob", { shotId: shot.shotId }));
      return;
    }

    refs.preview.src = url;
    updateStagePlaceholder();
  }

  state.screenshotTrail = buildScreenshotTrail(model.pointers, state.playheadMono);
  state.screenshotMarker = resolveScreenshotMarker(model.pointers, state.playheadMono, shot.marker);
  refs.filmstripMeta.textContent = describeScreenshotMeta(
    state.screenshotMarker,
    state.screenshotTrail,
    locale
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
  refs.preview.hidden = true;
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
    refs.stagePlaceholder.textContent = i18n.messages.screenshotLoading;
    return;
  }

  if (!refs.stagePlaceholder.textContent) {
    refs.stagePlaceholder.textContent = i18n.messages.screenshotNoLoaded;
  }
}

function resetScreenshotResources(): void {
  state.screenshotLoadToken += 1;
  hideProgressHover();

  for (const url of state.screenshotUrlCache.values()) {
    URL.revokeObjectURL(url);
  }

  state.screenshotUrlCache.clear();
  clearScreenshotView(i18n.messages.stagePlaceholderLoadArchive);
}

function applyTimelineFilters(model: ArchiveModel, visibleCount: number): WebBlackboxEvent[] {
  const text = state.textFilter.trim().toLowerCase();
  const filterType = state.typeFilter;
  const scopeFilter = state.scopeFilter;

  if (!text && filterType === "all" && scopeFilter === "all") {
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

    if (!matchesScopeFilter(resolveEventScope(model, event), scopeFilter)) {
      continue;
    }

    if (text && !model.eventSearchText[index]?.includes(text)) {
      continue;
    }

    filtered.push(event);
  }

  return filtered;
}

function applyActionFilters(model: ArchiveModel, visibleCount: number): ActionTimelineEntry[] {
  const text = state.textFilter.trim().toLowerCase();
  const filterType = state.typeFilter;
  const scopeFilter = state.scopeFilter;

  if (!text && filterType === "all" && scopeFilter === "all") {
    return model.actionTimeline.slice(0, visibleCount);
  }

  const filtered: ActionTimelineEntry[] = [];

  for (let index = 0; index < visibleCount; index += 1) {
    const action = model.actionTimeline[index];

    if (!action) {
      continue;
    }

    if (!matchesActionTypeFilter(action, filterType)) {
      continue;
    }

    if (!matchesScopeFilter(resolveActionScope(model, action), scopeFilter)) {
      continue;
    }

    if (text && !model.actionSearchText[index]?.includes(text)) {
      continue;
    }

    filtered.push(action);
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

function matchesActionTypeFilter(action: ActionTimelineEntry, filterType: TimelineFilter): boolean {
  if (filterType === "all") {
    return true;
  }

  if (filterType === "errors") {
    return action.errorCount > 0;
  }

  if (filterType === "network") {
    return action.requestCount > 0;
  }

  if (filterType === "storage") {
    return action.triggerType?.startsWith("storage.") ?? false;
  }

  if (filterType === "console") {
    return action.errorCount > 0 || (action.triggerType?.startsWith("console.") ?? false);
  }

  return true;
}

function resolveEventScope(model: ArchiveModel, event: WebBlackboxEvent): EventScope {
  return model.eventScopeById.get(event.id) ?? inferEventScope(event);
}

function resolveRequestScope(model: ArchiveModel, reqId: string): EventScope {
  return model.requestScopeByReqId.get(reqId) ?? "main";
}

function resolveScopeByEventId(model: ArchiveModel, eventId: string): EventScope {
  const event = model.eventById.get(eventId);

  if (!event) {
    return "main";
  }

  return resolveEventScope(model, event);
}

function resolveActionScope(model: ArchiveModel, action: ActionTimelineEntry): EventScope {
  const indexedScope = model.actionScopeByActId.get(action.actId);

  if (indexedScope) {
    return indexedScope;
  }

  const triggerEvent = model.eventById.get(action.triggerEventId);

  if (triggerEvent && resolveEventScope(model, triggerEvent) === "iframe") {
    return "iframe";
  }

  const hasIframeRequest = action.requests.some(
    (request) => resolveRequestScope(model, request.reqId) === "iframe"
  );

  if (hasIframeRequest) {
    return "iframe";
  }

  const hasIframeError = action.errors.some((error) => {
    const event = model.eventById.get(error.eventId);
    return Boolean(event && resolveEventScope(model, event) === "iframe");
  });

  if (hasIframeError) {
    return "iframe";
  }

  return "main";
}

function buildArchiveModel(player: WebBlackboxPlayer): ArchiveModel {
  const timeNormalization = normalizePlaybackEvents(player.events);
  const events = timeNormalization.events;
  const rawActionTimeline = player.getActionTimeline();
  const derived = player.buildDerived();
  const consoleSignals: WebBlackboxEvent[] = [];
  const consoleSignalSearchText: string[] = [];
  const eventById = new Map<string, WebBlackboxEvent>();
  const eventScopeById = new Map<string, EventScope>();
  const eventSearchText: string[] = [];
  const errorPrefix: number[] = [];
  const requestPrefix: number[] = [];
  const screenshots: ScreenshotRecord[] = [];
  const shotByEventId = new Map<string, ScreenshotRecord>();
  const pointers: PointerSample[] = [];
  const requestScopeByReqId = new Map<string, EventScope>();

  let errorCount = 0;
  let requestCount = 0;

  for (const event of events) {
    const scope = inferEventScope(event);

    eventById.set(event.id, event);
    eventScopeById.set(event.id, scope);

    if (event.type.startsWith("error.")) {
      errorCount += 1;
      consoleSignals.push(event);
      consoleSignalSearchText.push(buildConsoleSignalSearchText(event));
    } else if (event.type.startsWith("console.")) {
      consoleSignals.push(event);
      consoleSignalSearchText.push(buildConsoleSignalSearchText(event));
    }

    if (event.type === "network.request") {
      requestCount += 1;
    }

    const reqId = extractReqIdFromEvent(event);

    if (reqId) {
      requestScopeByReqId.set(reqId, mergeEventScopes(requestScopeByReqId.get(reqId), scope));
    }

    errorPrefix.push(errorCount);
    requestPrefix.push(requestCount);
    eventSearchText.push(
      `${buildEventSearchText(event)} ${scope} ${event.cdp ?? ""} ${event.frame ?? ""}`.toLowerCase()
    );

    const data = asRecord(event.data);

    if (event.type === "screen.screenshot") {
      const shotId = readScreenshotShotId(event, data);

      if (shotId) {
        const shot: ScreenshotRecord = {
          eventId: event.id,
          mono: event.mono,
          shotId,
          reason: typeof data?.reason === "string" ? data.reason : null,
          format: typeof data?.format === "string" ? data.format : null,
          size: asFiniteNumber(data?.size),
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
        reason: click ? i18n.messages.pointerReasonActionClick : i18n.messages.pointerReasonMove
      });
    }
  }

  screenshots.sort((left, right) => left.mono - right.mono);
  pointers.sort((left, right) => left.mono - right.mono);

  const waterfall = player
    .getNetworkWaterfall()
    .map((entry) => normalizeWaterfallEntry(entry, timeNormalization))
    .sort((left, right) => left.startMono - right.startMono);
  const waterfallByReqId = new Map<string, NetworkWaterfallEntry>();

  for (const entry of waterfall) {
    waterfallByReqId.set(entry.reqId, entry);
  }

  const actionSpanById = new Map(derived.actionSpans.map((span) => [span.actId, span]));
  const actionTimeline = rawActionTimeline
    .map((entry) =>
      normalizeActionTimelineEntry(entry, actionSpanById, timeNormalization, screenshots)
    )
    .sort((left, right) => left.startMono - right.startMono);
  const actionSearchText = actionTimeline.map((entry) => buildActionSearchText(entry));
  const actionScopeByActId = buildActionScopeIndex(
    derived.actionSpans,
    eventById,
    requestScopeByReqId
  );
  const minMono = events[0]?.mono ?? 0;
  const maxMono = events[events.length - 1]?.mono ?? 0;
  const progressMarkers = buildProgressMarkers(events, minMono, maxMono);

  return {
    events,
    eventScopeById,
    actionTimeline,
    actionScopeByActId,
    actionSearchText,
    consoleSignals,
    consoleSignalSearchText,
    eventById,
    eventSearchText,
    errorPrefix,
    requestPrefix,
    screenshots,
    shotByEventId,
    pointers,
    waterfall,
    waterfallByReqId,
    requestScopeByReqId,
    realtime: player
      .getRealtimeNetworkTimeline()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
    storage: player
      .getStorageTimeline()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
    perf: player
      .getPerformanceArtifacts()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
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

function normalizeWaterfallEntry(
  entry: NetworkWaterfallEntry,
  timeNormalization: PlaybackTimeNormalization
): NetworkWaterfallEntry {
  const eventMonos = entry.eventIds
    .map((eventId) => timeNormalization.monoByEventId.get(eventId))
    .filter((mono): mono is number => typeof mono === "number" && Number.isFinite(mono))
    .sort((left, right) => left - right);

  if (eventMonos.length === 0) {
    return entry;
  }

  const startMono = eventMonos[0] ?? entry.startMono;
  const eventEndMono = eventMonos[eventMonos.length - 1] ?? startMono;
  const eventDurationMs = Math.max(0, eventEndMono - startMono);
  const durationMs =
    timeNormalization.source === "wall-clock" && eventMonos.length > 1
      ? eventDurationMs
      : entry.durationMs;
  const endMono = Math.max(eventEndMono, startMono + Math.max(0, durationMs));

  return {
    ...entry,
    startMono,
    endMono,
    durationMs: Math.max(0, durationMs)
  };
}

function normalizeActionTimelineEntry(
  entry: ActionTimelineEntry,
  actionSpanById: Map<string, ActionSpan>,
  timeNormalization: PlaybackTimeNormalization,
  screenshots: ScreenshotRecord[]
): ActionTimelineEntry {
  const span = actionSpanById.get(entry.actId);
  const spanMonos =
    span?.eventIds
      .map((eventId) => timeNormalization.monoByEventId.get(eventId))
      .filter((mono): mono is number => typeof mono === "number" && Number.isFinite(mono)) ?? [];
  const triggerMono = normalizeMonoForEvent(
    entry.triggerEventId,
    timeNormalization,
    entry.startMono
  );
  const startMono = spanMonos.length > 0 ? Math.min(...spanMonos) : triggerMono;
  const endMono =
    spanMonos.length > 0
      ? Math.max(...spanMonos)
      : Math.max(startMono, normalizeMonoValue(entry.endMono, timeNormalization));
  const normalizedErrors = entry.errors.map((error) => ({
    ...error,
    mono: normalizeMonoForEvent(error.eventId, timeNormalization, error.mono)
  }));
  const screenshot = entry.screenshot
    ? {
        ...entry.screenshot,
        mono: normalizeMonoForEvent(
          entry.screenshot.eventId,
          timeNormalization,
          entry.screenshot.mono
        )
      }
    : findScreenshotForNormalizedAction(startMono, endMono, screenshots);

  return {
    ...entry,
    startMono,
    endMono,
    durationMs: Number(Math.max(0, endMono - startMono).toFixed(2)),
    errors: normalizedErrors,
    screenshot
  };
}

function findScreenshotForNormalizedAction(
  startMono: number,
  endMono: number,
  screenshots: ScreenshotRecord[]
): ActionTimelineEntry["screenshot"] {
  const inSpan = screenshots.filter((shot) => shot.mono >= startMono && shot.mono <= endMono);
  const afterSpan = screenshots.find((shot) => shot.mono > endMono && shot.mono <= endMono + 2_000);
  const shot = inSpan[inSpan.length - 1] ?? afterSpan;

  if (!shot) {
    return null;
  }

  return {
    eventId: shot.eventId,
    mono: shot.mono,
    shotId: shot.shotId,
    reason: shot.reason,
    format: shot.format,
    size: shot.size
  };
}

function normalizeMonoForEvent(
  eventId: string,
  timeNormalization: PlaybackTimeNormalization,
  fallbackMono: number
): number {
  return (
    timeNormalization.monoByEventId.get(eventId) ??
    normalizeMonoValue(fallbackMono, timeNormalization)
  );
}

function normalizeMonoValue(mono: number, timeNormalization: PlaybackTimeNormalization): number {
  if (timeNormalization.source === "mono") {
    return mono;
  }

  for (const [eventId, rawMono] of timeNormalization.rawMonoByEventId.entries()) {
    if (Math.abs(rawMono - mono) < 0.001) {
      return timeNormalization.monoByEventId.get(eventId) ?? mono;
    }
  }

  return mono;
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

function renderSignalEvents(
  container: HTMLElement,
  events: WebBlackboxEvent[],
  model: ArchiveModel
): void {
  const scoped = events.slice(-MAX_SIGNAL_ROWS);

  container.innerHTML = scoped
    .map((event) => {
      const text = stringifySignalPayload(event.data);
      const eventScope = resolveEventScope(model, event);
      const scopeLabel = i18n.formatScopeTag(eventScope);
      const scopeClass =
        eventScope === "iframe" ? "scope-tag scope-tag-iframe" : "scope-tag scope-tag-main";
      const sourceLabel = [
        event.cdp ? truncateId(event.cdp) : "",
        event.frame ? truncateId(event.frame) : ""
      ]
        .filter((value) => value.length > 0)
        .join(" · ");
      const sourceTag = sourceLabel
        ? `<span class="scope-session mono" title="${escapeHtml(event.cdp ?? event.frame ?? "")}">${escapeHtml(sourceLabel)}</span>`
        : "";

      return `<li class="signal"><span class="signal-type">${escapeHtml(event.type)}</span><span class="${scopeClass}">${scopeLabel}</span>${sourceTag}<span class="signal-text">${escapeHtml(text)}</span></li>`;
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
  setFeedback(i18n.t("feedbackCopyCurl", { reqId }));
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
  setFeedback(i18n.t("feedbackCopyFetch", { reqId }));
}

async function replaySelectedRequest(): Promise<void> {
  const model = state.model;
  const reqId = state.selectedRequestId;

  if (!model || !reqId) {
    return;
  }

  const request = model.waterfallByReqId.get(reqId);

  if (!request) {
    return;
  }

  const headers = buildReplayHeaders(request.requestHeaders);
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers
  };

  if (shouldAttachReplayBody(method, request.requestBodyText)) {
    init.body = request.requestBodyText;
  }

  const startedAt = performance.now();

  try {
    const response = await fetch(request.url, init);
    const elapsedMs = performance.now() - startedAt;
    const replayStatus = response.status;
    const capturedStatus = typeof request.status === "number" ? request.status : null;
    const statusDelta = capturedStatus === null ? null : replayStatus - capturedStatus;
    const replayBody = await response.text();
    const replayBodyHash = await sha256HexFromText(replayBody);
    const capturedBodyHash = request.responseBodyHash ?? null;
    const bodyHashMatch =
      typeof replayBodyHash === "string" &&
      typeof capturedBodyHash === "string" &&
      replayBodyHash === capturedBodyHash;
    const capturedBodySize =
      typeof request.responseBodySize === "number" ? request.responseBodySize : null;
    const replayBodySize = replayBody.length;

    refs.requestDetails.textContent = JSON.stringify(
      {
        replay: {
          reqId,
          method,
          url: request.url,
          status: replayStatus,
          statusText: response.statusText || null,
          durationMs: Number(elapsedMs.toFixed(2)),
          responseBodyHash: replayBodyHash,
          responseBodySize: replayBodySize
        },
        captured: {
          status: capturedStatus,
          failed: request.failed,
          durationMs: Number(request.durationMs.toFixed(2)),
          responseBodyHash: capturedBodyHash,
          responseBodySize: capturedBodySize
        },
        delta: {
          status: statusDelta,
          durationMs: Number((elapsedMs - request.durationMs).toFixed(2)),
          responseBodySize:
            capturedBodySize === null
              ? null
              : Number((replayBodySize - capturedBodySize).toFixed(0)),
          responseBodyHashMatch: bodyHashMatch
        },
        responsePreview: compactText(replayBody, 4_000)
      },
      null,
      2
    );

    const statusLabel =
      capturedStatus === null
        ? String(replayStatus)
        : i18n.t("feedbackReplayStatusDelta", {
            status: replayStatus,
            captured: capturedStatus,
            delta: formatDelta(statusDelta ?? 0)
          });
    setFeedback(i18n.t("feedbackReplaySucceeded", { reqId, statusLabel }));
  } catch (error) {
    refs.requestDetails.textContent = JSON.stringify(
      {
        replay: {
          reqId,
          method,
          url: request.url,
          error: String(error)
        }
      },
      null,
      2
    );
    setFeedback(i18n.t("feedbackReplayFailed", { reqId }));
  }
}

async function copyProgressHoverResponse(): Promise<void> {
  const payload = state.responseCopyText;

  if (!payload) {
    return;
  }

  try {
    await copyText(payload);
  } catch {
    setFeedback(i18n.messages.responseCopyFailed);
    return;
  }

  refs.progressHoverResponseCopy.textContent = i18n.messages.copied;
  setFeedback(i18n.messages.responseCopied);
  const token = state.progressHoverToken;

  window.setTimeout(() => {
    if (token !== state.progressHoverToken || refs.progressHoverResponseCopy.disabled) {
      return;
    }

    refs.progressHoverResponseCopy.textContent = i18n.messages.copy;
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

    const passphrase = await promptArchivePassphrase(fileName);

    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error(i18n.messages.encryptedArchivePassphraseRequired);
    }

    return WebBlackboxPlayer.open(bytes, {
      passphrase: passphrase.trim()
    });
  }
}

async function promptArchivePassphrase(fileName: string): Promise<string | null> {
  refs.archivePassphraseContext.textContent = i18n.formatPassphrasePrompt(fileName);
  refs.archivePassphraseInput.value = "";
  const result = await openDialog(refs.archivePassphraseDialog, refs.archivePassphraseInput);

  if (result !== "confirm") {
    return null;
  }

  const trimmed = refs.archivePassphraseInput.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function setFeedback(text: string): void {
  state.feedback = text;
  refs.feedback.textContent = text;
}

function rememberShareServerApiKey(baseUrl: string, apiKey: string): void {
  setShareServerApiKeyForBaseUrl(state.shareServerApiKeysByOrigin, baseUrl, apiKey);
  persistShareServerApiKeys(state.shareServerApiKeysByOrigin);
}

function readStoredShareServerApiKeys(baseUrl: string): Record<string, string> {
  const parsed = parseStoredShareServerApiKeys(readStoredText(SHARE_SERVER_API_KEYS_STORAGE_KEY));
  const legacyApiKey = readStoredText(LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY);

  if (legacyApiKey) {
    const origin = resolveShareServerOrigin(baseUrl);

    if (origin && !parsed[origin]) {
      parsed[origin] = legacyApiKey;
    }

    removeStoredItem(LEGACY_SHARE_SERVER_API_KEY_STORAGE_KEY);
    persistShareServerApiKeys(parsed);
  }

  return parsed;
}

function parseStoredShareServerApiKeys(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const candidate = asRecord(JSON.parse(raw));

    if (!candidate) {
      return {};
    }

    const parsed: Record<string, string> = {};

    for (const [originCandidate, apiKeyCandidate] of Object.entries(candidate)) {
      if (typeof apiKeyCandidate !== "string") {
        continue;
      }

      const origin = resolveShareServerOrigin(originCandidate);
      const apiKey = apiKeyCandidate.trim();

      if (!origin || apiKey.length === 0) {
        continue;
      }

      parsed[origin] = apiKey;
    }

    return parsed;
  } catch {
    removeStoredItem(SHARE_SERVER_API_KEYS_STORAGE_KEY);
    return {};
  }
}

function persistShareServerApiKeys(apiKeysByOrigin: Record<string, string>): void {
  const entries: Array<{ origin: string; apiKey: string }> = [];

  for (const [originCandidate, apiKeyCandidate] of Object.entries(apiKeysByOrigin)) {
    const origin = resolveShareServerOrigin(originCandidate);
    const apiKey = apiKeyCandidate.trim();

    if (!origin || apiKey.length === 0) {
      continue;
    }

    entries.push({
      origin,
      apiKey
    });
  }

  entries.sort((left, right) => left.origin.localeCompare(right.origin));

  if (entries.length === 0) {
    removeStoredItem(SHARE_SERVER_API_KEYS_STORAGE_KEY);
    return;
  }

  const serialized: Record<string, string> = {};

  for (const entry of entries) {
    serialized[entry.origin] = entry.apiKey;
  }

  writeStoredText(SHARE_SERVER_API_KEYS_STORAGE_KEY, JSON.stringify(serialized));
}
