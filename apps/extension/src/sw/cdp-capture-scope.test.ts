import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  filterCdpSnapshotDocuments,
  hasDisallowedCdpFrames,
  isCdpSessionWithinScope,
  primeCdpCaptureFrameTree
} from "./cdp-capture-scope.js";

function policy(overrides: Partial<CapturePolicy["scope"]> = {}): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    consent: {
      ...DEFAULT_CAPTURE_POLICY.consent,
      grantedAt: "2020-01-01T00:00:00.000Z"
    },
    scope: {
      ...DEFAULT_CAPTURE_POLICY.scope,
      tabId: 7,
      origin: "https://app.example",
      ...overrides
    }
  };
}

function state(capturePolicy: CapturePolicy = policy()) {
  return createCdpCaptureScopeState(capturePolicy, 7, "https://app.example/home");
}

describe("CDP capture scope", () => {
  it("primes root and child frames with independent scope decisions", () => {
    const scope = state();

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [
        {
          frame: { id: "child", url: "https://widgets.example/embed" }
        }
      ]
    });

    expect(scope.rootFrameId).toBe("root");
    expect(scope.frameScopes.get("root")).toBe(true);
    expect(scope.frameScopes.get("child")).toBe(false);
    expect(hasDisallowedCdpFrames(scope)).toBe(true);
  });

  it("allows only explicitly scoped child frames", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
        frame: {
          id: "child-ok",
          parentId: "root",
          url: "https://widgets.example/embed"
        }
      }).allowed
    ).toBe(true);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
        frame: {
          id: "child-denied",
          parentId: "root",
          url: "https://blocked.example/embed"
        }
      }).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
        frame: { id: "child-opaque", parentId: "root", url: "about:blank" }
      }).allowed
    ).toBe(false);
  });

  it("stops a disallowed top-level navigation and accepts an allowed one", () => {
    const stoppingScope = state();
    const stopped = evaluateCdpCaptureScopeEvent(stoppingScope, "Page.frameNavigated", {
      frame: { id: "root", url: "https://admin.example/home" }
    });

    expect(stopped.allowed).toBe(false);
    expect(stopped.topNavigation?.decision.reason).toBe("origin-changed");

    const continuingScope = state(
      policy({
        stopOnOriginChange: false,
        allowedOrigins: ["https://app.example", "https://admin.example"]
      })
    );
    const continued = evaluateCdpCaptureScopeEvent(continuingScope, "Page.frameNavigated", {
      frame: { id: "root", url: "https://admin.example/home" }
    });

    expect(continued.allowed).toBe(true);
    expect(continuingScope.captureUrl).toBe("https://admin.example/home");
  });

  it("binds child target sessions to their target URL", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
        sessionId: "allowed-session",
        targetInfo: { url: "https://widgets.example/worker.js" }
      }).allowed
    ).toBe(true);
    expect(isCdpSessionWithinScope(scope, "allowed-session")).toBe(true);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
        sessionId: "opaque-session",
        targetInfo: { url: "" }
      }).allowed
    ).toBe(false);
  });

  it("carries a frame decision through the network request lifecycle", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
    });

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Network.requestWillBeSent", {
        requestId: "R-child",
        frameId: "child",
        documentURL: "https://widgets.example/embed"
      }).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Network.responseReceived", {
        requestId: "R-child"
      }).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Network.loadingFailed", {
        requestId: "R-child"
      }).allowed
    ).toBe(false);
    expect(scope.requestScopes.has("R-child")).toBe(false);

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Network.requestWillBeSent", {
        requestId: "R-root",
        frameId: "root",
        documentURL: "https://app.example/home"
      }).allowed
    ).toBe(true);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Network.loadingFinished", {
        requestId: "R-root"
      }).allowed
    ).toBe(true);
  });

  it("carries frame scope through Runtime execution contexts", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://app.example/embed" } }]
    });

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Runtime.executionContextCreated", {
        context: { id: 11, origin: "https://app.example", auxData: { frameId: "child" } }
      }).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Runtime.consoleAPICalled", {
        executionContextId: 11
      }).allowed
    ).toBe(false);
  });

  it("filters DOM snapshot documents to allowed frame IDs", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://app.example/embed" } }]
    });

    expect(
      filterCdpSnapshotDocuments(scope, [
        { frameId: "root", marker: "keep" },
        { frameId: "child", marker: "drop" },
        { marker: "ambiguous" }
      ])
    ).toEqual([{ frameId: "root", marker: "keep" }]);
  });

  it("drops unbound Network, Runtime, and Log events", () => {
    const scope = state();

    expect(evaluateCdpCaptureScopeEvent(scope, "Network.loadingFinished", {}).allowed).toBe(false);
    expect(evaluateCdpCaptureScopeEvent(scope, "Runtime.consoleAPICalled", {}).allowed).toBe(false);
    expect(evaluateCdpCaptureScopeEvent(scope, "Log.entryAdded", {}).allowed).toBe(false);
  });
});
