import { describe, expect, it, vi } from "vitest";

import {
  ContentDocumentAuthorization,
  type ContentNavigationAuthorization
} from "./content-document-authorization.js";
import {
  authorizeLiteWebRequest,
  isLiteWebRequestDocumentUrlUnambiguous
} from "./lite-web-request-authorization.js";

const TAB_ID = 7;

describe("Lite webRequest document URL sufficiency", () => {
  it("disables subresource capture for path-sensitive policy but keeps document navigation", () => {
    expect(isLiteWebRequestDocumentUrlUnambiguous([], "fetch")).toBe(true);
    expect(isLiteWebRequestDocumentUrlUnambiguous(["/private/*"], "fetch")).toBe(false);
    expect(isLiteWebRequestDocumentUrlUnambiguous(["/private/*"], "main_frame")).toBe(true);
    expect(isLiteWebRequestDocumentUrlUnambiguous(["/private/*"], "sub_frame")).toBe(true);
  });
});

describe("authorizeLiteWebRequest", () => {
  it("requires ordinary child requests to match the exact active document", () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");
    const evaluateScope = vi.fn().mockReturnValue(true);

    expect(
      decide(
        authorization,
        {
          frameId: 4,
          documentId: "document-a",
          url: "https://api.example/resource"
        },
        { evaluateScope }
      ).allowed
    ).toBe(true);
    expect(evaluateScope).toHaveBeenLastCalledWith("https://widgets.example/document-a", 4);
    expect(
      decide(authorization, {
        frameId: 4,
        documentId: "stale-document",
        url: "https://api.example/resource"
      }).allowed
    ).toBe(false);
    expect(
      decide(authorization, {
        frameId: 4,
        url: "https://api.example/resource"
      }).allowed
    ).toBe(false);
  });

  it("revokes the old child only in sub_frame onBefore", () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");

    const before = decide(authorization, {
      frameId: 4,
      documentId: "document-a",
      type: "sub_frame",
      url: "https://widgets.example/document-b"
    });

    expect(before).toMatchObject({ allowed: true, frameId: 4, kind: "subframe-navigation" });
    expect(before.navigationAuthorization).toBeDefined();
    expect(authorization.get(4)).toBeNull();
  });

  it("drops completion for a denied sub_frame onBefore", () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");
    const details = {
      frameId: 4,
      type: "sub_frame",
      url: "https://blocked.example/document-b"
    };

    const before = decide(authorization, details, { evaluateScope: () => false });
    expect(before.allowed).toBe(false);
    expect(
      decide(authorization, details, {
        phase: "completion",
        navigationAuthorization: before.navigationAuthorization
      }).allowed
    ).toBe(false);
  });

  it("allows an approved navigation completion without revoking the new document", async () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");
    const details = {
      frameId: 4,
      type: "sub_frame",
      url: "https://widgets.example/document-b"
    };
    const before = decide(authorization, details);
    expect(before.allowed).toBe(true);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 4,
        documentId: "document-b",
        url: details.url
      },
      () => true
    );
    authorization.completePendingInjection(4, "document-b");
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 4,
      documentId: "document-b",
      url: details.url
    });

    expect(
      decide(authorization, details, {
        phase: "completion",
        navigationAuthorization: before.navigationAuthorization
      }).allowed
    ).toBe(true);
    expect(authorization.get(4)?.documentId).toBe("document-b");
  });

  it("requires ordinary top requests to match the exact active top document", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/current" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/current"
    });
    const evaluateScope = vi.fn().mockReturnValue(true);

    expect(
      decide(
        authorization,
        {
          frameId: 0,
          documentId: "top-document-a",
          type: "xmlhttprequest",
          url: "https://api.example/data"
        },
        { evaluateScope }
      )
    ).toEqual({ allowed: true, frameId: 0, kind: "top-document" });
    expect(evaluateScope).toHaveBeenCalledWith("https://app.example/current", 0);
    expect(
      decide(authorization, {
        frameId: 0,
        documentId: "stale-top-document",
        type: "xmlhttprequest",
        url: "https://api.example/stale"
      }).allowed
    ).toBe(false);
    expect(
      decide(authorization, {
        frameId: 0,
        type: "xmlhttprequest",
        url: "https://api.example/missing-document-id"
      }).allowed
    ).toBe(false);
  });

  it("rejects a subframe navigation without an exact current parent document", () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");

    expect(
      decide(authorization, {
        frameId: 4,
        parentFrameId: 0,
        parentDocumentId: "stale-top-document",
        type: "sub_frame",
        url: "https://widgets.example/document-b"
      }).allowed
    ).toBe(false);
    expect(authorization.get(4)?.documentId).toBe("document-a");
  });

  it("rejects pending and preparing documents as subframe parents", async () => {
    const pendingParent = authorizedTop("top-document-a", "https://app.example/a");
    await pendingParent.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: "https://app.example/b"
      },
      () => true
    );

    expect(
      decide(pendingParent, {
        frameId: 4,
        parentFrameId: 0,
        parentDocumentId: "top-document-b",
        type: "sub_frame",
        url: "https://widgets.example/pending-child"
      }).allowed
    ).toBe(false);

    const preparingParent = authorizedTop("top-document-a", "https://app.example/a");
    let release!: (allowed: boolean) => void;
    const policy = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const preparation = preparingParent.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-c",
        url: "https://app.example/c"
      },
      () => policy
    );

    expect(
      decide(preparingParent, {
        frameId: 5,
        parentFrameId: 0,
        parentDocumentId: "top-document-c",
        type: "sub_frame",
        url: "https://widgets.example/preparing-child"
      }).allowed
    ).toBe(false);
    release(true);
    await preparation;
  });

  it("closes A synchronously when top navigation B starts", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    authorization.reset({ url: "https://app.example/current" });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document-a",
      url: "https://app.example/current"
    });
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 3,
      documentId: "child-document-a",
      url: "https://widgets.example/a"
    });
    const evaluateScope = vi.fn((url: string) => url.startsWith("https://app.example/"));
    const navigation = {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/document-b"
    };

    const before = decide(authorization, navigation, { evaluateScope });

    expect(before).toMatchObject({ allowed: true, frameId: 0, kind: "top-navigation" });
    expect(before.navigationAuthorization).toBeDefined();
    expect(authorization.activeFrameIds()).toEqual([]);
    expect(authorization.getPending(0)).toBeNull();
    expect(evaluateScope).toHaveBeenCalledWith("https://app.example/document-b", 0);
  });

  it("keeps a denied top navigation closed through completion", () => {
    const authorization = authorizedTop("top-document-a", "https://app.example/current");
    const deniedNavigation = {
      frameId: 0,
      type: "main_frame",
      url: "https://denied.example/private"
    };
    const evaluateScope = (url: string) => url.startsWith("https://app.example/");
    const before = decide(authorization, deniedNavigation, { evaluateScope });

    expect(before.allowed).toBe(false);
    expect(authorization.get(0)).toBeNull();
    expect(
      decide(authorization, deniedNavigation, {
        phase: "completion",
        navigationAuthorization: before.navigationAuthorization,
        evaluateScope
      }).allowed
    ).toBe(false);
  });

  it("drops an allowed top navigation completion that redirects out of scope", () => {
    const authorization = authorizedTop("top-document-a", "https://app.example/current");
    const before = decide(authorization, {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/redirecting"
    });

    expect(
      decide(
        authorization,
        { frameId: 0, type: "main_frame", url: "https://denied.example/final" },
        {
          phase: "completion",
          navigationAuthorization: before.navigationAuthorization,
          evaluateScope: (url) => url.startsWith("https://app.example/")
        }
      ).allowed
    ).toBe(false);
  });

  it("accepts current top completion after onCommitted without a documentId", async () => {
    const authorization = authorizedTop("top-document-a", "https://app.example/a");
    const details = {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/b"
    };
    const before = decide(authorization, details);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-b",
        url: details.url
      },
      () => true
    );

    expect(
      decide(authorization, details, {
        phase: "completion",
        navigationAuthorization: before.navigationAuthorization
      })
    ).toMatchObject({ allowed: true, navigationCurrent: true });
  });

  it("rejects B completion after top navigation C supersedes it", async () => {
    const authorization = authorizedTop("top-document-a", "https://app.example/a");
    const navigationB = {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/b"
    };
    const beforeB = decide(authorization, navigationB);
    const beforeC = decide(authorization, {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/c"
    });

    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 0,
        documentId: "top-document-c",
        url: "https://app.example/c"
      },
      () => true
    );

    expect(beforeC.allowed).toBe(true);
    expect(
      decide(
        authorization,
        { ...navigationB, documentId: "top-document-b" },
        {
          phase: "completion",
          navigationAuthorization: beforeB.navigationAuthorization
        }
      ).allowed
    ).toBe(false);
    expect(authorization.getPending(0)?.documentId).toBe("top-document-c");
  });

  it("recognizes a current top navigation error without documentId but rejects stale B", () => {
    const authorization = authorizedTop("top-document-a", "https://app.example/a");
    const navigationB = {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/b"
    };
    const beforeB = decide(authorization, navigationB);

    expect(
      decide(authorization, navigationB, {
        phase: "completion",
        navigationAuthorization: beforeB.navigationAuthorization
      }).allowed
    ).toBe(true);

    decide(authorization, {
      frameId: 0,
      type: "main_frame",
      url: "https://app.example/c"
    });

    expect(
      decide(authorization, navigationB, {
        phase: "completion",
        navigationAuthorization: beforeB.navigationAuthorization
      }).allowed
    ).toBe(false);
  });
});

