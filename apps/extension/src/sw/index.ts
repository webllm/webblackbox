import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import { FlightRecorderPipeline, IndexedDbPipelineStorage } from "@webblackbox/pipeline";
import {
  createSessionId,
  DEFAULT_RECORDER_CONFIG,
  type CaptureMode,
  type SessionMetadata
} from "@webblackbox/protocol";
import {
  createDefaultRecorderPlugins,
  type RawRecorderEvent,
  WebBlackboxRecorder
} from "@webblackbox/recorder";

import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import {
  PORT_NAMES,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type SessionListItem
} from "../shared/messages.js";

type SessionRuntime = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
  recorder: WebBlackboxRecorder;
  pipeline: FlightRecorderPipeline;
  cdpRouter: CdpRouter | null;
  requestMeta: Map<string, { url?: string; mimeType?: string; status?: number }>;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  queue: Promise<void>;
  removeCdpListeners: Array<() => void>;
};

const chromeApi = getChromeApi();

const sessionsByTab = new Map<number, SessionRuntime>();
const sessionsBySid = new Map<string, SessionRuntime>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;

const OFFSCREEN_PATH = "offscreen.html";
const SCREENSHOT_INTERVAL_MS = 8_000;
const NETWORK_BODY_MAX_BYTES = 256 * 1024;
const OPTIONS_STORAGE_KEY = "webblackbox.options";
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";

console.info("[WebBlackbox] service worker booted");

void restoreRuntimeState();

chromeApi?.runtime?.onInstalled.addListener(() => {
  void setIdleBadge();
});

chromeApi?.runtime?.onConnect.addListener((port) => {
  if (
    !Object.values(PORT_NAMES).includes(port.name as (typeof PORT_NAMES)[keyof typeof PORT_NAMES])
  ) {
    return;
  }

  connectedPorts.add(port);

  if (port.name === PORT_NAMES.offscreen) {
    offscreenPort = port;
    notifyOffscreenPipelineStatus();
  }

  pushSessionList();

  const onMessage = (rawMessage: unknown) => {
    const message = parseInboundMessage(rawMessage);

    if (!message) {
      return;
    }

    void handleInboundMessage(message, port);
  };

  const onDisconnect = () => {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
    }

    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
});

chromeApi?.runtime?.onMessage.addListener((rawMessage, sender) => {
  const message = parseInboundMessage(rawMessage);

  if (!message) {
    return;
  }

  void handleInboundMessage(message, undefined, sender.tab?.id);
  return false;
});

chromeApi?.commands?.onCommand.addListener((command) => {
  if (command !== "mark-bug") {
    return;
  }

  void relayMarkerCommand();
});

async function handleInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  senderTabId?: number
): Promise<void> {
  if (message.kind === "ui.start") {
    await startSession(message.tabId, message.mode);
    return;
  }

  if (message.kind === "ui.stop") {
    await stopSession(message.tabId);
    return;
  }

  if (message.kind === "ui.export") {
    await exportSession(message.sid);
    return;
  }

  if (message.kind === "content.marker") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId === "number") {
      ingestRawEvent({
        source: "content",
        rawType: "marker",
        tabId,
        sid: sessionsByTab.get(tabId)?.sid ?? "",
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          message: message.message
        }
      });
    }

    return;
  }

  if (message.kind === "content.events") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return;
    }

    for (const rawEvent of message.events) {
      ingestRawEvent({
        ...rawEvent,
        tabId
      });
    }
  }
}

