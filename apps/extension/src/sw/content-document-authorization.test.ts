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

  it("does not let a late B injection failure cancel pending or active C", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    await prepare(authorization, 10, "document-b");
    await prepare(authorization, 10, "document-c");

    expect(authorization.failNavigation(10, "document-b")).toBe(false);
    expect(authorization.getPending(10)?.documentId).toBe("document-c");

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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
