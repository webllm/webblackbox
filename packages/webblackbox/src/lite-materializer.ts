import type { RecorderConfig } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { LiteMaterializerContext } from "./types.js";

const DEFAULT_NETWORK_BODY_MAX_BYTES = 256 * 1024;
const DEFAULT_BODY_MIME_ALLOWLIST = [
  "text/*",
  "application/json",
  "application/*+json",
  "application/xml",
  "application/*+xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];
const REDACTED_TOKEN = "[REDACTED]";
const DEFAULT_SCREENSHOT_MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;
const DEFAULT_SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_DOM_SNAPSHOT_MAX_BYTES = 1_500 * 1024;

type LiteBodyCaptureRule = {
  enabled: boolean;
  maxBytes: number;
  mimeAllowlist: string[];
};

/** Returns whether a raw content event should be transformed into lite payload artifacts. */
export function shouldMaterializeLiteRawEvent(rawEvent: RawRecorderEvent): boolean {
  if (rawEvent.source !== "content") {
    return false;
  }

  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return false;
  }

  if (rawEvent.rawType === "screenshot") {
    return typeof payload.dataUrl === "string" && payload.dataUrl.length > 0;
  }

  if (rawEvent.rawType === "snapshot") {
    return typeof payload.html === "string" && payload.html.length > 0;
  }

  if (rawEvent.rawType === "localStorageSnapshot") {
    return asRecord(payload.entries) !== null;
  }

  if (rawEvent.rawType === "indexedDbSnapshot") {
    return Array.isArray(payload.databaseNames);
  }

  if (rawEvent.rawType === "cookieSnapshot") {
    return Array.isArray(payload.names);
  }

  if (rawEvent.rawType === "networkBody") {
    return (
      (typeof payload.reqId === "string" || typeof payload.requestId === "string") &&
      typeof payload.body === "string"
    );
  }

  return false;
}

/**
 * Converts raw capture payloads (screenshots, DOM/storage snapshots, network bodies)
 * into lite-normalized payloads, persisting large blobs through `context.putBlob`.
 */
export async function materializeLiteRawEvent(
  rawEvent: RawRecorderEvent,
  context: LiteMaterializerContext
): Promise<RawRecorderEvent | null> {
  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(rawEvent, context);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(rawEvent, context);
  }

  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    return materializeLiteStorageSnapshot(rawEvent);
  }

  if (rawEvent.rawType === "networkBody") {
    return materializeLiteNetworkBody(rawEvent, context);
  }

  return rawEvent;
}

async function materializeLiteScreenshot(
  rawEvent: RawRecorderEvent,
  context: LiteMaterializerContext
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const dataUrl = asString(payload?.dataUrl);
  const maxDataUrlLength =
    context.limits?.screenshotMaxDataUrlLength ?? DEFAULT_SCREENSHOT_MAX_DATA_URL_LENGTH;
  const maxBytes = context.limits?.screenshotMaxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;

  if (!payload || !dataUrl || dataUrl.length > maxDataUrlLength) {
    return null;
  }

  const decoded = decodeDataUrl(dataUrl);

  if (!decoded || decoded.bytes.byteLength === 0 || decoded.bytes.byteLength > maxBytes) {
    return null;
  }

  const shotId = await context.putBlob(decoded.mime, decoded.bytes);
  const width = normalizePositiveInt(payload.w) ?? normalizePositiveInt(payload.width);
  const height = normalizePositiveInt(payload.h) ?? normalizePositiveInt(payload.height);
  const quality = normalizePositiveInt(payload.quality);
  const reason = asString(payload.reason) ?? undefined;
  const viewport = normalizeScreenshotViewport(payload.viewport);
  const pointer = normalizeScreenshotPointer(payload.pointer);
  const format = decoded.mime.includes("png") ? "png" : "webp";

  return {
    ...rawEvent,
    payload: {
      shotId,
      format,
      w: width,
      h: height,
      quality: format === "webp" ? quality : undefined,
      size: decoded.bytes.byteLength,
      reason,
      viewport,
      pointer
    }
  };
}

async function materializeLiteDomSnapshot(
  rawEvent: RawRecorderEvent,
  context: LiteMaterializerContext
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const html = asString(payload?.html);
  const maxBytes = context.limits?.domSnapshotMaxBytes ?? DEFAULT_DOM_SNAPSHOT_MAX_BYTES;

  if (!payload || !html) {
    return null;
  }

  const encoded = encodeTextWithByteLimit(html, maxBytes);
  const contentHash = await context.putBlob("text/html", encoded.bytes);
  const snapshotId = asString(payload.snapshotId) ?? `D-${Math.round(rawEvent.mono)}`;
  const nodeCount = normalizeNonNegativeInt(payload.nodeCount);
  const reason = asString(payload.reason) ?? undefined;
  const htmlLength = normalizeNonNegativeInt(payload.htmlLength) ?? html.length;
  const truncated = payload.truncated === true || encoded.truncated;

  return {
    ...rawEvent,
    payload: {
      snapshotId,
      contentHash,
      source: "html",
      nodeCount,
      reason,
      htmlLength,
      truncated
    }
  };
}

