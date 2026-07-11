import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  canCaptureGlobalCdpArtifacts,
  canCaptureGlobalCdpArtifactsForRoot,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  filterCdpSnapshotDocuments,
  hasDisallowedCdpFrames,
  invalidateCdpCaptureFrameTree,
  isCdpSessionWithinScope,
  primeCdpCaptureFrameTree,
  refreshCdpCaptureFrameTree
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
  it("starts unprimed and enables global artifacts only after a complete allowed tree", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );

    expect(scope.primed).toBe(false);
    expect(scope.generation).toBe(0);
    expect(scope.rootFrameId).toBeUndefined();
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [
        {
          frame: { id: "child", url: "https://widgets.example/embed" }
        }
      ]
    });

    expect(scope.primed).toBe(true);
    expect(scope.generation).toBe(1);
    expect(scope.rootFrameId).toBe("root");
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
  });

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
    expect(scope.primed).toBe(true);
    expect(scope.frameScopes.get("root")).toBe(true);
    expect(scope.frameScopes.get("child")).toBe(false);
    expect(hasDisallowedCdpFrames(scope)).toBe(true);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
  });

  it("remains unprimed for missing, malformed, duplicate, or denied root trees", () => {
    const malformedTrees: unknown[] = [
      undefined,
      null,
      {},
      { frame: {} },
      { frame: { id: "root" } },
      {
        frame: { id: "root", url: "https://app.example/home" },
        childFrames: {}
      },
      {
        frame: { id: "root", url: "https://app.example/home" },
        childFrames: [{ frame: { id: "root", url: "https://app.example/embed" } }]
      }
    ];

    for (const frameTree of malformedTrees) {
      const scope = state();
      primeCdpCaptureFrameTree(scope, frameTree);

      expect(scope.primed).toBe(false);
      expect(scope.rootFrameId).toBeUndefined();
      expect(scope.frameScopes.size).toBe(0);
      expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
    }

    const deniedScope = state();
    primeCdpCaptureFrameTree(deniedScope, {
      frame: { id: "root", url: "https://admin.example/home" }
    });

    expect(deniedScope.primed).toBe(false);
    expect(deniedScope.rootFrameId).toBe("root");
    expect(deniedScope.frameScopes.get("root")).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(deniedScope)).toBe(false);
  });

  it("invalidates a previous prime when frame-tree refresh fails", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(scope.primed).toBe(true);

    primeCdpCaptureFrameTree(scope, undefined);

    expect(scope.primed).toBe(false);
    expect(scope.rootFrameId).toBe("root");
    expect(scope.frameScopes.size).toBe(0);
  });

  it("fails closed when the frame-tree command rejects", async () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    const previousGeneration = scope.generation;

    await expect(
      refreshCdpCaptureFrameTree(scope, () => Promise.reject(new Error("CDP unavailable")))
    ).resolves.toBe(false);

    expect(scope.generation).toBe(previousGeneration + 1);
    expect(scope.primed).toBe(false);
    expect(scope.rootFrameId).toBe("root");
    expect(scope.frameScopes.size).toBe(0);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
  });

  it("rejects a stale frame-tree response after a newer invalidation", async () => {
    const scope = state();
    let resolveFrameTree: ((value: unknown) => void) | undefined;
    const pending = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveFrameTree = resolve;
        })
    );
    const pendingGeneration = scope.generation;

    invalidateCdpCaptureFrameTree(scope);
    resolveFrameTree?.({ frame: { id: "stale-root", url: "https://app.example/home" } });

    await expect(pending).resolves.toBe(false);
    expect(scope.generation).toBe(pendingGeneration + 1);
    expect(scope.primed).toBe(false);
    expect(scope.rootFrameId).toBeUndefined();
  });

  it("keeps a newer successful prime current when an older refresh resolves last", async () => {
    const scope = state();
    let resolveOlder: ((value: unknown) => void) | undefined;
    let resolveNewer: ((value: unknown) => void) | undefined;
    const older = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        })
    );
    const olderGeneration = scope.generation;
    const newer = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveNewer = resolve;
        })
    );

    resolveNewer?.({ frame: { id: "root-new", url: "https://app.example/new" } });
    await expect(newer).resolves.toBe(true);
    const newerGeneration = scope.generation;
    expect(canCaptureGlobalCdpArtifacts(scope, newerGeneration)).toBe(true);

    resolveOlder?.({ frame: { id: "root-old", url: "https://app.example/old" } });
    await expect(older).resolves.toBe(false);

    expect(scope.rootFrameId).toBe("root-new");
    expect(scope.rootUrl).toBe("https://app.example/new");
    expect(canCaptureGlobalCdpArtifacts(scope, newerGeneration)).toBe(true);
    expect(canCaptureGlobalCdpArtifacts(scope, olderGeneration)).toBe(false);
  });

  it("keeps the root identity so same-document navigation invalidates a pending refresh", async () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    let resolveFrameTree: ((value: unknown) => void) | undefined;
    const pending = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveFrameTree = resolve;
        })
    );
    const pendingGeneration = scope.generation;

    const navigation = evaluateCdpCaptureScopeEvent(scope, "Page.navigatedWithinDocument", {
      frameId: "root",
      url: "https://app.example/home#new"
    });
    resolveFrameTree?.({ frame: { id: "root", url: "https://app.example/home" } });

    expect(navigation.topNavigation?.url).toBe("https://app.example/home#new");
    expect(scope.generation).toBe(pendingGeneration + 1);
    await expect(pending).resolves.toBe(false);
    expect(scope.primed).toBe(false);
  });

  it("does not let a stale refresh overwrite a child navigation decision", async () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
    });
    let resolveFrameTree: ((value: unknown) => void) | undefined;
    const pending = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveFrameTree = resolve;
        })
    );

    evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
      frame: {
        id: "child",
        parentId: "root",
        url: "https://blocked.example/replacement"
      }
    });
    resolveFrameTree?.({
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
    });

    await expect(pending).resolves.toBe(false);
    expect(scope.primed).toBe(false);
    expect(scope.frameScopes.get("child")).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
  });

  it("keeps global capture disabled between a parent change and a denied grandchild event", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [
        {
          frame: { id: "parent", url: "https://widgets.example/parent" },
          childFrames: [{ frame: { id: "grandchild", url: "https://widgets.example/child" } }]
        }
      ]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);

    evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
      frame: {
        id: "parent",
        parentId: "root",
        url: "https://widgets.example/replacement"
      }
    });

    expect(scope.primed).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [
        {
          frame: { id: "parent", url: "https://widgets.example/replacement" },
          childFrames: [{ frame: { id: "grandchild", url: "https://blocked.example/child" } }]
        }
      ]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
  });

  it("binds a global artifact claim to the exact primed generation", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    const claimedGeneration = scope.generation;

    expect(canCaptureGlobalCdpArtifacts(scope, claimedGeneration)).toBe(true);

    invalidateCdpCaptureFrameTree(scope);
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root-next", url: "https://app.example/next" }
    });

    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
    expect(canCaptureGlobalCdpArtifacts(scope, claimedGeneration)).toBe(false);
  });

  it("rejects an otherwise allowed prime whose root URL is stale", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/old" }
    });

    expect(
      canCaptureGlobalCdpArtifactsForRoot(scope, "https://app.example/old", scope.generation)
    ).toBe(true);
    expect(
      canCaptureGlobalCdpArtifactsForRoot(scope, "https://app.example/new", scope.generation)
    ).toBe(false);
  });

  it.each([
    "Page.captureScreenshot",
    "DOMSnapshot.captureSnapshot",
    "Performance.getMetrics",
    "screen recording"
  ])("fails closed for %s before priming and after navigation invalidation", () => {
    const scope = state();

    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    const claimedGeneration = scope.generation;
    expect(canCaptureGlobalCdpArtifacts(scope, claimedGeneration)).toBe(true);

    evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
      frame: { id: "root", url: "https://app.example/next" }
    });

    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope, claimedGeneration)).toBe(false);
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
    primeCdpCaptureFrameTree(stoppingScope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    const stopped = evaluateCdpCaptureScopeEvent(stoppingScope, "Page.frameNavigated", {
      frame: { id: "root", url: "https://admin.example/home" }
    });

    expect(stopped.allowed).toBe(false);
    expect(stoppingScope.primed).toBe(false);
    expect(stopped.topNavigation?.decision.reason).toBe("origin-changed");
    expect(stoppingScope.frameScopes.get("root")).toBe(false);
    expect(hasDisallowedCdpFrames(stoppingScope)).toBe(true);
    expect(
      filterCdpSnapshotDocuments(stoppingScope, [
        { frameId: "root", marker: "must-not-cross-denied-root" }
      ])
    ).toEqual([]);

    const continuingScope = state(
      policy({
        stopOnOriginChange: false,
        allowedOrigins: ["https://app.example", "https://admin.example"]
      })
    );
    primeCdpCaptureFrameTree(continuingScope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    const continued = evaluateCdpCaptureScopeEvent(continuingScope, "Page.frameNavigated", {
      frame: { id: "root", url: "https://admin.example/home" }
    });

    expect(continued.allowed).toBe(true);
    expect(continuingScope.primed).toBe(false);
    expect(continuingScope.captureUrl).toBe("https://admin.example/home");
  });

  it("invalidates same-document top navigation without letting child updates prime state", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );

    expect(
      evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
        frame: {
          id: "child",
          parentId: "root",
          url: "https://widgets.example/embed"
        }
      }).allowed
    ).toBe(true);
    expect(scope.primed).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
    });
    expect(scope.primed).toBe(true);

    const navigated = evaluateCdpCaptureScopeEvent(scope, "Page.navigatedWithinDocument", {
      frameId: "root",
      url: "https://app.example/home#details"
    });

    expect(navigated.allowed).toBe(true);
    expect(navigated.topNavigation?.url).toBe("https://app.example/home#details");
    expect(scope.primed).toBe(false);

    evaluateCdpCaptureScopeEvent(scope, "Page.frameNavigated", {
      frame: {
        id: "child-2",
        parentId: "root",
        url: "https://widgets.example/second"
      }
    });
    expect(scope.primed).toBe(false);
  });

  it("invalidates priming when the root frame detaches", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    expect(scope.primed).toBe(true);
    evaluateCdpCaptureScopeEvent(scope, "Page.frameDetached", { frameId: "root" });

    expect(scope.primed).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
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
        targetInfo: { type: "worker", url: "https://widgets.example/worker.js" }
      }).allowed
    ).toBe(true);
    expect(isCdpSessionWithinScope(scope, "allowed-session")).toBe(true);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
        sessionId: "opaque-session",
        targetInfo: { type: "worker", url: "" }
      }).allowed
    ).toBe(false);
  });

  it("fails closed for an OOPIF before its frame event and while its scope is denied", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "oopif-session",
      targetInfo: { type: "iframe", url: "https://blocked.example/embed" }
    });

    expect(attached.globalFrameTreeMutation).toBe(true);
    expect(scope.pendingGlobalTargetSessions.has("oopif-session")).toBe(true);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "oopif-frame",
          parentId: "root",
          url: "https://blocked.example/embed"
        }
      },
      "oopif-session"
    );
    expect(scope.pendingGlobalTargetSessions.has("oopif-session")).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: "oopif-session"
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
  });

  it("requires an OOPIF frame event and a full-tree prime before restoring global capture", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "oopif-session",
      targetInfo: { type: "iframe", url: "" }
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "oopif-frame",
          parentId: "root",
          url: "https://widgets.example/embed"
        }
      },
      "oopif-session"
    );
    expect(scope.globalTargetScopes.get("oopif-session")).toBe(true);
    expect(scope.primed).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "oopif-frame", url: "https://widgets.example/embed" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
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