async function startSession(tabId: number, mode: CaptureMode): Promise<void> {
  const existing = sessionsByTab.get(tabId);

  if (existing) {
    await stopSession(tabId);
  }

  await ensureOffscreenDocument();

  const sid = createSessionId();
  const startedAt = Date.now();
  const recorderConfig = await loadRecorderConfig(mode);
  const metadata: SessionMetadata = {
    sid,
    tabId,
    startedAt,
    mode,
    url: `tab:${tabId}`,
    tags: []
  };

  const storage = new IndexedDbPipelineStorage("webblackbox-flight-recorder");
  const recorderPlugins = createDefaultRecorderPlugins();
  const pipeline = new FlightRecorderPipeline({
    session: metadata,
    storage,
    maxChunkBytes: 512 * 1024
  });

  await pipeline.start();

  const runtime: SessionRuntime = {
    sid,
    tabId,
    mode,
    config: recorderConfig,
    startedAt,
    recorder: new WebBlackboxRecorder(
      {
        ...recorderConfig,
        mode
      },
      {},
      undefined,
      recorderPlugins
    ),
    pipeline,
    cdpRouter: null,
    requestMeta: new Map(),
    screenshotInterval: null,
    queue: Promise.resolve(),
    removeCdpListeners: []
  };

  runtime.recorder = new WebBlackboxRecorder(
    {
      ...recorderConfig,
      mode
    },
    {
      onEvent: (event) => {
        enqueue(runtime, async () => {
          await runtime.pipeline.ingest(event);
        });
      },
      onFreeze: (reason) => {
        broadcast({ kind: "sw.freeze", sid: runtime.sid, reason });

        if (runtime.mode === "full") {
          enqueue(runtime, async () => {
            await captureFullModeArtifacts(runtime, `freeze:${reason}`);
          });
        }
      }
    },
    undefined,
    recorderPlugins
  );

  sessionsByTab.set(tabId, runtime);
  sessionsBySid.set(sid, runtime);

  ingestRawEvent({
    source: "system",
    rawType: "config",
    sid,
    tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: recorderConfig
  });

  await chromeApi?.scripting
    ?.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      files: ["injected.js"]
    })
    .catch(() => undefined);

  if (mode === "full") {
    await attachCdp(runtime);
  }

  await setRecordingBadge();
  await notifyTabStatus(tabId, true, sid, mode);
  broadcast({ kind: "sw.recording-status", active: true, sid, mode });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function stopSession(tabId: number): Promise<void> {
  const runtime = sessionsByTab.get(tabId);

  if (!runtime) {
    return;
  }

  await runtime.queue;
  await runtime.pipeline.flush();

  if (runtime.cdpRouter) {
    await runtime.cdpRouter.detach(runtime.tabId).catch(() => undefined);

    for (const dispose of runtime.removeCdpListeners) {
      dispose();
    }

    runtime.cdpRouter.dispose();
  }

  if (runtime.screenshotInterval !== null) {
    clearInterval(runtime.screenshotInterval);
    runtime.screenshotInterval = null;
  }

  sessionsByTab.delete(runtime.tabId);
  sessionsBySid.delete(runtime.sid);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
    await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
  } else {
    await setRecordingBadge();
  }

  await notifyTabStatus(tabId, false);
  broadcast({ kind: "sw.recording-status", active: false, sid: runtime.sid, mode: runtime.mode });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function exportSession(sid: string): Promise<void> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    return;
  }

  await runtime.queue;
  const exported = await runtime.pipeline.exportBundle();

  if (!chromeApi?.downloads?.download) {
    return;
  }

  const blobBytes = new Uint8Array(exported.bytes.byteLength);
  blobBytes.set(exported.bytes);
  const blob = new Blob([blobBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);

  try {
    await chromeApi.downloads.download({
      url,
      filename: `webblackbox/${exported.fileName}`,
      saveAs: true
    });
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 30_000);
  }
}

function ingestRawEvent(rawEvent: RawRecorderEvent): void {
  const runtime = sessionsByTab.get(rawEvent.tabId);

  if (!runtime) {
    return;
  }

  const nextRawEvent: RawRecorderEvent = {
    ...rawEvent,
    sid: runtime.sid
  };

  runtime.recorder.ingest(nextRawEvent);
}

