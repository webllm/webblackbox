import {
  ContentDocumentAuthorization,
  type ContentNavigationAuthorization
} from "./content-document-authorization.js";

export type LiteWebRequestAuthorizationPhase = "before" | "completion";

export type LiteWebRequestAuthorizationDetails = Readonly<{
  tabId: number;
  frameId?: number;
  documentId?: string;
  parentFrameId?: number;
  parentDocumentId?: string;
  type?: string;
  url: string;
}>;

export type LiteWebRequestAuthorizationDecision = Readonly<{
  allowed: boolean;
  frameId: number;
  kind: "top-document" | "top-navigation" | "child-document" | "subframe-navigation";
  navigationAuthorization?: ContentNavigationAuthorization;
  navigationCurrent?: boolean;
}>;

export function authorizeLiteWebRequest(input: {
  authorization: ContentDocumentAuthorization;
  details: LiteWebRequestAuthorizationDetails;
  phase: LiteWebRequestAuthorizationPhase;
  navigationAuthorization?: ContentNavigationAuthorization;
  evaluateScope: (documentUrl: string, frameId: number) => boolean;
}): LiteWebRequestAuthorizationDecision {
  const frameId = normalizeFrameId(input.details.frameId);

  if (input.details.tabId !== input.authorization.tabId || frameId === null) {
    return denied(frameId ?? 0, "child-document");
  }

  if (frameId === 0) {
    if (input.details.type === "main_frame") {
      if (input.phase === "before") {
        const navigationAuthorization = input.navigationAuthorization
          ? input.authorization.continueNavigation(input.navigationAuthorization, input.details.url)
          : input.authorization.beginNavigation(frameId, input.details.url);
        const allowed =
          navigationAuthorization !== null && input.evaluateScope(input.details.url, frameId);

        return {
          allowed,
          frameId,
          kind: "top-navigation",
          navigationCurrent: navigationAuthorization !== null,
          ...(allowed ? { navigationAuthorization } : {})
        };
      }

      const navigationCurrent =
        input.navigationAuthorization !== undefined &&
        input.authorization.matchesNavigationCompletion({
          authorization: input.navigationAuthorization,
          frameId,
          documentId: input.details.documentId
        });

      return {
        allowed: navigationCurrent && input.evaluateScope(input.details.url, frameId),
        frameId,
        kind: "top-navigation",
        navigationCurrent
      };
    }

    const document = input.authorization.get(frameId);
    return {
      allowed:
        document !== null &&
        input.authorization.matchesWebRequest({
          tabId: input.details.tabId,
          frameId,
          documentId: input.details.documentId
        }) &&
        input.evaluateScope(document.url, frameId),
      frameId,
      kind: "top-document"
    };
  }

  if (input.details.type === "sub_frame") {
    if (input.phase === "before") {
      if (
        input.details.parentFrameId === undefined ||
        !input.authorization.matchesKnownDocument({
          frameId: input.details.parentFrameId,
          documentId: input.details.parentDocumentId
        })
      ) {
        return {
          allowed: false,
          frameId,
          kind: "subframe-navigation",
          navigationCurrent: false
        };
      }

      const navigationAuthorization = input.navigationAuthorization
        ? input.authorization.continueNavigation(input.navigationAuthorization, input.details.url)
        : input.authorization.beginNavigation(frameId, input.details.url);
      const allowed =
        navigationAuthorization !== null && input.evaluateScope(input.details.url, frameId);
      return {
        allowed,
        frameId,
        kind: "subframe-navigation",
        navigationCurrent: navigationAuthorization !== null,
        ...(allowed ? { navigationAuthorization } : {})
      };
    }

    const navigationCurrent =
      input.navigationAuthorization !== undefined &&
      input.authorization.matchesNavigationCompletion({
        authorization: input.navigationAuthorization,
        frameId,
        documentId: input.details.documentId
      });

    return {
      allowed: navigationCurrent && input.evaluateScope(input.details.url, frameId),
      frameId,
      kind: "subframe-navigation",
      navigationCurrent
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
