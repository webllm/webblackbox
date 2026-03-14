import type { CaptureMode, RecorderConfig } from "@webblackbox/protocol";

export type BodyCaptureRule = {
  enabled: boolean;
  maxBytes: number;
  mimeAllowlist: string[];
};

type BodyCaptureConfig = {
  sampling: {
    bodyCaptureMaxBytes: number;
  };
  sitePolicies: RecorderConfig["sitePolicies"];
};

type RuleResolutionOptions = {
  defaultMimeAllowlist?: string[];
  fallbackMaxBytes?: number;
};

type TransformResponseBodyArgs = {
  body: string;
  base64Encoded: boolean;
  redactPatterns: string[];
  maxBytes: number;
  decodeBase64: (value: string) => Uint8Array;
  redactionToken?: string;
};

const DEFAULT_FALLBACK_MAX_BYTES = 256 * 1024;
const DEFAULT_BODY_MIME_ALLOWLIST = [
  "text/*",
  "application/json",
  "application/*+json",
  "application/xml",
  "application/*+xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];
const DEFAULT_REDACTION_TOKEN = "[REDACTED]";

export function resolveLiteBodyCaptureRule(
  config: BodyCaptureConfig,
  url: string,
  mimeType: string | undefined,
  options: RuleResolutionOptions = {}
): BodyCaptureRule {
  const defaultRule = buildDefaultRule(config, options);

  if (!url) {
    return defaultRule;
  }

  const parsedUrl = safeParseUrl(url);

  if (!parsedUrl) {
    return defaultRule;
  }

  const policyRule = resolvePolicyRule(
    config.sitePolicies,
    "lite",
    parsedUrl,
    defaultRule,
    mimeType
  );
  return policyRule ?? defaultRule;
}

export function resolveFullBodyCaptureRule(
  config: BodyCaptureConfig,
  url: string,
  mimeType: string | undefined,
  options: RuleResolutionOptions = {}
): BodyCaptureRule {
  const defaultRule = buildDefaultRule(config, options);
  const fallbackRule = isMimeAllowed(defaultRule.mimeAllowlist, mimeType)
    ? defaultRule
    : { ...defaultRule, enabled: false };

  if (!url) {
    return fallbackRule;
  }

  const parsedUrl = safeParseUrl(url);

  if (!parsedUrl) {
    return fallbackRule;
  }

  const policyRule = resolvePolicyRule(
    config.sitePolicies,
    "full",
    parsedUrl,
    defaultRule,
    mimeType
  );
  return policyRule ?? fallbackRule;
}

export function normalizeBodyCaptureMaxBytes(
  candidate: unknown,
  fallbackMaxBytes: number = DEFAULT_FALLBACK_MAX_BYTES
): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallbackMaxBytes;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(4 * 1024, Math.min(8 * 1024 * 1024, Math.round(value)));
}

export function normalizeMimeAllowlist(values: string[]): string[] {
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

export function matchesSitePolicy(
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

export function wildcardMatch(value: string, pattern: string): boolean {
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

export function isMimeAllowed(allowlist: string[], mimeType: string | undefined): boolean {
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

export function normalizeMimeType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const [mime] = value.split(";");
  const normalized = mime?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function redactBodyText(
  value: string,
  patterns: string[],
  redactionToken: string = DEFAULT_REDACTION_TOKEN
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

    output = output.replace(regex, redactionToken);
    touched = true;
  }

  return {
    value: output,
    redacted: touched
  };
}

export function isTextualMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("ecmascript") ||
    mimeType.includes("x-www-form-urlencoded")
  );
}

export function isLikelyTextualResourceType(resourceType?: string): boolean {
  return (
    resourceType === "Document" ||
    resourceType === "XHR" ||
    resourceType === "Fetch" ||
    resourceType === "Script" ||
    resourceType === "EventSource"
  );
}

export function transformResponseBodyForCapture(args: TransformResponseBodyArgs): {
  originalBytes: Uint8Array;
  sampledBytes: Uint8Array;
  redacted: boolean;
  truncated: boolean;
} {
  const originalBytes = args.base64Encoded
    ? args.decodeBase64(args.body)
    : new TextEncoder().encode(args.body);

  let candidateBytes = originalBytes;
  let redacted = false;

  if (!args.base64Encoded && args.redactPatterns.length > 0) {
    const redaction = redactBodyText(
      args.body,
      args.redactPatterns,
      args.redactionToken ?? DEFAULT_REDACTION_TOKEN
    );

    if (redaction.redacted) {
      candidateBytes = new TextEncoder().encode(redaction.value);
      redacted = true;
    }
  }

  const maxBytes = normalizeBodyCaptureMaxBytes(args.maxBytes);
  const truncated = candidateBytes.byteLength > maxBytes;
  const sampledBytes = truncated ? candidateBytes.slice(0, maxBytes) : candidateBytes;

  return {
    originalBytes,
    sampledBytes,
    redacted,
    truncated
  };
}

function buildDefaultRule(
  config: BodyCaptureConfig,
  options: RuleResolutionOptions
): BodyCaptureRule {
  const defaultMimeAllowlist =
    options.defaultMimeAllowlist && options.defaultMimeAllowlist.length > 0
      ? options.defaultMimeAllowlist
      : DEFAULT_BODY_MIME_ALLOWLIST;

  const maxBytes = normalizeBodyCaptureMaxBytes(
    config.sampling.bodyCaptureMaxBytes,
    options.fallbackMaxBytes ?? DEFAULT_FALLBACK_MAX_BYTES
  );

  return {
    enabled: maxBytes > 0,
    maxBytes,
    mimeAllowlist: normalizeMimeAllowlist(defaultMimeAllowlist)
  };
}

function resolvePolicyRule(
  policies: RecorderConfig["sitePolicies"],
  mode: CaptureMode,
  parsedUrl: URL,
  defaultRule: BodyCaptureRule,
  mimeType: string | undefined
): BodyCaptureRule | null {
  for (const policy of policies) {
    if (!policy.enabled || policy.mode !== mode) {
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

  return null;
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
