export type ScreenRecordingChunkWriteInput = Readonly<{
  index: number;
  fingerprint: string;
  putBlob: () => Promise<string>;
  enqueueEvent: (hash: string) => void | Promise<void>;
  flush: () => void | Promise<void>;
  getDurableHash: () => string | undefined;
  commitDurable: (hash: string) => void;
}>;

export type DurableScreenRecordingFinalizationOptions = Readonly<{
  beginCompletionCheckpoint: () => void;
  rollbackCompletionCheckpoint: () => void;
  persistCompletionCheckpoint: () => Promise<void>;
  writeTerminalEvidence: () => Promise<void>;
  commit: () => void;
}>;

export type RetriedScreenRecordingFinalizationOptions = Readonly<{
  maxAttempts: number;
  isCurrent: () => boolean;
  finalize: () => Promise<void>;
  waitForRetry: (attempt: number) => Promise<void>;
}>;

type ScreenRecordingChunkWriteState = {
  readonly fingerprint: string;
  hash?: string;
  eventQueued: boolean;
  task: Promise<string> | null;
};

/** Coalesces terminal notifications and explicit stop responses for one recording identity. */
export class ScreenRecordingFinalizationGate {
  private pending: Promise<void> | null = null;

  public run(operation: () => Promise<void>): Promise<void> {
    if (this.pending) {
      return this.pending;
    }

    const task = Promise.resolve().then(operation);
    this.pending = task;
    void task.then(
      () => {
        if (this.pending === task) {
          this.pending = null;
        }
      },
      () => {
        if (this.pending === task) {
          this.pending = null;
        }
      }
    );
    return task;
  }
}

/** Checkpoints the absence of a live recorder before its terminal event removes resume evidence. */
export async function runDurableScreenRecordingFinalization(
  options: DurableScreenRecordingFinalizationOptions
): Promise<void> {
  options.beginCompletionCheckpoint();
  try {
    await options.persistCompletionCheckpoint();
  } catch (error) {
    options.rollbackCompletionCheckpoint();
    throw error;
  }

  await options.writeTerminalEvidence();
  options.commit();
}

/** Retries one spontaneous terminal result while its exact runtime identity remains current. */
export async function retryScreenRecordingFinalization(
  options: RetriedScreenRecordingFinalizationOptions
): Promise<void> {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) {
    throw new Error("Screen recording finalization attempts must be a positive safe integer.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (!options.isCurrent()) {
      return;
    }
    try {
      await options.finalize();
      return;
    } catch (error) {
      lastError = error;
      if (!options.isCurrent()) {
        return;
      }
      if (attempt === options.maxAttempts) {
        break;
      }
      await options.waitForRetry(attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Screen recording finalization failed: ${String(lastError)}`);
}

/** Coalesces exact retries and retains pre-flush progress after a transient failure. */
export class ScreenRecordingChunkWriteLedger {
  private readonly writes = new Map<number, ScreenRecordingChunkWriteState>();

  public execute(input: ScreenRecordingChunkWriteInput): Promise<string> {
    if (!Number.isSafeInteger(input.index) || input.index < 0 || input.fingerprint.length === 0) {
      return Promise.reject(new Error("Invalid screen recording chunk write identity."));
    }

    let state = this.writes.get(input.index);
    if (state && state.fingerprint !== input.fingerprint) {
      return Promise.reject(
        new Error("Screen recording chunk index was reused with different metadata.")
      );
    }
    if (!state) {
      state = {
        fingerprint: input.fingerprint,
        eventQueued: false,
        task: null
      };
      this.writes.set(input.index, state);
    }
    if (state.task) {
      return state.task;
    }

    const write = state;
    const task = this.executeAttempt(write, input);
    write.task = task;
    void task.then(
      () => {
        if (write.task === task) {
          write.task = null;
          this.writes.delete(input.index);
        }
      },
      () => {
        if (write.task === task) write.task = null;
      }
    );
    return task;
  }

  private async executeAttempt(
    state: ScreenRecordingChunkWriteState,
    input: ScreenRecordingChunkWriteInput
  ): Promise<string> {
    const hash = await input.putBlob();
    if (state.hash && state.hash !== hash) {
      throw new Error("Screen recording chunk index was reused with different bytes.");
    }
    state.hash = hash;

    const durableHash = input.getDurableHash();
    if (durableHash) {
      if (durableHash !== hash) {
        throw new Error("Durable screen recording chunk identity does not match its replay.");
      }
      return hash;
    }

    if (!state.eventQueued) {
      await input.enqueueEvent(hash);
      state.eventQueued = true;
    }
    await input.flush();
    input.commitDurable(hash);
    return hash;
  }
}
