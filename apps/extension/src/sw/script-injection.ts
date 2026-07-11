import type { CaptureMode } from "@webblackbox/protocol";

import type { ChromeApi, InjectionResult, ScriptInjectionTarget } from "../shared/chrome-api.js";
import {
  shouldInjectIsolatedContentForMode,
  shouldInjectMainWorldHooksForMode
} from "../shared/mode-profile.js";

const CONTENT_SCRIPT_FILE = "content.js";
const MAIN_WORLD_HOOK_FILE = "injected.js";

export type ContentScriptInjectionTarget =
  | {
      allFrames: boolean;
      documentId?: never;
      frameId?: never;
      tabId: number;
    }
  | {
      allFrames?: never;
      documentId: string;
      frameId: number;
      tabId: number;
    };

/**
 * The frame id remains available even when a document id is supplied so the
 * caller can keep top-frame failures fatal while treating child-frame failures
 * as best effort.
 */
export type MainWorldHookInjectionTarget = {
  documentId?: string;
  frameId: number;
  tabId: number;
};

export type RootPageAgentInjectionOptions = {
  contentTarget: ContentScriptInjectionTarget;
  mainWorldTarget: MainWorldHookInjectionTarget;
  mode: CaptureMode;
};

/**
 * Applies the mode boundary to initial, restored, and post-navigation root
 * instrumentation. The isolated content agent remains available in Full for
 * interaction hints, while page MAIN-world hooks are a Lite-only facility.
 */
export async function injectRootPageAgentsForMode(
  chromeApi: ChromeApi | null | undefined,
  options: RootPageAgentInjectionOptions
): Promise<void> {
  if (shouldInjectIsolatedContentForMode(options.mode)) {
    await injectContentScript(chromeApi, options.contentTarget);
  }

  if (shouldInjectMainWorldHooksForMode(options.mode)) {
    await injectMainWorldHook(chromeApi, options.mainWorldTarget);
  }
}

export async function injectContentScript(
  chromeApi: ChromeApi | null | undefined,
  target: ContentScriptInjectionTarget
): Promise<InjectionResult[]> {
  const injectionTarget = resolveContentInjectionTarget(target);
  const results = await executeScript(chromeApi, {
    target: injectionTarget,
    world: "ISOLATED",
    files: [CONTENT_SCRIPT_FILE]
  });
  const targetResult = target.documentId
    ? results.find((result) => result.documentId === target.documentId)
    : results.find((result) => result.frameId === 0);

  assertSuccessfulResult(
    targetResult,
    target.documentId
      ? "Content script injection did not succeed in its exact document target."
      : "Content script injection did not succeed in the main frame."
  );

  return results;
}

function resolveContentInjectionTarget(
  target: ContentScriptInjectionTarget
): ScriptInjectionTarget {
  if (target.documentId) {
    return {
      tabId: target.tabId,
      documentIds: [target.documentId]
    };
  }

  return {
    tabId: target.tabId,
    allFrames: target.allFrames
  };
}

export async function injectMainWorldHook(
  chromeApi: ChromeApi | null | undefined,
  target: MainWorldHookInjectionTarget
): Promise<InjectionResult[]> {
  const injectionTarget = resolveExactInjectionTarget(target);
  const results = await executeScript(chromeApi, {
    target: injectionTarget,
    world: "MAIN",
    files: [MAIN_WORLD_HOOK_FILE]
  });
  const targetResult = target.documentId
    ? results.find((result) => result.documentId === target.documentId)
    : results.find((result) => result.frameId === target.frameId);

  assertSuccessfulResult(targetResult, "Main-world hook injection did not succeed in its target.");

  return results;
}

function resolveExactInjectionTarget(target: MainWorldHookInjectionTarget): ScriptInjectionTarget {
  if (target.documentId) {
    return {
      tabId: target.tabId,
      documentIds: [target.documentId]
    };
  }

  return {
    tabId: target.tabId,
    frameIds: [target.frameId]
  };
}

async function executeScript(
  chromeApi: ChromeApi | null | undefined,
  options: Parameters<NonNullable<ChromeApi["scripting"]>["executeScript"]>[0]
): Promise<InjectionResult[]> {
  const scripting = chromeApi?.scripting;
  const execute = scripting?.executeScript;

  if (!scripting || !execute) {
    throw new Error("Chrome scripting.executeScript API is unavailable.");
  }

  return execute.call(scripting, options);
}

function assertSuccessfulResult(
  result: InjectionResult | undefined,
  message: string
): asserts result is InjectionResult {
  if (!result || (typeof result.error === "string" && result.error.length > 0)) {
    throw new Error(result?.error ? `${message} ${result.error}` : message);
  }
}
