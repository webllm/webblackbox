import type { RawRecorderEvent } from "@webblackbox/recorder";

import { getChromeApi } from "../shared/chrome-api.js";
import { PORT_NAMES, type ExtensionOutboundMessage } from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.content });

const eventBuffer: RawRecorderEvent[] = [];

let flushTimer = 0;
let recordingActive = false;
let indicator: HTMLDivElement | null = null;

if (port) {
  port.onMessage.addListener((message) => {
    handleSwMessage(message as ExtensionOutboundMessage);
  });
}

chromeApi?.runtime?.onMessage.addListener((message) => {
  handleSwMessage(message as ExtensionOutboundMessage);

  if (isMarkerCommand(message)) {
    emitMarker("Keyboard marker");
  }

  return false;
});

emitLifecycleEvent("visibilitychange", {
  state: document.visibilityState
});

window.addEventListener("visibilitychange", () => {
  emitLifecycleEvent("visibilitychange", {
    state: document.visibilityState
  });
});

window.addEventListener("beforeunload", () => {
  emitLifecycleEvent("beforeunload", {
    href: location.href
  });
  flushEvents();
});

window.addEventListener("message", (event) => {
  if (event.data && event.data.kind === "webblackbox.marker") {
    emitMarker(typeof event.data.message === "string" ? event.data.message : "Marker");
  }
});

function handleSwMessage(message: ExtensionOutboundMessage): void {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.kind === "sw.recording-status") {
    recordingActive = message.active;

    if (recordingActive) {
      ensureIndicator(message.sid, message.mode);
    } else {
      removeIndicator();
    }

    return;
  }

  if (message.kind === "sw.freeze") {
    ensureIndicator(message.sid, "freeze");
  }
}

function ensureIndicator(sid?: string, mode?: string): void {
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.setAttribute("data-webblackbox-indicator", "true");
    indicator.style.position = "fixed";
    indicator.style.right = "12px";
    indicator.style.bottom = "12px";
    indicator.style.zIndex = "2147483647";
    indicator.style.padding = "6px 10px";
    indicator.style.borderRadius = "8px";
    indicator.style.background = "rgba(173, 29, 42, 0.92)";
    indicator.style.color = "#fff";
    indicator.style.font = "600 12px/1.2 'IBM Plex Sans', sans-serif";
    indicator.style.boxShadow = "0 6px 20px rgba(0,0,0,0.22)";
    indicator.style.pointerEvents = "none";
    document.documentElement.appendChild(indicator);
  }

  const suffix = sid ? ` ${sid.slice(0, 8)}` : "";
  indicator.textContent = `WebBlackbox REC ${mode ?? "lite"}${suffix}`;
}

function removeIndicator(): void {
  if (!indicator) {
    return;
  }

  indicator.remove();
  indicator = null;
}

function emitLifecycleEvent(rawType: string, payload: Record<string, unknown>): void {
  queueEvent({
    source: "content",
    rawType,
    tabId: -1,
    sid: "",
    t: Date.now(),
    mono: monotonicTime(),
    payload
  });
}

function emitMarker(message: string): void {
  if (!port) {
    return;
  }

  port.postMessage({
    kind: "content.marker",
    message
  });
}

function queueEvent(event: RawRecorderEvent): void {
  if (!recordingActive || !port) {
    return;
  }

  eventBuffer.push(event);

  if (flushTimer > 0) {
    return;
  }

  flushTimer = window.setTimeout(() => {
    flushEvents();
  }, 250);
}

function flushEvents(): void {
  if (!port || eventBuffer.length === 0) {
    return;
  }

  const events = eventBuffer.splice(0, eventBuffer.length);
  port.postMessage({
    kind: "content.events",
    events
  });

  if (flushTimer > 0) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
}

function monotonicTime(): number {
  return performance.timeOrigin + performance.now();
}

function isMarkerCommand(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  return (message as { kind?: unknown }).kind === "sw.marker-command";
}
