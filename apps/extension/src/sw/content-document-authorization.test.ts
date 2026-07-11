import { describe, expect, it } from "vitest";

import {
  ContentDocumentAuthorization,
  TOP_CONTENT_FRAME_ID,
  type ContentDocumentScopeDecision
} from "./content-document-authorization.js";

const TAB_ID = 7;
const TOP_URL = "https://app.example/dashboard";

describe("ContentDocumentAuthorization", () => {
  it("requires an exact top document sender after bootstrap", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });

    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: TOP_CONTENT_FRAME_ID,
        url: TOP_URL
      })
    ).toBeNull();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: TOP_CONTENT_FRAME_ID,
        documentId: "top-document",
        url: "https://other.example/"
      })
    ).toBeNull();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: TOP_CONTENT_FRAME_ID,
        documentId: "top-document",
        url: TOP_URL
      })
    ).toEqual({
      frameId: TOP_CONTENT_FRAME_ID,
      documentId: "top-document",
      url: TOP_URL
    });
  });

  it("updates the same top document URL without invalidating child documents", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: TOP_URL
    });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 3,
      documentId: "child-document",
      url: "https://widgets.example/embed"
    });

    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document",
        url: "https://app.example/next"
      })
    ).toMatchObject({ url: "https://app.example/next" });
    expect(authorization.get(3)?.documentId).toBe("child-document");
  });

  it("lets store-safe top B prove navigation before tabs policy resolution", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });

    expect(
      authorization.authorizeTopSender(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-b",
          url: "https://app.example/b"
        },
        {
          allowNavigationFallback: true,
          currentCaptureUrl: "https://app.example/a"
        }
      )
    ).toMatchObject({ documentId: "top-document-b" });
  });

  it("does not let exact-navigation mode reset pending B for stale A", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    expect(
      authorization.authorizeTopSender(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-a",
          url: "https://app.example/a"
        },
        {
          allowNavigationFallback: false,
          currentCaptureUrl: "https://app.example/b"
        }
      )
    ).toBeNull();
    expect(authorization.getPending(0)?.documentId).toBe("top-document-b");
  });

  it("snapshots exact active document identities for targeted deactivation", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 4,
      documentId: "child-document",
      url: "https://widgets.example/embed"
    });

    const documents = authorization.activeDocuments();
    documents[0] = { ...documents[0]!, documentId: "mutated-copy" };

    expect(authorization.activeDocuments()).toEqual([
      {
        frameId: 4,
        documentId: "child-document",
        url: "https://widgets.example/embed"
      }
    ]);
  });

  it("binds child sender matching to documentId and URL", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 4,
      documentId: "child-document",
      url: "https://widgets.example/embed"
    });

    expect(
      authorization.matchesSender({
        tabId: TAB_ID,
        frameId: 4,
        documentId: "child-document",
        url: "https://widgets.example/embed"
      })
    ).toBe(true);
    expect(
      authorization.matchesSender({
        tabId: TAB_ID,
        frameId: 4,
        documentId: "child-document",
        url: "https://widgets.example/replaced"
      })
    ).toBe(false);
    expect(authorization.matchesSender({ tabId: TAB_ID, frameId: 4 })).toBe(false);
  });

  it("requires webRequest events to match the exact active document", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 2,
      documentId: "child-document",
      url: "https://widgets.example/embed"
    });

    expect(
      authorization.matchesWebRequest({
        tabId: TAB_ID,
        frameId: 2,
        documentId: "child-document"
      })
    ).toBe(true);
    expect(authorization.matchesWebRequest({ tabId: TAB_ID, frameId: 2 })).toBe(false);
    expect(
      authorization.matchesWebRequest({
        tabId: TAB_ID,
        frameId: 2,
        documentId: "old-document"
      })
    ).toBe(false);
  });

  it("conditionally revokes so an old port cannot remove its replacement", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const prepared = await prepare(authorization, 5, "new-document");
    expect(prepared.prepared).toBe(true);
    authorization.completePendingInjection(5, "new-document");
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 5,
      documentId: "new-document",
      url: "https://widgets.example/new-document"
    });

    expect(authorization.revoke(5, "old-document")).toBe(false);
    expect(authorization.get(5)?.documentId).toBe("new-document");
    expect(authorization.activeFrameIds()).toEqual([5]);
    expect(authorization.revoke(5, "new-document")).toBe(true);
    expect(authorization.get(5)).toBeNull();
  });

  it("revokes a current top port but permits the same exact document to reconnect", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: TOP_URL
    });

    expect(authorization.revoke(0, "top-document")).toBe(true);
    expect(authorization.get(0)).toBeNull();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document",
        url: TOP_URL
      })
    ).toMatchObject({ documentId: "top-document" });
  });

  it("keeps an allowed committed navigation pending until exact content.ready", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 8,
      documentId: "old-document",
      url: "https://widgets.example/old"
    });

    const result = await prepare(authorization, 8, "committed-document");

    expect(result).toEqual({
      prepared: true,
      reason: "prepared",
      document: {
        frameId: 8,
        documentId: "committed-document",
        url: "https://widgets.example/committed-document"
      },
      target: {
        tabId: TAB_ID,
        documentIds: ["committed-document"]
      }
    });
    expect(authorization.get(8)).toBeNull();
    expect(
      authorization.matchesWebRequest({
        tabId: TAB_ID,
        frameId: 8,
        documentId: "committed-document"
      })
    ).toBe(false);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 8,
        documentId: "wrong-document",
        url: "https://widgets.example/committed-document"
      })
    ).toBeNull();
    expect(authorization.completePendingInjection(8, "committed-document")).toBe(true);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 8,
        documentId: "committed-document",
        url: "https://widgets.example/committed-document"
      })
    ).toMatchObject({ documentId: "committed-document" });
    expect(
      authorization.matchesWebRequest({
        tabId: TAB_ID,
        frameId: 8,
        documentId: "committed-document"
      })
    ).toBe(true);
  });

  it("revokes before scope evaluation and keeps denied frames closed", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 6,
      documentId: "old-document",
      url: "https://widgets.example/old"
    });

    const result = await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 6,
        documentId: "denied-document",
        url: "https://denied.example/embed"
      },
      () => {
        expect(authorization.get(6)).toBeNull();
        return false;
      }
    );

    expect(result).toMatchObject({ prepared: false, reason: "scope-denied" });
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 6,
        documentId: "old-document",
        url: "https://widgets.example/old"
      })
    ).toBeNull();
  });

  it("fails closed when a committed child omits documentId", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 9,
      documentId: "old-document",
      url: "https://widgets.example/old"
    });

    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 9,
          url: "https://widgets.example/new"
        },
        () => true
      )
    ).resolves.toMatchObject({ prepared: false, reason: "invalid-navigation" });
    expect(authorization.get(9)).toBeNull();
  });

  it("does not let late B scope completion overwrite C", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const bDecision = deferred<ContentDocumentScopeDecision>();
    const navigationB = authorization.prepareCommittedNavigation(
      navigation(10, "document-b"),
      () => bDecision.promise
    );
    const navigationC = await authorization.prepareCommittedNavigation(
      navigation(10, "document-c"),
      () => true
    );

    bDecision.resolve(true);

    await expect(navigationB).resolves.toMatchObject({
      prepared: false,
      reason: "stale-navigation"
    });
    expect(navigationC).toMatchObject({ prepared: true });
    expect(authorization.getPending(10)?.documentId).toBe("document-c");
  });

  it("promotes only exact top B after A enters the navigation window", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });

    const started = authorization.beginNavigation(0);
    expect(started).not.toBeNull();
    expect(authorization.get(0)).toBeNull();

    const prepared = await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    expect(prepared).toMatchObject({ prepared: true });
    expect(authorization.get(0)).toBeNull();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-a",
        url: "https://app.example/a"
      })
    ).toBeNull();
    expect(authorization.completePendingInjection(0, "top-document-b")).toBe(true);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      })
    ).toMatchObject({ documentId: "top-document-b" });
  });

  it("keeps a request token valid after exact commit without a webRequest documentId", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const navigationB = authorization.beginNavigation(0, "https://app.example/b");

    expect(navigationB).not.toBeNull();
    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-b",
          url: "https://app.example/b"
        },
        () => true
      )
    ).resolves.toMatchObject({ prepared: true });
    expect(
      authorization.matchesNavigationCompletion({
        authorization: navigationB!,
        frameId: 0
      })
    ).toBe(true);
  });

  it("associates redirect URLs with one current request token", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const navigation = authorization.beginNavigation(0, "https://app.example/start");

    expect(navigation).not.toBeNull();
    expect(authorization.continueNavigation(navigation!, "https://app.example/final")).toEqual(
      navigation
    );
    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-final",
          url: "https://app.example/final"
        },
        () => true
      )
    ).resolves.toMatchObject({ prepared: true });
    expect(
      authorization.matchesNavigationCompletion({
        authorization: navigation!,
        frameId: 0
      })
    ).toBe(true);
  });

  it("finalizes B request lineage before a later BFCache A commit", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const navigationB = authorization.beginNavigation(0, "https://app.example/b");
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    expect(authorization.finalizeNavigation(navigationB!)).toBe(true);
    expect(
      authorization.matchesNavigationCompletion({
        authorization: navigationB!,
        frameId: 0
      })
    ).toBe(false);
    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-a-restored",
          url: "https://app.example/a"
        },
        () => true
      )
    ).resolves.toMatchObject({ prepared: true });
    expect(authorization.getPending(0)?.documentId).toBe("top-document-a-restored");
  });

  it("treats same-URL store-safe commits as distinct exact documents", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const url = "https://app.example/dashboard";
    authorization.reset({ url });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url
    });

    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url
      },
      () => true
    );
    expect(authorization.get(0)).toBeNull();
    expect(authorization.completePendingInjection(0, "top-document-b")).toBe(true);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url
    });
    expect(authorization.get(0)?.documentId).toBe("top-document-b");

    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-c",
        url
      },
      () => true
    );
    expect(authorization.get(0)).toBeNull();
    expect(authorization.getPending(0)?.documentId).toBe("top-document-c");
  });

  it("records early exact ready during policy evaluation and promotes only after allow", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.beginNavigation(0, "https://app.example/b");
    const policy = deferred<ContentDocumentScopeDecision>();
    const preparation = authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => policy.promise
    );

    await Promise.resolve();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      })
    ).toBeNull();
    const recognizedReady = authorization.waitForPreparingAuthorization({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url: "https://app.example/b"
    });
    expect(recognizedReady).not.toBeNull();
    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-b"
      })
    ).toBe(false);
    expect(authorization.get(0)).toBeNull();

    policy.resolve(true);
    await expect(preparation).resolves.toMatchObject({ prepared: true });
    let readyResolved = false;
    void recognizedReady?.then(() => {
      readyResolved = true;
    });
    await Promise.resolve();
    expect(readyResolved).toBe(false);
    expect(authorization.get(0)).toBeNull();
    expect(authorization.completePendingInjection(0, "top-document-b")).toBe(true);
    await expect(recognizedReady).resolves.toBe(true);
    expect(authorization.get(0)?.documentId).toBe("top-document-b");
  });

  it("recovers a pageshow ready sent before preparing through the post-injection request", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });

    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      })
    ).toBeNull();

    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );
    expect(authorization.getPending(0)?.documentId).toBe("top-document-b");

    // The exact status-request delivered after duplicate-safe injection causes
    // the singleton to send ready again while injection is not yet committed.
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      })
    ).toBeNull();
    const requestedReady = authorization.waitForPreparingAuthorization({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url: "https://app.example/b"
    });
    expect(requestedReady).not.toBeNull();
    expect(authorization.completePendingInjection(0, "top-document-b")).toBe(true);
    await expect(requestedReady).resolves.toBe(true);
    expect(authorization.get(0)?.documentId).toBe("top-document-b");
  });

  it("keeps an acknowledged suspended singleton pending until pageshow ready", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    // The suspended singleton acknowledges the exact status request without
    // sending ready. Injection can complete, but capture stays pending.
    expect(authorization.completePendingInjection(0, "top-document-b")).toBe(true);
    expect(authorization.get(0)).toBeNull();
    expect(authorization.getPending(0)?.documentId).toBe("top-document-b");

    // pageshow resumes the singleton and its existing lifecycle hook requests
    // status, which is now the only operation allowed to promote the document.
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      })
    ).toMatchObject({ documentId: "top-document-b" });
  });

  it("cannot resurrect a preparing document after stop cancellation", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.beginNavigation(0, "https://app.example/b");
    const policy = deferred<ContentDocumentScopeDecision>();
    const preparation = authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => policy.promise
    );

    await Promise.resolve();
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url: "https://app.example/b"
    });
    const recognizedReady = authorization.waitForPreparingAuthorization({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url: "https://app.example/b"
    });
    expect(recognizedReady).not.toBeNull();
    authorization.cancelPendingNavigations();
    policy.resolve(true);

    await expect(recognizedReady).resolves.toBe(false);
    await expect(preparation).resolves.toMatchObject({
      prepared: false,
      reason: "stale-navigation"
    });
    expect(authorization.get(0)).toBeNull();
    expect(authorization.getPending(0)).toBeNull();
  });

  it("keeps stale A children closed and recognizes only B as their parent", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 4,
      documentId: "child-document-a",
      url: "https://widgets.example/a"
    });

    authorization.beginNavigation(0, "https://app.example/b");
    expect(authorization.matchesKnownDocument({ frameId: 0, documentId: "top-document-a" })).toBe(
      false
    );
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 4,
        documentId: "child-document-a",
        url: "https://widgets.example/a"
      })
    ).toBeNull();

    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );
    expect(authorization.matchesKnownDocument({ frameId: 0, documentId: "top-document-b" })).toBe(
      true
    );
  });

  it("keeps denied top B closed without restoring A", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });

    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-b",
          url: "https://denied.example/b"
        },
        () => false
      )
    ).resolves.toMatchObject({ prepared: false, reason: "scope-denied" });
    expect(authorization.get(0)).toBeNull();
    expect(authorization.getPending(0)).toBeNull();
    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-b"
      })
    ).toBe(false);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-a",
        url: "https://app.example/a"
      })
    ).toBeNull();
  });

  it("does not let stale top A stop an active replacement B", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );
    authorization.completePendingInjection(0, "top-document-b");
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-b",
      url: "https://app.example/b"
    });

    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-a",
        url: "https://app.example/a"
      })
    ).toBeNull();
    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-a"
      })
    ).toBe(false);
    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-b"
      })
    ).toBe(true);
    expect(authorization.get(0)?.documentId).toBe("top-document-b");
  });

  it("stops only the exact pending top sender, never stale A", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-b"
      })
    ).toBe(true);
    expect(
      authorization.shouldStopRuntimeForDeniedSender({
        frameId: 0,
        documentId: "top-document-a"
      })
    ).toBe(false);
  });

  it("allows a denied top sender to fail closed only without active or pending identity", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);

    expect(authorization.shouldStopRuntimeForDeniedSender({ frameId: 0 })).toBe(true);
    expect(authorization.shouldStopRuntimeForDeniedSender({ frameId: 4 })).toBe(false);
  });

  it("classifies a current scope failure without letting a late B failure stop C", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);

    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-b",
          url: "https://app.example/b"
        },
        () => Promise.reject(new Error("policy unavailable"))
      )
    ).resolves.toMatchObject({ prepared: false, reason: "scope-error" });

    const bPolicy = deferred<ContentDocumentScopeDecision>();
    const navigationB = authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => bPolicy.promise
    );
    const navigationC = await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-c",
        url: "https://app.example/c"
      },
      () => true
    );

    bPolicy.reject(new Error("late B policy failure"));
    await expect(navigationB).resolves.toMatchObject({
      prepared: false,
      reason: "stale-navigation"
    });
    expect(navigationC).toMatchObject({ prepared: true });
    expect(authorization.getPending(0)?.documentId).toBe("top-document-c");
  });

  it("keeps a superseded top navigation token and completion stale", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const navigationB = authorization.beginNavigation(0);
    expect(navigationB).not.toBeNull();

    const navigationC = authorization.beginNavigation(0);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-c",
        url: "https://app.example/c"
      },
      () => true
    );

    expect(navigationB).not.toBeNull();
    expect(navigationC).not.toBeNull();
    expect(
      authorization.matchesNavigationCompletion({
        authorization: navigationB!,
        frameId: 0,
        documentId: "top-document-b"
      })
    ).toBe(false);
    expect(authorization.getPending(0)?.documentId).toBe("top-document-c");
  });

  it("fails closed when a committed top document omits documentId", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);

    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          url: "https://app.example/b"
        },
        () => true
      )
    ).resolves.toMatchObject({ prepared: false, reason: "invalid-navigation" });
    expect(authorization.get(0)).toBeNull();
    expect(authorization.getPending(0)).toBeNull();
  });

  it("does not let a late B injection failure cancel pending or active C", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await prepare(authorization, 10, "document-b");
    await prepare(authorization, 10, "document-c");

    expect(authorization.failNavigation(10, "document-b")).toBe(false);
    expect(authorization.getPending(10)?.documentId).toBe("document-c");

    authorization.completePendingInjection(10, "document-c");
    authorization.authorize(navigation(10, "document-c"));
    expect(authorization.failNavigation(10, "document-b")).toBe(false);
    expect(authorization.get(10)?.documentId).toBe("document-c");
  });

  it("revokes a sender promoted during a failed exact injection", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await prepare(authorization, 12, "document-d");
    authorization.authorize(navigation(12, "document-d"));

    expect(authorization.failNavigation(12, "document-d")).toBe(true);
    expect(authorization.get(12)).toBeNull();
    expect(authorization.authorize(navigation(12, "document-d"))).toBeNull();
  });
});

function navigation(frameId: number, documentId: string) {
  return {
    tabId: TAB_ID,
    frameId,
    documentId,
    url: `https://widgets.example/${documentId}`
  };
}

function prepare(authorization: ContentDocumentAuthorization, frameId: number, documentId: string) {
  return authorization.prepareCommittedNavigation(navigation(frameId, documentId), () => true);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