async function materializeLiteStorageSnapshot(
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reason = asString(payload.reason) ?? undefined;

  if (rawEvent.rawType === "localStorageSnapshot") {
    const entries = asRecord(payload.entries) ?? {};
    const count = normalizeNonNegativeInt(payload.count) ?? Object.keys(entries).length;

    return {
      ...rawEvent,
      payload: {
        count,
        mode: "counts-only",
        redacted: true,
        reason,
        truncated: payload.truncated === true
      }
    };
  }

  if (rawEvent.rawType === "indexedDbSnapshot") {
    const names = asStringArray(payload.databaseNames, 400);
    const count = normalizeNonNegativeInt(payload.count) ?? names.length;

    return {
      ...rawEvent,
      payload: {
        count,
        mode: "counts-only",
        redacted: true,
        reason,
        truncated: payload.truncated === true
      }
    };
  }

  if (rawEvent.rawType === "cookieSnapshot") {
    const names = asStringArray(payload.names, 400);
    const count = normalizeNonNegativeInt(payload.count) ?? names.length;

    return {
      ...rawEvent,
      payload: {
        count,
        mode: "counts-only",
        redacted: true,
        reason,
        truncated: payload.truncated === true
      }
    };
  }

  return rawEvent;
}

async function materializeLiteNetworkBody(
  rawEvent: RawRecorderEvent,
  context: LiteMaterializerContext
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reqId = asString(payload.reqId) ?? asString(payload.requestId);
  const body = asString(payload.body);
  const encoding = asString(payload.encoding) ?? "utf8";
  const url = asString(payload.url) ?? "";
  const mimeType = normalizeMimeType(asString(payload.mimeType));

  if (!reqId || !body || (encoding !== "utf8" && encoding !== "base64")) {
    return null;
  }

  const captureRule = resolveLiteBodyCaptureRule(context.config, url, mimeType, context.limits);

  if (!captureRule.enabled || !isMimeAllowed(captureRule.mimeAllowlist, mimeType)) {
    return null;
  }

  let bytes: Uint8Array;
  let redacted = payload.redacted === true;

  if (encoding === "utf8") {
    const redaction = redactBodyText(body, context.config.redaction.redactBodyPatterns);
    redacted = redacted || redaction.redacted;
    bytes = new TextEncoder().encode(redaction.value);
  } else {
    bytes = decodeBase64(body);
  }

  if (bytes.byteLength === 0) {
    return null;
  }

  const size = normalizeNonNegativeInt(payload.size) ?? bytes.byteLength;
  const truncatedByInput = payload.truncated === true;
  const truncatedByLimit = bytes.byteLength > captureRule.maxBytes;
  const sampledBytes = truncatedByLimit ? bytes.slice(0, captureRule.maxBytes) : bytes;
  const contentHash = await context.putBlob(mimeType ?? "application/octet-stream", sampledBytes);

  return {
    ...rawEvent,
    payload: {
      reqId,
      requestId: reqId,
      contentHash,
      mimeType,
      size,
      sampledSize: sampledBytes.byteLength,
      truncated: truncatedByInput || truncatedByLimit || sampledBytes.byteLength < size,
      redacted
    }
  };
}

function resolveLiteBodyCaptureRule(
  config: RecorderConfig,
  url: string,
  mimeType: string | undefined,
  limits: LiteMaterializerContext["limits"]
): LiteBodyCaptureRule {
  const defaultRule: LiteBodyCaptureRule = {
    enabled: false,
    maxBytes: normalizeBodyCaptureMaxBytes(
      config.sampling.bodyCaptureMaxBytes,
      limits?.defaultBodyCaptureMaxBytes
    ),
    mimeAllowlist: normalizeMimeAllowlist(DEFAULT_BODY_MIME_ALLOWLIST)
  };

  defaultRule.enabled = defaultRule.maxBytes > 0;

  if (!url) {
    return defaultRule;
  }

  let parsedUrl: URL | null = null;

  try {
    parsedUrl = new URL(url);
  } catch {
    return defaultRule;
  }

  for (const policy of config.sitePolicies) {
    if (!policy.enabled || policy.mode !== "lite") {
      continue;
    }

    if (
      !matchesSitePolicy(parsedUrl, policy.originPattern, policy.pathAllowlist, policy.pathDenylist)
    ) {
      continue;
    }

    if (!policy.allowBodyCapture) {
      return {
        ...defaultRule,
        enabled: false
      };
    }

    const allowlist =
      policy.bodyMimeAllowlist.length > 0
        ? normalizeMimeAllowlist(policy.bodyMimeAllowlist)
        : defaultRule.mimeAllowlist;

    if (!isMimeAllowed(allowlist, mimeType)) {
      return {
        enabled: false,
        maxBytes: defaultRule.maxBytes,
        mimeAllowlist: allowlist
      };
    }

    return {
      enabled: true,
      maxBytes: defaultRule.maxBytes,
      mimeAllowlist: allowlist
    };
  }

  return defaultRule;
}

