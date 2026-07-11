export type PersistedSessionAnnotation = Readonly<{
  tags: readonly string[];
  note?: string;
}>;

type RuntimeWithPersistedSessionAnnotation<Runtime> = Runtime extends unknown
  ? Omit<Runtime, "tags" | "note"> & { tags: string[]; note?: string }
  : never;

/**
 * Serializes the complete mutation transaction for the shared annotation
 * checkpoint. A sid remains part of the API so callers cannot accidentally
 * coalesce an anonymous mutation, while the single tail also protects writes
 * for different sids that share one chrome.storage object.
 */
export class SessionAnnotationMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public run<Result>(sid: string, operation: () => Promise<Result>): Promise<Result> {
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 256) {
      return Promise.reject(new Error("Invalid session annotation identity."));
    }

    const task = this.tail.catch(() => undefined).then(operation);
    this.tail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}

export async function commitSessionAnnotationMutation(options: {
  apply: () => void;
  rollback: () => void;
  persist: () => Promise<void>;
}): Promise<void> {
  options.apply();
  try {
    await options.persist();
  } catch (error) {
    options.rollback();
    throw error;
  }
}

/** Makes the independently durable annotation row authoritative during runtime restoration. */
export function mergePersistedSessionAnnotation<
  Runtime extends Readonly<{ tags: readonly string[]; note?: string }>
>(
  runtime: Runtime,
  annotation: PersistedSessionAnnotation | undefined
): RuntimeWithPersistedSessionAnnotation<Runtime> {
  if (!annotation) {
    return {
      ...runtime,
      tags: [...runtime.tags]
    } as unknown as RuntimeWithPersistedSessionAnnotation<Runtime>;
  }

  const { note: _discardedNote, ...base } = runtime;
  void _discardedNote;
  return {
    ...base,
    tags: [...annotation.tags],
    ...(annotation.note ? { note: annotation.note } : {})
  } as RuntimeWithPersistedSessionAnnotation<Runtime>;
}
