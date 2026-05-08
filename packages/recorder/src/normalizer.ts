import {
  extractRequestIdFromPayload,
  sanitizeUrlForPrivacy,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

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
  "Log.entryAdded": "console.entry",
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
  rrweb: "dom.rrweb.event",
  snapshot: "dom.snapshot",
  screenshot: "screen.screenshot",
  console: "console.entry",
  pageError: "error.exception",
  unhandledrejection: "error.unhandledrejection",
  resourceError: "error.resource",
  longtask: "perf.longtask",
  vitals: "perf.vitals",
  privacyViolation: "privacy.violation",
  localStorageOp: "storage.local.op",
  localStorageSnapshot: "storage.local.snapshot",
  sessionStorageOp: "storage.session.op",
  indexedDbOp: "storage.idb.op",
  indexedDbSnapshot: "storage.idb.snapshot",
  cookieSnapshot: "storage.cookie.snapshot",
  sse: "network.sse.message"
};
let fallbackRequestSequence = 0;

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
        payload:
          eventType === "console.entry"
            ? normalizeCdpConsolePayload(input.rawType, input.payload)
            : input.payload
      };
    }

    if (input.source === "content") {
      if (input.rawType === "console") {
        return {
          eventType: "console.entry",
          payload: normalizeContentConsolePayload(input.payload)
        };
      }

      if (input.rawType === "fetch" || input.rawType === "xhr") {
        const payload = asRecord(input.payload);
        const phase = asString(payload?.phase);

        if (phase === "end") {
          return {
            eventType: "network.response",
            payload: normalizeContentNetworkResponsePayload(payload)
          };
        }

        return {
          eventType: "network.request",
          payload: normalizeContentNetworkRequestPayload(payload)
        };
      }

      if (input.rawType === "fetchError") {
        return {
          eventType: "network.failed",
          payload: normalizeContentNetworkFailedPayload(asRecord(input.payload))
        };
      }

      if (input.rawType === "networkBody") {
        return {
          eventType: "network.body",
          payload: normalizeContentNetworkBodyPayload(asRecord(input.payload))
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

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

function normalizeCdpConsolePayload(rawType: string, payload: unknown): Record<string, unknown> {
  if (rawType === "Log.entryAdded") {
    const row = asRecord(payload);
    const entry = asRecord(row?.entry);
    const text = asString(entry?.text) ?? "";
    const method = asString(entry?.source) ?? "log.entry";

    return stripUndefined({
      source: "cdp.log",
      level: normalizeConsoleLevel(asString(entry?.level) ?? method),
      method,
      text: text || "(empty log entry)",
      args: text ? [text] : [],
      stackTop: readStackTop(asRecord(entry?.stackTrace)),
      url: asString(entry?.url),
      line: asFiniteNumber(entry?.lineNumber) ?? undefined,
      col: asFiniteNumber(entry?.columnNumber) ?? undefined,
      networkRequestId: asString(entry?.networkRequestId),
      workerId: asString(entry?.workerId),
      timestamp: asFiniteNumber(entry?.timestamp) ?? undefined
    });
  }

  const row = asRecord(payload);
  const method = asString(row?.type) ?? "log";
  const args = asArray(row?.args).map((entry) => normalizeCdpRemoteObject(entry));
  const text = asString(row?.text) ?? formatConsoleText(args);

  return stripUndefined({
    source: "cdp.runtime",
    level: normalizeConsoleLevel(method),
    method,
    text,
    args,
    stackTop: readStackTop(asRecord(row?.stackTrace)),
    executionContextId: asFiniteNumber(row?.executionContextId) ?? undefined,
    timestamp: asFiniteNumber(row?.timestamp) ?? undefined
  });
}

function normalizeContentConsolePayload(payload: unknown): Record<string, unknown> {
  const row = asRecord(payload);
  const method = asString(row?.method) ?? "log";
  const args = asArray(row?.args).map((entry) => sanitizeSerializable(entry, 0));
  const text = asString(row?.text) ?? formatConsoleText(args);

  return stripUndefined({
    source: asString(row?.source) ?? "content.injected",
    level: normalizeConsoleLevel(asString(row?.level) ?? method),
    method,
    text,
    args,
    stackTop: asString(row?.stackTop) ?? undefined
  });
}

function normalizeContentNetworkRequestPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = (asString(payload?.method) ?? "GET").toUpperCase();
  const url = sanitizeUrlForPrivacy(asString(payload?.url) ?? "unknown://request");
  const reqId = readRequestId(payload) ?? buildFallbackReqId(method, url);

  return stripUndefined({
    reqId,
    requestId: reqId,
    method,
    url,
    headers: normalizeHeaderRecord(payload?.headers),
    postDataSize:
      asFiniteNumber(payload?.postDataSize) ??
      asFiniteNumber(payload?.bodyLength) ??
      asFiniteNumber(payload?.size) ??
      undefined
  });
}

function normalizeContentNetworkResponsePayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = asString(payload?.method);
  const url = asString(payload?.url);
  const sanitizedUrl = url ? sanitizeUrlForPrivacy(url) : undefined;
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId(method ?? "GET", sanitizedUrl ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    method: method ? method.toUpperCase() : undefined,
    url: sanitizedUrl,
    status: asFiniteNumber(payload?.status) ?? undefined,
    statusText: asString(payload?.statusText) ?? undefined,
    mimeType: asString(payload?.mimeType) ?? undefined,
    headers: normalizeHeaderRecord(payload?.headers),
    encodedDataLength:
      asFiniteNumber(payload?.encodedDataLength) ??
      asFiniteNumber(payload?.bodyLength) ??
      asFiniteNumber(payload?.size) ??
      undefined,
    duration: asFiniteNumber(payload?.duration) ?? undefined,
    ok: asBoolean(payload?.ok),
    redirected: asBoolean(payload?.redirected),
    responseUrl: sanitizeOptionalUrl(asString(payload?.responseUrl)),
    failed: asBoolean(payload?.failed)
  });
}

function normalizeContentNetworkFailedPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = asString(payload?.method);
  const url = asString(payload?.url);
  const sanitizedUrl = url ? sanitizeUrlForPrivacy(url) : undefined;
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId(method ?? "GET", sanitizedUrl ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    method: method ? method.toUpperCase() : undefined,
    url: sanitizedUrl,
    duration: asFiniteNumber(payload?.duration) ?? undefined,
    message: asString(payload?.message) ?? undefined,
    errorText: asString(payload?.errorText) ?? asString(payload?.message) ?? undefined
  });
}

function normalizeContentNetworkBodyPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId("GET", sanitizeOptionalUrl(asString(payload?.url)) ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    contentHash: asString(payload?.contentHash) ?? asString(payload?.hash) ?? undefined,
    mimeType: asString(payload?.mimeType) ?? undefined,
    size: asFiniteNumber(payload?.size) ?? undefined,
    sampledSize: asFiniteNumber(payload?.sampledSize) ?? undefined,
    redacted: asBoolean(payload?.redacted),
    truncated: asBoolean(payload?.truncated)
  });
}

function readRequestId(payload: Record<string, unknown> | null): string | null {
  return extractRequestIdFromPayload(payload);
}

function buildFallbackReqId(method: string, url: string): string {
  fallbackRequestSequence = (fallbackRequestSequence + 1) >>> 0;
  return `content-${method.toUpperCase()}-${compactText(url, 120)}-${fallbackRequestSequence.toString(36)}`;
}

function normalizeHeaderRecord(value: unknown): Record<string, string> | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const output: Record<string, string> = {};

  for (const [key, entry] of Object.entries(row).slice(0, 64)) {
    if (typeof entry === "string") {
      output[key.toLowerCase()] = compactText(entry, 500);
      continue;
    }

    if (typeof entry === "number" || typeof entry === "boolean") {
      output[key.toLowerCase()] = String(entry);
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeConsoleLevel(rawLevel: string): ConsoleLevel {
  const value = rawLevel.toLowerCase();

  if (value === "error" || value === "assert") {
    return "error";
  }

  if (value === "warn" || value === "warning") {
    return "warn";
  }

  if (value === "info") {
    return "info";
  }

  if (value === "debug" || value === "trace") {
    return "debug";
  }

  return "log";
}

function normalizeCdpRemoteObject(value: unknown): unknown {
  const row = asRecord(value);

  if (!row) {
    return sanitizeSerializable(value, 0);
  }

  if (typeof row.unserializableValue === "string") {
    return row.unserializableValue;
  }

  if ("value" in row) {
    return sanitizeSerializable(row.value, 0);
  }

  const description = asString(row.description);

  if (description) {
    return compactText(description, 320);
  }

  return stripUndefined({
    type: asString(row.type),
    subtype: asString(row.subtype),
    className: asString(row.className)
  });
}

function sanitizeSerializable(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return compactText(value, 260);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (depth >= 4) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizeSerializable(entry, depth + 1));
  }

  if (value instanceof Error) {
    return stripUndefined({
      name: value.name,
      message: value.message,
      stack: value.stack ? compactText(value.stack, 500) : undefined
    });
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      output[key] = sanitizeSerializable(entry, depth + 1);
    }

    return output;
  }

  return String(value);
}

function readStackTop(stackTrace: Record<string, unknown> | null): string | undefined {
  if (!stackTrace) {
    return undefined;
  }

  const frames = asArray(stackTrace.callFrames);
  const frame = asRecord(frames[0]);

  if (!frame) {
    return undefined;
  }

  const url = sanitizeOptionalUrl(asString(frame.url)) ?? "(anonymous)";
  const line = asFiniteNumber(frame.lineNumber);
  const col = asFiniteNumber(frame.columnNumber);
  const functionName = asString(frame.functionName) ?? "(anonymous)";

  return `${functionName} @ ${url}:${line ?? 0}:${col ?? 0}`;
}

function formatConsoleText(args: unknown[]): string {
  if (args.length === 0) {
    return "";
  }

  const parts = args
    .slice(0, 8)
    .map((entry) => stringifyConsoleArg(entry))
    .filter((entry) => entry.length > 0);

  return compactText(parts.join(" "), 600);
}

function stringifyConsoleArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = entry;
    }
  }

  return output;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeOptionalUrl(value: string | undefined): string | undefined {
  return value ? sanitizeUrlForPrivacy(value) : undefined;
}

function compactText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
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

  if (rawType === "privacyViolation") {
    return "privacy.violation";
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
