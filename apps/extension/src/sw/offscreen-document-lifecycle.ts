export type EnsureOffscreenDocumentOptions = Readonly<{
  exists: () => Promise<boolean>;
  create: () => Promise<void>;
}>;

export type CloseOffscreenDocumentOptions = Readonly<{
  isUnused: () => boolean;
  close: () => Promise<void>;
}>;

/** Serializes create/close and shares concurrent creation without retaining failed attempts. */
export class OffscreenDocumentLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private ensureTask: Promise<void> | null = null;

  public ensure(options: EnsureOffscreenDocumentOptions): Promise<void> {
    if (this.ensureTask) {
      return this.ensureTask;
    }

    const task = this.enqueue(async () => {
      if (!(await options.exists())) {
        await options.create();
      }
    });
    this.ensureTask = task;
    void task.then(
      () => {
        if (this.ensureTask === task) {
          this.ensureTask = null;
        }
      },
      () => {
        if (this.ensureTask === task) {
          this.ensureTask = null;
        }
      }
    );
    return task;
  }

  public closeIfUnused(options: CloseOffscreenDocumentOptions): Promise<void> {
    return this.enqueue(async () => {
      if (options.isUnused()) {
        await options.close();
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.tail.catch(() => undefined).then(operation);
    this.tail = task;
    return task;
  }
}
