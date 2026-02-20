import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import {
  createSessionId,
  DEFAULT_RECORDER_CONFIG,
  type CaptureMode,
  type HashesManifest,
  type SessionMetadata,
  type WebBlackboxEvent
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
  stoppedAt?: number;
  recorder: WebBlackboxRecorder;
  pipeline: SessionPipelineClient;
  cdpRouter: CdpRouter | null;
  requestMeta: Map<string, { url?: string; mimeType?: string; status?: number }>;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  queue: Promise<void>;
  removeCdpListeners: Array<() => void>;
  heapSnapshotCapture: HeapSnapshotCaptureState | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

type HeapSnapshotCaptureState = {
  chunks: string[];
  bytes: number;
  truncated: boolean;
};

type PipelineExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
};

type SessionPipelineClient = {
  start: (session: SessionMetadata) => Promise<void>;
  ingest: (event: WebBlackboxEvent) => Promise<void>;
  flush: () => Promise<void>;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  exportBundle: (options?: { passphrase?: string }) => Promise<PipelineExportResult>;
  close: () => Promise<void>;
};

type OffscreenPipelineRequest = {
  kind: "sw.pipeline-request";
  requestId: string;
  op: "start" | "ingest" | "flush" | "putBlob" | "export" | "close";
  sid: string;
  session?: SessionMetadata;
  event?: WebBlackboxEvent;
  mime?: string;
  bytes?: Uint8Array;
  passphrase?: string;
};

type OffscreenPipelineResponse = {
  kind: "offscreen.pipeline-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const chromeApi = getChromeApi();

const sessionsByTab = new Map<number, SessionRuntime>();
const sessionsBySid = new Map<string, SessionRuntime>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingOffscreenRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
let offscreenRequestSeq = 0;

const OFFSCREEN_PATH = "offscreen.html";
const SCREENSHOT_INTERVAL_MS = 8_000;
const NETWORK_BODY_MAX_BYTES = 256 * 1024;
const CPU_PROFILE_SAMPLE_MS = 350;
const HEAP_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const OPTIONS_STORAGE_KEY = "webblackbox.options";
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";
const STOPPED_SESSION_TTL_MS = 10 * 60_000;

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
    if (handleOffscreenRuntimeMessage(rawMessage, port)) {
      return;
    }

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
      rejectPendingOffscreenRequests("Offscreen pipeline disconnected.");
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
    await exportSession(message.sid, message.passphrase, message.saveAs);
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

  const recorderPlugins = createDefaultRecorderPlugins();
  const pipeline = createOffscreenPipelineClient(sid);
  await pipeline.start(metadata);

  const runtime: SessionRuntime = {
    sid,
    tabId,
    mode,
    config: recorderConfig,
    startedAt,
    stoppedAt: undefined,
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
    removeCdpListeners: [],
    heapSnapshotCapture: null,
    cleanupTimer: null
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
  await runtime.pipeline.flush().catch(() => undefined);
  await teardownCaptureInstrumentation(runtime);
  sessionsByTab.delete(runtime.tabId);
  runtime.stoppedAt = Date.now();
  scheduleStoppedRuntimeCleanup(runtime);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await notifyTabStatus(tabId, false);
  broadcast({ kind: "sw.recording-status", active: false, sid: runtime.sid, mode: runtime.mode });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function exportSession(sid: string, passphrase?: string, saveAs = true): Promise<void> {
  const runtime = sessionsBySid.get(sid);

  if (!runtime) {
    console.warn("[WebBlackbox] export ignored; unknown session", sid);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: "Session not found for export."
    });
    return;
  }

  try {
    const exported = await enqueueWithResult(runtime, async () => {
      return runtime.pipeline.exportBundle({ passphrase });
    });

    await downloadExportedBundle(exported, saveAs);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: true,
      fileName: exported.fileName
    });

    if (runtime.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  } catch (error) {
    console.warn("[WebBlackbox] export failed", error);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
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

function createOffscreenPipelineClient(sid: string): SessionPipelineClient {
  return {
    start: async (session) => {
      await requestOffscreenPipeline<void>({
        op: "start",
        sid,
        session
      });
    },
    ingest: async (event) => {
      await requestOffscreenPipeline<void>({
        op: "ingest",
        sid,
        event
      });
    },
    flush: async () => {
      await requestOffscreenPipeline<void>({
        op: "flush",
        sid
      });
    },
    putBlob: async (mime, bytes) => {
      return requestOffscreenPipeline<string>({
        op: "putBlob",
        sid,
        mime,
        bytes
      });
    },
    exportBundle: async (options = {}) => {
      const exported = await requestOffscreenPipeline<unknown>({
        op: "export",
        sid,
        passphrase: options.passphrase
      });

      return normalizePipelineExportResult(exported);
    },
    close: async () => {
      await requestOffscreenPipeline<void>({
        op: "close",
        sid
      });
    }
  };
}

async function requestOffscreenPipeline<TResult>(
  request: Omit<OffscreenPipelineRequest, "kind" | "requestId">
): Promise<TResult> {
  const port = await ensureOffscreenPortReady();
  const requestId = `off-${Date.now()}-${offscreenRequestSeq}`;
  offscreenRequestSeq += 1;

  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOffscreenRequests.delete(requestId);
      reject(new Error(`Timed out waiting for offscreen response: ${request.op}`));
    }, 30_000);

    pendingOffscreenRequests.set(requestId, {
      resolve,
      reject,
      timeout
    });

    port.postMessage({
      kind: "sw.pipeline-request",
      requestId,
      ...request
    });
  });

  return result as TResult;
}

