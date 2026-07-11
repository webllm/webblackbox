import { describe, expect, it, vi } from "vitest";

import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import { authorizeLiteWebRequest } from "./lite-web-request-authorization.js";

const TAB_ID = 7;

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

    expect(before).toEqual({ allowed: true, frameId: 4, kind: "subframe-navigation" });
    expect(authorization.get(4)).toBeNull();
  });

  it("drops completion for a denied sub_frame onBefore", () => {
    const authorization = authorizedChild("document-a", "https://widgets.example/document-a");
    const details = {
      frameId: 4,
      type: "sub_frame",
      url: "https://blocked.example/document-b"
    };

    expect(decide(authorization, details, { evaluateScope: () => false }).allowed).toBe(false);
    expect(
      decide(authorization, details, {
        phase: "completion",
        navigationStartedAllowed: false
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
    expect(decide(authorization, details).allowed).toBe(true);
    await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 4,
        documentId: "document-b",
        url: details.url
      },
      () => true
    );
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 4,
      documentId: "document-b",
      url: details.url
    });

    expect(
      decide(authorization, details, {
        phase: "completion",
        navigationStartedAllowed: true
      }).allowed
    ).toBe(true);
    expect(authorization.get(4)?.documentId).toBe("document-b");
  });

  it("keeps ordinary top subresources scoped to the current top document URL", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const evaluateScope = vi.fn().mockReturnValue(true);

    expect(
      decide(
        authorization,
        { frameId: 0, type: "xmlhttprequest", url: "https://api.example/data" },
        { topDocumentUrl: "https://app.example/current", evaluateScope }
      )
    ).toEqual({ allowed: true, frameId: 0, kind: "top-document" });
    expect(evaluateScope).toHaveBeenCalledWith("https://app.example/current", 0);
  });

  it("evaluates a top navigation against its destination instead of the old document", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const evaluateScope = vi.fn((url: string) => url.startsWith("https://app.example/"));
    const deniedNavigation = {
      frameId: 0,
      type: "main_frame",
      url: "https://denied.example/private"
    };

    expect(
      decide(authorization, deniedNavigation, {
        topDocumentUrl: "https://app.example/current",
        evaluateScope
      })
    ).toEqual({ allowed: false, frameId: 0, kind: "top-navigation" });
    expect(evaluateScope).toHaveBeenCalledWith("https://denied.example/private", 0);
    expect(
      decide(authorization, deniedNavigation, {
        phase: "completion",
        navigationStartedAllowed: false,
        topDocumentUrl: "https://app.example/current",
        evaluateScope
      }).allowed
    ).toBe(false);
  });

  it("drops an allowed top navigation completion that redirects out of scope", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);

    expect(
      decide(
        authorization,
        { frameId: 0, type: "main_frame", url: "https://denied.example/final" },
        {
          phase: "completion",
          navigationStartedAllowed: true,
          evaluateScope: (url) => url.startsWith("https://app.example/")
        }
      ).allowed
    ).toBe(false);
  });
});

function authorizedChild(documentId: string, url: string): ContentDocumentAuthorization {
  const authorization = new ContentDocumentAuthorization(TAB_ID);
  authorization.authorize({ tabId: TAB_ID, frameId: 4, documentId, url });
  return authorization;
}

function decide(
  authorization: ContentDocumentAuthorization,
  details: {
    frameId?: number;
    documentId?: string;
    type?: string;
    url: string;
  },
  options: {
    phase?: "before" | "completion";
    navigationStartedAllowed?: boolean;
    topDocumentUrl?: string;
    evaluateScope?: (url: string, frameId: number) => boolean;
  } = {}
) {
  return authorizeLiteWebRequest({
    authorization,
    details: { tabId: TAB_ID, ...details },
    phase: options.phase ?? "before",
    topDocumentUrl: options.topDocumentUrl ?? "https://app.example/current",
    navigationStartedAllowed: options.navigationStartedAllowed,
    evaluateScope: options.evaluateScope ?? (() => true)
  });
}
