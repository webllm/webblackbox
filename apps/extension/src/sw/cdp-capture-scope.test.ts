import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  canCaptureGlobalCdpArtifacts,
  canCaptureGlobalCdpArtifactsForRoot,
  completeCdpChildFrameTreePrime,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  failCdpChildSessionAttachment,
  filterCdpSnapshotDocuments,
  hasDisallowedCdpFrames,
  isCdpChildSessionClaimCurrent,
  invalidateCdpCaptureFrameTree,
  isCdpCaptureFrameTreePrimedForRoot,
  isCdpSessionWithinScope,
  markCdpChildSessionBaselineReady,
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

  it("rejects a root prime that resolves after a new visual child attaches", async () => {
    const scope = state(policy({ includeSubframes: true }));
    let resolveFrameTree: ((value: unknown) => void) | undefined;
    const pending = refreshCdpCaptureFrameTree(
      scope,
      () =>
        new Promise((resolve) => {
          resolveFrameTree = resolve;
        })
    );
    const primeGeneration = scope.generation;
    const childRevision = scope.childMutationRevision;

    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "late-child",
      targetInfo: { type: "iframe", url: "https://app.example/embed" }
    });
    resolveFrameTree?.({ frame: { id: "root", url: "https://app.example/home" } });

    await expect(pending).resolves.toBe(false);
    expect(scope.generation).toBeGreaterThan(primeGeneration);
    expect(scope.childMutationRevision).toBeGreaterThan(childRevision);
    expect(scope.childSessions.get("late-child")?.status).toBe("pending");
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
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

  it("accepts a frame-tree root that omits the authoritative SPA fragment", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    evaluateCdpCaptureScopeEvent(scope, "Page.navigatedWithinDocument", {
      frameId: "root",
      url: "https://app.example/home#/checkout?step=payment"
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    expect(
      canCaptureGlobalCdpArtifactsForRoot(
        scope,
        "https://app.example/home#/checkout?step=payment",
        scope.generation
      )
    ).toBe(true);
  });

  it("rejects a conflicting non-empty SPA fragment during root validation", () => {
    const scope = state();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home#/settings" }
    });

    expect(
      canCaptureGlobalCdpArtifactsForRoot(
        scope,
        "https://app.example/home#/checkout",
        scope.generation
      )
    ).toBe(false);
  });

  it("keeps root validity separate from a child that blocks global artifacts", () => {
    const scope = state(policy({ includeSubframes: false }));

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
    });

    expect(
      isCdpCaptureFrameTreePrimedForRoot(scope, "https://app.example/home", scope.generation)
    ).toBe(true);
    expect(
      canCaptureGlobalCdpArtifactsForRoot(scope, "https://app.example/home", scope.generation)
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
    expect(scope.childSessions.get("oopif-session")?.status).toBe("pending");
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
    expect(
      isCdpCaptureFrameTreePrimedForRoot(scope, "https://app.example/home", scope.generation)
    ).toBe(true);

    const navigated = evaluateCdpCaptureScopeEvent(
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
    expect(navigated.childSessionClaim).toBeDefined();
    expect(scope.childSessions.get("oopif-session")?.status).toBe("pending");
    expect(markCdpChildSessionBaselineReady(scope, attached.childSessionClaim!)).toBe(true);
    expect(
      completeCdpChildFrameTreePrime(scope, navigated.childSessionClaim!, {
        frame: { id: "oopif-frame", url: "https://blocked.example/embed" }
      })
    ).toBe("denied");
    expect(scope.childSessions.get("oopif-session")?.status).toBe("denied");
    expect(scope.childSessions.get("oopif-session")?.frameScopes.get("oopif-frame")).toBe(false);
    expect(scope.frameScopes.has("oopif-frame")).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: "oopif-session"
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(scope.childSessions.has("oopif-session")).toBe(false);
    expect(scope.frameScopes.has("oopif-frame")).toBe(false);
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

    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "oopif-session",
      targetInfo: { type: "iframe", url: "" }
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    const navigated = evaluateCdpCaptureScopeEvent(
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
    expect(markCdpChildSessionBaselineReady(scope, attached.childSessionClaim!)).toBe(true);
    expect(
      completeCdpChildFrameTreePrime(scope, navigated.childSessionClaim!, {
        frame: { id: "oopif-frame", url: "https://widgets.example/embed" }
      })
    ).toBe("ready");
    expect(scope.childSessions.get("oopif-session")?.status).toBe("ready");
    expect(scope.primed).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "oopif-frame", url: "https://widgets.example/embed" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
  });

  it("invalidates an older root prime when a visual child becomes ready", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );
    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "oopif-session",
      targetInfo: {
        targetId: "oopif-frame",
        type: "iframe",
        url: "https://widgets.example/embed"
      }
    });

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "oopif-frame", url: "https://widgets.example/embed" } }]
    });
    expect(scope.primed).toBe(true);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    expect(markCdpChildSessionBaselineReady(scope, attached.childSessionClaim!)).toBe(true);
    expect(
      completeCdpChildFrameTreePrime(scope, attached.childSessionClaim!, {
        frame: { id: "oopif-frame", url: "https://widgets.example/embed" }
      })
    ).toBe("ready");
    expect(scope.primed).toBe(false);
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "oopif-frame", url: "https://widgets.example/embed" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
  });

  it("does not let a page event wash a failed visual child back to readiness", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );
    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "failed-child",
      targetInfo: { type: "iframe", url: "https://widgets.example/embed" }
    });

    expect(failCdpChildSessionAttachment(scope, attached.childSessionClaim!)).toBe(true);
    const navigated = evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "failed-frame",
          parentId: "root",
          url: "https://widgets.example/next"
        }
      },
      "failed-child"
    );

    expect(scope.childSessions.get("failed-child")?.status).toBe("failed");
    expect(navigated.childSessionClaim).toBeDefined();
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "failed-frame", url: "https://widgets.example/next" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
  });

  it("rejects stale navigation primes and lets a denied child recover through a new prime", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "moving-child",
      targetInfo: { type: "iframe", url: "https://blocked.example/embed" }
    });
    expect(markCdpChildSessionBaselineReady(scope, attached.childSessionClaim!)).toBe(true);
    expect(
      completeCdpChildFrameTreePrime(scope, attached.childSessionClaim!, {
        frame: { id: "moving-frame", url: "https://blocked.example/embed" }
      })
    ).toBe("denied");

    const allowedNavigation = evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "moving-frame",
          parentId: "root",
          url: "https://widgets.example/embed"
        }
      },
      "moving-child"
    );

    expect(isCdpChildSessionClaimCurrent(scope, attached.childSessionClaim!)).toBe(false);
    expect(
      completeCdpChildFrameTreePrime(scope, attached.childSessionClaim!, {
        frame: { id: "moving-frame", url: "https://blocked.example/stale" }
      })
    ).toBe("stale");
    expect(
      completeCdpChildFrameTreePrime(scope, allowedNavigation.childSessionClaim!, {
        frame: { id: "moving-frame", url: "https://widgets.example/embed" }
      })
    ).toBe("ready");
  });

  it("does not let a detached child claim mutate a reused session id", () => {
    const scope = state(policy({ includeSubframes: true }));
    const first = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: { targetId: "target-a", type: "iframe", url: "https://app.example/a" }
    });
    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", { sessionId: "reused" });
    const replacement = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: { targetId: "target-b", type: "iframe", url: "https://app.example/b" }
    });

    expect(markCdpChildSessionBaselineReady(scope, first.childSessionClaim!)).toBe(false);
    expect(failCdpChildSessionAttachment(scope, first.childSessionClaim!)).toBe(false);
    expect(scope.childSessions.get("reused")?.token).toBe(replacement.childSessionClaim?.token);
    expect(scope.childSessions.get("reused")?.status).toBe("pending");

    const replacementRevision = scope.childSessions.get("reused")?.navigationRevision;
    const stalePageEvent = evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "target-a",
          parentId: "root",
          url: "https://app.example/stale-a"
        }
      },
      "reused"
    );
    expect(stalePageEvent.allowed).toBe(false);
    expect(stalePageEvent.globalFrameTreeMutation).toBeUndefined();
    expect(scope.childSessions.get("reused")?.navigationRevision).toBe(replacementRevision);
    expect(scope.childSessions.get("reused")?.targetId).toBe("target-b");

    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: "reused",
      targetId: "target-a"
    });
    expect(scope.childSessions.get("reused")?.targetId).toBe("target-b");
  });

  it("retains root re-prime ownership when a visual session id becomes nonvisual", () => {
    const scope = state(policy({ includeSubframes: true }));
    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: {
        targetId: "visual-frame",
        type: "iframe",
        url: "https://app.example/frame"
      }
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    const replacement = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: {
        targetId: "worker-target",
        type: "worker",
        url: "https://app.example/worker.js"
      }
    });
    expect(replacement.globalFrameTreeMutation).toBe(true);
    expect(scope.childSessions.get("reused")).toMatchObject({
      visual: false,
      rootReprimeRequired: true
    });

    evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "worker-target",
          url: "https://app.example/worker.js"
        }
      },
      "reused"
    );
    expect(scope.childSessions.get("reused")?.rootReprimeRequired).toBe(true);

    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(scope.childSessions.get("reused")?.rootReprimeRequired).toBe(false);
  });

  it("fails closed for an unknown child Page session until its Target detach", () => {
    const scope = state(policy({ includeSubframes: true }));
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    const unknown = evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "unknown-frame",
          parentId: "root",
          url: "https://app.example/allowed-but-unowned"
        }
      },
      "unknown-session"
    );

    expect(unknown.allowed).toBe(false);
    expect(unknown.globalFrameTreeMutation).toBe(true);
    expect(scope.childSessions.get("unknown-session")).toMatchObject({
      visual: true,
      status: "failed",
      sessionAllowed: false
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);

    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: "unknown-session"
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });
    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(true);
  });

  it("marks a visual target without a child session as a fatal scope violation", () => {
    const scope = state(policy({ includeSubframes: true }));
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" }
    });

    const malformed = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      targetInfo: {
        targetId: "unbound-frame",
        type: "iframe",
        url: "https://app.example/embed"
      }
    });

    expect(malformed).toMatchObject({
      allowed: false,
      globalFrameTreeMutation: true,
      fatalScopeViolation: true
    });
    expect(scope.primed).toBe(false);
  });

  it("requires every live visual child to be ready but ignores a failed worker", () => {
    const scope = state(policy({ includeSubframes: true }));
    const readyChild = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "ready",
      targetInfo: { type: "iframe", url: "https://app.example/ready" }
    });
    const pendingChild = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "pending",
      targetInfo: { type: "iframe", url: "https://app.example/pending" }
    });
    const worker = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "worker",
      targetInfo: { type: "worker", url: "https://app.example/worker.js" }
    });
    markCdpChildSessionBaselineReady(scope, readyChild.childSessionClaim!);
    completeCdpChildFrameTreePrime(scope, readyChild.childSessionClaim!, {
      frame: { id: "ready-frame", url: "https://app.example/ready" }
    });
    failCdpChildSessionAttachment(scope, worker.childSessionClaim!);
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "ready-frame", url: "https://app.example/ready" } }]
    });

    expect(canCaptureGlobalCdpArtifacts(scope)).toBe(false);
    expect(scope.childSessions.get("pending")?.status).toBe("pending");
    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: pendingChild.childSessionClaim?.sessionId
    });
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "ready-frame", url: "https://app.example/ready" } }]
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

  it("does not reuse child request scope across attachment or navigation revisions", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"]
      })
    );
    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: {
        targetId: "child-a",
        type: "iframe",
        url: "https://widgets.example/a"
      }
    });
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Network.requestWillBeSent",
        {
          requestId: "request-1",
          frameId: "child-a",
          documentURL: "https://widgets.example/a"
        },
        "reused"
      ).allowed
    ).toBe(true);

    evaluateCdpCaptureScopeEvent(scope, "Target.detachedFromTarget", {
      sessionId: "reused",
      targetId: "child-a"
    });
    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "reused",
      targetInfo: {
        targetId: "child-b",
        type: "iframe",
        url: "https://widgets.example/b"
      }
    });
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Network.responseReceived",
        { requestId: "request-1" },
        "reused"
      ).allowed
    ).toBe(false);

    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Network.requestWillBeSent",
        {
          requestId: "request-2",
          frameId: "child-b",
          documentURL: "https://widgets.example/b"
        },
        "reused"
      ).allowed
    ).toBe(true);
    evaluateCdpCaptureScopeEvent(
      scope,
      "Page.frameNavigated",
      {
        frame: {
          id: "child-b",
          parentId: "root",
          url: "https://widgets.example/b-next"
        }
      },
      "reused"
    );
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Network.responseReceived",
        { requestId: "request-2" },
        "reused"
      ).allowed
    ).toBe(false);
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

  it("isolates Runtime execution contexts by child session and refreshes them from its tree", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    primeCdpCaptureFrameTree(scope, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "root-denied", url: "https://blocked.example/root" } }]
    });
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Runtime.executionContextCreated", {
        context: {
          id: 11,
          origin: "https://blocked.example",
          auxData: { frameId: "root-denied" }
        }
      }).allowed
    ).toBe(false);

    const attached = evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "child-frame",
        type: "iframe",
        url: "https://widgets.example/embed"
      }
    });
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Runtime.executionContextCreated",
        {
          context: {
            id: 11,
            origin: "https://widgets.example",
            auxData: { frameId: "child-frame" }
          }
        },
        "child"
      ).allowed
    ).toBe(true);
    expect(
      evaluateCdpCaptureScopeEvent(scope, "Runtime.consoleAPICalled", {
        executionContextId: 11
      }).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Runtime.consoleAPICalled",
        { executionContextId: 11 },
        "child"
      ).allowed
    ).toBe(true);

    expect(markCdpChildSessionBaselineReady(scope, attached.childSessionClaim!)).toBe(true);
    expect(
      completeCdpChildFrameTreePrime(scope, attached.childSessionClaim!, {
        frame: { id: "child-frame", url: "https://blocked.example/now-denied" }
      })
    ).toBe("denied");
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Runtime.consoleAPICalled",
        { executionContextId: 11 },
        "child"
      ).allowed
    ).toBe(false);
  });

  it("uses a child context origin instead of its allowed target fallback", () => {
    const scope = state(
      policy({
        includeSubframes: true,
        allowedOrigins: ["https://app.example", "https://widgets.example"],
        deniedOrigins: ["https://blocked.example"]
      })
    );
    evaluateCdpCaptureScopeEvent(scope, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "child-frame",
        type: "iframe",
        url: "https://widgets.example/embed"
      }
    });

    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Runtime.executionContextCreated",
        {
          context: {
            id: 12,
            origin: "https://blocked.example",
            auxData: { frameId: "unknown-frame" }
          }
        },
        "child"
      ).allowed
    ).toBe(false);
    expect(
      evaluateCdpCaptureScopeEvent(
        scope,
        "Runtime.consoleAPICalled",
        { executionContextId: 12 },
        "child"
      ).allowed
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