async function ensureOffscreenPortReady(): Promise<PortLike> {
  if (offscreenPort) {
    return offscreenPort;
  }

  await ensureOffscreenDocument();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (offscreenPort) {
      return offscreenPort;
    }

    await wait(25);
  }

  throw new Error("Offscreen pipeline is unavailable.");
}

function handleOffscreenRuntimeMessage(rawMessage: unknown, port: PortLike): boolean {
  if (port.name !== PORT_NAMES.offscreen) {
    return false;
  }

  if (rawMessage === null || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    return false;
  }

  const kind = (rawMessage as { kind?: unknown }).kind;

  if (kind === "offscreen.ready") {
    notifyOffscreenPipelineStatus();
    return true;
  }

  if (kind !== "offscreen.pipeline-response") {
    return false;
  }

  const response = rawMessage as OffscreenPipelineResponse;
  const pending = pendingOffscreenRequests.get(response.requestId);

  if (!pending) {
    return true;
  }

  clearTimeout(pending.timeout);
  pendingOffscreenRequests.delete(response.requestId);

  if (response.ok) {
    pending.resolve(response.result);
  } else {
    pending.reject(new Error(response.error ?? "Offscreen pipeline request failed."));
  }

  return true;
}

function rejectPendingOffscreenRequests(message: string): void {
  for (const pending of pendingOffscreenRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }

  pendingOffscreenRequests.clear();
}