function normalizeBodyCaptureMaxBytes(candidate: unknown, defaultMaxBytes?: number): number {
  const value = asFiniteNumber(candidate);
  const fallback = defaultMaxBytes ?? DEFAULT_NETWORK_BODY_MAX_BYTES;

  if (value === null) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(4 * 1024, Math.min(8 * 1024 * 1024, Math.round(value)));
}

function normalizeMimeAllowlist(values: string[]): string[] {
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.trim().toLowerCase();

    if (!normalized || output.includes(normalized)) {
      continue;
    }

    output.push(normalized);
  }

  return output;
}

function matchesSitePolicy(
  targetUrl: URL,
  originPattern: string,
  pathAllowlist: string[],
  pathDenylist: string[]
): boolean {
  if (!wildcardMatch(targetUrl.origin, originPattern.trim())) {
    return false;
  }

  const path = `${targetUrl.pathname}${targetUrl.search}`;
  const normalizedAllowlist = pathAllowlist.map((entry) => entry.trim()).filter(Boolean);
  const normalizedDenylist = pathDenylist.map((entry) => entry.trim()).filter(Boolean);

  if (
    normalizedAllowlist.length > 0 &&
    !normalizedAllowlist.some((entry) => wildcardMatch(path, entry))
  ) {
    return false;
  }

  if (normalizedDenylist.some((entry) => wildcardMatch(path, entry))) {
    return false;
  }

  return true;
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }

  if (pattern === "*") {
    return true;
  }

  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`,
    "i"
  );

  return regex.test(value);
}

function isMimeAllowed(allowlist: string[], mimeType: string | undefined): boolean {
  if (!mimeType) {
    return true;
  }

  const normalizedMime = mimeType.toLowerCase();

  return allowlist.some((rule) => {
    if (rule.endsWith("/*")) {
      const prefix = rule.slice(0, -1);
      return normalizedMime.startsWith(prefix);
    }

    if (rule.includes("*")) {
      return wildcardMatch(normalizedMime, rule);
    }

    return normalizedMime === rule;
  });
}

function normalizeMimeType(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const [mime] = value.split(";");
  const normalized = mime?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function redactBodyText(
  value: string,
  patterns: string[]
): {
  value: string;
  redacted: boolean;
} {
  if (patterns.length === 0 || value.length === 0) {
    return {
      value,
      redacted: false
    };
  }

  let output = value;
  let touched = false;

  for (const pattern of patterns) {
    const normalized = pattern.trim();

    if (!normalized) {
      continue;
    }

    const regex = new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

    if (!regex.test(output)) {
      continue;
    }

    output = output.replace(regex, REDACTED_TOKEN);
    touched = true;
  }

  return {
    value: output,
    redacted: touched
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate <= 0) {
    return undefined;
  }

  return Math.max(1, Math.round(candidate));
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate < 0) {
    return undefined;
  }

  return Math.max(0, Math.round(candidate));
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      continue;
    }

    output.push(entry);

    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function encodeTextWithByteLimit(
  value: string,
  maxBytes: number
): { bytes: Uint8Array; truncated: boolean } {
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(value);

  if (fullBytes.byteLength <= maxBytes) {
    return {
      bytes: fullBytes,
      truncated: false
    };
  }

  const roughRatio = Math.max(0.05, maxBytes / fullBytes.byteLength);
  let targetChars = Math.max(1, Math.floor(value.length * roughRatio));
  let clipped = value.slice(0, targetChars);
  let clippedBytes = encoder.encode(clipped);

  while (clippedBytes.byteLength > maxBytes && targetChars > 1) {
    targetChars = Math.max(1, Math.floor(targetChars * 0.9));
    clipped = value.slice(0, targetChars);
    clippedBytes = encoder.encode(clipped);
  }

  return {
    bytes: clippedBytes,
    truncated: true
  };
}

function normalizeScreenshotViewport(
  value: unknown
): { width: number; height: number; dpr: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const width = normalizePositiveInt(row.width);
  const height = normalizePositiveInt(row.height);
  const dpr = asFiniteNumber(row.dpr);

  if (!width || !height || dpr === null || dpr <= 0) {
    return undefined;
  }

  return {
    width,
    height,
    dpr: Number(dpr.toFixed(3))
  };
}

function normalizeScreenshotPointer(
  value: unknown
): { x: number; y: number; t?: number; mono?: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const x = asFiniteNumber(row.x);
  const y = asFiniteNumber(row.y);
  const t = asFiniteNumber(row.t);
  const mono = asFiniteNumber(row.mono);

  if (x === null || y === null) {
    return undefined;
  }

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    t: t === null ? undefined : t,
    mono: mono === null ? undefined : mono
  };
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");

  if (commaIndex <= 5) {
    return null;
  }

  const header = dataUrl.slice(5, commaIndex);
  const encoded = dataUrl.slice(commaIndex + 1);
  const segments = header.split(";");
  const mime = segments[0] && segments[0].length > 0 ? segments[0] : "application/octet-stream";
  const isBase64 = segments.includes("base64");

  try {
    if (isBase64) {
      return {
        mime,
        bytes: decodeBase64(encoded)
      };
    }

    return {
      mime,
      bytes: new TextEncoder().encode(decodeURIComponent(encoded))
    };
  } catch {
    return null;
  }
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