async function attachCdp(runtime: SessionRuntime): Promise<void> {
  try {
    const router = createCdpRouter(createChromeDebuggerTransport());

    const unsubscribeEvent = router.onEvent((event) => {
      ingestRawEvent({
        source: "cdp",
        rawType: event.method,
        tabId: runtime.tabId,
        sid: runtime.sid,
        t: Date.now(),
        mono: monotonicTime(),
        cdpSessionId: event.sessionId,
        payload: event.params ?? {}
      });

      enqueue(runtime, async () => {
        await processFullModeEvent(runtime, event.method, event.params ?? {}, event.sessionId);
      });
    });

    const unsubscribeDetach = router.onDetach((event) => {
      if (event.tabId === runtime.tabId) {
        void stopSession(runtime.tabId);
      }
    });

    runtime.removeCdpListeners.push(unsubscribeEvent, unsubscribeDetach);

    await router.attach(runtime.tabId);
    await router.enableBaseline(runtime.tabId);
    await router.enableAutoAttach(runtime.tabId);
    await router.send({ tabId: runtime.tabId }, "DOMStorage.enable").catch(() => undefined);
    await router.send({ tabId: runtime.tabId }, "Performance.enable").catch(() => undefined);

    runtime.cdpRouter = router;

    await captureFullModeArtifacts(runtime, "session-start");

    runtime.screenshotInterval = globalThis.setInterval(() => {
      enqueue(runtime, async () => {
        await captureScreenshot(runtime, "interval");
      });
    }, SCREENSHOT_INTERVAL_MS);
  } catch (error) {
    console.warn("[WebBlackbox] failed to attach debugger", error);
    runtime.cdpRouter = null;
  }
}

async function processFullModeEvent(
  runtime: SessionRuntime,
  method: string,
  params: unknown,
  sessionId?: string
): Promise<void> {
  const payload = asRecord(params);

  if (method === "Network.responseReceived") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    const response = asRecord(payload?.response);

    if (requestId) {
      runtime.requestMeta.set(requestId, {
        url: typeof response?.url === "string" ? response.url : undefined,
        mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
        status: typeof response?.status === "number" ? response.status : undefined
      });
    }

    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

    if (requestId) {
      await captureResponseBody(runtime, requestId, sessionId);
    }

    return;
  }

  if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
    await captureFullModeArtifacts(runtime, method);
    return;
  }

  if (method === "Page.frameNavigated") {
    await captureDomSnapshot(runtime, "navigation");
  }
}

async function captureResponseBody(
  runtime: SessionRuntime,
  requestId: string,
  sessionId?: string
): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
  const response = await runtime.cdpRouter
    .send<{
      body?: string;
      base64Encoded?: boolean;
    }>(target, "Network.getResponseBody", { requestId })
    .catch(() => undefined);

  if (!response?.body) {
    return;
  }

  const fullBytes = response.base64Encoded
    ? decodeBase64(response.body)
    : new TextEncoder().encode(response.body);
  const truncated = fullBytes.byteLength > NETWORK_BODY_MAX_BYTES;
  const sampledBytes = truncated ? fullBytes.slice(0, NETWORK_BODY_MAX_BYTES) : fullBytes;
  const metadata = runtime.requestMeta.get(requestId);
  const hash = await runtime.pipeline.putBlob(
    metadata?.mimeType ?? "application/octet-stream",
    sampledBytes
  );

  ingestRawEvent({
    source: "system",
    rawType: "cdp.network.body",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      reqId: requestId,
      contentHash: hash,
      mimeType: metadata?.mimeType,
      size: fullBytes.byteLength,
      sampledSize: sampledBytes.byteLength,
      redacted: true,
      truncated
    }
  });
}

async function captureFullModeArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureScreenshot(runtime, reason),
    captureDomSnapshot(runtime, reason),
    captureStorageSnapshots(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ]);
}

