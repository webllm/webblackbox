import { ContentDocumentAuthorization } from "./content-document-authorization.js";

export type LiteWebRequestAuthorizationPhase = "before" | "completion";

export type LiteWebRequestAuthorizationDetails = Readonly<{
  tabId: number;
  frameId?: number;
  documentId?: string;
  type?: string;
  url: string;
}>;

export type LiteWebRequestAuthorizationDecision = Readonly<{
  allowed: boolean;
  frameId: number;
  kind: "top-document" | "top-navigation" | "child-document" | "subframe-navigation";
}>;

export function authorizeLiteWebRequest(input: {
  authorization: ContentDocumentAuthorization;
  details: LiteWebRequestAuthorizationDetails;
  phase: LiteWebRequestAuthorizationPhase;
  topDocumentUrl: string;
  navigationStartedAllowed?: boolean;
  evaluateScope: (documentUrl: string, frameId: number) => boolean;
}): LiteWebRequestAuthorizationDecision {
  const frameId = normalizeFrameId(input.details.frameId);

  if (input.details.tabId !== input.authorization.tabId || frameId === null) {
    return denied(frameId ?? 0, "child-document");
  }

  if (frameId === 0) {
    if (input.details.type === "main_frame") {
      return {
        allowed:
          input.phase === "before"
            ? input.evaluateScope(input.details.url, 0)
            : input.navigationStartedAllowed === true && input.evaluateScope(input.details.url, 0),
        frameId,
        kind: "top-navigation"
      };
    }

    return {
      allowed: input.evaluateScope(input.topDocumentUrl, 0),
      frameId,
      kind: "top-document"
    };
  }

  if (input.details.type === "sub_frame") {
    if (input.phase === "before") {
      input.authorization.beginNavigation(frameId);
      return {
        allowed: input.evaluateScope(input.details.url, frameId),
        frameId,
        kind: "subframe-navigation"
      };
    }

    return {
      allowed:
        input.navigationStartedAllowed === true && input.evaluateScope(input.details.url, frameId),
      frameId,
      kind: "subframe-navigation"
    };
  }

  const document = input.authorization.get(frameId);
  const allowed =
    document !== null &&
    input.authorization.matchesWebRequest({
      tabId: input.details.tabId,
      frameId,
      documentId: input.details.documentId
    }) &&
    input.evaluateScope(document.url, frameId);

  return {
    allowed,
    frameId,
    kind: "child-document"
  };
}

function normalizeFrameId(value: number | undefined): number | null {
  if (value === undefined) {
    return 0;
  }

  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function denied(
  frameId: number,
  kind: LiteWebRequestAuthorizationDecision["kind"]
): LiteWebRequestAuthorizationDecision {
  return { allowed: false, frameId, kind };
}
