import type { ChromeApi } from "../shared/chrome-api.js";
import {
  ContentDocumentAuthorization,
  type AuthorizedContentDocument
} from "./content-document-authorization.js";
import { injectContentScript, injectMainWorldHook } from "./script-injection.js";

export type DynamicContentInjectionResult =
  | Readonly<{ status: "injected" | "stale" }>
  | Readonly<{ status: "failed"; failedCurrentNavigation: boolean; error: unknown }>;

/**
 * Injects both worlds into one exact committed document. Every async boundary
 * rechecks the navigation identity so a late B result cannot touch C.
 */
export async function injectPendingContentDocument(input: {
  chromeApi: ChromeApi | null | undefined;
  authorization: ContentDocumentAuthorization;
  document: AuthorizedContentDocument;
  isRuntimeActive: () => boolean;
}): Promise<DynamicContentInjectionResult> {
  const { frameId, documentId } = input.document;
  const isCurrent = () =>
    input.isRuntimeActive() && input.authorization.isCurrentNavigation(frameId, documentId);

  if (!isCurrent()) {
    return { status: "stale" };
  }

  try {
    await injectMainWorldHook(input.chromeApi, {
      tabId: input.authorization.tabId,
      frameId,
      documentId
    });

    if (!isCurrent()) {
      return { status: "stale" };
    }

    await injectContentScript(input.chromeApi, {
      tabId: input.authorization.tabId,
      frameId,
      documentId
    });

    if (!isCurrent()) {
      return { status: "stale" };
    }

    return { status: "injected" };
  } catch (error) {
    const failedCurrentNavigation = input.authorization.failNavigation(frameId, documentId);
    return { status: "failed", failedCurrentNavigation, error };
  }
}
