/** Serializes every pipeline operation for one sid while allowing unrelated sessions to proceed. */
export class PipelineRequestCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  public run<Result>(sid: string, operation: () => Promise<Result>): Promise<Result> {
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 256) {
      return Promise.reject(new Error("Invalid pipeline request session identity."));
    }

    const predecessor = this.tails.get(sid) ?? Promise.resolve();
    const task = predecessor.catch(() => undefined).then(operation);
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(sid, tail);
    void tail.then(() => {
      if (this.tails.get(sid) === tail) {
        this.tails.delete(sid);
      }
    });
    return task;
  }

  public hasPending(sid: string): boolean {
    return this.tails.has(sid);
  }
}

/**
 * Stops media outside the data FIFO so its final chunk can re-enter through
 * putBlob/ingest, then places the destructive close behind that durable tail.
 */
export async function runTwoPhasePipelineClose<Result>(options: {
  coordinator: PipelineRequestCoordinator;
  sid: string;
  stopScreenRecording: () => Promise<void>;
  closePipeline: () => Promise<Result>;
  onScreenRecordingStopError?: (error: unknown) => void;
}): Promise<Result> {
  try {
    await options.stopScreenRecording();
  } catch (error) {
    options.onScreenRecordingStopError?.(error);
  }
  return options.coordinator.run(options.sid, options.closePipeline);
}

/** Places later work after an already-reserved close, preserving arrival order. */
export async function runAfterPipelineClose<Result>(options: {
  coordinator: PipelineRequestCoordinator;
  sid: string;
  pendingClose: Promise<unknown> | undefined;
  operation: () => Promise<Result>;
}): Promise<Result> {
  await options.pendingClose?.catch(() => undefined);
  return options.coordinator.run(options.sid, options.operation);
}
