import type { FreezeReason, RecorderConfig, WebBlackboxEvent } from "@webblackbox/protocol";

const NETWORK_FAILURE_WINDOW_MS = 10_000;
const NETWORK_FAILURE_THRESHOLD = 3;
const LONG_TASK_THRESHOLD_MS = 200;

export class FreezePolicy {
  private readonly networkFailures: number[] = [];

  public constructor(private readonly config: RecorderConfig) {}

  public evaluate(event: WebBlackboxEvent): FreezeReason | null {
    if (this.config.freezeOnError && isErrorEvent(event.type)) {
      return "error";
    }

    if (this.config.freezeOnNetworkFailure && event.type === "network.failed") {
      this.recordFailure(event.t);

      if (this.networkFailures.length >= NETWORK_FAILURE_THRESHOLD) {
        // Network failure spikes intentionally reuse the "error" freeze bucket.
        // FreezeReason is a coarse triage signal ("error" | "marker" | "perf" | "manual").
        return "error";
      }
    }

    if (this.config.freezeOnLongTaskSpike && event.type === "perf.longtask") {
      const duration = readDuration(event.data);

      if (duration >= LONG_TASK_THRESHOLD_MS) {
        return "perf";
      }
    }

    if (event.type === "user.marker") {
      return "marker";
    }

    return null;
  }

  private recordFailure(timestamp: number): void {
    this.networkFailures.push(timestamp);

    const threshold = timestamp - NETWORK_FAILURE_WINDOW_MS;

    while (this.networkFailures[0] && this.networkFailures[0] < threshold) {
      this.networkFailures.shift();
    }
  }
}

function isErrorEvent(type: string): boolean {
  return type === "error.exception" || type === "error.unhandledrejection";
}

function readDuration(payload: unknown): number {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return 0;
  }

  const maybeDuration = (payload as Record<string, unknown>).duration;

  if (typeof maybeDuration === "number" && Number.isFinite(maybeDuration)) {
    return maybeDuration;
  }

  return 0;
}