async function captureScreenshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const screenshot = await runtime.cdpRouter
    .send<{ data?: string }>({ tabId: runtime.tabId }, "Page.captureScreenshot", {
      format: "webp",
      quality: 70,
      fromSurface: true
    })
    .catch(() => undefined);

  if (!screenshot?.data) {
    return;
  }

  const bytes = decodeBase64(screenshot.data);
  const hash = await runtime.pipeline.putBlob("image/webp", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.screen.screenshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      shotId: hash,
      format: "webp",
      size: bytes.byteLength,
      reason
    }
  });
}

async function captureDomSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const snapshot = await runtime.cdpRouter
    .send<Record<string, unknown>>({ tabId: runtime.tabId }, "DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility", "opacity", "width", "height"]
    })
    .catch(() => undefined);

  if (!snapshot) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);
  const documents = Array.isArray(snapshot.documents) ? snapshot.documents : [];
  const firstDocument = documents[0] as Record<string, unknown> | undefined;
  const nodes = firstDocument ? asRecord(firstDocument.nodes) : null;
  const nodeNameArray = Array.isArray(nodes?.nodeName) ? nodes.nodeName : [];

  ingestRawEvent({
    source: "system",
    rawType: "cdp.dom.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      snapshotId: `D-${Date.now()}`,
      contentHash: hash,
      source: "cdp",
      nodeCount: nodeNameArray.length,
      reason
    }
  });
}

async function captureStorageSnapshots(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const cookies = await runtime.cdpRouter
    .send<{ cookies?: unknown[] }>({ tabId: runtime.tabId }, "Storage.getCookies")
    .catch(() => undefined);

  if (cookies?.cookies) {
    const bytes = new TextEncoder().encode(JSON.stringify(cookies.cookies));
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.cookie.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: cookies.cookies.length,
        redacted: true,
        reason
      }
    });
  }

  const localStorageData = await evaluateExpression(
    runtime,
    "JSON.stringify(Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])))"
  );

  if (typeof localStorageData === "string") {
    const bytes = new TextEncoder().encode(localStorageData);
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.local.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: Object.keys(JSON.parse(localStorageData) as Record<string, unknown>).length,
        reason
      }
    });
  }

  const origin = await evaluateExpression(runtime, "location.origin");

  if (typeof origin === "string") {
    const dbNames = await runtime.cdpRouter
      .send<{ databaseNames?: string[] }>(
        { tabId: runtime.tabId },
        "IndexedDB.requestDatabaseNames",
        {
          securityOrigin: origin
        }
      )
      .catch(() => undefined);

    if (dbNames?.databaseNames) {
      const bytes = new TextEncoder().encode(JSON.stringify(dbNames.databaseNames));
      const hash = await runtime.pipeline.putBlob("application/json", bytes);

      ingestRawEvent({
        source: "system",
        rawType: "cdp.storage.idb.snapshot",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          origin,
          schemaHash: hash,
          mode: "schema-only",
          reason
        }
      });
    }
  }
}

async function captureTraceMetrics(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const metrics = await runtime.cdpRouter
    .send<Record<string, unknown>>({ tabId: runtime.tabId }, "Performance.getMetrics")
    .catch(() => undefined);

  if (!metrics) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(metrics));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.trace",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      traceHash: hash,
      durationMs: 0,
      mode: "reportEvents",
      categories: "metrics",
      reason
    }
  });
}

async function evaluateExpression(runtime: SessionRuntime, expression: string): Promise<unknown> {
  if (!runtime.cdpRouter) {
    return undefined;
  }

  const result = await runtime.cdpRouter
    .send<{
      result?: {
        value?: unknown;
      };
    }>({ tabId: runtime.tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    .catch(() => undefined);

  return result?.result?.value;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    return new TextEncoder().encode(value);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chromeApi?.offscreen?.createDocument || !chromeApi.runtime?.getURL) {
    return;
  }

  const offscreenUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
  const contexts = chromeApi.runtime.getContexts
    ? await chromeApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      })
    : [];

  if (contexts.length > 0) {
    return;
  }

  await chromeApi.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "WebBlackbox uses offscreen document for persistent local recording pipeline."
  });
}

