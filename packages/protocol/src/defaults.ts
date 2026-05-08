import type { ExportPolicy, RecorderConfig } from "./types.js";

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
  redaction: {
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
  },
  sitePolicies: []
};

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
  includeScreenshots: false,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
};
