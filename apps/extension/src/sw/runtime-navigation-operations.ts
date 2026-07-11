import type { RuntimeNavigationSource } from "./runtime-navigation-claim.js";

export type TabNavigationSignal = Readonly<{
  candidateUrl?: string;
  completed: boolean;
  source: Extract<RuntimeNavigationSource, "tabs-url" | "tabs-complete" | "tabs-url-complete">;
}>;

export type GuardedNavigationStepResult<Value> =
  | Readonly<{ status: "skipped" }>
  | Readonly<{ status: "stale"; value: Value }>
  | Readonly<{ status: "current"; value: Value }>;

export type CdpNavigationPrimeOutcome = "root-invalid" | "global-blocked" | "ready";

export type RuntimeNavigationTaskResult =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failed-closed"; error: unknown }>;

export type AmbiguousNavigationResourceStartResult =
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "retained"; error: unknown }>;

export type DetachedNavigationTask = Readonly<{
  run: () => void | Promise<void>;
  onFailure: (error: unknown) => void | Promise<void>;
  onSettled?: () => void;
  onUnhandledFailure?: (error: unknown) => void;
}>;

/** Normalizes one tabs.onUpdated callback into at most one navigation claim. */
export function resolveTabNavigationSignal(input: {
  url?: string;
  status?: string;
}): TabNavigationSignal | null {
  const candidateUrl =
    typeof input.url === "string" && input.url.length > 0 ? input.url : undefined;
  const completed = input.status === "complete";

  if (!candidateUrl && !completed) {
    return null;
  }

  return Object.freeze({
    ...(candidateUrl === undefined ? {} : { candidateUrl }),
    completed,
    source: candidateUrl ? (completed ? "tabs-url-complete" : "tabs-url") : "tabs-complete"
  });
}

/**
 * Runs one async boundary only while its navigation owner is current and
 * reports a completion that lost ownership without discarding its value.
 */
export async function runGuardedNavigationStep<Value>(
  isCurrent: () => boolean,
  operation: () => Value | Promise<Value>
): Promise<GuardedNavigationStepResult<Value>> {
  if (!isCurrent()) {
    return { status: "skipped" };
  }

  const value = await operation();
  return isCurrent() ? { status: "current", value } : { status: "stale", value };
}

/** Distinguishes a completed operation from one skipped before it started. */
export function didGuardedNavigationOperationRun<Value>(
  result: GuardedNavigationStepResult<Value>
): result is Exclude<GuardedNavigationStepResult<Value>, Readonly<{ status: "skipped" }>> {
  return result.status !== "skipped";
}

/** Stops only the still-current owner when a queued navigation task rejects. */
export async function runRuntimeNavigationTask(
  isCurrent: () => boolean,
  task: () => void | Promise<void>,
  stopCurrent: () => void | Promise<void>
): Promise<RuntimeNavigationTaskResult> {
  try {
    const result = await runGuardedNavigationStep(isCurrent, task);
    return result.status === "current" ? { kind: "completed" } : { kind: "stale" };
  } catch (error) {
    if (!isCurrent()) {
      return { kind: "stale" };
    }

    await stopCurrent();
    return { kind: "failed-closed", error };
  }
}

/**
 * Starts a guarded navigation continuation without returning its promise to a
 * caller's general-purpose queue. This keeps a hung old restore from holding
 * the queue tail while the restore lane applies its own generation ordering.
 */
export function launchDetachedNavigationTask(task: DetachedNavigationTask): void {
  const running = (async () => {
    try {
      await task.run();
    } catch (error) {
      await task.onFailure(error);
    } finally {
      task.onSettled?.();
    }
  })();

  void running.catch((error) => {
    task.onUnhandledFailure?.(error);
  });
}

/** Keeps a valid root usable while distinguishing child-only global blocking. */
export function resolveCdpNavigationPrimeOutcome(input: {
  rootValid: boolean;
  globalCaptureReady: boolean;
}): CdpNavigationPrimeOutcome {
  if (!input.rootValid) {
    return "root-invalid";
  }

  return input.globalCaptureReady ? "ready" : "global-blocked";
}

/** Prevents stale stop/start work from operating on a replacement resource. */
export function canOperateOnExpectedNavigationResource<Resource>(
  isCurrent: () => boolean,
  current: Resource | null,
  expected: Resource | null
): expected is Resource {
  return expected !== null && current === expected && isCurrent();
}

/**
 * Reconciles an unknown start result by stopping only the exact local resource.
 * A failed stop deliberately retains the identity for outer transaction cleanup.
 */
export async function reconcileAmbiguousNavigationResourceStart<Resource>(input: {
  current: () => Resource | null;
  expected: Resource;
  stop: (expected: Resource) => void | Promise<void>;
}): Promise<AmbiguousNavigationResourceStartResult> {
  if (input.current() !== input.expected) {
    return { kind: "stale" };
  }

  try {
    await input.stop(input.expected);
    return { kind: "stopped" };
  } catch (error) {
    return { kind: "retained", error };
  }
}
