import type { CaptureMode } from "@webblackbox/protocol";
import type {
  InjectedDirectBootstrapResult,
  InjectedDirectCommand,
  InjectedDirectControlResult
} from "webblackbox/injected-hooks";

import type { ChromeApi, InjectionResult, ScriptInjectionTarget } from "../shared/chrome-api.js";
import { parseContentActivationId } from "../shared/content-activation-protocol.js";
import {
  advanceMainWorldControllerHint,
  createMainWorldControllerHint,
  parseInjectedDirectBootstrapResult,
  parseInjectedDirectControlResult,
  parseMainWorldControllerHint,
  parseMainWorldControllerSeedAck,
  type MainWorldControllerHint
} from "../shared/main-world-controller.js";
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
export type MainWorldHookInjectionTarget =
  | {
      documentId?: string;
      frameId: number;
      allFrames?: never;
      tabId: number;
    }
  | {
      allFrames: true;
      documentId?: never;
      frameId?: never;
      tabId: number;
    };

export type RootPageAgentInjectionStep = "isolated-content" | "main-world-hook";

export type RootPageAgentInjectionOptions = {
  assertCurrent?: () => void;
  beforeEach?: (step: RootPageAgentInjectionStep) => Promise<void> | void;
  contentTarget: ContentScriptInjectionTarget;
  mainWorldTarget: MainWorldHookInjectionTarget;
  mode: CaptureMode;
};

export type RootPageAgentInjectionResult = Readonly<{
  contentResults: InjectionResult[];
  mainWorldResults: MainWorldControllerInjectionResult[];
}>;

export type MainWorldControllerInjectionResult = InjectionResult<InjectedDirectBootstrapResult> & {
  controller: MainWorldControllerHint;
};

export type ExactMainWorldDirectTarget = Readonly<{
  documentId: string;
  frameId: number;
  tabId: number;
}>;

export { createMainWorldControllerHint } from "../shared/main-world-controller.js";

/**
 * Applies the mode boundary to initial, restored, and post-navigation root
 * instrumentation. The isolated content agent remains available in Full for
 * interaction hints, while page MAIN-world hooks are a Lite-only facility.
 */
export async function injectRootPageAgentsForMode(
  chromeApi: ChromeApi | null | undefined,
  options: RootPageAgentInjectionOptions
): Promise<RootPageAgentInjectionResult> {
  let contentResults: InjectionResult[] = [];
  let mainWorldResults: MainWorldControllerInjectionResult[] = [];

  if (shouldInjectIsolatedContentForMode(options.mode)) {
    contentResults = await runGuardedRootInjection(options, "isolated-content", () =>
      injectContentScript(chromeApi, options.contentTarget)
    );
  }

  if (shouldInjectMainWorldHooksForMode(options.mode)) {
    mainWorldResults = await runGuardedRootInjection(options, "main-world-hook", () =>
      bootstrapMainWorldControllersForContentResults(chromeApi, contentResults, options)
    );
  }

  return { contentResults, mainWorldResults };
}

async function bootstrapMainWorldControllersForContentResults(
  chromeApi: ChromeApi | null | undefined,
  contentResults: InjectionResult[],
  options: RootPageAgentInjectionOptions
): Promise<MainWorldControllerInjectionResult[]> {
  const injected: MainWorldControllerInjectionResult[] = [];
  for (const contentResult of contentResults) {
    if (
      contentResult.error ||
      typeof contentResult.documentId !== "string" ||
      contentResult.documentId.length === 0
    ) {
      continue;
    }
    options.assertCurrent?.();
    const target: ExactMainWorldDirectTarget = {
      tabId: options.contentTarget.tabId,
      frameId: contentResult.frameId,
      documentId: contentResult.documentId
    };
    const controller = createMainWorldControllerHint();
    try {
      const seeded = await seedMainWorldControllerHint(chromeApi, target, controller);
      options.assertCurrent?.();
      const result = await bootstrapMainWorldDirectController(chromeApi, target, seeded);
      if (result.kind !== "installed" && result.kind !== "existing") {
        throw new Error("MAIN-world direct bootstrap rejected its seeded controller.");
      }
      options.assertCurrent?.();
      const probe = await controlMainWorldDirectController(chromeApi, target, seeded, {
        kind: "probe"
      });
      const advanced = advanceControllerFromControl(seeded, probe);
      if (!advanced) {
        throw new Error("MAIN-world direct bootstrap did not match its seeded controller.");
      }
      injected.push({ ...contentResult, result, controller: advanced });
    } catch (error) {
      if (contentResult.frameId === 0) {
        throw error;
      }
      injected.push({
        frameId: contentResult.frameId,
        ...(contentResult.documentId ? { documentId: contentResult.documentId } : {}),
        error: error instanceof Error ? error.message : String(error),
        controller
      });
    }
  }
  return injected;
}

