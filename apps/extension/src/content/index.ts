import type { RawRecorderEvent } from "@webblackbox/recorder";
import type { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import { createExtensionI18n } from "../shared/i18n.js";
import { PORT_NAMES, type ExtensionOutboundMessage } from "../shared/messages.js";
import { CONTENT_EVENT_FLUSH_CHUNK, resolveContentEventFlushDelay } from "./flush-policy.js";

type ContentAgentModule = typeof import("./content-agent.js");

const chromeApi = getChromeApi();
const { t } = createExtensionI18n();
let contentPort: PortLike | null = null;
let reconnectTimer = 0;
let reconnectAttempts = 0;
let captureAgent: LiteCaptureAgent | null = null;
let captureAgentPromise: Promise<LiteCaptureAgent> | null = null;

let recordingActive = false;
let pendingEvents: RawRecorderEvent[] = [];
let pendingEventFlushTimer = 0;
let pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;

const PORT_RECONNECT_INITIAL_MS = 250;
const PORT_RECONNECT_MAX_MS = 5_000;
const PENDING_EVENT_MAX = 1_200;
const DEFAULT_TAB_ID = -1;
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const INJECTED_CAPTURE_CONFIG_EVENT = "webblackbox:injected-config";

void requestRecordingStatusOnce();

chromeApi?.runtime?.onMessage.addListener((message) => {
  if (isMarkerCommand(message)) {
    if (recordingActive) {
      void emitKeyboardMarker();
    }

    return false;
  }

  void handleSwMessage(message as ExtensionOutboundMessage);
  return false;
});

window.addEventListener("beforeunload", cleanup);
window.addEventListener("pagehide", cleanup, { once: true });

function cleanup(): void {
  recordingActive = false;
  stopPortReconnect();
  stopPendingEventFlush();
  pendingEvents = [];
  captureAgent?.dispose();
  captureAgent = null;
  captureAgentPromise = null;
  disconnectContentPort();
}

function connectContentPort(): void {
  if (!recordingActive || !chromeApi?.runtime || contentPort) {
    return;
  }

  try {
    const port = chromeApi.runtime.connect({ name: PORT_NAMES.content });
    bindContentPort(port);
  } catch (error) {
    debugPortSendFailure("runtime.connect", error);
    schedulePortReconnect();
  }
}

function bindContentPort(port: PortLike): void {
  stopPortReconnect();
  reconnectAttempts = 0;
  contentPort = port;

  const onMessage = (message: unknown) => {
    void handleSwMessage(message as ExtensionOutboundMessage);
  };

  const onDisconnect = () => {
    if (contentPort === port) {
      contentPort = null;
    }

    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    stopPendingEventFlush();
    schedulePortReconnect();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  if (recordingActive) {
    schedulePendingEventFlush();
  }
}

function disconnectContentPort(): void {
  const port = contentPort;

  if (!port) {
    return;
  }

  contentPort = null;

  try {
    port.disconnect?.();
  } catch (error) {
    debugPortSendFailure("runtime.disconnect", error);
  }
}

function schedulePortReconnect(): void {
  if (!recordingActive || !chromeApi?.runtime || reconnectTimer > 0 || contentPort) {
    return;
  }

  const delay = Math.min(PORT_RECONNECT_INITIAL_MS * 2 ** reconnectAttempts, PORT_RECONNECT_MAX_MS);
  reconnectAttempts += 1;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connectContentPort();
  }, delay);
}

function stopPortReconnect(): void {
  reconnectAttempts = 0;

  if (reconnectTimer > 0) {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
}

function queuePendingEvents(events: RawRecorderEvent[]): void {
  if (!recordingActive || events.length === 0) {
    return;
  }

  pendingEvents.push(...events);
  trimPendingEvents();
}

function trimPendingEvents(): void {
  if (pendingEvents.length <= PENDING_EVENT_MAX) {
    return;
  }

  pendingEvents.splice(0, pendingEvents.length - PENDING_EVENT_MAX);
}

function flushPendingEventsChunk(): boolean {
  if (!contentPort || !recordingActive || pendingEvents.length === 0) {
    return false;
  }

  const batch = pendingEvents.splice(0, CONTENT_EVENT_FLUSH_CHUNK);

  try {
    contentPort.postMessage({
      kind: "content.events",
      events: batch
    });
  } catch (error) {
    debugPortSendFailure("content.events.replay", error);
    pendingEvents = [...batch, ...pendingEvents];
    trimPendingEvents();
    contentPort = null;
    schedulePortReconnect();
    return false;
  }

  return true;
}

function flushPendingEvents(): void {
  if (!flushPendingEventsChunk()) {
    return;
  }

  if (pendingEvents.length > 0) {
    schedulePendingEventFlush(pendingEvents.length >= CONTENT_EVENT_FLUSH_CHUNK);
  }
}

async function flushAllPendingEvents(): Promise<void> {
  stopPendingEventFlush();

  while (contentPort && recordingActive && pendingEvents.length > 0) {
    if (!flushPendingEventsChunk()) {
      return;
    }
  }
}

function emitBatch(events: RawRecorderEvent[]): void {
  if (events.length === 0) {
    return;
  }

  queuePendingEvents(events);

  if (!contentPort) {
    connectContentPort();
    return;
  }

  schedulePendingEventFlush(pendingEvents.length >= CONTENT_EVENT_FLUSH_CHUNK);
}

function emitMarker(message: string): void {
  if (!contentPort) {
    connectContentPort();
    return;
  }

  try {
    contentPort.postMessage({
      kind: "content.marker",
      message
    });
  } catch (error) {
    debugPortSendFailure("content.marker", error);
  }
}

function emitStopDrained(sid?: string): void {
  if (!contentPort || window.top !== window || typeof sid !== "string" || sid.length === 0) {
    return;
  }

  try {
    contentPort.postMessage({
      kind: "content.stop-drained",
      sid
    });
  } catch (error) {
    debugPortSendFailure("content.stop-drained", error);
  }
}

async function handleSwMessage(message: ExtensionOutboundMessage): Promise<void> {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.kind === "sw.recording-status") {
    syncInjectedCaptureConfig(message);
    const nextState = {
      active: message.active,
      sid: message.sid,
      tabId: DEFAULT_TAB_ID,
      mode: message.mode,
      sampling: message.sampling
    };

    if (message.active) {
      recordingActive = true;
      connectContentPort();
      const agent = await ensureCaptureAgent();
      agent.setRecordingStatus(nextState);
      schedulePendingEventFlush();
    } else {
      const wasRecording = recordingActive;
      const agent = captureAgent;

      if (wasRecording && agent) {
        await agent.prepareStopCapture();
        agent.setRecordingStatus(nextState);
        await flushAllPendingEvents();
        emitStopDrained(nextState.sid);
      } else if (agent) {
        agent.setRecordingStatus(nextState);
      }

      recordingActive = false;
      stopPendingEventFlush();
      pendingEvents = [];
      disconnectContentPort();
    }

    return;
  }

  if (message.kind === "sw.freeze") {
    captureAgent?.setIndicatorState(message.sid, "freeze");
  }
}

