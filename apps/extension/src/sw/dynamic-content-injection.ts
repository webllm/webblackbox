import type { CaptureMode } from "@webblackbox/protocol";

import type { ChromeApi } from "../shared/chrome-api.js";
import type { MainWorldControllerHint } from "../shared/main-world-controller.js";
import {
  shouldInjectIsolatedContentForMode,
  shouldInjectMainWorldHooksForMode
} from "../shared/mode-profile.js";
import {
  ContentDocumentAuthorization,
  type AuthorizedContentDocument
} from "./content-document-authorization.js";
import {
  advanceControllerFromControl,
  bootstrapMainWorldDirectController,
  controlMainWorldDirectController,
  createMainWorldControllerHint,
  injectContentScript,
  seedMainWorldControllerHint
} from "./script-injection.js";

export type DynamicContentInjectionResult =
  | Readonly<{ status: "injected"; mainWorldController?: MainWorldControllerHint }>
  | Readonly<{ status: "stale" }>
  | Readonly<{ status: "failed"; failedCurrentNavigation: boolean; error: unknown }>;

/**
 * Injects the mode-allowed worlds into one exact committed document. Every
 * async boundary rechecks the navigation identity so a late B result cannot
 * touch C.
 */
export async function injectPendingContentDocument(input: {
  chromeApi: ChromeApi | null | undefined;
  authorization: ContentDocumentAuthorization;
  document: AuthorizedContentDocument;
  isRuntimeActive: () => boolean;
  mode: CaptureMode;
}): Promise<DynamicContentInjectionResult> {
  const { frameId, documentId } = input.document;
  const isCurrent = () =>
    input.isRuntimeActive() && input.authorization.isCurrentNavigation(frameId, documentId);

  if (!isCurrent()) {
    return { status: "stale" };
  }

  try {
    if (shouldInjectIsolatedContentForMode(input.mode)) {
      await injectContentScript(input.chromeApi, {
        tabId: input.authorization.tabId,
        frameId,
        documentId
      });

      if (!isCurrent()) {
        return { status: "stale" };
      }
    }

    let mainWorldController: MainWorldControllerHint | undefined;
    if (shouldInjectMainWorldHooksForMode(input.mode)) {
      const target = {
        tabId: input.authorization.tabId,
        frameId,
        documentId
      };
      const generated = createMainWorldControllerHint();
      const seeded = await seedMainWorldControllerHint(input.chromeApi, target, generated);

      if (!isCurrent()) {
        return { status: "stale" };
      }

      const bootstrap = await bootstrapMainWorldDirectController(input.chromeApi, target, seeded);
      if (bootstrap.kind !== "installed" && bootstrap.kind !== "existing") {
        throw new Error("MAIN-world direct bootstrap was rejected.");
      }
      if (!isCurrent()) {
        return { status: "stale" };
      }
      const probe = await controlMainWorldDirectController(input.chromeApi, target, seeded, {
        kind: "probe"
      });
      const advanced = advanceControllerFromControl(seeded, probe);
      if (!advanced) {
        throw new Error("MAIN-world direct probe did not match its isolated controller.");
      }
      mainWorldController = advanced;

      if (!isCurrent()) {
        return { status: "stale" };
      }
    }

    if (!isCurrent()) {
      return { status: "stale" };
    }

    return {
      status: "injected",
      ...(mainWorldController === undefined ? {} : { mainWorldController })
    };
  } catch (error) {
    const failedCurrentNavigation = input.authorization.failNavigation(frameId, documentId);
    return { status: "failed", failedCurrentNavigation, error };
  }
}