async function attachCdp(runtime: SessionRuntime): Promise<void> {
  try {
    const router = createCdpRouter(createChromeDebuggerTransport());

    const unsubscribeEvent = router.onEvent((event) => {
      const normalizedPayload = normalizeFullModePayload(event.method, event.params ?? {});

      if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
        const payload = asRecord(normalizedPayload);
        const chunk = typeof payload?.chunk === "string" ? payload.chunk : undefined;

        if (chunk && runtime.heapSnapshotCapture) {
          const chunkBytes = new TextEncoder().encode(chunk).byteLength;
          const nextBytes = runtime.heapSnapshotCapture.bytes + chunkBytes;

          if (nextBytes <= HEAP_SNAPSHOT_MAX_BYTES) {
            runtime.heapSnapshotCapture.chunks.push(chunk);
            runtime.heapSnapshotCapture.bytes = nextBytes;
          } else {
            runtime.heapSnapshotCapture.truncated = true;
          }
        }
      }

      ingestRawEvent({
        source: "cdp",
        rawType: event.method,
        tabId: runtime.tabId,
        sid: runtime.sid,
        t: Date.now(),
        mono: monotonicTime(),
        cdpSessionId: event.sessionId,
        payload: normalizedPayload
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
  const tasks: Array<Promise<void>> = [
    captureScreenshot(runtime, reason),
    captureDomSnapshot(runtime, reason),
    captureStorageSnapshots(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ];

  if (shouldCaptureAdvancedProfiles(reason)) {
    tasks.push(captureAdvancedProfiles(runtime, reason));
  }

  await Promise.allSettled(tasks);
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

async function captureAdvancedProfiles(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureCpuProfile(runtime, reason),
    captureHeapSnapshot(runtime, reason)
  ]);
}

async function captureCpuProfile(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  await runtime.cdpRouter.send({ tabId: runtime.tabId }, "Profiler.enable").catch(() => undefined);
  const started = await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "Profiler.start")
    .then(() => true)
    .catch(() => false);

  if (!started) {
    return;
  }

  await wait(CPU_PROFILE_SAMPLE_MS);

  const profileResult = await runtime.cdpRouter
    .send<{ profile?: unknown }>({ tabId: runtime.tabId }, "Profiler.stop")
    .catch(() => undefined);

  if (!profileResult?.profile) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(profileResult.profile));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.cpu.profile",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      profileHash: hash,
      sampleMs: CPU_PROFILE_SAMPLE_MS,
      size: bytes.byteLength,
      reason
    }
  });

  await runtime.cdpRouter.send({ tabId: runtime.tabId }, "Profiler.disable").catch(() => undefined);
}

async function captureHeapSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  runtime.heapSnapshotCapture = {
    chunks: [],
    bytes: 0,
    truncated: false
  };

  await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.enable")
    .catch(() => undefined);

  const completed = await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: true
    })
    .then(() => true)
    .catch(() => false);

  const snapshot = runtime.heapSnapshotCapture;
  runtime.heapSnapshotCapture = null;

  if (!completed || !snapshot || snapshot.chunks.length === 0) {
    await runtime.cdpRouter
      .send({ tabId: runtime.tabId }, "HeapProfiler.disable")
      .catch(() => undefined);
    return;
  }

  const joined = snapshot.chunks.join("");
  const bytes = new TextEncoder().encode(joined);
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.heap.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      snapshotHash: hash,
      size: bytes.byteLength,
      chunkCount: snapshot.chunks.length,
      truncated: snapshot.truncated,
      reason
    }
  });

  await runtime.cdpRouter
    .send({ tabId: runtime.tabId }, "HeapProfiler.disable")
    .catch(() => undefined);
}

function shouldCaptureAdvancedProfiles(reason: string): boolean {
  return (
    reason.startsWith("freeze:") ||
    reason === "Runtime.exceptionThrown" ||
    reason === "Network.loadingFailed" ||
    reason === "manual"
  );
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
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

function normalizeFullModePayload(method: string, params: unknown): unknown {
  const payload = asRecord(params);

  if (!payload) {
    return params;
  }

  if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
    const response = asRecord(payload.response);
    const rawData = typeof response?.payloadData === "string" ? response.payloadData : "";

    return {
      ...payload,
      direction: method.endsWith("Sent") ? "sent" : "received",
      frame: {
        opcode: typeof response?.opcode === "number" ? response.opcode : undefined,
        masked: response?.mask === true,
        payloadLength: rawData.length,
        payloadPreview: rawData.slice(0, 512)
      }
    };
  }

  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePipelineExportResult(raw: unknown): PipelineExportResult {
  const row = asRecord(raw);

  if (!row) {
    throw new Error("Invalid offscreen export payload.");
  }

  const fileName =
    typeof row.fileName === "string" && row.fileName.length > 0
      ? row.fileName
      : "session.webblackbox";

  const bytes = asUint8Array(row.bytes);

  if (!bytes || bytes.byteLength === 0) {
    throw new Error("Offscreen export payload did not include archive bytes.");
  }

  return {
    fileName,
    bytes,
    integrity: normalizeHashesManifest(row.integrity)
  };
}

function normalizeHashesManifest(value: unknown): HashesManifest {
  const row = asRecord(value);
  const filesRow = asRecord(row?.files);
  const files: Record<string, string> = {};

  if (filesRow) {
    for (const [name, digest] of Object.entries(filesRow)) {
      if (typeof digest === "string") {
        files[name] = digest;
      }
    }
  }

  return {
    manifestSha256: typeof row?.manifestSha256 === "string" ? row.manifestSha256 : "",
    files
  };
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value, (entry) =>
      typeof entry === "number" && Number.isFinite(entry) ? entry & 0xff : 0
    );
  }

  const row = asRecord(value);

  if (!row) {
    return null;
  }

  const numericKeys = Object.keys(row)
    .filter((key) => /^\d+$/.test(key))
    .map((key) => Number(key))
    .sort((left, right) => left - right);

  if (numericKeys.length === 0) {
    return null;
  }

  const bytes = new Uint8Array(numericKeys[numericKeys.length - 1] + 1);

  for (const index of numericKeys) {
    const rawByte = row[String(index)];

    if (typeof rawByte !== "number" || !Number.isFinite(rawByte)) {
      return null;
    }

    bytes[index] = rawByte & 0xff;
  }

  return bytes;
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

