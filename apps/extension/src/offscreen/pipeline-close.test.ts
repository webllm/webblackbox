import { describe, expect, it, vi } from "vitest";

import { closeOffscreenPipelineSession, type ClosableOffscreenPipeline } from "./pipeline-close.js";

function createHarness() {
  return {
    pipelines: new Map<string, ClosableOffscreenPipeline>(),
    stopScreenRecording: vi.fn().mockResolvedValue(undefined),
    ingestIdempotencyRegistry: { clearSession: vi.fn() },
    screenRecordingTerminalResults: { clearSession: vi.fn() }
  };
}

describe("offscreen pipeline close", () => {
  it("purges an unknown session idempotently", async () => {
    const harness = createHarness();

    await closeOffscreenPipelineSession({ sid: "missing", purge: true, ...harness });
    await closeOffscreenPipelineSession({ sid: "missing", purge: true, ...harness });

    expect(harness.stopScreenRecording).toHaveBeenCalledTimes(2);
    expect(harness.ingestIdempotencyRegistry.clearSession).toHaveBeenCalledTimes(2);
    expect(harness.screenRecordingTerminalResults.clearSession).toHaveBeenCalledTimes(2);
  });

  it("stops recording, closes the pipeline, and clears session registries", async () => {
    const harness = createHarness();
    const close = vi.fn().mockResolvedValue(undefined);
    harness.pipelines.set("session-1", { close });

    await closeOffscreenPipelineSession({ sid: "session-1", purge: true, ...harness });

    expect(harness.stopScreenRecording).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ purge: true });
    expect(harness.pipelines.has("session-1")).toBe(false);
    expect(harness.ingestIdempotencyRegistry.clearSession).toHaveBeenCalledWith("session-1");
    expect(harness.screenRecordingTerminalResults.clearSession).toHaveBeenCalledWith("session-1");
  });

  it("still closes and clears when recording teardown reports an error", async () => {
    const harness = createHarness();
    const close = vi.fn().mockResolvedValue(undefined);
    const onScreenRecordingStopError = vi.fn();
    harness.pipelines.set("session-1", { close });
    harness.stopScreenRecording.mockRejectedValueOnce(new Error("recorder failed"));

    await closeOffscreenPipelineSession({
      sid: "session-1",
      purge: true,
      ...harness,
      onScreenRecordingStopError
    });

    expect(onScreenRecordingStopError).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(harness.pipelines.has("session-1")).toBe(false);
  });
});
