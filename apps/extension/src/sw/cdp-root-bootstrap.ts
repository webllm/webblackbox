import type { CapturePolicy } from "@webblackbox/protocol";

const ROOT_BASELINE_STAGES = [
  ["network-enable", "Network.enable"],
  ["runtime-baseline-enable", "Runtime.enable"],
  ["log-enable", "Log.enable"],
  ["page-enable", "Page.enable"]
] as const;

export type CdpRootBootstrapStage =
  | "debugger-attach"
  | (typeof ROOT_BASELINE_STAGES)[number][0]
  | "subframe-auto-attach"
  | "frame-tree-prime"
  | "execution-context-clear"
  | "runtime-disable"
  | "runtime-enable"
  | "performance-enable";

export type CdpRootBootstrapCommands = {
  attach: () => Promise<void>;
  clearExecutionContextScopes: () => void;
  enableAutoAttach: () => Promise<void>;
  primeFrameTree: () => Promise<CdpRootFrameTreePrime>;
  send: (method: string) => Promise<unknown>;
};

export type CdpRootBootstrapOptions = {
  cdpLevel: CapturePolicy["categories"]["cdp"];
  commands: CdpRootBootstrapCommands;
  includeSubframes: boolean;
};

export type CdpRootBootstrapResult = Readonly<{
  domStorageEnabled: boolean;
  globalCaptureReady: boolean;
  performanceEnabled: boolean;
}>;

export type CdpRootFrameTreePrime = Readonly<{
  globalCaptureReady: boolean;
  rootValid: boolean;
}>;

export class CdpRootBootstrapError extends Error {
  public readonly stage: CdpRootBootstrapStage;

  public override readonly cause: unknown;

  public constructor(stage: CdpRootBootstrapStage, cause: unknown) {
    super(`Full CDP root bootstrap failed at ${stage}: ${describeFailure(cause)}`);
    this.name = "CdpRootBootstrapError";
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Establishes the minimum root CDP contract promised by Full mode. Optional
 * artifact domains stay outside this transaction so they cannot silently
 * weaken the root network/runtime/page baseline.
 */
export async function bootstrapCdpRoot(
  options: CdpRootBootstrapOptions
): Promise<CdpRootBootstrapResult> {
  const { commands } = options;

  await runHardStage("debugger-attach", commands.attach);

  for (const [stage, method] of ROOT_BASELINE_STAGES) {
    await runHardStage(stage, () => commands.send(method));
  }

  if (options.includeSubframes) {
    await runHardStage("subframe-auto-attach", commands.enableAutoAttach);
  }

  const frameTreePrime = await runHardStage("frame-tree-prime", async () => {
    const result = await commands.primeFrameTree();

    if (!result.rootValid) {
      throw new Error("Page.getFrameTree did not produce a valid current root capture scope.");
    }

    return result;
  });

  await runHardStage("execution-context-clear", commands.clearExecutionContextScopes);
  await runHardStage("runtime-disable", () => commands.send("Runtime.disable"));
  await runHardStage("runtime-enable", () => commands.send("Runtime.enable"));

  let domStorageEnabled = false;

  try {
    await commands.send("DOMStorage.enable");
    domStorageEnabled = true;
  } catch {
    // DOM storage events are an optional Full artifact; the root baseline is still usable.
  }

  const performanceEnabled = options.cdpLevel === "full";

  if (performanceEnabled) {
    await runHardStage("performance-enable", () => commands.send("Performance.enable"));
  }

  return {
    domStorageEnabled,
    globalCaptureReady: frameTreePrime.globalCaptureReady,
    performanceEnabled
  };
}

/** Preserves the bootstrap stage while still surfacing a failed cleanup. */
export async function cleanupAndRethrowCdpRootBootstrapFailure(
  failure: unknown,
  cleanup: () => Promise<void>
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      "Full CDP root bootstrap and its cleanup both failed."
    );
  }

  throw failure;
}

async function runHardStage<TResult>(
  stage: CdpRootBootstrapStage,
  operation: () => Promise<TResult> | TResult
): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CdpRootBootstrapError) {
      throw error;
    }

    throw new CdpRootBootstrapError(stage, error);
  }
}

function describeFailure(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
