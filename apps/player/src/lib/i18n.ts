import { readStoredText, writeStoredText } from "./storage.js";

export type PlayerLocale = "en" | "zh-CN";

type PanelKey =
  | "timeline"
  | "details"
  | "actions"
  | "network"
  | "compare"
  | "console"
  | "realtime"
  | "storage"
  | "perf";

type NetworkType =
  | "document"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "text"
  | "other";

type CompareSignal = "regressed" | "stable" | "new" | "missing";
type MarkerKind = "error" | "network" | "screenshot" | "action";
type SortDirection = "asc" | "desc";
type SelectionKind = "action" | "event" | "request";

type PlayerMessages = {
  pageTitlePlayer: string;
  toolbarTitlePlayer: string;
  toolbarPlayerVersion: string;
  toolbarLoadArchive: string;
  toolbarLoadCompare: string;
  toolbarGitHubRepo: string;
  toolbarLanguage: string;
  localeNames: Record<PlayerLocale, string>;
  statusWindow: string;
  statusCounts: string;
  statusPanelOnly: string;
  statusPanelSelection: string;
  quickTriage: string;
  maskResponsePreview: string;
  dismiss: string;
  cancel: string;
  load: string;
  copy: string;
  copied: string;
  close: string;
  preflightErrors: string;
  preflightFailedReqs: string;
  preflightSlowReqs: string;
  preflightScreenshots: string;
  preflightActions: string;
  preflightOpenFullPlayer: string;
  preflightCopyBugReport: string;
  preflightJumpFirstError: string;
  preflightJumpSlowestRequest: string;
  playbackBackStep: string;
  playbackPlay: string;
  playbackPause: string;
  playbackForwardStep: string;
  playbackSpeed: string;
  playbackTime: string;
  previewAltScreenshotPlayback: string;
  previewAltProgressPreview: string;
  stagePlaceholderLoadArchive: string;
  progressLegendError: string;
  progressLegendNetwork: string;
  progressLegendScreenshot: string;
  progressLegendAction: string;
  resizeScreenshotStage: string;
  resizePanels: string;
  filterTimelinePlaceholder: string;
  filterAllTimelineEvents: string;
  filterErrors: string;
  filterNetwork: string;
  filterStorage: string;
  filterConsole: string;
  scopeFilterAll: string;
  scopeFilterMain: string;
  scopeFilterIframe: string;
  exportBugReport: string;
  exportHar: string;
  exportPlaywright: string;
  exportPlaywrightMocks: string;
  exportGitHub: string;
  exportJira: string;
  share: string;
  loadShared: string;
  panelTabsLabel: string;
  eventHeading: string;
  eventDetailsHeading: string;
  actionTimelineHeading: string;
  networkHeading: string;
  compareHeading: string;
  consoleHeading: string;
  realtimeHeading: string;
  storageHeading: string;
  performanceHeading: string;
  networkFiltersLabel: string;
  networkFilterPlaceholder: string;
  networkAllMethods: string;
  networkAllStatus: string;
  networkStatusFailed: string;
  networkAllTypes: string;
  networkColumnName: string;
  networkColumnMethod: string;
  networkColumnStatus: string;
  networkColumnType: string;
  networkColumnInitiator: string;
  networkColumnSize: string;
  networkColumnTime: string;
  networkColumnWaterfall: string;
  copyCurl: string;
  copyFetch: string;
  replayRequest: string;
  consoleFilterPlaceholder: string;
  shareArchiveTitle: string;
  shareArchiveDescription: string;
  shareServerUrl: string;
  shareOptionalApiKey: string;
  sharePlaceholderServerUrl: string;
  sharePlaceholderApiKeyRequired: string;
  sharePrivacyPreflightTitle: string;
  sharePrivacyPreflightDescription: string;
  sharePrivacyRedactionProfile: string;
  sharePrivacyDetectedSignals: string;
  sharePrivacySensitivePreview: string;
  sharePrivacyReviewed: string;
  sharePrivacyProfileSummary: string;
  sharePrivacyDetectedSummary: string;
  sharePrivacyPreviewSummary: string;
  sharePrivacyPreviewEmpty: string;
  sharePrivacyPreviewSample: string;
  loadSharedArchiveTitle: string;
  loadSharedArchiveDescription: string;
  shareReference: string;
  shareReferencePlaceholder: string;
  encryptedArchiveTitle: string;
  encryptedArchiveDescription: string;
  passphrase: string;
  passphrasePlaceholder: string;
  playwrightPreviewTitle: string;
  playwrightPreviewDescription: string;
  playwrightRangeStart: string;
  playwrightRangeEnd: string;
  playwrightMaxActions: string;
  playwrightIncludeHarReplay: string;
  regenerate: string;
  download: string;
  dropArchiveToLoad: string;
  dropArchiveSupport: string;
  responseExpandJson: string;
  responseCollapseJson: string;
  responseNoBodyCaptured: string;
  responseUnavailable: string;
  responseCopyFailed: string;
  responseCopied: string;
  responsePreviewEmptyBody: string;
  responsePreviewBinary: string;
  noEventAtTime: string;
  progressMarkerLabel: string;
  progressSummary: string;
  jumpNoErrorEvents: string;
  jumpedFirstError: string;
  jumpNoNetworkRequests: string;
  jumpedSlowestRequest: string;
  summaryEmptyLoadArchive: string;
  compareDetailsEmpty: string;
  summaryLabelTriage: string;
  summaryPillErrors: string;
  summaryPillFailedRequests: string;
  summaryPillSlowRequests: string;
  summaryCompareEventDelta: string;
  summaryMode: string;
  summaryOrigin: string;
  summaryPlayhead: string;
  summaryVisibleEvents: string;
  summaryMainEvents: string;
  summaryIframeEvents: string;
  summaryVisibleErrors: string;
  summaryVisibleRequests: string;
  summaryMainRequests: string;
  summaryIframeRequests: string;
  summaryVisibleActions: string;
  summaryVisibleScreenshots: string;
  summaryAllActions: string;
  compareNoArchiveLoaded: string;
  compareNoEndpointDeltas: string;
  compareHeadingTimelineAB: string;
  compareHeadingWaterfallAlignment: string;
  compareHeadingEndpointRegressions: string;
  compareColumnEndpoint: string;
  compareColumnCountDelta: string;
  compareColumnFailRateDelta: string;
  compareColumnP95Delta: string;
  compareColumnSessionA: string;
  compareColumnSessionB: string;
  compareColumnSignal: string;
  compareEndpointSummary: string;
  timelineEmpty: string;
  actionsEmpty: string;
  eventDetailsEmpty: string;
  eventDetailsOutOfRange: string;
  actionDetailsEmpty: string;
  actionDetailsOutOfRange: string;
  actionMetricDuration: string;
  actionMetricEvents: string;
  actionMetricRequests: string;
  actionMetricErrors: string;
  actionMetricShot: string;
  actionMetricNoShot: string;
  actionSectionNetwork: string;
  actionSectionErrors: string;
  actionSectionReplay: string;
  replayDiagnosticSummary: string;
  replayConfidenceHigh: string;
  replayConfidenceMedium: string;
  replayConfidenceLow: string;
  replayCauseChainEmpty: string;
  sortColumnFallback: string;
  sortByColumn: string;
  sortedByColumn: string;
  requestDetailsEmpty: string;
  requestNoneSelected: string;
  requestWindowEmpty: string;
  requestFilterEmpty: string;
  networkScopeSummary: string;
  networkSummaryEmpty: string;
  networkSummary: string;
  networkSummaryTruncated: string;
  scopeTagMain: string;
  scopeTagIframe: string;
  scopeSummaryMain: string;
  scopeSummaryIframe: string;
  realtimeNoPayload: string;
  noScreenshotEvents: string;
  screenshotBeforePlayhead: string;
  screenshotLoading: string;
  screenshotDecodeFailed: string;
  screenshotMissingBlob: string;
  screenshotNoLoaded: string;
  feedbackBugReportExported: string;
  feedbackHarExported: string;
  feedbackGitHubIssueExported: string;
  feedbackJiraIssueExported: string;
  feedbackQuickTriageDismissed: string;
  feedbackNoSupportedArchive: string;
  feedbackArchiveLoaded: string;
  feedbackArchiveLoadedWithoutPlayback: string;
  feedbackArchiveLoadFailed: string;
  feedbackCompareLoaded: string;
  feedbackCompareLoadFailed: string;
  feedbackBugReportCopied: string;
  feedbackLoadArchiveBeforePlaywright: string;
  feedbackPlaywrightPreviewCopied: string;
  feedbackPlaywrightScriptExported: string;
  feedbackPlaywrightMocksExported: string;
  feedbackLoadArchiveBeforeSharing: string;
  feedbackInvalidShareServerUrl: string;
  feedbackShareUploadProgress: string;
  feedbackShareMissingUrl: string;
  feedbackShareSucceeded: string;
  feedbackShareFailed: string;
  feedbackInvalidShareReference: string;
  feedbackSharedArchiveLoaded: string;
  feedbackSharedArchiveLoadFailed: string;
  feedbackSharedArchiveLoadingFromUrl: string;
  feedbackCopyCurl: string;
  feedbackCopyFetch: string;
  feedbackReplayStatusDelta: string;
  feedbackReplaySucceeded: string;
  feedbackReplayFailed: string;
  encryptedArchivePassphraseRequired: string;
  encryptedArchivePrompt: string;
  uploadNetworkError: string;
  uploadAborted: string;
  uploadResponseNotJsonObject: string;
  uploadInvalidJson: string;
  screenshotTrailPoints: string;
  screenshotNoTrailPoints: string;
  screenshotNoPointerMarker: string;
  screenshotPointerMarker: string;
  pointerReasonActionClick: string;
  pointerReasonMove: string;
  networkInitiatorDirect: string;
  networkInitiatorActionNumber: string;
  networkStatusPending: string;
  networkStatusPendingPlain: string;
  markerKinds: Record<MarkerKind, string>;
  networkTypes: Record<NetworkType, string>;
  compareSignals: Record<CompareSignal, string>;
  panels: Record<PanelKey, string>;
  sortDirections: Record<SortDirection, string>;
};

