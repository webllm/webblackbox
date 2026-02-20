import type { WebBlackboxEventType } from "@webblackbox/protocol";

import type { EventNormalizer, RawRecorderEvent } from "./types.js";

const CDP_EVENT_MAP: Record<string, WebBlackboxEventType> = {
  "Network.requestWillBeSent": "network.request",
  "Network.responseReceived": "network.response",
  "Network.loadingFinished": "network.finished",
  "Network.loadingFailed": "network.failed",
  "Network.webSocketCreated": "network.ws.open",
  "Network.webSocketFrameReceived": "network.ws.frame",
  "Network.webSocketFrameSent": "network.ws.frame",
  "Network.webSocketClosed": "network.ws.close",
  "Runtime.consoleAPICalled": "console.entry",
  "Runtime.exceptionThrown": "error.exception",
  "Page.frameNavigated": "nav.commit",
  "Page.navigatedWithinDocument": "nav.hash"
};

const CONTENT_EVENT_MAP: Record<string, WebBlackboxEventType> = {
  click: "user.click",
  dblclick: "user.dblclick",
  keydown: "user.keydown",
  input: "user.input",
  submit: "user.submit",
  scroll: "user.scroll",
  mousemove: "user.mousemove",
  focus: "user.focus",
  blur: "user.blur",
  marker: "user.marker",
  visibilitychange: "user.visibility",
  resize: "user.resize",
  mutation: "dom.mutation.batch",
  snapshot: "dom.snapshot",
  screenshot: "screen.screenshot",
  console: "console.entry",
  pageError: "error.exception",
  unhandledrejection: "error.unhandledrejection",
  resourceError: "error.resource",
  longtask: "perf.longtask",
  vitals: "perf.vitals",
  localStorageOp: "storage.local.op",
  sessionStorageOp: "storage.session.op",
  indexedDbOp: "storage.idb.op",
  cookieSnapshot: "storage.cookie.snapshot",
  sse: "network.sse.message"
};

export class DefaultEventNormalizer implements EventNormalizer {
  public normalize(
    input: RawRecorderEvent
  ): { eventType: WebBlackboxEventType; payload: unknown } | null {
    if (input.source === "cdp") {
      const eventType = CDP_EVENT_MAP[input.rawType];

      if (!eventType) {
        return null;
      }

      return {
        eventType,
        payload: input.payload
      };
    }

    if (input.source === "content") {
      if (input.rawType === "fetch" || input.rawType === "xhr") {
        const payload = asRecord(input.payload);
        const phase = payload?.phase;

        if (phase === "end") {
          return {
            eventType: "network.response",
            payload: input.payload
          };
        }

        return {
          eventType: "network.request",
          payload: input.payload
        };
      }

      if (input.rawType === "fetchError") {
        return {
          eventType: "network.failed",
          payload: input.payload
        };
      }

      const eventType = CONTENT_EVENT_MAP[input.rawType];

      if (!eventType) {
        return null;
      }

      return {
        eventType,
        payload: input.payload
      };
    }

    const normalized = tryNormalizeSystemEvent(input.rawType);

    if (!normalized) {
      return null;
    }

    return {
      eventType: normalized,
      payload: input.payload
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tryNormalizeSystemEvent(rawType: string): WebBlackboxEventType | null {
  if (rawType === "session-start") {
    return "meta.session.start";
  }

  if (rawType === "session-end") {
    return "meta.session.end";
  }

  if (rawType === "notice") {
    return "sys.notice";
  }

  if (rawType === "debugger-attach") {
    return "sys.debugger.attach";
  }

  if (rawType === "debugger-detach") {
    return "sys.debugger.detach";
  }

  if (rawType === "config") {
    return "meta.config";
  }

  if (rawType === "cdp.network.body") {
    return "network.body";
  }

  if (rawType === "cdp.screen.screenshot") {
    return "screen.screenshot";
  }

  if (rawType === "cdp.dom.snapshot") {
    return "dom.snapshot";
  }

  if (rawType === "cdp.storage.cookie.snapshot") {
    return "storage.cookie.snapshot";
  }

  if (rawType === "cdp.storage.local.snapshot") {
    return "storage.local.snapshot";
  }

  if (rawType === "cdp.storage.idb.snapshot") {
    return "storage.idb.snapshot";
  }

  if (rawType === "cdp.perf.trace") {
    return "perf.trace";
  }

  if (rawType === "cdp.perf.cpu.profile") {
    return "perf.cpu.profile";
  }

  if (rawType === "cdp.perf.heap.snapshot") {
    return "perf.heap.snapshot";
  }

  return null;
}
