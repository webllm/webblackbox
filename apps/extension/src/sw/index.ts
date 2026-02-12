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
import { type RawRecorderEvent, WebBlackboxRecorder } from "@webblackbox/recorder";

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
  startedAt: number;
  recorder: WebBlackboxRecorder;
  pipeline: FlightRecorderPipeline;
  cdpRouter: CdpRouter | null;
  queue: Promise<void>;
  removeCdpListeners: Array<() => void>;
};

const chromeApi = getChromeApi();

const sessionsByTab = new Map<number, SessionRuntime>();
const sessionsBySid = new Map<string, SessionRuntime>();
const connectedPorts = new Set<PortLike>();

const OFFSCREEN_PATH = "offscreen.html";

console.info("[WebBlackbox] service worker booted");

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
  const metadata: SessionMetadata = {
    sid,
    tabId,
    startedAt,
    mode,
    url: `tab:${tabId}`,
    tags: []
  };

  const storage = new IndexedDbPipelineStorage("webblackbox-flight-recorder");
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
    startedAt,
    recorder: new WebBlackboxRecorder({
      ...DEFAULT_RECORDER_CONFIG,
      mode
    }),
    pipeline,
    cdpRouter: null,
    queue: Promise.resolve(),
    removeCdpListeners: []
  };

  runtime.recorder = new WebBlackboxRecorder(
    {
      ...DEFAULT_RECORDER_CONFIG,
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
      }
    }
  );

  sessionsByTab.set(tabId, runtime);
  sessionsBySid.set(sid, runtime);

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
  pushSessionList();
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

  sessionsByTab.delete(runtime.tabId);
  sessionsBySid.delete(runtime.sid);

  if (sessionsByTab.size === 0) {
    await setIdleBadge();
    await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
  } else {
    await setRecordingBadge();
  }

  await notifyTabStatus(tabId, false);
  pushSessionList();
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

    runtime.cdpRouter = router;
  } catch (error) {
    console.warn("[WebBlackbox] failed to attach debugger", error);
    runtime.cdpRouter = null;
  }
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
