export type RootNavigationInstrumentationResult =
  | { kind: "completed" }
  | { kind: "failed-closed"; error: unknown }
  | { kind: "stale" };

export type RootNavigationInstrumentationOptions = {
  continueAfterInjection: (assertCurrent: () => void) => Promise<void>;
  inject: (assertCurrent: () => void) => Promise<void>;
  isCurrent: () => boolean;
  stopCurrent: () => Promise<void>;
};

class StaleRootNavigationError extends Error {
  public constructor() {
    super("The root navigation runtime was replaced.");
    this.name = "StaleRootNavigationError";
  }
}

/**
 * Keeps post-navigation root injection identity-safe. Injection failures stop
 * only the runtime that requested the work, while a replacement makes the
 * result stale and never reaches CDP restoration or content notification.
 */
export async function runRootNavigationInstrumentationTransaction(
  options: RootNavigationInstrumentationOptions
): Promise<RootNavigationInstrumentationResult> {
  const assertCurrent = () => {
    if (!options.isCurrent()) {
      throw new StaleRootNavigationError();
    }
  };

  try {
    assertCurrent();
    await options.inject(assertCurrent);
    assertCurrent();
  } catch (error) {
    if (error instanceof StaleRootNavigationError || !options.isCurrent()) {
      return { kind: "stale" };
    }

    await options.stopCurrent();
    return { kind: "failed-closed", error };
  }

  try {
    assertCurrent();
    await options.continueAfterInjection(assertCurrent);
    assertCurrent();
  } catch (error) {
    if (error instanceof StaleRootNavigationError || !options.isCurrent()) {
      return { kind: "stale" };
    }

    throw error;
  }

  return { kind: "completed" };
}