function enqueue(runtime: SessionRuntime, task: () => Promise<void>): void {
  runtime.queue = runtime.queue.then(task).catch((error) => {
    console.warn("[WebBlackbox] session queue error", error);
  });
}

function pushSessionList(): void {
  const sessions: SessionListItem[] = [...sessionsByTab.values()].map((runtime) => ({
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt
  }));

  broadcast({
    kind: "sw.session-list",
    sessions
  });
}

function broadcast(message: ExtensionOutboundMessage): void {
  for (const port of connectedPorts) {
    port.postMessage(message);
  }
}

async function loadRecorderConfig(mode: CaptureMode): Promise<typeof DEFAULT_RECORDER_CONFIG> {
  const baseConfig: typeof DEFAULT_RECORDER_CONFIG = {
    ...DEFAULT_RECORDER_CONFIG,
    mode
  };

  const storedValues = await chromeApi?.storage?.local?.get(OPTIONS_STORAGE_KEY);
  const stored = asRecord(storedValues?.[OPTIONS_STORAGE_KEY]);

  if (!stored) {
    return baseConfig;
  }

  const sampling = asRecord(stored.sampling);
  const redaction = asRecord(stored.redaction);

  return {
    ...baseConfig,
    ...stored,
    mode,
    sampling: {
      ...baseConfig.sampling,
      ...sampling
    },
    redaction: {
      ...baseConfig.redaction,
      ...redaction
    },
    sitePolicies: Array.isArray(stored.sitePolicies)
      ? (stored.sitePolicies as typeof baseConfig.sitePolicies)
      : baseConfig.sitePolicies
  };
}

async function persistRuntimeState(): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    return;
  }

  const sessions = [...sessionsByTab.values()].map((runtime) => ({
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt
  }));

  await chromeApi.storage.local.set({
    [ACTIVE_SESSION_STORAGE_KEY]: sessions
  });
}

async function restoreRuntimeState(): Promise<void> {
  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
  const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];

  if (Array.isArray(persisted) && persisted.length > 0) {
    await chromeApi.storage.local
      .set({
        [ACTIVE_SESSION_STORAGE_KEY]: []
      })
      .catch(() => undefined);

    for (const item of persisted) {
      const row = asRecord(item);
      const tabId = typeof row?.tabId === "number" ? row.tabId : undefined;

      if (typeof tabId === "number") {
        await notifyTabStatus(tabId, false);
      }
    }
  }

  await setIdleBadge();
  pushSessionList();
  notifyOffscreenPipelineStatus();
}

function notifyOffscreenPipelineStatus(): void {
  if (!offscreenPort) {
    return;
  }

  offscreenPort.postMessage({
    kind: "sw.pipeline-status",
    activeSessions: sessionsByTab.size,
    sessions: [...sessionsByTab.values()].map((runtime) => ({
      sid: runtime.sid,
      tabId: runtime.tabId,
      mode: runtime.mode,
      startedAt: runtime.startedAt
    })),
    updatedAt: Date.now()
  });
}

async function notifyTabStatus(
  tabId: number,
  active: boolean,
  sid?: string,
  mode?: CaptureMode
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  await chromeApi.tabs
    .sendMessage(tabId, {
      kind: "sw.recording-status",
      active,
      sid,
      mode
    })
    .catch(() => undefined);
}

async function relayMarkerCommand(): Promise<void> {
  const activeTabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  const tabId = activeTabs[0]?.id;

  if (typeof tabId !== "number") {
    return;
  }

  await chromeApi?.tabs?.sendMessage(tabId, { kind: "sw.marker-command" }).catch(() => undefined);
}

function parseInboundMessage(message: unknown): ExtensionInboundMessage | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const kind = (message as { kind?: unknown }).kind;

  if (typeof kind !== "string") {
    return null;
  }

  return message as ExtensionInboundMessage;
}

async function setIdleBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "WB" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#1864ab" }).catch(() => undefined);
}

async function setRecordingBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "REC" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#c92a2a" }).catch(() => undefined);
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
