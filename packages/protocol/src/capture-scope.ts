import type { CapturePolicy } from "./types.js";

export type CaptureScopeDecisionReason =
  | "allowed"
  | "missing-policy"
  | "tab-mismatch"
  | "consent-invalid"
  | "consent-expired"
  | "frame-context-invalid"
  | "subframes-disabled"
  | "opaque-or-invalid-url"
  | "origin-changed"
  | "origin-denied"
  | "origin-not-allowed"
  | "url-excluded";

export type CaptureScopeContext = {
  url: string | null | undefined;
  tabId?: number;
  frameId?: number;
  topLevel: boolean;
  now?: number;
};

export type CaptureScopeDecision = {
  allowed: boolean;
  reason: CaptureScopeDecisionReason;
  origin: string | null;
};

/**
 * Evaluates a document against the complete capture scope. Invalid, opaque, or
 * ambiguous inputs are denied so all runtimes can use the same fail-closed
 * boundary at start, navigation, injection, and event ingestion.
 */
export function evaluateCaptureScope(
  policy: CapturePolicy | null | undefined,
  context: CaptureScopeContext
): CaptureScopeDecision {
  if (!policy) {
    return denied("missing-policy");
  }

  const now = normalizeNow(context.now);
  const consentReason = validateConsentWindow(policy, now);

  if (consentReason) {
    return denied(consentReason);
  }

  const frameId = normalizeFrameId(context.frameId);

  if (frameId === null) {
    return denied("frame-context-invalid");
  }

  if (context.topLevel !== (frameId === 0)) {
    return denied("frame-context-invalid");
  }

  if (
    typeof context.tabId === "number" &&
    Number.isFinite(context.tabId) &&
    policy.scope.tabId > 0 &&
    Math.floor(context.tabId) !== policy.scope.tabId
  ) {
    return denied("tab-mismatch");
  }

  if ((!context.topLevel || frameId > 0) && !policy.scope.includeSubframes) {
    return denied("subframes-disabled");
  }

  const parsedUrl = parseCaptureUrl(context.url);

  if (!parsedUrl) {
    return denied("opaque-or-invalid-url");
  }

  const origin = parsedUrl.origin;
  const scopeOrigin = normalizeOrigin(policy.scope.origin);

  if (context.topLevel && policy.scope.stopOnOriginChange && scopeOrigin !== null) {
    if (origin !== scopeOrigin) {
      return denied("origin-changed", origin);
    }
  }

  if (policy.scope.deniedOrigins.some((pattern) => matchesCaptureOrigin(origin, pattern))) {
    return denied("origin-denied", origin);
  }

  if (
    policy.scope.allowedOrigins.length > 0 &&
    !policy.scope.allowedOrigins.some((pattern) => matchesCaptureOrigin(origin, pattern))
  ) {
    return denied("origin-not-allowed", origin);
  }

  if (
    policy.scope.excludedUrlPatterns.some((pattern) => matchesCaptureUrlPattern(parsedUrl, pattern))
  ) {
    return denied("url-excluded", origin);
  }

  return {
    allowed: true,
    reason: "allowed",
    origin
  };
}

/** Matches exact origins plus the wildcard forms used by enterprise policy. */
export function matchesCaptureOrigin(origin: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim();

  if (!pattern) {
    return false;
  }

  if (origin === normalizeOrigin(pattern)) {
    return true;
  }

  let originUrl: URL;

  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  if (pattern.startsWith("*.")) {
    return matchesHostSuffix(originUrl.hostname, pattern.slice(2));
  }

  const schemeHostWildcard = /^([a-z][a-z\d+.-]*:\/\/)\*\.(.+)$/i.exec(pattern);

  if (schemeHostWildcard) {
    const [, scheme, suffixWithPort] = schemeHostWildcard;

    if (!scheme || !suffixWithPort || originUrl.protocol + "//" !== scheme.toLowerCase()) {
      return false;
    }

    const [suffix, port] = splitHostAndPort(suffixWithPort);

    return (
      matchesHostSuffix(originUrl.hostname, suffix) &&
      (port === undefined || originUrl.port === port)
    );
  }

  return pattern.includes("*") && wildcardMatch(origin, pattern);
}

function validateConsentWindow(
  policy: CapturePolicy,
  now: number
): "consent-invalid" | "consent-expired" | null {
  const grantedAt = Date.parse(policy.consent.grantedAt);

  if (!Number.isFinite(grantedAt) || grantedAt > now) {
    return "consent-invalid";
  }

  if (policy.consent.expiresAt === undefined) {
    return null;
  }

  const expiresAt = Date.parse(policy.consent.expiresAt);

  if (!Number.isFinite(expiresAt) || expiresAt <= grantedAt) {
    return "consent-invalid";
  }

  return now >= expiresAt ? "consent-expired" : null;
}

function parseCaptureUrl(value: string | null | undefined): URL | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);

    if (parsed.origin === "null") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string | null {
  const parsed = parseCaptureUrl(value);
  return parsed?.origin ?? null;
}

function matchesCaptureUrlPattern(url: URL, rawPattern: string): boolean {
  const pattern = rawPattern.trim();

  if (!pattern) {
    return false;
  }

  if (pattern.startsWith("/")) {
    return wildcardMatch(`${url.pathname}${url.search}${url.hash}`, pattern);
  }

  return wildcardMatch(url.href, pattern) || wildcardMatch(url.origin + url.pathname, pattern);
}

function matchesHostSuffix(hostname: string, rawSuffix: string): boolean {
  const suffix = rawSuffix
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  const host = hostname.toLowerCase();

  return suffix.length > 0 && (host === suffix || host.endsWith(`.${suffix}`));
}

function splitHostAndPort(value: string): [string, string | undefined] {
  const separator = value.lastIndexOf(":");

  if (separator <= 0 || !/^\d+$/.test(value.slice(separator + 1))) {
    return [value, undefined];
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}

function wildcardMatch(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let wildcardIndex = -1;
  let wildcardValueIndex = -1;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
      continue;
    }

    if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      wildcardIndex = patternIndex;
      wildcardValueIndex = valueIndex;
      patternIndex += 1;
      continue;
    }

    if (wildcardIndex >= 0) {
      patternIndex = wildcardIndex + 1;
      wildcardValueIndex += 1;
      valueIndex = wildcardValueIndex;
      continue;
    }

    return false;
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex === pattern.length;
}

function normalizeFrameId(value: number | undefined): number | null {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizeNow(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function denied(reason: CaptureScopeDecisionReason, origin: string | null = null) {
  return {
    allowed: false,
    reason,
    origin
  } satisfies CaptureScopeDecision;
}
