import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { getChromeApi } from "../shared/chrome-api.js";
import { PORT_NAMES, type ExtensionOutboundMessage } from "../shared/messages.js";

const chromeApi = getChromeApi();
let contentPort = chromeApi?.runtime?.connect({ name: PORT_NAMES.content }) ?? null;

const captureAgent = new LiteCaptureAgent({
  emitBatch: emitBatch,
  onMarker: emitMarker,
  showIndicator: true
});

let recordingActive = false;
let readyPingTimer = 0;
let readyPingAttempts = 0;

const READY_PING_MAX_ATTEMPTS = 50;
const READY_PING_INTERVAL_MS = 150;
const DEFAULT_TAB_ID = -1;

if (contentPort) {
  contentPort.onMessage.addListener((message) => {
    handleSwMessage(message as ExtensionOutboundMessage);
  });

  contentPort.onDisconnect.addListener(() => {
    contentPort = null;
    stopReadyPing();
  });

  requestRecordingStatusHandshake(true);
}

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
  captureAgent.dispose();
}

function emitBatch(events: RawRecorderEvent[]): void {
  if (!contentPort || events.length === 0) {
    return;
  }

  try {
    contentPort.postMessage({
      kind: "content.events",
      events
    });
  } catch {
    void 0;
  }
}

function emitMarker(message: string): void {
  if (!contentPort) {
    return;
  }

  try {
    contentPort.postMessage({
      kind: "content.marker",
      message
    });
  } catch {
    void 0;
  }
}

function handleSwMessage(message: ExtensionOutboundMessage): void {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.kind === "sw.recording-status") {
    recordingActive = message.active;

    captureAgent.setRecordingStatus({
      active: message.active,
      sid: message.sid,
      tabId: DEFAULT_TAB_ID,
      mode: message.mode,
      sampling: message.sampling
    });

    if (message.active) {
      stopReadyPing();
    } else {
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
  } catch {
    void 0;
  }
}

function stopReadyPing(): void {
  readyPingAttempts = 0;

  if (readyPingTimer > 0) {
    clearInterval(readyPingTimer);
    readyPingTimer = 0;
  }
}

function isMarkerCommand(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  return (message as { kind?: unknown }).kind === "sw.marker-command";
}