function authorizedChild(documentId: string, url: string): ContentDocumentAuthorization {
  const authorization = new ContentDocumentAuthorization(TAB_ID);
  authorization.reset({ url: "https://app.example/current" });
  authorization.authorize({
    tabId: TAB_ID,
    frameId: 0,
    documentId: "top-document",
    url: "https://app.example/current"
  });
  authorization.authorize({ tabId: TAB_ID, frameId: 4, documentId, url });
  return authorization;
}

function authorizedTop(documentId: string, url: string): ContentDocumentAuthorization {
  const authorization = new ContentDocumentAuthorization(TAB_ID);
  authorization.reset({ url });
  authorization.authorize({ tabId: TAB_ID, frameId: 0, documentId, url });
  return authorization;
}

function decide(
  authorization: ContentDocumentAuthorization,
  details: {
    frameId?: number;
    documentId?: string;
    parentFrameId?: number;
    parentDocumentId?: string;
    type?: string;
    url: string;
  },
  options: {
    phase?: "before" | "completion";
    navigationAuthorization?: ContentNavigationAuthorization;
    evaluateScope?: (url: string, frameId: number) => boolean;
  } = {}
) {
  return authorizeLiteWebRequest({
    authorization,
    details: {
      tabId: TAB_ID,
      ...(details.type === "sub_frame"
        ? { parentFrameId: 0, parentDocumentId: "top-document" }
        : {}),
      ...details
    },
    phase: options.phase ?? "before",
    navigationAuthorization: options.navigationAuthorization,
    evaluateScope: options.evaluateScope ?? (() => true)
  });
}
