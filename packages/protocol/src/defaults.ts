import type { CapturePolicy, ExportPolicy, RecorderConfig, RedactionProfile } from "./types.js";

export const DEFAULT_REDACTION_PROFILE: RedactionProfile = {
  redactHeaders: [
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token"
  ],
  redactCookieNames: ["token", "session", "auth", "jwt", "refresh_token", "csrf", "xsrf"],
  redactBodyPatterns: [
    "password",
    "token",
    "secret",
    "otp",
    "credential",
    "api_key",
    "apikey",
    "private_key",
    "refresh_token"
  ],
  blockedSelectors: [
    ".secret",
    "[data-sensitive]",
    "[data-webblackbox-redact]",
    "input[type='password']",
    "input[name*='token']",
    "input[name*='secret']",
    "input[autocomplete='cc-number']"
  ],
  hashSensitiveValues: true
};

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  schemaVersion: 2,
  mode: "private",
  captureContext: "real-user",
  consent: {
    id: "default-private-consent",
    provenance: "self-recording",
    purpose: "debugging",
    grantedAt: "1970-01-01T00:00:00.000Z"
  },
  unmaskPolicySource: "none",
  scope: {
    tabId: 0,
    origin: "",
    allowedOrigins: [],
    deniedOrigins: [],
    includeSubframes: false,
    stopOnOriginChange: true,
    excludedUrlPatterns: []
  },
  categories: {
    actions: "metadata",
    inputs: "length-only",
    dom: "masked",
    screenshots: "off",
    console: "metadata",
    network: "metadata",
    storage: "counts-only",
    indexedDb: "counts-only",
    cookies: "count-only",
    cdp: "off",
    heapProfiles: "off"
  },
  redaction: DEFAULT_REDACTION_PROFILE,
  encryption: {
    localAtRest: "required",
    archive: "required",
    archiveKeyEnvelope: "passphrase"
  },
  retention: {
    localTtlMs: 24 * 60 * 60 * 1000
  }
};

export const DEFAULT_RECORDER_CONFIG: RecorderConfig = {
  mode: "lite",
  ringBufferMinutes: 10,
  freezeOnError: true,
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true,
  sampling: {
    mousemoveHz: 20,
    scrollHz: 15,
    domFlushMs: 100,
    screenshotIdleMs: 0,
    snapshotIntervalMs: 20000,
    actionWindowMs: 1500,
    bodyCaptureMaxBytes: 0
  },
  redaction: DEFAULT_REDACTION_PROFILE,
  capturePolicy: DEFAULT_CAPTURE_POLICY,
  sitePolicies: []
};

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
  includeScreenshots: false,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};