export const PLAYER_LOCALE_STORAGE_KEY = "webblackbox.player.locale";

const PLAYER_MESSAGES: Record<PlayerLocale, PlayerMessages> = {
  en: {
    pageTitlePlayer: "WebBlackbox Player",
    toolbarTitlePlayer: "Player",
    toolbarPlayerVersion: "Player version",
    toolbarLoadArchive: "Load Archive",
    toolbarLoadCompare: "Load Compare",
    toolbarGitHubRepo: "GitHub Repo",
    toolbarLanguage: "Language",
    localeNames: {
      en: "English",
      "zh-CN": "中文"
    },
    statusWindow: "Window",
    statusCounts: "{events} events | {errors} errors | {requests} requests",
    statusPanelOnly: "{panel} panel",
    statusPanelSelection: "{panel} panel | {selection}",
    quickTriage: "Quick Triage",
    maskResponsePreview: "Mask response preview",
    dismiss: "Dismiss",
    cancel: "Cancel",
    load: "Load",
    copy: "Copy",
    copied: "Copied",
    close: "Close",
    preflightErrors: "Errors",
    preflightFailedReqs: "Failed reqs",
    preflightSlowReqs: "Slow reqs",
    preflightScreenshots: "Screenshots",
    preflightActions: "Actions",
    preflightOpenFullPlayer: "Open Full Player",
    preflightCopyBugReport: "Copy Bug Report",
    preflightJumpFirstError: "Jump to first error",
    preflightJumpSlowestRequest: "Jump to slowest request",
    playbackBackStep: "-1s",
    playbackPlay: "Play",
    playbackPause: "Pause",
    playbackForwardStep: "+1s",
    playbackSpeed: "Speed",
    playbackTime: "Playback time",
    previewAltScreenshotPlayback: "Screenshot playback",
    previewAltProgressPreview: "Progress preview",
    stagePlaceholderLoadArchive: "Load an archive to start playback.",
    progressLegendError: "Error",
    progressLegendNetwork: "Network",
    progressLegendScreenshot: "Screenshot",
    progressLegendAction: "Action",
    resizeScreenshotStage: "Resize screenshot stage",
    resizePanels: "Resize panels",
    filterTimelinePlaceholder: "Filter timeline",
    filterAllTimelineEvents: "All Timeline Events",
    filterErrors: "Errors",
    filterNetwork: "Network",
    filterStorage: "Storage",
    filterConsole: "Console",
    scopeFilterAll: "All Scopes",
    scopeFilterMain: "Main Page",
    scopeFilterIframe: "Iframes/Child Targets",
    exportBugReport: "Bug Report",
    exportHar: "HAR",
    exportPlaywright: "Playwright",
    exportPlaywrightMocks: "PW Mocks",
    exportGitHub: "GitHub",
    exportJira: "Jira",
    share: "Share",
    loadShared: "Load Shared",
    panelTabsLabel: "Log panels",
    eventHeading: "Event",
    eventDetailsHeading: "Event Details",
    actionTimelineHeading: "Action Timeline",
    networkHeading: "Network",
    compareHeading: "Compare",
    consoleHeading: "Console",
    realtimeHeading: "Realtime",
    storageHeading: "Storage",
    performanceHeading: "Performance",
    networkFiltersLabel: "Network filters",
    networkFilterPlaceholder: "Filter URL, host, id, method",
    networkAllMethods: "All Methods",
    networkAllStatus: "All Status",
    networkStatusFailed: "Failed",
    networkAllTypes: "All Types",
    networkColumnName: "Name",
    networkColumnMethod: "Method",
    networkColumnStatus: "Status",
    networkColumnType: "Type",
    networkColumnInitiator: "Initiator",
    networkColumnSize: "Size",
    networkColumnTime: "Time",
    networkColumnWaterfall: "Waterfall",
    copyCurl: "Copy cURL",
    copyFetch: "Copy fetch",
    replayRequest: "Replay request",
    consoleFilterPlaceholder: "Filter logs by type or content",
    shareArchiveTitle: "Share Archive",
    shareArchiveDescription:
      "Upload the loaded archive to a share server and copy the generated link.",
    shareServerUrl: "Share server URL",
    shareOptionalApiKey: "Optional API key",
    sharePlaceholderServerUrl: "https://share.example.com",
    sharePlaceholderApiKeyRequired: "Required when server auth is enabled",
    sharePrivacyPreflightTitle: "Privacy Preflight",
    sharePrivacyPreflightDescription:
      "Review redaction coverage and detected sensitive signals before uploading.",
    sharePrivacyRedactionProfile: "Redaction profile",
    sharePrivacyDetectedSignals: "Detected signals",
    sharePrivacySensitivePreview: "Sensitive preview",
    sharePrivacyReviewed: "I reviewed this privacy summary",
    sharePrivacyProfileSummary: "{headers} headers | {cookies} cookies | {patterns} patterns",
    sharePrivacyDetectedSummary: "{markers} markers | {hashes} hashes | {mentions} mentions",
    sharePrivacyPreviewSummary: "{matches} matches | {samples} samples",
    sharePrivacyPreviewEmpty: "No sensitive preview samples detected.",
    sharePrivacyPreviewSample: "{reason}: {snippet}",
    loadSharedArchiveTitle: "Load Shared Archive",
    loadSharedArchiveDescription: "Paste a share URL, archive API URL, or share ID.",
    shareReference: "Share reference",
    shareReferencePlaceholder: "https://host/share/abc123 or abc123",
    encryptedArchiveTitle: "Encrypted Archive",
    encryptedArchiveDescription:
      "This archive is encrypted. Enter the passphrase to continue loading.",
    passphrase: "Passphrase",
    passphrasePlaceholder: "Required for encrypted archives",
    playwrightPreviewTitle: "Playwright Preview",
    playwrightPreviewDescription: "Preview, tweak, and export generated replay script.",
    playwrightRangeStart: "Start (seconds)",
    playwrightRangeEnd: "End (seconds)",
    playwrightMaxActions: "Max actions",
    playwrightIncludeHarReplay: "Include HAR replay",
    regenerate: "Regenerate",
    download: "Download",
    dropArchiveToLoad: "Drop Archive to Load",
    dropArchiveSupport: "Supports .webblackbox and .zip",
    responseExpandJson: "Expand JSON",
    responseCollapseJson: "Collapse JSON",
    responseNoBodyCaptured: "(no response body captured)",
    responseUnavailable: "(response body unavailable)",
    responseCopyFailed: "Failed to copy response preview.",
    responseCopied: "Copied response preview.",
    responsePreviewEmptyBody: "(empty body)",
    responsePreviewBinary: "[binary {mime} {bytes}B]",
    noEventAtTime: "No event at this time",
    progressMarkerLabel: "{kind} marker",
    progressSummary:
      "{markerPrefix}{eventText} | {eventCount} ev/1s | {networkCount} net | {errorCount} err",
    jumpNoErrorEvents: "No error events in this archive.",
    jumpedFirstError: "Jumped to first error at {time}.",
    jumpNoNetworkRequests: "No network requests in this archive.",
    jumpedSlowestRequest: "Jumped to slowest request ({durationMs}ms).",
    summaryEmptyLoadArchive: "Load an archive to inspect playback.",
    compareDetailsEmpty: "Load a comparison archive to inspect event deltas.",
    summaryLabelTriage: "triage",
    summaryPillErrors: "errors {count}",
    summaryPillFailedRequests: "failed requests {count}",
    summaryPillSlowRequests: "slow requests {count} (>={thresholdMs}ms)",
    summaryCompareEventDelta: "compare event delta {delta}",
    summaryMode: "{mode} mode",
    summaryOrigin: "origin {origin}",
    summaryPlayhead: "playhead {time}",
    summaryVisibleEvents: "visible events {count}",
    summaryMainEvents: "main events {count}",
    summaryIframeEvents: "iframe events {count}",
    summaryVisibleErrors: "visible errors {count}",
    summaryVisibleRequests: "visible requests {count}",
    summaryMainRequests: "main requests {count}",
    summaryIframeRequests: "iframe requests {count}",
    summaryVisibleActions: "visible actions {count}",
    summaryVisibleScreenshots: "visible screenshots {count}",
    summaryAllActions: "all actions {count}",
    compareNoArchiveLoaded: "No comparison archive loaded.",
    compareNoEndpointDeltas: "No endpoint regression deltas.",
    compareHeadingTimelineAB: "Timeline (A/B)",
    compareHeadingWaterfallAlignment: "Waterfall Alignment",
    compareHeadingEndpointRegressions: "Endpoint Regressions",
    compareColumnEndpoint: "Endpoint",
    compareColumnCountDelta: "Count Δ",
    compareColumnFailRateDelta: "Fail-rate Δ",
    compareColumnP95Delta: "P95 Δ",
    compareColumnSessionA: "Session A",
    compareColumnSessionB: "Session B",
    compareColumnSignal: "Signal",
    compareEndpointSummary: "{count} req | {failRate}% fail | p95 {p95Ms}ms",
    timelineEmpty: "No timeline events at current filters.",
    actionsEmpty: "No action spans at current filters.",
    eventDetailsEmpty: "Select a timeline event or action card to inspect payload details.",
    eventDetailsOutOfRange: "Selected event is outside the current playhead range.",
    actionDetailsEmpty: "Select an action card to inspect trigger and root-cause context.",
    actionDetailsOutOfRange: "Selected action is outside the current playhead range.",
    actionMetricDuration: "duration {value}ms",
    actionMetricEvents: "events {count}",
    actionMetricRequests: "req {count}",
    actionMetricErrors: "err {count}",
    actionMetricShot: "shot {time}",
    actionMetricNoShot: "no-shot",
    actionSectionNetwork: "network",
    actionSectionErrors: "errors",
    actionSectionReplay: "replay",
    replayDiagnosticSummary: "{confidence} confidence | {requests} req | {errors} err | {chain}",
    replayConfidenceHigh: "high",
    replayConfidenceMedium: "medium",
    replayConfidenceLow: "low",
    replayCauseChainEmpty: "no cause chain",
    sortColumnFallback: "column",
    sortByColumn: "Sort by {column}",
    sortedByColumn: "Sorted by {column} ({direction})",
    requestDetailsEmpty: "Select a request row to inspect network details.",
    requestNoneSelected: "No request selected.",
    requestWindowEmpty: "No requests visible in current table window.",
    requestFilterEmpty: "No requests at current playhead or current filters.",
    networkScopeSummary: "{mainLabel} {mainCount} | {iframeLabel} {iframeCount}",
    networkSummaryEmpty: "0 / 0 requests",
    networkSummary:
      "{filteredCount} / {totalCount} requests | {filteredBytes} / {totalBytes} transferred",
    networkSummaryTruncated:
      " | showing {renderedCount}/{filteredCount} ({hiddenCount} hidden; narrow filters to inspect more)",
    scopeTagMain: "MAIN",
    scopeTagIframe: "IFRAME",
    scopeSummaryMain: "main",
    scopeSummaryIframe: "iframe",
    realtimeNoPayload: "(no payload)",
    noScreenshotEvents: "No screenshot events in this archive.",
    screenshotBeforePlayhead: "No screenshot available before this playhead.",
    screenshotLoading: "Loading screenshot...",
    screenshotDecodeFailed: "Failed to decode screenshot.",
    screenshotMissingBlob: "Missing screenshot blob: {shotId}",
    screenshotNoLoaded: "No screenshot loaded.",
    feedbackBugReportExported: "Bug report exported.",
    feedbackHarExported: "HAR exported.",
    feedbackGitHubIssueExported: "GitHub issue template exported.",
    feedbackJiraIssueExported: "Jira issue template exported.",
    feedbackQuickTriageDismissed: "Quick triage dismissed.",
    feedbackNoSupportedArchive: "No supported archive found in drop payload.",
    feedbackArchiveLoaded: "Loaded {sourceName}",
    feedbackArchiveLoadedWithoutPlayback:
      "Loaded {sourceName}, but it contains only recorder metadata. No playback events or screenshots were found.",
    feedbackArchiveLoadFailed: "Failed to load {sourceName}: {error}",
    feedbackCompareLoaded: "Loaded comparison archive: {fileName}",
    feedbackCompareLoadFailed: "Failed to load comparison archive {fileName}: {error}",
    feedbackBugReportCopied: "Bug report copied.",
    feedbackLoadArchiveBeforePlaywright: "Load an archive before generating Playwright.",
    feedbackPlaywrightPreviewCopied: "Playwright preview copied.",
    feedbackPlaywrightScriptExported: "Playwright script exported.",
    feedbackPlaywrightMocksExported: "Playwright mock script exported.",
    feedbackLoadArchiveBeforeSharing: "Load an archive before sharing.",
    feedbackInvalidShareServerUrl: "Invalid share server URL.",
    feedbackShareUploadProgress:
      "Uploading share archive... {percent}% ({loadedBytes} / {totalBytes})",
    feedbackShareMissingUrl: "Share server did not return a share URL.",
    feedbackShareSucceeded: "Shared archive. URL copied: {shareUrl}",
    feedbackShareFailed: "Share failed: {error}",
    feedbackInvalidShareReference: "Invalid share reference.",
    feedbackSharedArchiveLoaded: "Loaded shared archive {shareId}.",
    feedbackSharedArchiveLoadFailed: "Failed to load shared archive: {error}",
    feedbackSharedArchiveLoadingFromUrl: "Loading shared archive from URL...",
    feedbackCopyCurl: "Copied cURL for {reqId}",
    feedbackCopyFetch: "Copied fetch snippet for {reqId}",
    feedbackReplayStatusDelta: "{status} (captured {captured}, delta {delta})",
    feedbackReplaySucceeded: "Replayed {reqId}: {statusLabel}",
    feedbackReplayFailed: "Replay failed for {reqId}.",
    encryptedArchivePassphraseRequired: "Passphrase is required for encrypted archive.",
    encryptedArchivePrompt:
      "Archive '{fileName}' is encrypted. Enter passphrase to continue loading.",
    uploadNetworkError: "Network error while uploading archive.",
    uploadAborted: "Upload aborted.",
    uploadResponseNotJsonObject: "Share server response is not a JSON object.",
    uploadInvalidJson: "Share server returned invalid JSON.",
    screenshotTrailPoints: "Trail points: {count}",
    screenshotNoTrailPoints: "No trail points.",
    screenshotNoPointerMarker: "No pointer marker on this screenshot.",
    screenshotPointerMarker: "Pointer marker: ({x}, {y})",
    pointerReasonActionClick: "action:click",
    pointerReasonMove: "pointer:move",
    networkInitiatorDirect: "(direct)",
    networkInitiatorActionNumber: "action #{index}",
    networkStatusPending: "(pending)",
    networkStatusPendingPlain: "Pending",
    markerKinds: {
      error: "error",
      network: "network",
      screenshot: "screenshot",
      action: "action"
    },
    networkTypes: {
      document: "Document",
      fetch: "Fetch/XHR",
      script: "Script",
      stylesheet: "Stylesheet",
      image: "Image",
      font: "Font",
      text: "Text",
      other: "Other"
    },
    compareSignals: {
      regressed: "regressed",
      stable: "stable",
      new: "new",
      missing: "missing"
    },
    panels: {
      timeline: "Timeline",
      details: "Event",
      actions: "Actions",
      network: "Network",
      compare: "Compare",
      console: "Console",
      realtime: "Realtime",
      storage: "Storage",
      perf: "Performance"
    },
    sortDirections: {
      asc: "asc",
      desc: "desc"
    }
  },
  "zh-CN": {
    pageTitlePlayer: "WebBlackbox 播放器",
    toolbarTitlePlayer: "播放器",
    toolbarPlayerVersion: "播放器版本",
    toolbarLoadArchive: "加载归档",
    toolbarLoadCompare: "加载对比归档",
    toolbarGitHubRepo: "GitHub 仓库",
    toolbarLanguage: "语言",
    localeNames: {
      en: "English",
      "zh-CN": "中文"
    },
    statusWindow: "窗口",
    statusCounts: "{events} 个事件 | {errors} 个错误 | {requests} 个请求",
    statusPanelOnly: "{panel} 面板",
    statusPanelSelection: "{panel} 面板 | {selection}",
    quickTriage: "快速分诊",
    maskResponsePreview: "遮罩响应预览",
    dismiss: "关闭",
    cancel: "取消",
    load: "加载",
    copy: "复制",
    copied: "已复制",
    close: "关闭",
    preflightErrors: "错误",
    preflightFailedReqs: "失败请求",
    preflightSlowReqs: "慢请求",
    preflightScreenshots: "截图",
    preflightActions: "动作",
    preflightOpenFullPlayer: "打开完整播放器",
    preflightCopyBugReport: "复制缺陷报告",
    preflightJumpFirstError: "跳到首个错误",
    preflightJumpSlowestRequest: "跳到最慢请求",
    playbackBackStep: "-1 秒",
    playbackPlay: "播放",
    playbackPause: "暂停",
    playbackForwardStep: "+1 秒",
    playbackSpeed: "倍速",
    playbackTime: "播放时间",
    previewAltScreenshotPlayback: "截图回放",
    previewAltProgressPreview: "进度预览",
    stagePlaceholderLoadArchive: "加载归档以开始回放。",
    progressLegendError: "错误",
    progressLegendNetwork: "网络",
    progressLegendScreenshot: "截图",
    progressLegendAction: "动作",
    resizeScreenshotStage: "调整截图区域大小",
    resizePanels: "调整面板大小",
    filterTimelinePlaceholder: "筛选时间线",
    filterAllTimelineEvents: "全部时间线事件",
    filterErrors: "错误",
    filterNetwork: "网络",
    filterStorage: "存储",
    filterConsole: "控制台",
    scopeFilterAll: "全部范围",
    scopeFilterMain: "主页面",
    scopeFilterIframe: "子框架/子目标",
    exportBugReport: "缺陷报告",
    exportHar: "HAR",
    exportPlaywright: "Playwright",
    exportPlaywrightMocks: "PW Mock",
    exportGitHub: "GitHub",
    exportJira: "Jira",
    share: "分享",
    loadShared: "加载分享归档",
    panelTabsLabel: "日志面板",
    eventHeading: "事件",
    eventDetailsHeading: "事件详情",
    actionTimelineHeading: "动作时间线",
    networkHeading: "网络",
    compareHeading: "对比",
    consoleHeading: "控制台",
    realtimeHeading: "实时",
    storageHeading: "存储",
    performanceHeading: "性能",
    networkFiltersLabel: "网络筛选",
    networkFilterPlaceholder: "筛选 URL、主机、ID、方法",
    networkAllMethods: "全部方法",
    networkAllStatus: "全部状态",
    networkStatusFailed: "失败",
    networkAllTypes: "全部类型",
    networkColumnName: "名称",
    networkColumnMethod: "方法",
    networkColumnStatus: "状态",
    networkColumnType: "类型",
    networkColumnInitiator: "触发源",
    networkColumnSize: "大小",
    networkColumnTime: "耗时",
    networkColumnWaterfall: "瀑布图",
    copyCurl: "复制 cURL",
    copyFetch: "复制 fetch",
    replayRequest: "重放请求",
    consoleFilterPlaceholder: "按类型或内容筛选日志",
    shareArchiveTitle: "分享归档",
    shareArchiveDescription: "将当前归档上传到分享服务并复制生成的链接。",
    shareServerUrl: "分享服务 URL",
    shareOptionalApiKey: "可选 API Key",
    sharePlaceholderServerUrl: "https://share.example.com",
    sharePlaceholderApiKeyRequired: "当服务启用鉴权时必填",
    sharePrivacyPreflightTitle: "隐私预检",
    sharePrivacyPreflightDescription: "上传前审核脱敏覆盖范围和检测到的敏感信号。",
    sharePrivacyRedactionProfile: "脱敏配置",
    sharePrivacyDetectedSignals: "检测信号",
    sharePrivacySensitivePreview: "敏感预览",
    sharePrivacyReviewed: "我已审核该隐私摘要",
    sharePrivacyProfileSummary: "{headers} 个请求头 | {cookies} 个 Cookie | {patterns} 个模式",
    sharePrivacyDetectedSummary: "{markers} 个标记 | {hashes} 个哈希 | {mentions} 次提及",
    sharePrivacyPreviewSummary: "{matches} 处匹配 | {samples} 个样本",
    sharePrivacyPreviewEmpty: "未检测到敏感预览样本。",
    sharePrivacyPreviewSample: "{reason}: {snippet}",
    loadSharedArchiveTitle: "加载分享归档",
    loadSharedArchiveDescription: "粘贴分享链接、archive API URL 或 share ID。",
    shareReference: "分享引用",
    shareReferencePlaceholder: "https://host/share/abc123 或 abc123",
    encryptedArchiveTitle: "加密归档",
    encryptedArchiveDescription: "该归档已加密。请输入口令后继续加载。",
    passphrase: "口令",
    passphrasePlaceholder: "加密归档必填",
    playwrightPreviewTitle: "Playwright 预览",
    playwrightPreviewDescription: "预览、调整并导出生成的回放脚本。",
    playwrightRangeStart: "开始（秒）",
    playwrightRangeEnd: "结束（秒）",
    playwrightMaxActions: "最大动作数",
    playwrightIncludeHarReplay: "包含 HAR 回放",
    regenerate: "重新生成",
    download: "下载",
    dropArchiveToLoad: "拖放归档以加载",
    dropArchiveSupport: "支持 .webblackbox 和 .zip",
    responseExpandJson: "展开 JSON",
    responseCollapseJson: "收起 JSON",
    responseNoBodyCaptured: "（未捕获响应体）",
    responseUnavailable: "（响应体不可用）",
    responseCopyFailed: "复制响应预览失败。",
    responseCopied: "已复制响应预览。",
    responsePreviewEmptyBody: "（空响应体）",
    responsePreviewBinary: "[二进制 {mime} {bytes}B]",
    noEventAtTime: "该时间点没有事件",
    progressMarkerLabel: "{kind}标记",
    progressSummary:
      "{markerPrefix}{eventText} | 1 秒内 {eventCount} 个事件 | {networkCount} 个网络 | {errorCount} 个错误",
    jumpNoErrorEvents: "该归档中没有错误事件。",
    jumpedFirstError: "已跳到首个错误，时间 {time}。",
    jumpNoNetworkRequests: "该归档中没有网络请求。",
    jumpedSlowestRequest: "已跳到最慢请求（{durationMs}ms）。",
    summaryEmptyLoadArchive: "加载归档以查看回放。",
    compareDetailsEmpty: "加载对比归档以查看事件差异。",
    summaryLabelTriage: "分诊",
    summaryPillErrors: "错误 {count}",
    summaryPillFailedRequests: "失败请求 {count}",
    summaryPillSlowRequests: "慢请求 {count}（>={thresholdMs}ms）",
    summaryCompareEventDelta: "对比事件差值 {delta}",
    summaryMode: "{mode} 模式",
    summaryOrigin: "来源 {origin}",
    summaryPlayhead: "播放头 {time}",
    summaryVisibleEvents: "可见事件 {count}",
    summaryMainEvents: "主页面事件 {count}",
    summaryIframeEvents: "子框架事件 {count}",
    summaryVisibleErrors: "可见错误 {count}",
    summaryVisibleRequests: "可见请求 {count}",
    summaryMainRequests: "主页面请求 {count}",
    summaryIframeRequests: "子框架请求 {count}",
    summaryVisibleActions: "可见动作 {count}",
    summaryVisibleScreenshots: "可见截图 {count}",
    summaryAllActions: "全部动作 {count}",
    compareNoArchiveLoaded: "尚未加载对比归档。",
    compareNoEndpointDeltas: "没有端点回归差异。",
    compareHeadingTimelineAB: "时间线（A/B）",
    compareHeadingWaterfallAlignment: "瀑布图对齐",
    compareHeadingEndpointRegressions: "端点回归",
    compareColumnEndpoint: "端点",
    compareColumnCountDelta: "次数差值",
    compareColumnFailRateDelta: "失败率差值",
    compareColumnP95Delta: "P95 差值",
    compareColumnSessionA: "会话 A",
    compareColumnSessionB: "会话 B",
    compareColumnSignal: "信号",
    compareEndpointSummary: "{count} 个请求 | 失败率 {failRate}% | p95 {p95Ms}ms",
    timelineEmpty: "当前筛选条件下没有时间线事件。",
    actionsEmpty: "当前筛选条件下没有动作跨度。",
    eventDetailsEmpty: "选择一个时间线事件或动作卡片以查看载荷详情。",
    eventDetailsOutOfRange: "所选事件不在当前播放头范围内。",
    actionDetailsEmpty: "选择一个动作卡片以查看触发与根因上下文。",
    actionDetailsOutOfRange: "所选动作不在当前播放头范围内。",
    actionMetricDuration: "时长 {value}ms",
    actionMetricEvents: "事件 {count}",
    actionMetricRequests: "请求 {count}",
    actionMetricErrors: "错误 {count}",
    actionMetricShot: "截图 {time}",
    actionMetricNoShot: "无截图",
    actionSectionNetwork: "网络",
    actionSectionErrors: "错误",
    actionSectionReplay: "回放",
    replayDiagnosticSummary: "{confidence} 可信度 | {requests} 个请求 | {errors} 个错误 | {chain}",
    replayConfidenceHigh: "高",
    replayConfidenceMedium: "中",
    replayConfidenceLow: "低",
    replayCauseChainEmpty: "无因果链",
    sortColumnFallback: "列",
    sortByColumn: "按 {column} 排序",
    sortedByColumn: "按 {column} 排序（{direction}）",
    requestDetailsEmpty: "选择一行请求以查看网络详情。",
    requestNoneSelected: "未选择请求。",
    requestWindowEmpty: "当前表格窗口内没有可见请求。",
    requestFilterEmpty: "当前播放头或筛选条件下没有请求。",
    networkScopeSummary: "{mainLabel} {mainCount} | {iframeLabel} {iframeCount}",
    networkSummaryEmpty: "0 / 0 个请求",
    networkSummary: "{filteredCount} / {totalCount} 个请求 | 已传输 {filteredBytes} / {totalBytes}",
    networkSummaryTruncated:
      " | 当前显示 {renderedCount}/{filteredCount}（隐藏 {hiddenCount} 个；可缩小筛选范围查看更多）",
    scopeTagMain: "主页面",
    scopeTagIframe: "子框架",
    scopeSummaryMain: "主页面",
    scopeSummaryIframe: "子框架",
    realtimeNoPayload: "（无载荷）",
    noScreenshotEvents: "该归档中没有截图事件。",
    screenshotBeforePlayhead: "当前播放头之前没有可用截图。",
    screenshotLoading: "截图加载中...",
    screenshotDecodeFailed: "截图解码失败。",
    screenshotMissingBlob: "缺少截图 Blob：{shotId}",
    screenshotNoLoaded: "未加载截图。",
    feedbackBugReportExported: "已导出缺陷报告。",
    feedbackHarExported: "已导出 HAR。",
    feedbackGitHubIssueExported: "已导出 GitHub issue 模板。",
    feedbackJiraIssueExported: "已导出 Jira issue 模板。",
    feedbackQuickTriageDismissed: "已关闭快速分诊。",
    feedbackNoSupportedArchive: "拖放内容中没有找到受支持的归档。",
    feedbackArchiveLoaded: "已加载 {sourceName}",
    feedbackArchiveLoadedWithoutPlayback:
      "已加载 {sourceName}，但归档内只有记录器元数据，没有可播放事件或截图。",
    feedbackArchiveLoadFailed: "加载 {sourceName} 失败：{error}",
    feedbackCompareLoaded: "已加载对比归档：{fileName}",
    feedbackCompareLoadFailed: "加载对比归档 {fileName} 失败：{error}",
    feedbackBugReportCopied: "已复制缺陷报告。",
    feedbackLoadArchiveBeforePlaywright: "请先加载归档，再生成 Playwright。",
    feedbackPlaywrightPreviewCopied: "已复制 Playwright 预览。",
    feedbackPlaywrightScriptExported: "已导出 Playwright 脚本。",
    feedbackPlaywrightMocksExported: "已导出 Playwright Mock 脚本。",
    feedbackLoadArchiveBeforeSharing: "请先加载归档，再执行分享。",
    feedbackInvalidShareServerUrl: "分享服务 URL 无效。",
    feedbackShareUploadProgress: "正在上传分享归档... {percent}%（{loadedBytes} / {totalBytes}）",
    feedbackShareMissingUrl: "分享服务未返回分享 URL。",
    feedbackShareSucceeded: "分享归档已完成，链接已复制：{shareUrl}",
    feedbackShareFailed: "分享失败：{error}",
    feedbackInvalidShareReference: "分享引用无效。",
    feedbackSharedArchiveLoaded: "已加载分享归档 {shareId}。",
    feedbackSharedArchiveLoadFailed: "加载分享归档失败：{error}",
    feedbackSharedArchiveLoadingFromUrl: "正在从 URL 加载分享归档...",
    feedbackCopyCurl: "已复制 {reqId} 的 cURL",
    feedbackCopyFetch: "已复制 {reqId} 的 fetch 片段",
    feedbackReplayStatusDelta: "{status}（录制值 {captured}，差值 {delta}）",
    feedbackReplaySucceeded: "已重放 {reqId}：{statusLabel}",
    feedbackReplayFailed: "{reqId} 重放失败。",
    encryptedArchivePassphraseRequired: "加密归档必须提供口令。",
    encryptedArchivePrompt: "归档“{fileName}”已加密。请输入口令后继续加载。",
    uploadNetworkError: "上传归档时发生网络错误。",
    uploadAborted: "上传已取消。",
    uploadResponseNotJsonObject: "分享服务返回的响应不是 JSON 对象。",
    uploadInvalidJson: "分享服务返回了无效 JSON。",
    screenshotTrailPoints: "轨迹点：{count}",
    screenshotNoTrailPoints: "没有轨迹点。",
    screenshotNoPointerMarker: "该截图上没有指针标记。",
    screenshotPointerMarker: "指针标记：({x}, {y})",
    pointerReasonActionClick: "动作:点击",
    pointerReasonMove: "指针:移动",
    networkInitiatorDirect: "（直接）",
    networkInitiatorActionNumber: "动作 #{index}",
    networkStatusPending: "（等待中）",
    networkStatusPendingPlain: "等待中",
    markerKinds: {
      error: "错误",
      network: "网络",
      screenshot: "截图",
      action: "动作"
    },
    networkTypes: {
      document: "文档",
      fetch: "Fetch/XHR",
      script: "脚本",
      stylesheet: "样式表",
      image: "图片",
      font: "字体",
      text: "文本",
      other: "其他"
    },
    compareSignals: {
      regressed: "回归",
      stable: "稳定",
      new: "新增",
      missing: "缺失"
    },
    panels: {
      timeline: "时间线",
      details: "事件",
      actions: "动作",
      network: "网络",
      compare: "对比",
      console: "控制台",
      realtime: "实时",
      storage: "存储",
      perf: "性能"
    },
    sortDirections: {
      asc: "升序",
      desc: "降序"
    }
  }
};