async function ensureCaptureAgent(): Promise<LiteCaptureAgent> {
  if (captureAgent) {
    return captureAgent;
  }

  if (captureAgentPromise) {
    return captureAgentPromise;
  }

  const moduleUrl = chromeApi?.runtime?.getURL?.("content-agent.js") ?? "./content-agent.js";

  captureAgentPromise = import(moduleUrl)
    .then((module) => {
      const { createContentCaptureAgent } = module as ContentAgentModule;
      const options: LiteCaptureAgentOptions = {
        emitBatch,
        onMarker: emitMarker,
        showIndicator: true
      };
      const agent = createContentCaptureAgent(options);
      captureAgent = agent;
      return agent;
    })
    .finally(() => {
      captureAgentPromise = null;
    });

  return captureAgentPromise;
}

async function emitKeyboardMarker(): Promise<void> {
  const agent = await ensureCaptureAgent();
  agent.emitMarker(t("contentKeyboardMarker"));
}

async function requestRecordingStatusOnce(): Promise<void> {
  if (!chromeApi?.runtime?.sendMessage) {
    return;
  }

  try {
    const response = await chromeApi.runtime.sendMessage({
      kind: "content.ready"
    });

    if (isRecordingStatusMessage(response)) {
      await handleSwMessage(response);
    }
  } catch (error) {
    debugPortSendFailure("content.ready", error);
  }
}

function isRecordingStatusMessage(message: unknown): message is ExtensionOutboundMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  return (message as { kind?: unknown }).kind === "sw.recording-status";
}

function schedulePendingEventFlush(immediate = false): void {
  if (!contentPort || !recordingActive || pendingEvents.length === 0) {
    return;
  }

  const delayMs = resolveContentEventFlushDelay(pendingEvents.length, immediate);

  if (pendingEventFlushTimer > 0) {
    if (delayMs >= pendingEventFlushDelayMs) {
      return;
    }

    clearTimeout(pendingEventFlushTimer);
    pendingEventFlushTimer = 0;
  }

  pendingEventFlushDelayMs = delayMs;

  pendingEventFlushTimer = window.setTimeout(() => {
    pendingEventFlushTimer = 0;
    pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;
    flushPendingEvents();
  }, delayMs);
}

function stopPendingEventFlush(): void {
  if (pendingEventFlushTimer > 0) {
    clearTimeout(pendingEventFlushTimer);
    pendingEventFlushTimer = 0;
  }

  pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;
}

function debugPortSendFailure(kind: string, error: unknown): void {
  const flags = globalThis as unknown as Record<string, unknown>;
  const enabled = flags[PORT_DEBUG_LOG_FLAG] === true || flags.__WEBBLACKBOX_PERF__ === true;

  if (!enabled) {
    return;
  }

  console.debug("[WebBlackbox][port] content postMessage failed", {
    kind,
    error: error instanceof Error ? error.message : String(error)
  });
}

function isMarkerCommand(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  return (message as { kind?: unknown }).kind === "sw.marker-command";
}

function syncInjectedCaptureConfig(
  message: Extract<ExtensionOutboundMessage, { kind: "sw.recording-status" }>
): void {
  const bodyCaptureMaxBytes =
    message.active && message.mode === "lite"
      ? normalizeBodyCaptureBudget(message.sampling?.bodyCaptureMaxBytes)
      : 0;

  window.dispatchEvent(
    new CustomEvent(INJECTED_CAPTURE_CONFIG_EVENT, {
      detail: {
        bodyCaptureMaxBytes
      }
    })
  );
}

function normalizeBodyCaptureBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(4 * 1024, Math.min(8 * 1024 * 1024, Math.round(value)));
}
