import { describe, expect, it } from "vitest";

import { DEFAULT_CAPTURE_POLICY } from "./defaults.js";
import { evaluateCaptureScope, matchesCaptureOrigin } from "./capture-scope.js";
import type { CapturePolicy } from "./types.js";

const NOW = Date.parse("2026-07-11T00:00:00.000Z");

function policy(overrides: Partial<CapturePolicy["scope"]> = {}): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    consent: {
      ...DEFAULT_CAPTURE_POLICY.consent,
      grantedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-12T00:00:00.000Z"
    },
    scope: {
      ...DEFAULT_CAPTURE_POLICY.scope,
      tabId: 7,
      origin: "https://app.example",
      ...overrides
    }
  };
}

describe("evaluateCaptureScope", () => {
  it("allows the bound top-level origin and same-origin navigation", () => {
    expect(
      evaluateCaptureScope(policy(), {
        url: "https://app.example/projects/123?token=secret",
        tabId: 7,
        frameId: 0,
        topLevel: true,
        now: NOW
      })
    ).toMatchObject({ allowed: true, reason: "allowed", origin: "https://app.example" });
  });

  it("stops cross-origin top-level navigation when configured", () => {
    expect(
      evaluateCaptureScope(policy(), {
        url: "https://admin.example/dashboard",
        tabId: 7,
        frameId: 0,
        topLevel: true,
        now: NOW
      })
    ).toMatchObject({ allowed: false, reason: "origin-changed" });
  });

  it("allows a policy-approved origin change only when stopOnOriginChange is disabled", () => {
    const capturePolicy = policy({
      stopOnOriginChange: false,
      allowedOrigins: ["https://app.example", "https://admin.example"]
    });

    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://admin.example/dashboard",
        tabId: 7,
        topLevel: true,
        now: NOW
      }).allowed
    ).toBe(true);
  });

  it("applies deny before allow and supports enterprise wildcard origins", () => {
    const capturePolicy = policy({
      stopOnOriginChange: false,
      allowedOrigins: ["*.example.com"],
      deniedOrigins: ["https://blocked.example.com"]
    });

    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://api.example.com/v1",
        topLevel: true,
        now: NOW
      }).allowed
    ).toBe(true);
    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://blocked.example.com/v1",
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("origin-denied");
    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://outside.test/v1",
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("origin-not-allowed");
  });

  it("rejects excluded paths before capture", () => {
    const capturePolicy = policy({
      excludedUrlPatterns: ["https://app.example/private/*", "/billing/*"]
    });

    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://app.example/private/token",
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("url-excluded");
    expect(
      evaluateCaptureScope(capturePolicy, {
        url: "https://app.example/billing/card",
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("url-excluded");
  });

  it("denies child frames unless includeSubframes is explicitly enabled", () => {
    expect(
      evaluateCaptureScope(policy(), {
        url: "https://app.example/embed",
        frameId: 2,
        topLevel: false,
        now: NOW
      }).reason
    ).toBe("subframes-disabled");

    expect(
      evaluateCaptureScope(
        policy({ includeSubframes: true, allowedOrigins: ["https://widgets.example"] }),
        {
          url: "https://widgets.example/embed",
          frameId: 2,
          topLevel: false,
          now: NOW
        }
      ).allowed
    ).toBe(true);
  });

  it("rejects inconsistent frame identity", () => {
    expect(
      evaluateCaptureScope(policy({ includeSubframes: true }), {
        url: "https://app.example/frame",
        frameId: 3,
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("frame-context-invalid");
  });

  it.each(["about:blank", "data:text/html,hello", "file:///tmp/private.html", "not a url"])(
    "denies opaque or invalid URL %s",
    (url) => {
      expect(
        evaluateCaptureScope(policy({ stopOnOriginChange: false }), {
          url,
          topLevel: true,
          now: NOW
        }).reason
      ).toBe("opaque-or-invalid-url");
    }
  );

  it("denies expired, malformed, and not-yet-granted consent", () => {
    const expired = policy();
    const malformed = policy();
    const future = policy();
    expired.consent = { ...expired.consent, expiresAt: "2026-07-10T12:00:00.000Z" };
    malformed.consent = { ...malformed.consent, expiresAt: "invalid" };
    future.consent = { ...future.consent, grantedAt: "2026-07-12T00:00:00.000Z" };

    const context = { url: "https://app.example", topLevel: true, now: NOW };
    expect(evaluateCaptureScope(expired, context).reason).toBe("consent-expired");
    expect(evaluateCaptureScope(malformed, context).reason).toBe("consent-invalid");
    expect(evaluateCaptureScope(future, context).reason).toBe("consent-invalid");
  });

  it("rejects a session used from a different tab", () => {
    expect(
      evaluateCaptureScope(policy(), {
        url: "https://app.example",
        tabId: 8,
        topLevel: true,
        now: NOW
      }).reason
    ).toBe("tab-mismatch");
  });
});

describe("matchesCaptureOrigin", () => {
  it("supports exact, host wildcard, and scheme-qualified host wildcard patterns", () => {
    expect(matchesCaptureOrigin("https://app.example.com", "https://app.example.com")).toBe(true);
    expect(matchesCaptureOrigin("https://app.example.com", "*.example.com")).toBe(true);
    expect(matchesCaptureOrigin("https://example.com", "*.example.com")).toBe(true);
    expect(matchesCaptureOrigin("https://app.example.com", "https://*.example.com")).toBe(true);
    expect(matchesCaptureOrigin("http://app.example.com", "https://*.example.com")).toBe(false);
  });
});