function interpolate(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

export function resolvePlayerLocale(raw: string | null | undefined): PlayerLocale {
  const normalized = raw?.trim().toLowerCase().replace(/_/g, "-");

  if (!normalized) {
    return "en";
  }

  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-")
  ) {
    return "zh-CN";
  }

  return "en";
}

export function detectPlayerLocale(): PlayerLocale {
  try {
    const parsed = new URL(window.location.href);
    const queryLocale = parsed.searchParams.get("lang") ?? parsed.searchParams.get("locale");

    if (queryLocale) {
      return resolvePlayerLocale(queryLocale);
    }
  } catch {
    // Ignore invalid URLs in test contexts.
  }

  const stored = readStoredText(PLAYER_LOCALE_STORAGE_KEY);

  if (stored) {
    return resolvePlayerLocale(stored);
  }

  const preferred =
    typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) : "en";
  return resolvePlayerLocale(preferred);
}

export function storePlayerLocale(locale: PlayerLocale): void {
  writeStoredText(PLAYER_LOCALE_STORAGE_KEY, locale);
}

export function createPlayerI18n(locale: PlayerLocale = "en") {
  const messages = PLAYER_MESSAGES[locale];

  const t = <K extends keyof PlayerMessages>(
    key: K,
    values?: Record<string, string | number>
  ): string => {
    const value = messages[key];
    return typeof value === "string" ? interpolate(value, values) : "";
  };

  const formatMode = (mode: string): string => {
    if (mode === "lite") {
      return locale === "zh-CN" ? "轻量" : "Lite";
    }

    if (mode === "full") {
      return locale === "zh-CN" ? "完整" : "Full";
    }

    return mode.toUpperCase();
  };

  const formatPanelLabel = (panel: PanelKey): string => messages.panels[panel];
  const formatScopeTag = (scope: "main" | "iframe"): string =>
    scope === "iframe" ? messages.scopeTagIframe : messages.scopeTagMain;
  const formatMarkerKind = (kind: MarkerKind): string => messages.markerKinds[kind];
  const formatNetworkType = (type: NetworkType): string => messages.networkTypes[type];
  const formatCompareSignal = (signal: CompareSignal): string => messages.compareSignals[signal];
  const formatSortDirection = (direction: SortDirection): string =>
    messages.sortDirections[direction];
  const formatSelection = (kind: SelectionKind, id: string): string => {
    if (kind === "action") {
      return locale === "zh-CN" ? `动作 ${id}` : `action ${id}`;
    }

    if (kind === "event") {
      return locale === "zh-CN" ? `事件 ${id}` : `event ${id}`;
    }

    return locale === "zh-CN" ? `请求 ${id}` : `request ${id}`;
  };

  const formatStatusCounts = (events: number, errors: number, requests: number): string =>
    t("statusCounts", { events, errors, requests });
  const formatStatusPanel = (panel: PanelKey, selection?: string): string =>
    selection
      ? t("statusPanelSelection", { panel: formatPanelLabel(panel), selection })
      : t("statusPanelOnly", { panel: formatPanelLabel(panel) });
  const formatScopeSummary = (mainCount: number, iframeCount: number): string =>
    t("networkScopeSummary", {
      mainLabel: messages.scopeSummaryMain,
      mainCount,
      iframeLabel: messages.scopeSummaryIframe,
      iframeCount
    });
  const formatNetworkSummary = (
    filteredCount: number,
    totalCount: number,
    filteredBytes: string,
    totalBytes: string,
    renderedCount?: number
  ): string => {
    if (filteredCount <= 0 && totalCount <= 0) {
      return messages.networkSummaryEmpty;
    }

    const base = t("networkSummary", {
      filteredCount,
      totalCount,
      filteredBytes,
      totalBytes
    });

    if (typeof renderedCount !== "number" || renderedCount >= filteredCount || filteredCount <= 0) {
      return base;
    }

    return `${base}${t("networkSummaryTruncated", {
      renderedCount,
      filteredCount,
      hiddenCount: Math.max(0, filteredCount - renderedCount)
    })}`;
  };
  const formatProgressSummary = (options: {
    markerKind?: MarkerKind;
    eventText: string;
    eventCount: number;
    networkCount: number;
    errorCount: number;
  }): string => {
    const markerPrefix = options.markerKind
      ? `${t("progressMarkerLabel", { kind: formatMarkerKind(options.markerKind) })} | `
      : "";

    return t("progressSummary", {
      markerPrefix,
      eventText: options.eventText,
      eventCount: options.eventCount,
      networkCount: options.networkCount,
      errorCount: options.errorCount
    });
  };
  const formatActionMetrics = (options: {
    durationMs: number;
    eventCount: number;
    requestCount: number;
    errorCount: number;
    screenshotMeta: string;
  }): string[] => [
    t("actionMetricDuration", { value: options.durationMs.toFixed(1) }),
    t("actionMetricEvents", { count: options.eventCount }),
    t("actionMetricRequests", { count: options.requestCount }),
    t("actionMetricErrors", { count: options.errorCount }),
    options.screenshotMeta
  ];
  const formatCompareEndpointSummary = (count: number, failRate: number, p95Ms: number): string =>
    t("compareEndpointSummary", {
      count,
      failRate: failRate.toFixed(0),
      p95Ms: p95Ms.toFixed(0)
    });
  const formatPassphrasePrompt = (fileName: string): string =>
    t("encryptedArchivePrompt", { fileName });
  const formatShareUploadProgress = (
    percent: string,
    loadedBytes: string,
    totalBytes: string
  ): string => t("feedbackShareUploadProgress", { percent, loadedBytes, totalBytes });
  const formatBinaryResponsePreview = (mime: string, bytes: number): string =>
    t("responsePreviewBinary", { mime, bytes });
  const formatNetworkInitiatorActionNumber = (index: string): string =>
    t("networkInitiatorActionNumber", { index });

  return {
    locale,
    messages,
    t,
    formatMode,
    formatPanelLabel,
    formatScopeTag,
    formatMarkerKind,
    formatNetworkType,
    formatCompareSignal,
    formatSortDirection,
    formatSelection,
    formatStatusCounts,
    formatStatusPanel,
    formatScopeSummary,
    formatNetworkSummary,
    formatProgressSummary,
    formatActionMetrics,
    formatCompareEndpointSummary,
    formatPassphrasePrompt,
    formatShareUploadProgress,
    formatBinaryResponsePreview,
    formatNetworkInitiatorActionNumber
  };
}

export function applyPlayerDocumentLocale(locale: PlayerLocale): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = locale;
  document.title = createPlayerI18n(locale).messages.pageTitlePlayer;
}
