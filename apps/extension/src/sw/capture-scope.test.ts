import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  bindCapturePolicyToSession,
  evaluateCaptureDocumentScope,
  isCaptureEventFrameAllowed,
  resolveContentScriptInjectionTarget,
  shouldStopForEnterpriseOriginPolicy
} from "./capture-scope.js";

const NOW = Date.parse("2026-07-11T00:00:00.000Z");

function policy(overrides: Partial<CapturePolicy["scope"]> = {}): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    consent: {
      ...DEFAULT_CAPTURE_POLICY.consent,
      grantedAt: "2026-07-10T00:00:00.000Z"
    },
    scope: {
      ...DEFAULT_CAPTURE_POLICY.scope,
      tabId: 7,
      origin: "https://app.example",
      ...overrides
    }
  };
}

describe("capture-scope", () => {
  it("binds tab and origin without weakening origin-change or frame policy", () => {
    const base = policy({
      tabId: 0,
      origin: "",
      stopOnOriginChange: true,
      includeSubframes: false,
      allowedOrigins: ["https://app.example"],
      deniedOrigins: ["https://blocked.example"],
      excludedUrlPatterns: ["*/private/*"]
    });
    const bound = bindCapturePolicyToSession(base, {
      tabId: 19,
      origin: "https://app.example"
    });

    expect(bound.scope).toEqual({
      ...base.scope,
      tabId: 19,
      origin: "https://app.example"
    });
    expect(bound.scope.allowedOrigins).not.toBe(base.scope.allowedOrigins);
    expect(bound.scope.deniedOrigins).not.toBe(base.scope.deniedOrigins);
    expect(bound.scope.excludedUrlPatterns).not.toBe(base.scope.excludedUrlPatterns);
  });

  it("allows top-frame capture only in the bound tab and origin", () => {
    expect(
      evaluateCaptureDocumentScope(policy(), {
        url: "https://app.example/dashboard",
        tabId: 7,
        frameId: 0,
        now: NOW
      }).allowed
    ).toBe(true);
    expect(
      evaluateCaptureDocumentScope(policy(), {
        url: "https://app.example/dashboard",
        tabId: 8,
        frameId: 0,
        now: NOW
      }).reason
    ).toBe("tab-mismatch");
  });

  it("honors allow, deny, and URL exclusion on navigation", () => {
    const capturePolicy = policy({
      stopOnOriginChange: false,
      allowedOrigins: ["*.example"],
      deniedOrigins: ["https://blocked.example"],
      excludedUrlPatterns: ["*/private/*"]
    });

    expect(
      evaluateCaptureDocumentScope(capturePolicy, {
        url: "https://admin.example/home",
        tabId: 7,
        now: NOW
      }).allowed
    ).toBe(true);
    expect(
      evaluateCaptureDocumentScope(capturePolicy, {
        url: "https://blocked.example/home",
        tabId: 7,
        now: NOW
      }).reason
    ).toBe("origin-denied");
    expect(
      evaluateCaptureDocumentScope(capturePolicy, {
        url: "https://admin.example/private/key",
        tabId: 7,
        now: NOW
      }).reason
    ).toBe("url-excluded");
  });

  it("rejects child and opaque frame senders by default", () => {
    expect(
      evaluateCaptureDocumentScope(policy(), {
        url: "https://app.example/frame",
        tabId: 7,
        frameId: 3,
        now: NOW
      }).reason
    ).toBe("subframes-disabled");
    expect(
      evaluateCaptureDocumentScope(policy({ includeSubframes: true }), {
        url: "about:blank",
        tabId: 7,
        frameId: 3,
        now: NOW
      }).reason
    ).toBe("opaque-or-invalid-url");
  });

  it("allows an explicitly scoped child frame", () => {
    expect(
      evaluateCaptureDocumentScope(
        policy({
          includeSubframes: true,
          allowedOrigins: ["https://widgets.example"]
        }),
        {
          url: "https://widgets.example/embed",
          tabId: 7,
          frameId: 3,
          now: NOW
        }
      ).allowed
    ).toBe(true);
  });

  it("drops marked child content and CDP events as a second-line defense", () => {
    expect(
      isCaptureEventFrameAllowed(policy(), {
        source: "content",
        frame: "content-frame-3"
      })
    ).toBe(false);
    expect(
      isCaptureEventFrameAllowed(policy(), {
        source: "cdp",
        cdpSessionId: "child-session"
      })
    ).toBe(false);
    expect(
      isCaptureEventFrameAllowed(policy({ includeSubframes: true }), {
        source: "cdp",
        cdpSessionId: "child-session"
      })
    ).toBe(true);
  });

  it("injects only the top frame unless subframes are explicitly enabled", () => {
    expect(resolveContentScriptInjectionTarget(policy(), 7)).toEqual({
      tabId: 7,
      allFrames: false
    });
    expect(resolveContentScriptInjectionTarget(policy({ includeSubframes: true }), 7)).toEqual({
      tabId: 7,
      allFrames: true
    });
    expect(resolveContentScriptInjectionTarget(undefined, 7).allFrames).toBe(false);
  });

  it("fails closed for opaque enterprise navigations", () => {
    expect(
      shouldStopForEnterpriseOriginPolicy({
        nextOrigin: null,
        isEnterpriseOriginAllowed: () => true
      })
    ).toBe(true);
  });
});
