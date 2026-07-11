export type BoundedMainWorldDeactivationResult =
  | Readonly<{ kind: "deactivated" }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "timed-out" }>;

/** Never drops the controller binding after a live document failed to deactivate. */
export function canFinalizeMainWorldRevocation(
  outcome: BoundedMainWorldDeactivationResult,
  documentReachable: boolean
): boolean {
  return outcome.kind === "deactivated" || !documentReachable;
}

/**
 * Waits only for the bounded revocation window while still observing a late
 * controller rejection so it never becomes an unhandled promise rejection.
 */
export async function runBoundedMainWorldDeactivation(options: {
  deactivate: () => Promise<void>;
  timeoutMs: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}): Promise<BoundedMainWorldDeactivationResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("MAIN-world deactivation timeout must be a positive safe integer.");
  }

  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const operation = Promise.resolve()
    .then(options.deactivate)
    .then(
      (): BoundedMainWorldDeactivationResult => ({ kind: "deactivated" }),
      (error: unknown): BoundedMainWorldDeactivationResult => ({ kind: "failed", error })
    );
  const timeout = new Promise<BoundedMainWorldDeactivationResult>((resolve) => {
    timer = setTimer(() => resolve({ kind: "timed-out" }), options.timeoutMs);
  });
  const result = await Promise.race([operation, timeout]);

  if (timer !== null) {
    clearTimer(timer);
  }
  return result;
}
