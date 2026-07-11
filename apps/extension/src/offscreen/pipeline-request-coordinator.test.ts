import { describe, expect, it, vi } from "vitest";

import {
  PipelineRequestCoordinator,
  runAfterPipelineClose,
  runTwoPhasePipelineClose
} from "./pipeline-request-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("PipelineRequestCoordinator", () => {
  it("orders delayed start, ingest, and close for one exact sid", async () => {
    const coordinator = new PipelineRequestCoordinator();
    const startGate = deferred();
    const order: string[] = [];
    const start = coordinator.run("S-one", async () => {
      order.push("start:begin");
      await startGate.promise;
      order.push("start:end");
    });
    const ingest = coordinator.run("S-one", async () => {
      order.push("ingest");
    });
    const close = coordinator.run("S-one", async () => {
      order.push("close");
    });

    await vi.waitFor(() => expect(order).toEqual(["start:begin"]));
    startGate.resolve();
    await Promise.all([start, ingest, close]);
    expect(order).toEqual(["start:begin", "start:end", "ingest", "close"]);
    await vi.waitFor(() => expect(coordinator.hasPending("S-one")).toBe(false));
  });

  it("lets different sessions proceed independently", async () => {
    const coordinator = new PipelineRequestCoordinator();
    const firstGate = deferred();
    const first = coordinator.run("S-first", () => firstGate.promise);
    const second = vi.fn(async () => "ready");

    await expect(coordinator.run("S-second", second)).resolves.toBe("ready");
    expect(second).toHaveBeenCalledOnce();
    firstGate.resolve();
    await first;
  });

  it("continues the FIFO after a failed request", async () => {
    const coordinator = new PipelineRequestCoordinator();
    const failed = coordinator.run("S-retry", () => Promise.reject(new Error("start failed")));
    const next = coordinator.run("S-retry", async () => "closed");

    await expect(failed).rejects.toThrow("start failed");
    await expect(next).resolves.toBe("closed");
  });

  it("lets a close persist its final reentrant chunk before entering the destructive FIFO", async () => {
    const coordinator = new PipelineRequestCoordinator();
    const order: string[] = [];

    await runTwoPhasePipelineClose({
      coordinator,
      sid: "S-recording",
      stopScreenRecording: async () => {
        order.push("stop:begin");
        await coordinator.run("S-recording", async () => {
          order.push("putBlob:final");
        });
        await coordinator.run("S-recording", async () => {
          order.push("ingest:final");
        });
        order.push("stop:end");
      },
      closePipeline: async () => {
        order.push("close");
      }
    });

    expect(order).toEqual(["stop:begin", "putBlob:final", "ingest:final", "stop:end", "close"]);
  });

  it("keeps later start and ingest behind a close reservation", async () => {
    const coordinator = new PipelineRequestCoordinator();
    const stopGate = deferred();
    const order: string[] = [];
    const close = runTwoPhasePipelineClose({
      coordinator,
      sid: "S-close-order",
      stopScreenRecording: async () => {
        order.push("stop");
        await stopGate.promise;
      },
      closePipeline: async () => {
        order.push("close");
      }
    });
    const start = runAfterPipelineClose({
      coordinator,
      sid: "S-close-order",
      pendingClose: close,
      operation: async () => {
        order.push("start");
      }
    });
    const ingest = runAfterPipelineClose({
      coordinator,
      sid: "S-close-order",
      pendingClose: close,
      operation: async () => {
        order.push("ingest");
      }
    });

    await vi.waitFor(() => expect(order).toEqual(["stop"]));
    stopGate.resolve();
    await Promise.all([close, start, ingest]);
    expect(order).toEqual(["stop", "close", "start", "ingest"]);
  });

  it("orders delayed pipeline readiness before screen start and media start before stop", async () => {
    const pipeline = new PipelineRequestCoordinator();
    const media = new PipelineRequestCoordinator();
    const pipelineGate = deferred();
    const order: string[] = [];
    const startPipeline = pipeline.run("S-media", async () => {
      order.push("pipeline:begin");
      await pipelineGate.promise;
      order.push("pipeline:end");
    });
    const startScreen = media.run("S-media", async () => {
      await pipeline.run("S-media", async () => undefined);
      order.push("screen:start");
    });
    const stopScreen = media.run("S-media", async () => {
      order.push("screen:stop");
    });

    await vi.waitFor(() => expect(order).toEqual(["pipeline:begin"]));
    pipelineGate.resolve();
    await Promise.all([startPipeline, startScreen, stopScreen]);
    expect(order).toEqual(["pipeline:begin", "pipeline:end", "screen:start", "screen:stop"]);
  });
});
