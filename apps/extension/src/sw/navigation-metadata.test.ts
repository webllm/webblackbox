import { describe, expect, it } from "vitest";

import {
  advanceCdpRestoreEpoch,
  cancelExactWebNavigationCommitObservation,
  canUseExactLiteTopDocumentAuthorization,
  captureCdpTopNavigationRestoreContract,
  classifyActiveCommittedDocument,
  createExactTopNavigationObservationState,
  isCdpRestoreEpochCurrent,
  observeExactCdpTopNavigation,
  observeExactWebNavigationCommit,
  resolveCurrentTabUrlPolicyDecision,
  resolveCdpRestorePredecessor,
  resolveCdpTopNavigationOwnership,
  resolveExactInitialContentParent,
  shouldContentSenderClaimCaptureUrl,
  shouldUpdateSessionMetadataFromNavigation
} from "./navigation-metadata.js";

describe("navigation-metadata", () => {
  it("uses exact webNavigation commits in store-safe Lite without webRequest", () => {
    expect(
      canUseExactLiteTopDocumentAuthorization({
        mode: "lite",
        permissions: ["activeTab", "scripting", "webNavigation"],
        hasWebNavigationApi: true,
        hasSameDocumentNavigationApi: true,
        hasScriptingApi: true
      })
    ).toBe(true);
  });

  it("fails closed without the declared webNavigation capability", () => {
    expect(
      canUseExactLiteTopDocumentAuthorization({
        mode: "lite",
        permissions: ["activeTab", "scripting"],
        hasWebNavigationApi: true,
        hasSameDocumentNavigationApi: true,
        hasScriptingApi: true
      })
    ).toBe(false);
  });

  it("fails closed without same-document navigation callbacks", () => {
    expect(
      canUseExactLiteTopDocumentAuthorization({
        mode: "lite",
        permissions: ["activeTab", "scripting", "webNavigation"],
        hasWebNavigationApi: true,
        hasSameDocumentNavigationApi: false,
        hasScriptingApi: true
      })
    ).toBe(false);
  });

  it("classifies only active outermost and subframe commits", () => {
    expect(
      classifyActiveCommittedDocument({
        frameId: 0,
        documentLifecycle: "active",
        frameType: "outermost_frame"
      })
    ).toBe("top");
    expect(
      classifyActiveCommittedDocument({
        frameId: 3,
        documentLifecycle: "active",
        frameType: "sub_frame"
      })
    ).toBe("child");
  });

  it("rejects prerender, fenced, cached, and incomplete commit identities", () => {
    expect(
      classifyActiveCommittedDocument({
        frameId: 8,
        documentLifecycle: "prerender",
        frameType: "outermost_frame"
      })
    ).toBeNull();
    expect(
      classifyActiveCommittedDocument({
        frameId: 9,
        documentLifecycle: "active",
        frameType: "fenced_frame"
      })
    ).toBeNull();
    expect(
      classifyActiveCommittedDocument({
        frameId: 0,
        documentLifecycle: "cached",
        frameType: "outermost_frame"
      })
    ).toBeNull();
    expect(classifyActiveCommittedDocument({ frameId: 0 })).toBeNull();
  });

  it("leaves exact Full cross-document CDP navigation and restore to webNavigation", () => {
    expect(
      resolveCdpTopNavigationOwnership({
        navigationKind: "cross-document",
        usesExactWebNavigationDocumentOwnership: true,
        childMutationRevision: 7,
        restoreEpoch: 4
      })
    ).toEqual({
      urlOwner: "web-navigation",
      restore: null
    });
  });

  it("keeps same-document CDP navigation authoritative in exact mode", () => {
    expect(
      resolveCdpTopNavigationOwnership({
        navigationKind: "same-document",
        usesExactWebNavigationDocumentOwnership: true,
        childMutationRevision: 11,
        restoreEpoch: 5
      })
    ).toEqual({
      urlOwner: "cdp",
      restore: {
        expectedChildMutationRevision: 11,
        expectedRestoreEpoch: 5
      }
    });
  });

  it("lets fallback cross-document CDP navigation own URL adoption and restore", () => {
    expect(
      resolveCdpTopNavigationOwnership({
        navigationKind: "cross-document",
        usesExactWebNavigationDocumentOwnership: false,
        childMutationRevision: 3,
        restoreEpoch: 6
      })
    ).toEqual({
      urlOwner: "cdp",
      restore: {
        expectedChildMutationRevision: 3,
        expectedRestoreEpoch: 6
      }
    });
  });

  it("captures the child mutation revision before a queued top CDP restore", () => {
    const scope = { childMutationRevision: 19, restoreEpoch: 8 };
    const restore = captureCdpTopNavigationRestoreContract(scope);

    scope.childMutationRevision += 1;

    expect(restore).toEqual({
      expectedChildMutationRevision: 19,
      expectedRestoreEpoch: 8
    });
    expect(Object.isFrozen(restore)).toBe(true);
  });

  it("invalidates an old restore for a same-URL cross-document replacement", () => {
    const runtime = { cdpRestoreEpoch: 12 };
    const oldRestore = captureCdpTopNavigationRestoreContract({
      childMutationRevision: 3,
      restoreEpoch: runtime.cdpRestoreEpoch
    });

    expect(isCdpRestoreEpochCurrent(runtime, oldRestore.expectedRestoreEpoch)).toBe(true);
    expect(advanceCdpRestoreEpoch(runtime)).toBe(13);
    expect(isCdpRestoreEpochCurrent(runtime, oldRestore.expectedRestoreEpoch)).toBe(false);

    const replacementRestore = captureCdpTopNavigationRestoreContract({
      childMutationRevision: 3,
      restoreEpoch: runtime.cdpRestoreEpoch
    });
    expect(isCdpRestoreEpochCurrent(runtime, replacementRestore.expectedRestoreEpoch)).toBe(true);
  });

  it("rejects invalid or exhausted CDP restore epochs", () => {
    expect(() => advanceCdpRestoreEpoch({ cdpRestoreEpoch: -1 })).toThrow(
      "CDP restore epoch is invalid or exhausted."
    );
    expect(() => advanceCdpRestoreEpoch({ cdpRestoreEpoch: Number.MAX_SAFE_INTEGER })).toThrow(
      "CDP restore epoch is invalid or exhausted."
    );
  });

  it("does not queue a replacement restore behind a hung prior epoch", async () => {
    const hung = new Promise<void>(() => undefined);

    expect(
      resolveCdpRestorePredecessor({
        tail: hung,
        tailEpoch: 20,
        expectedRestoreEpoch: 20
      })
    ).toBe(hung);
    await expect(
      resolveCdpRestorePredecessor({
        tail: hung,
        tailEpoch: 20,
        expectedRestoreEpoch: 21
      })
    ).resolves.toBeUndefined();
  });

  it("shares one restore epoch when CDP observes a cross-document commit first", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 40;
    const allocate = () => (restoreEpoch += 1);

    const cdp = observeExactCdpTopNavigation(state, "https://app.example/b", allocate);
    const web = observeExactWebNavigationCommit(state, "https://app.example/b", allocate);

    expect(cdp).toMatchObject({ restoreEpoch: 41 });
    expect(web).toMatchObject({ restoreEpoch: 41, cdpObserved: true });
    expect(restoreEpoch).toBe(41);
    expect(state.pendingCdp).toEqual([]);
    expect(state.pendingWeb).toEqual([]);
  });

  it("matches canonically equivalent final URLs across Chrome event surfaces", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 50;
    const allocate = () => (restoreEpoch += 1);

    const cdp = observeExactCdpTopNavigation(state, "https://app.example", allocate);
    const web = observeExactWebNavigationCommit(state, "https://app.example/", allocate);

    expect(cdp.kind).toBe("current");
    if (cdp.kind !== "current") throw new Error("Expected a current CDP observation.");
    expect(web).toMatchObject({ restoreEpoch: cdp.restoreEpoch, cdpObserved: true });
    expect(restoreEpoch).toBe(51);
  });

  it("moves a web-first commit to a fresh epoch when its CDP observation arrives", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 7;
    const allocate = () => (restoreEpoch += 1);

    const web = observeExactWebNavigationCommit(state, "https://app.example/b", allocate);
    const cdp = observeExactCdpTopNavigation(state, "https://app.example/b", allocate);

    expect(cdp.kind).toBe("current");
    if (cdp.kind !== "current") throw new Error("Expected a current CDP observation.");
    expect(web).toMatchObject({ restoreEpoch: 8, cdpObserved: false });
    expect(cdp).toMatchObject({
      restoreEpoch: 9,
      matchedWebToken: web.token
    });
    expect(restoreEpoch).toBe(9);
    expect(isCdpRestoreEpochCurrent({ cdpRestoreEpoch: restoreEpoch }, web.restoreEpoch)).toBe(
      false
    );
    expect(isCdpRestoreEpochCurrent({ cdpRestoreEpoch: restoreEpoch }, cdp.restoreEpoch)).toBe(
      true
    );
    expect(state.pendingWeb).toEqual([]);
  });

  it("ignores a delayed superseded web match without advancing the current epoch", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 70;
    const allocate = () => (restoreEpoch += 1);
    const webB = observeExactWebNavigationCommit(state, "https://app.example/b", allocate);
    const webC = observeExactWebNavigationCommit(state, "https://app.example/c", allocate);

    const delayedB = observeExactCdpTopNavigation(
      state,
      "https://app.example/b",
      allocate,
      (token, epoch) => token === webC.token && epoch === webC.restoreEpoch
    );

    expect(delayedB).toEqual({
      kind: "ignored-stale",
      ignoredWebToken: webB.token,
      evictedWebTokens: []
    });
    expect(restoreEpoch).toBe(webC.restoreEpoch);

    const currentC = observeExactCdpTopNavigation(
      state,
      "https://app.example/c",
      allocate,
      (token, epoch) => token === webC.token && epoch === webC.restoreEpoch
    );
    expect(currentC).toMatchObject({
      kind: "current",
      matchedWebToken: webC.token,
      restoreEpoch: webC.restoreEpoch + 1
    });
  });

  it("consumes an evicted web observation without mutating the restore epoch", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 100;
    const allocate = () => (restoreEpoch += 1);

    for (let index = 0; index < 17; index += 1) {
      observeExactWebNavigationCommit(state, `https://app.example/navigation-${index}`, allocate);
    }
    const beforeDelayedCdp = restoreEpoch;

    expect(
      observeExactCdpTopNavigation(state, "https://app.example/navigation-0", allocate, () => false)
    ).toEqual({ kind: "ignored-stale", evictedWebTokens: [] });
    expect(restoreEpoch).toBe(beforeDelayedCdp);
    expect(state.pendingCdp).toEqual([]);
  });

  it("gives C a new epoch instead of adopting delayed B when URLs differ", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 2;
    const allocate = () => (restoreEpoch += 1);

    const webB = observeExactWebNavigationCommit(state, "https://app.example/b", allocate);
    const cdpC = observeExactCdpTopNavigation(state, "https://app.example/c", allocate);

    expect(cdpC.kind).toBe("current");
    if (cdpC.kind !== "current") throw new Error("Expected a current CDP observation.");
    expect(webB.restoreEpoch).toBe(3);
    expect(cdpC).toMatchObject({ restoreEpoch: 4 });
    expect(cdpC.matchedWebToken).toBeUndefined();
    expect(state.pendingWeb).toHaveLength(1);
    expect(state.pendingCdp).toHaveLength(1);
    expect(isCdpRestoreEpochCurrent({ cdpRestoreEpoch: restoreEpoch }, webB.restoreEpoch)).toBe(
      false
    );
  });

  it("keeps same-URL replacements FIFO and supports explicit cancellation", () => {
    const state = createExactTopNavigationObservationState();
    let restoreEpoch = 10;
    const allocate = () => (restoreEpoch += 1);
    const first = observeExactWebNavigationCommit(state, "https://app.example/same", allocate);
    const second = observeExactWebNavigationCommit(state, "https://app.example/same", allocate);

    const matched = observeExactCdpTopNavigation(state, "https://app.example/same", allocate);
    expect(matched.kind).toBe("current");
    expect(matched.kind === "current" ? matched.matchedWebToken : undefined).toBe(first.token);
    cancelExactWebNavigationCommitObservation(state, second.token);
    expect(state.pendingWeb).toEqual([]);
  });

  it("prevents exact top content senders from claiming capture URL ownership", () => {
    expect(
      shouldContentSenderClaimCaptureUrl({
        frameId: 0,
        senderUrl: "https://example.test/next",
        currentCaptureUrl: "https://example.test/current",
        usesExactTopDocumentAuthorization: true
      })
    ).toBe(false);
  });

  it("allows only changed fallback top content URLs to claim ownership", () => {
    expect(
      shouldContentSenderClaimCaptureUrl({
        frameId: 0,
        senderUrl: "https://example.test/next",
        currentCaptureUrl: "https://example.test/current",
        usesExactTopDocumentAuthorization: false
      })
    ).toBe(true);
    expect(
      shouldContentSenderClaimCaptureUrl({
        frameId: 4,
        senderUrl: "https://frame.example.test/next",
        currentCaptureUrl: "https://example.test/current",
        usesExactTopDocumentAuthorization: false
      })
    ).toBe(false);
    expect(
      shouldContentSenderClaimCaptureUrl({
        frameId: 0,
        senderUrl: "https://example.test/current",
        currentCaptureUrl: "https://example.test/current",
        usesExactTopDocumentAuthorization: false
      })
    ).toBe(false);
  });

  it("requires exact child and parent document identities for initial ancestry", () => {
    const exact = {
      frameId: 4,
      parentFrameId: 0,
      documentId: "child-document",
      parentDocumentId: "root-document",
      injectedDocumentId: "child-document",
      injectedParentDocumentId: "root-document"
    };

    expect(resolveExactInitialContentParent(exact)).toEqual({
      frameId: 0,
      documentId: "root-document"
    });
    expect(resolveExactInitialContentParent({ ...exact, documentId: undefined })).toBeNull();
    expect(resolveExactInitialContentParent({ ...exact, parentDocumentId: undefined })).toBeNull();
    expect(
      resolveExactInitialContentParent({ ...exact, injectedDocumentId: "replacement-child" })
    ).toBeNull();
    expect(
      resolveExactInitialContentParent({
        ...exact,
        injectedParentDocumentId: "replacement-root"
      })
    ).toBeNull();
  });

  it("keeps a current same-document denied URL fail closed", async () => {
    await expect(
      resolveCurrentTabUrlPolicyDecision({
        candidateUrl: "https://denied.example/next",
        evaluateAllowed: () => false,
        resolveCurrentUrl: () => "https://denied.example/next"
      })
    ).resolves.toBe("denied");
  });

  it("ignores a late B policy result after the tab advances to C", async () => {
    const policy = deferred<boolean>();
    const decision = resolveCurrentTabUrlPolicyDecision({
      candidateUrl: "https://app.example/b",
      evaluateAllowed: () => policy.promise,
      resolveCurrentUrl: () => "https://app.example/c"
    });

    policy.resolve(false);
    await expect(decision).resolves.toBe("stale");
  });

  it("accepts root target main-frame navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {},
        {
          frame: {
            id: "root",
            url: "https://example.com/dashboard"
          }
        }
      )
    ).toBe(true);
  });

  it("ignores same-target child frame navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {},
        {
          frame: {
            id: "child",
            parentId: "root",
            url: "about:srcdoc"
          }
        }
      )
    ).toBe(false);
  });

  it("ignores child CDP target navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {
          cdp: "child-session"
        },
        {
          frame: {
            id: "child-root",
            url: "https://third-party.example/frame"
          }
        }
      )
    ).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
