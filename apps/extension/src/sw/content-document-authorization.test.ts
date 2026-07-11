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

  it("requires an explicit policy-approved URL refresh without invalidating child documents", () => {
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
    ).toBeNull();
    expect(
      authorization.refreshKnownDocumentUrl({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document",
        url: "https://app.example/next"
      })
    ).toBe(true);
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

  it("accepts a lagging sender URL only for an exact same-origin document refresh", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: TOP_URL
    });
    const currentUrl = "https://app.example/checkout?step=payment#/confirm";
    expect(
      authorization.refreshKnownDocumentUrl({
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document",
        url: currentUrl
      })
    ).toBe(true);

    expect(
      authorization.matchesSameDocumentSender(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document",
          url: currentUrl
        },
        TOP_URL
      )
    ).toBe(true);
    expect(
      authorization.matchesSameDocumentSender(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document",
          url: currentUrl
        },
        "https://other.example/dashboard"
      )
    ).toBe(false);
    expect(
      authorization.matchesSameDocumentSender(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "stale-document",
          url: currentUrl
        },
        TOP_URL
      )
    ).toBe(false);
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

  it("conditionally revokes so a late failure cannot remove its replacement", async () => {
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

  it("keeps a policy-blocked child closed until a new committed navigation", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 5,
      documentId: "blocked-child",
      url: "https://widgets.example/blocked"
    });

    expect(authorization.blockDocument(5, "blocked-child")).toBe(true);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 5,
        documentId: "blocked-child",
        url: "https://widgets.example/blocked"
      })
    ).toBeNull();
  });

  it("revokes a failed current top document but permits the same exact document to reconnect", () => {
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

  it("re-evaluates the latest preparing URL before committing policy", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const firstDecision = deferred<ContentDocumentScopeDecision>();
    const evaluated: string[] = [];
    const preparation = authorization.prepareCommittedNavigation(
      navigation(10, "document-b"),
      ({ url }) => {
        evaluated.push(url);
        return evaluated.length === 1 ? firstDecision.promise : true;
      }
    );

    await Promise.resolve();
    expect(authorization.matchesKnownDocument({ frameId: 10, documentId: "document-b" })).toBe(
      true
    );
    expect(
      authorization.refreshKnownDocumentUrl({
        tabId: TAB_ID,
        frameId: 10,
        documentId: "document-b",
        url: "https://widgets.example/document-c"
      })
    ).toBe(true);
    firstDecision.resolve(true);

    await expect(preparation).resolves.toMatchObject({
      prepared: true,
      document: { url: "https://widgets.example/document-c" }
    });
    expect(evaluated).toEqual([
      "https://widgets.example/document-b",
      "https://widgets.example/document-c"
    ]);
  });

  it("exposes preparing and pending parents without authorizing them early", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const decision = deferred<ContentDocumentScopeDecision>();
    const preparation = authorization.prepareCommittedNavigation(
      navigation(12, "parent-document"),
      () => decision.promise
    );

    await Promise.resolve();
    expect(authorization.getKnownFrameDocument(12)).toMatchObject({
      documentId: "parent-document",
      state: "preparing"
    });
    const activation = authorization.waitForKnownDocumentActivation({
      frameId: 12,
      documentId: "parent-document"
    });
    expect(activation).not.toBeNull();

    decision.resolve(true);
    await preparation;
    expect(authorization.getKnownFrameDocument(12)).toMatchObject({
      documentId: "parent-document",
      state: "pending"
    });
    authorization.completePendingInjection(12, "parent-document");
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 12,
      documentId: "parent-document",
      url: "https://widgets.example/parent-document"
    });

    await expect(activation).resolves.toBe(true);
    expect(authorization.getKnownFrameDocument(12)).toMatchObject({ state: "active" });
  });

  it("promotes only the refreshed pending URL", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await authorization.prepareCommittedNavigation(navigation(11, "document-b"), () => true);
    expect(
      authorization.refreshKnownDocumentUrl({
        tabId: TAB_ID,
        frameId: 11,
        documentId: "document-b",
        url: "https://widgets.example/document-c"
      })
    ).toBe(true);
    expect(authorization.completePendingInjection(11, "document-b")).toBe(true);
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 11,
        documentId: "document-b",
        url: "https://widgets.example/document-b"
      })
    ).toBeNull();
    expect(
      authorization.authorize({
        tabId: TAB_ID,
        frameId: 11,
        documentId: "document-b",
        url: "https://widgets.example/document-c"
      })
    ).toMatchObject({ url: "https://widgets.example/document-c" });
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

  it("lets an exact commit supersede a request lineage that missed its final redirect", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/a" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/a"
    });
    const request = authorization.beginNavigation(0, "https://app.example/b");
    expect(request).not.toBeNull();

    await expect(
      authorization.prepareCommittedNavigation(
        {
          tabId: TAB_ID,
          frameId: 0,
          documentId: "top-document-c",
          url: "https://app.example/c"
        },
        () => true
      )
    ).resolves.toMatchObject({
      prepared: true,
      document: { documentId: "top-document-c", url: "https://app.example/c" }
    });
    expect(
      authorization.matchesNavigationCompletion({
        authorization: request!,
        frameId: 0
      })
    ).toBe(false);
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

  it("atomically blocks an exact parent and all active, pending, and preparing descendants", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: TOP_URL
    });
    authorization.authorize(navigation(4, "parent-document"));
    authorization.authorize(navigation(8, "unrelated-sibling"));
    await prepare(authorization, 5, "pending-child");
    await prepare(authorization, 6, "pending-grandchild");
    const preparingDecision = deferred<ContentDocumentScopeDecision>();
    const preparingGreatGrandchild = authorization.prepareCommittedNavigation(
      navigation(7, "preparing-great-grandchild"),
      () => preparingDecision.promise
    );
    await Promise.resolve();

    authorization.authorize(navigation(5, "pending-child"));
    authorization.authorize(navigation(6, "pending-grandchild"));
    const pendingChildOutcome = authorization.waitForPreparingAuthorization(
      navigation(5, "pending-child")
    );
    const pendingGrandchildOutcome = authorization.waitForPreparingAuthorization(
      navigation(6, "pending-grandchild")
    );
    const parents = new Map([
      ["4:parent-document", { frameId: 0, documentId: "top-document" }],
      ["5:pending-child", { frameId: 4, documentId: "parent-document" }],
      ["6:pending-grandchild", { frameId: 5, documentId: "pending-child" }],
      ["7:preparing-great-grandchild", { frameId: 6, documentId: "pending-grandchild" }],
      ["8:unrelated-sibling", { frameId: 0, documentId: "top-document" }]
    ]);

    const removed = authorization.blockKnownDocumentSubtree(
      { frameId: 4, documentId: "parent-document" },
      (document) => parents.get(`${document.frameId}:${document.documentId}`)
    );

    for (const document of removed) {
      parents.delete(`${document.frameId}:${document.documentId}`);
    }

    expect(removed).toEqual([
      expect.objectContaining({ frameId: 4, documentId: "parent-document", state: "active" }),
      expect.objectContaining({ frameId: 5, documentId: "pending-child", state: "pending" }),
      expect.objectContaining({ frameId: 6, documentId: "pending-grandchild", state: "pending" }),
      expect.objectContaining({
        frameId: 7,
        documentId: "preparing-great-grandchild",
        state: "preparing"
      })
    ]);
    await expect(pendingChildOutcome).resolves.toBe(false);
    await expect(pendingGrandchildOutcome).resolves.toBe(false);
    expect(authorization.beginNavigation(4, "https://widgets.example/replacement")).not.toBeNull();
    expect(authorization.get(4)).toBeNull();
    expect(authorization.getPending(5)).toBeNull();
    expect(authorization.getPending(6)).toBeNull();
    expect(
      authorization.matchesKnownDocument({
        frameId: 6,
        documentId: "pending-grandchild"
      })
    ).toBe(false);
    expect(authorization.get(8)?.documentId).toBe("unrelated-sibling");
    expect(parents).toEqual(
      new Map([["8:unrelated-sibling", { frameId: 0, documentId: "top-document" }]])
    );

    preparingDecision.resolve(true);
    await expect(preparingGreatGrandchild).resolves.toMatchObject({
      prepared: false,
      reason: "stale-navigation"
    });
  });

  it("fails closed for missing or cyclic exact ancestry during subtree cleanup", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: TOP_URL });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: TOP_URL
    });
    authorization.authorize(navigation(4, "parent-document"));
    authorization.authorize(navigation(8, "valid-sibling"));
    authorization.authorize(navigation(9, "missing-parent"));
    authorization.authorize(navigation(10, "cycle-a"));
    authorization.authorize(navigation(11, "cycle-b"));
    const parents = new Map([
      ["4:parent-document", { frameId: 0, documentId: "top-document" }],
      ["8:valid-sibling", { frameId: 0, documentId: "top-document" }],
      ["10:cycle-a", { frameId: 11, documentId: "cycle-b" }],
      ["11:cycle-b", { frameId: 10, documentId: "cycle-a" }]
    ]);

    const removed = authorization.blockKnownDocumentSubtree(
      { frameId: 4, documentId: "parent-document" },
      (document) => parents.get(`${document.frameId}:${document.documentId}`)
    );

    expect(removed.map(({ documentId }) => documentId)).toEqual([
      "parent-document",
      "missing-parent",
      "cycle-a",
      "cycle-b"
    ]);
    expect(authorization.get(8)?.documentId).toBe("valid-sibling");
    for (const documentId of ["parent-document", "missing-parent", "cycle-a", "cycle-b"]) {
      expect(
        authorization.matchesKnownDocument({
          frameId:
            documentId === "parent-document"
              ? 4
              : documentId === "missing-parent"
                ? 9
                : documentId === "cycle-a"
                  ? 10
                  : 11,
          documentId
        })
      ).toBe(false);
    }
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