async function runGuardedRootInjection<Result>(
  options: RootPageAgentInjectionOptions,
  step: RootPageAgentInjectionStep,
  inject: () => Promise<Result>
): Promise<Result> {
  await options.beforeEach?.(step);
  options.assertCurrent?.();
  const result = await inject();
  options.assertCurrent?.();
  return result;
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

/** Seeds the capability before any MAIN install so SW restart can recover it from isolated. */
export async function seedMainWorldControllerHint(
  chromeApi: ChromeApi | null | undefined,
  target: ExactMainWorldDirectTarget,
  controller: MainWorldControllerHint
): Promise<MainWorldControllerHint> {
  const parsedController = parseMainWorldControllerHint(controller);
  const sendMessage = chromeApi?.tabs?.sendMessage;
  if (!parsedController || !sendMessage) {
    throw new Error(
      parsedController
        ? "Chrome tabs.sendMessage API is unavailable for isolated controller seeding."
        : "Invalid MAIN-world direct controller hint."
    );
  }
  const response = await sendMessage.call(
    chromeApi.tabs,
    target.tabId,
    { kind: "sw.main-world-controller-seed", controller: parsedController },
    { frameId: target.frameId, documentId: target.documentId }
  );
  const acknowledgement = parseMainWorldControllerSeedAck(response);
  if (!acknowledgement) {
    throw new Error("Isolated content singleton rejected the exact MAIN-world controller seed.");
  }
  return acknowledgement.controller;
}

/** Bootstraps one unguessable ESM module instance in one exact MAIN document. */
export async function bootstrapMainWorldDirectController(
  chromeApi: ChromeApi | null | undefined,
  target: ExactMainWorldDirectTarget,
  controller: MainWorldControllerHint
): Promise<InjectedDirectBootstrapResult> {
  const parsedController = parseMainWorldControllerHint(controller);
  if (!parsedController) {
    throw new Error("Invalid MAIN-world direct controller hint.");
  }
  const moduleUrl = resolveMainWorldDirectModuleUrl(chromeApi, parsedController.moduleNonce);
  const results = await executeScript<InjectedDirectBootstrapResult>(chromeApi, {
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    world: "MAIN",
    func: invokeMainWorldDirectBootstrap as (...args: never[]) => unknown,
    args: [moduleUrl, parsedController.secret]
  });
  const targetResult = results.find(
    (result) => result.frameId === target.frameId && result.documentId === target.documentId
  );
  assertSuccessfulResult(
    targetResult,
    "MAIN-world direct bootstrap did not succeed in its exact document target."
  );
  const parsedResult = parseInjectedDirectBootstrapResult(targetResult.result);
  if (!parsedResult) {
    throw new Error("MAIN-world direct bootstrap returned an invalid result.");
  }
  return parsedResult;
}

/** Executes one strict command in the exact ESM instance selected by its module nonce. */
export async function controlMainWorldDirectController(
  chromeApi: ChromeApi | null | undefined,
  target: ExactMainWorldDirectTarget,
  controller: MainWorldControllerHint,
  command: InjectedDirectCommand
): Promise<InjectedDirectControlResult> {
  const parsedController = parseMainWorldControllerHint(controller);
  if (!parsedController) {
    throw new Error("Invalid MAIN-world direct controller hint.");
  }
  const moduleUrl = resolveMainWorldDirectModuleUrl(chromeApi, parsedController.moduleNonce);
  const results = await executeScript<InjectedDirectControlResult>(chromeApi, {
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    world: "MAIN",
    func: invokeMainWorldDirectControl as (...args: never[]) => unknown,
    args: [moduleUrl, parsedController.secret, command]
  });
  const targetResult = results.find(
    (result) => result.frameId === target.frameId && result.documentId === target.documentId
  );
  assertSuccessfulResult(
    targetResult,
    "MAIN-world direct control did not succeed in its exact document target."
  );
  const parsedResult = parseInjectedDirectControlResult(targetResult.result);
  if (!parsedResult) {
    throw new Error("MAIN-world direct control returned an invalid result.");
  }
  return parsedResult;
}

export function advanceControllerFromBootstrap(
  controller: MainWorldControllerHint,
  result: InjectedDirectBootstrapResult
): MainWorldControllerHint | null {
  if (result.kind !== "installed" && result.kind !== "existing") {
    return null;
  }
  const activationId = result.phase === "inactive" ? null : controller.activationId;
  if (result.phase !== "inactive" && !activationId) {
    return null;
  }
  return advanceMainWorldControllerHint(controller, {
    revision: result.revision,
    phase: result.phase,
    activationId
  });
}

export function advanceControllerFromControl(
  controller: MainWorldControllerHint,
  result: InjectedDirectControlResult
): MainWorldControllerHint | null {
  switch (result.kind) {
    case "probed": {
      const activationId =
        result.activationId === null ? null : parseContentActivationId(result.activationId);
      if (result.activationId !== null && !activationId) {
        return null;
      }
      return advanceMainWorldControllerHint(controller, {
        revision: result.revision,
        phase: result.phase,
        activationId
      });
    }
    case "activated": {
      const activationId = parseContentActivationId(result.activationId);
      if (!activationId) return null;
      return advanceMainWorldControllerHint(controller, {
        revision: result.revision,
        phase: "active",
        activationId
      });
    }
    case "deactivated":
      return advanceMainWorldControllerHint(controller, {
        revision: result.revision,
        phase: "inactive",
        activationId: null
      });
    case "drained": {
      const activationId = parseContentActivationId(result.activationId);
      if (!activationId) return null;
      return advanceMainWorldControllerHint(controller, {
        revision: result.revision,
        phase: "drained",
        activationId
      });
    }
    default:
      return null;
  }
}

function resolveMainWorldDirectModuleUrl(
  chromeApi: ChromeApi | null | undefined,
  moduleNonce: string
): string {
  const getURL = chromeApi?.runtime?.getURL;
  if (!getURL) {
    throw new Error("Chrome runtime.getURL API is unavailable.");
  }
  return `${getURL.call(chromeApi.runtime, MAIN_WORLD_HOOK_FILE)}#${moduleNonce}`;
}

async function invokeMainWorldDirectBootstrap(moduleUrl: string, secret: string): Promise<unknown> {
  const namespace = (await import(moduleUrl)) as Record<string, unknown>;
  const bootstrap = namespace.bootstrap;
  return typeof bootstrap === "function" ? bootstrap(secret) : { kind: "unavailable" };
}

async function invokeMainWorldDirectControl(
  moduleUrl: string,
  secret: string,
  command: unknown
): Promise<unknown> {
  const namespace = (await import(moduleUrl)) as Record<string, unknown>;
  const control = namespace.control;
  return typeof control === "function" ? control(secret, command) : { kind: "unavailable" };
}

async function executeScript<TResult = unknown>(
  chromeApi: ChromeApi | null | undefined,
  options: Parameters<NonNullable<ChromeApi["scripting"]>["executeScript"]>[0]
): Promise<InjectionResult<TResult>[]> {
  const scripting = chromeApi?.scripting;
  const execute = scripting?.executeScript;

  if (!scripting || !execute) {
    throw new Error("Chrome scripting.executeScript API is unavailable.");
  }

  return execute.call(scripting, options) as Promise<InjectionResult<TResult>[]>;
}

function assertSuccessfulResult(
  result: InjectionResult | undefined,
  message: string
): asserts result is InjectionResult {
  if (!result || (typeof result.error === "string" && result.error.length > 0)) {
    throw new Error(result?.error ? `${message} ${result.error}` : message);
  }
}
