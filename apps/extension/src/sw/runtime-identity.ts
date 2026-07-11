export type RuntimeIdentity = {
  sid: string;
  tabId: number;
};

export function cancelOwnedRuntimeStart(token: { cancel(): void } | null): void {
  token?.cancel();
}

export function resolveRuntimeEventOwner<TRuntime extends RuntimeIdentity>(
  sessionsBySid: ReadonlyMap<string, TRuntime>,
  sessionsByTab: ReadonlyMap<number, TRuntime>,
  event: { sid?: string; tabId: number }
): TRuntime | undefined {
  if (typeof event.sid === "string") {
    const runtime = sessionsBySid.get(event.sid);
    return runtime?.tabId === event.tabId ? runtime : undefined;
  }

  return sessionsByTab.get(event.tabId);
}

export class RuntimeTaskCoordinator<TRuntime extends object> {
  readonly #tasks = new WeakMap<TRuntime, Promise<void>>();

  public run(runtime: TRuntime, task: () => Promise<void>): Promise<void> {
    const existing = this.#tasks.get(runtime);

    if (existing) {
      return existing;
    }

    const pending = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.#tasks.get(runtime) === pending) {
          this.#tasks.delete(runtime);
        }
      });
    this.#tasks.set(runtime, pending);
    return pending;
  }
}
