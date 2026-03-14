import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import { INJECTED_CAPTURE_CONFIG_EVENT } from "webblackbox/injected-hooks";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import { PORT_NAMES, type ExtensionOutboundMessage } from "../shared/messages.js";

const chromeApi = getChromeApi();
let contentPort: PortLike | null = null;
let reconnectTimer = 0;
let reconnectAttempts = 0;

const captureAgent = new LiteCaptureAgent({
  emitBatch: emitBatch,
  onMarker: emitMarker,
  showIndicator: true
});

let recordingActive = false;
let readyPingTimer = 0;
let readyPingAttempts = 0;
let pendingEvents: RawRecorderEvent[] = [];

const READY_PING_MAX_ATTEMPTS = 50;
const READY_PING_INTERVAL_MS = 150;
const PORT_RECONNECT_INITIAL_MS = 250;
const PORT_RECONNECT_MAX_MS = 5_000;
const PENDING_EVENT_MAX = 1_200;
const PENDING_EVENT_FLUSH_CHUNK = 200;
const DEFAULT_TAB_ID = -1;
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";

connectContentPort();

chromeApi?.runtime?.onMessage.addListener((message) => {
  if (isMarkerCommand(message)) {
    captureAgent.emitMarker("Keyboard marker");
    return false;
  }

  handleSwMessage(message as ExtensionOutboundMessage);
  return false;
});

window.addEventListener("beforeunload", cleanup);
window.addEventListener("pagehide", cleanup, { once: true });

function cleanup(): void {
  stopReadyPing();
  stopPortReconnect();
  pendingEvents = [];
  captureAgent.dispose();
}

function connectContentPort(): void {
  if (!chromeApi?.runtime || contentPort) {
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
    handleSwMessage(message as ExtensionOutboundMessage);
  };

  const onDisconnect = () => {
    if (contentPort === port) {
      contentPort = null;
    }

    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    stopReadyPing();
    schedulePortReconnect();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  requestRecordingStatusHandshake(true);

  if (recordingActive) {
    flushPendingEvents();
  }
}

function schedulePortReconnect(): void {
  if (!chromeApi?.runtime || reconnectTimer > 0 || contentPort) {
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

function flushPendingEvents(): void {
  if (!contentPort || !recordingActive || pendingEvents.length === 0) {
    return;
  }

  while (pendingEvents.length > 0) {
    const batch = pendingEvents.splice(0, PENDING_EVENT_FLUSH_CHUNK);

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
      return;
    }
  }
}

function emitBatch(events: RawRecorderEvent[]): void {
  if (!contentPort || events.length === 0) {
    if (!contentPort) {
      queuePendingEvents(events);
      connectContentPort();
    }

    return;
  }

  try {
    contentPort.postMessage({
      kind: "content.events",
      events
    });
  } catch (error) {
    queuePendingEvents(events);
    debugPortSendFailure("content.events", error);
  }
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

function handleSwMessage(message: ExtensionOutboundMessage): void {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.kind === "sw.recording-status") {
    recordingActive = message.active;
    syncInjectedCaptureConfig(message);

    captureAgent.setRecordingStatus({
      active: message.active,
      sid: message.sid,
      tabId: DEFAULT_TAB_ID,
      mode: message.mode,
      sampling: message.sampling
    });

    if (message.active) {
      stopReadyPing();
      flushPendingEvents();
    } else {
      pendingEvents = [];
      requestRecordingStatusHandshake(false);
    }

    return;
  }

  if (message.kind === "sw.freeze") {
    captureAgent.setIndicatorState(message.sid, "freeze");
  }
}

function requestRecordingStatusHandshake(force = false): void {
  if (!contentPort) {
    connectContentPort();
    return;
  }

  if (recordingActive && !force) {
    stopReadyPing();
    return;
  }

  if (force) {
    readyPingAttempts = 0;
  }

  sendReadyPing();

  if (readyPingTimer > 0) {
    return;
  }

  readyPingTimer = window.setInterval(() => {
    if (recordingActive || readyPingAttempts >= READY_PING_MAX_ATTEMPTS) {
      stopReadyPing();
      return;
    }

    sendReadyPing();
  }, READY_PING_INTERVAL_MS);
}

function sendReadyPing(): void {
  if (!contentPort || recordingActive) {
    return;
  }

  readyPingAttempts += 1;

  try {
    contentPort.postMessage({
      kind: "content.ready"
    });
  } catch (error) {
    debugPortSendFailure("content.ready", error);
  }
}

function stopReadyPing(): void {
  readyPingAttempts = 0;

  if (readyPingTimer > 0) {
    clearInterval(readyPingTimer);
    readyPingTimer = 0;
  }
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
