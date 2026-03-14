import type { RawRecorderEvent } from "@webblackbox/recorder";

type LiteNetworkRuntimeContext = {
  sid: string;
  tabId: number;
  frame?: string;
};

type LiteNetworkStartDetails = {
  requestId: string;
  method?: string;
  url: string;
  timeStamp?: number;
};

type LiteNetworkEndDetails = LiteNetworkStartDetails & {
  statusCode?: number;
  statusLine?: string;
  duration?: number;
  redirected?: boolean;
  responseUrl?: string;
};

type LiteNetworkErrorDetails = LiteNetworkStartDetails & {
  duration?: number;
  error?: string;
};

export function buildLiteNetworkRequestRawEvent(
  context: LiteNetworkRuntimeContext,
  details: LiteNetworkStartDetails
): RawRecorderEvent {
  const { t, mono } = normalizeNetworkTime(details.timeStamp);

  return {
    source: "content",
    rawType: "fetch",
    sid: context.sid,
    tabId: context.tabId,
    frame: context.frame,
    t,
    mono,
    payload: {
      phase: "start",
      reqId: details.requestId,
      requestId: details.requestId,
      method: normalizeMethod(details.method),
      url: details.url
    }
  };
}

export function buildLiteNetworkResponseRawEvent(
  context: LiteNetworkRuntimeContext,
  details: LiteNetworkEndDetails
): RawRecorderEvent {
  const { t, mono } = normalizeNetworkTime(details.timeStamp);
  const status = normalizeStatusCode(details.statusCode);

  return {
    source: "content",
    rawType: "fetch",
    sid: context.sid,
    tabId: context.tabId,
    frame: context.frame,
    t,
    mono,
    payload: {
      phase: "end",
      reqId: details.requestId,
      requestId: details.requestId,
      method: normalizeMethod(details.method),
      url: details.url,
      status,
      statusText: parseStatusText(details.statusLine),
      duration: normalizeDuration(details.duration),
      ok: typeof status === "number" ? status >= 200 && status < 400 : undefined,
      redirected: details.redirected === true,
      responseUrl: details.responseUrl
    }
  };
}

export function buildLiteNetworkFailureRawEvent(
  context: LiteNetworkRuntimeContext,
  details: LiteNetworkErrorDetails
): RawRecorderEvent {
  const { t, mono } = normalizeNetworkTime(details.timeStamp);
  const message =
    typeof details.error === "string" && details.error.length > 0
      ? details.error
      : "Network request failed";

  return {
    source: "content",
    rawType: "fetchError",
    sid: context.sid,
    tabId: context.tabId,
    frame: context.frame,
    t,
    mono,
    payload: {
      reqId: details.requestId,
      requestId: details.requestId,
      method: normalizeMethod(details.method),
      url: details.url,
      duration: normalizeDuration(details.duration),
      message,
      errorText: message
    }
  };
}

function normalizeNetworkTime(candidate?: number): { t: number; mono: number } {
  const value =
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.round(candidate)
      : Date.now();

  return {
    t: value,
    mono: value
  };
}

function normalizeMethod(candidate?: string): string {
  return typeof candidate === "string" && candidate.length > 0 ? candidate.toUpperCase() : "GET";
}

function normalizeStatusCode(candidate?: number): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.round(candidate)
    : undefined;
}

function normalizeDuration(candidate?: number): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function parseStatusText(statusLine?: string): string | undefined {
  if (typeof statusLine !== "string" || statusLine.length === 0) {
    return undefined;
  }

  const parts = statusLine.trim().split(/\s+/);

  if (parts.length < 3) {
    return undefined;
  }

  return parts.slice(2).join(" ");
}
