import { describe, expect, it } from "vitest";

import {
  canUseExactLiteTopDocumentAuthorization,
  classifyActiveCommittedDocument,
  resolveCurrentTabUrlPolicyDecision,
  shouldUpdateSessionMetadataFromNavigation
} from "./navigation-metadata.js";

describe("navigation-metadata", () => {
  it("uses exact webNavigation commits in store-safe Lite without webRequest", () => {
    expect(
      canUseExactLiteTopDocumentAuthorization({
        mode: "lite",
        permissions: ["activeTab", "scripting", "webNavigation"],
        hasWebNavigationApi: true,
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
