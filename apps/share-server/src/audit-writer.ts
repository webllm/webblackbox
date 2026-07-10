export type AuditWriteResult =
  | {
      status: "written";
      recovered: boolean;
    }
  | {
      status: "dropped";
      reason: "queue-capacity" | "queue-timeout" | "circuit-open";
    }
  | {
      status: "failed";
      reason: "write-error" | "write-timeout";
      error?: unknown;
    };

export type BoundedAuditWriterOptions = {
  append: (line: string, signal: AbortSignal) => Promise<void>;
  maxQueuedEntries: number;
  queueWaitTimeoutMs: number;
  writeTimeoutMs: number;
  retryCooldownMs: number;
};

type CircuitState = "closed" | "open" | "half-open";

/**
 * Serializes audit appends without allowing a slow filesystem to create an
 * unbounded request backlog. A timed-out physical append remains counted until
 * it actually settles, so an uninterruptible filesystem operation cannot cause
 * repeated probes to accumulate behind it.
 */
export class BoundedAuditWriter {
  private readonly append: BoundedAuditWriterOptions["append"];
  private readonly maxQueuedEntries: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly retryCooldownMs: number;
  private readonly pendingPhysicalWrites = new Set<Promise<unknown>>();
  private tail: Promise<void> = Promise.resolve();
  private queuedEntries = 0;
  private activePhysicalWrites = 0;
  private circuitState: CircuitState = "closed";
  private circuitRetryAt = 0;

  constructor(options: BoundedAuditWriterOptions) {
    assertPositiveInteger("maxQueuedEntries", options.maxQueuedEntries);
    assertPositiveInteger("queueWaitTimeoutMs", options.queueWaitTimeoutMs);
    assertPositiveInteger("writeTimeoutMs", options.writeTimeoutMs);
    assertPositiveInteger("retryCooldownMs", options.retryCooldownMs);

    this.append = options.append;
    this.maxQueuedEntries = options.maxQueuedEntries;
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs;
    this.writeTimeoutMs = options.writeTimeoutMs;
    this.retryCooldownMs = options.retryCooldownMs;
  }

  write(line: string): Promise<AuditWriteResult> {
    const enqueuedAt = performance.now();
    const probe = this.tryReserveCircuitProbe(enqueuedAt);

    if (probe === null) {
      return Promise.resolve({
        status: "dropped",
        reason: "circuit-open"
      });
    }

    if (this.queuedEntries >= this.maxQueuedEntries) {
      if (probe) {
        this.reopenCircuit(enqueuedAt);
      }
      return Promise.resolve({
        status: "dropped",
        reason: "queue-capacity"
      });
    }

    this.queuedEntries += 1;
    const operation = this.tail
      .then(() => this.runQueuedWrite(line, enqueuedAt, probe))
      .catch((error: unknown): AuditWriteResult => {
        this.reopenCircuit(performance.now());
        return {
          status: "failed",
          reason: "write-error",
          error
        };
      });

    this.tail = operation.then(() => undefined);

    return operation.finally(() => {
      this.queuedEntries -= 1;
    });
  }

  async drain(): Promise<void> {
    while (true) {
      await this.tail;
      const pendingPhysicalWrites = [...this.pendingPhysicalWrites];
      if (pendingPhysicalWrites.length === 0) {
        return;
      }

      await Promise.allSettled(pendingPhysicalWrites);
    }
  }

  private tryReserveCircuitProbe(now: number): boolean | null {
    if (this.circuitState === "closed") {
      return false;
    }

    if (
      this.circuitState === "half-open" ||
      now < this.circuitRetryAt ||
      this.activePhysicalWrites > 0 ||
      this.queuedEntries > 0
    ) {
      return null;
    }

    this.circuitState = "half-open";
    return true;
  }

  private async runQueuedWrite(
    line: string,
    enqueuedAt: number,
    probe: boolean
  ): Promise<AuditWriteResult> {
    const now = performance.now();

    if (!probe && this.circuitState !== "closed") {
      return {
        status: "dropped",
        reason: "circuit-open"
      };
    }

    if (now - enqueuedAt >= this.queueWaitTimeoutMs) {
      if (probe) {
        this.reopenCircuit(now);
      }
      return {
        status: "dropped",
        reason: "queue-timeout"
      };
    }

    return this.runPhysicalWrite(line, probe);
  }

  private async runPhysicalWrite(line: string, probe: boolean): Promise<AuditWriteResult> {
    const abortController = new AbortController();
    this.activePhysicalWrites += 1;

    const physicalWrite = Promise.resolve()
      .then(() => this.append(line, abortController.signal))
      .then(
        () => ({ status: "written" as const }),
        (error: unknown) => ({ status: "failed" as const, error })
      )
      .finally(() => {
        this.activePhysicalWrites -= 1;
        this.pendingPhysicalWrites.delete(physicalWrite);
      });
    this.pendingPhysicalWrites.add(physicalWrite);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedWrite = new Promise<{ status: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), this.writeTimeoutMs);
    });
    const result = await Promise.race([physicalWrite, timedWrite]);

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    if (result.status === "timeout") {
      abortController.abort(new Error("Share audit append timed out."));
      this.reopenCircuit(performance.now());
      return {
        status: "failed",
        reason: "write-timeout"
      };
    }

    if (result.status === "failed") {
      this.reopenCircuit(performance.now());
      return {
        status: "failed",
        reason: "write-error",
        error: result.error
      };
    }

    const recovered = probe;
    if (probe) {
      this.circuitState = "closed";
      this.circuitRetryAt = 0;
    }
    return {
      status: "written",
      recovered
    };
  }

  private reopenCircuit(now: number): void {
    this.circuitState = "open";
    this.circuitRetryAt = now + this.retryCooldownMs;
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}