function enqueueWithResult<TResult>(
  runtime: SessionRuntime,
  task: () => Promise<TResult>
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    enqueue(runtime, async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function teardownCaptureInstrumentation(runtime: SessionRuntime): Promise<void> {
  if (runtime.cdpRouter) {
    await runtime.cdpRouter.detach(runtime.tabId).catch(() => undefined);

    for (const dispose of runtime.removeCdpListeners) {
      dispose();
    }

    runtime.removeCdpListeners = [];
    runtime.cdpRouter.dispose();
    runtime.cdpRouter = null;
  }

  if (runtime.screenshotInterval !== null) {
    clearInterval(runtime.screenshotInterval);
    runtime.screenshotInterval = null;
  }
}

function scheduleStoppedRuntimeCleanup(runtime: SessionRuntime): void {
  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
  }

  runtime.cleanupTimer = setTimeout(() => {
    void disposeStoppedSession(runtime);
  }, STOPPED_SESSION_TTL_MS);
}

async function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (!sessionsBySid.has(runtime.sid)) {
    return;
  }

  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = null;
  }

  await runtime.queue;
  await runtime.pipeline.flush().catch(() => undefined);
  await runtime.pipeline.close().catch(() => undefined);
  sessionsBySid.delete(runtime.sid);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
  } else {
    await setRecordingBadge();
  }

  await closeOffscreenIfUnused();
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function closeOffscreenIfUnused(): Promise<void> {
  if (sessionsBySid.size > 0) {
    return;
  }

  await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
}

function toSessionListItem(runtime: SessionRuntime): SessionListItem {
  const activeRuntime = sessionsByTab.get(runtime.tabId);
  const active = activeRuntime?.sid === runtime.sid;

  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    active,
    stoppedAt: runtime.stoppedAt
  };
}

async function downloadExportedBundle(
  exported: PipelineExportResult,
  saveAs: boolean
): Promise<void> {
  if (!chromeApi?.downloads?.download) {
    return;
  }

  const downloadUrl = toZipDataUrl(exported.bytes);

  await chromeApi.downloads.download({
    url: downloadUrl,
    filename: `webblackbox/${exported.fileName}`,
    saveAs
  });
}

function toZipDataUrl(bytes: Uint8Array): string {
  const base64 = bytesToBase64(bytes);
  return `data:application/zip;base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this runtime.");
  }

  let binary = "";
  const chunkSize = 32 * 1024;

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));

    for (const value of chunk) {
      binary += String.fromCharCode(value);
    }
  }

  return btoa(binary);
}

function pushSessionList(): void {
  const sessions: SessionListItem[] = [...sessionsBySid.values()]
    .map((runtime) => toSessionListItem(runtime))
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);

      if (activeDiff !== 0) {
        return activeDiff;
      }

      return right.startedAt - left.startedAt;
    });

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
      startedAt: runtime.startedAt,
      active: true
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
