import { describe, expect, it, vi, beforeEach } from "vitest";

import { readWebBlackboxArchive } from "@webblackbox/pipeline";
import type { RawRecorderEvent } from "@webblackbox/recorder";

const mockRuntime = vi.hoisted(() => {
  const installInjectedLiteCaptureHooksMock = vi.fn();
  const instances: Array<{
    statusHistory: Array<Record<string, unknown>>;
    flushCalls: number;
    disposeCalls: number;
    emitBatch: (events: unknown[]) => void;
  }> = [];

  class MockLiteCaptureAgent {
    public readonly statusHistory: Array<Record<string, unknown>> = [];

    public flushCalls = 0;

    public disposeCalls = 0;

    public constructor(
      private readonly options: {
        emitBatch: (events: unknown[]) => void;
        onMarker?: (message: string) => void;
      }
    ) {
      instances.push(this);
    }

    public setRecordingStatus(state: Record<string, unknown>): void {
      this.statusHistory.push(state);
    }

    public emitMarker(message: string): void {
      this.options.onMarker?.(message);
    }

    public emitBatch(events: unknown[]): void {
      this.options.emitBatch(events);
    }

    public flush(): void {
      this.flushCalls += 1;
    }

    public dispose(): void {
      this.disposeCalls += 1;
    }

    public setIndicatorState(): void {
      void 0;
    }
  }

  return {
    installInjectedLiteCaptureHooksMock,
    MockLiteCaptureAgent,
    instances
  };
});

vi.mock("./injected-hooks.js", () => {
  return {
    installInjectedLiteCaptureHooks: mockRuntime.installInjectedLiteCaptureHooksMock
  };
});

vi.mock("./lite-capture-agent.js", () => {
  return {
    LiteCaptureAgent: mockRuntime.MockLiteCaptureAgent
  };
});

import { WebBlackboxLiteSdk } from "./lite-sdk.js";

function createRawEvent(rawType: string, payload: Record<string, unknown>): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    tabId: 99,
    sid: "S-raw",
    t: Date.now(),
    mono: performance.timeOrigin + performance.now(),
    payload
  };
}

describe("WebBlackboxLiteSdk", () => {
  beforeEach(() => {
    mockRuntime.instances.length = 0;
    mockRuntime.installInjectedLiteCaptureHooksMock.mockReset();
  });

  it("starts and stops recording with injected hooks wired", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-start-stop",
      injectHookFlag: "__WB_TEST_FLAG__",
      useDefaultPlugins: false
    });

    expect(mockRuntime.installInjectedLiteCaptureHooksMock).toHaveBeenCalledTimes(1);
    expect(mockRuntime.installInjectedLiteCaptureHooksMock).toHaveBeenCalledWith({
      flag: "__WB_TEST_FLAG__"
    });

    await sdk.start();
    const agent = mockRuntime.instances.at(-1);
    expect(agent).toBeDefined();
    expect(agent?.statusHistory.at(-1)).toMatchObject({
      active: true,
      sid: "S-sdk-start-stop",
      mode: "lite"
    });

    await sdk.stop();
    expect(agent?.statusHistory.at(-1)).toMatchObject({
      active: false,
      sid: "S-sdk-start-stop",
      mode: "lite"
    });
    expect(agent?.flushCalls).toBeGreaterThan(0);

    await sdk.dispose();
    expect(agent?.disposeCalls).toBe(1);
  });

  it("exports normalized events and materialized screenshot payloads", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-export",
      injectHooks: false,
      useDefaultPlugins: false
    });

    await sdk.start();

    sdk.ingestRawEvent(
      createRawEvent("click", {
        x: 320,
        y: 180,
        target: {
          selector: "button#submit"
        }
      })
    );

    sdk.ingestRawEvent(
      createRawEvent("screenshot", {
        dataUrl: `data:image/png;base64,${Buffer.from([10, 20, 30, 40]).toString("base64")}`,
        w: 320,
        h: 180,
        reason: "action:click"
      })
    );

    const exported = await sdk.export();
    const parsed = await readWebBlackboxArchive(exported.bytes);

    const clickEvent = parsed.events.find((event) => event.type === "user.click");
    const screenshotEvent = parsed.events.find((event) => event.type === "screen.screenshot");

    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(clickEvent).toBeDefined();
    expect(clickEvent?.sid).toBe("S-sdk-export");
    expect(clickEvent?.tab).toBe(-1);

    expect(screenshotEvent).toBeDefined();
    expect(screenshotEvent?.data).toMatchObject({
      w: 320,
      h: 180,
      reason: "action:click"
    });
    expect(typeof (screenshotEvent?.data as { shotId?: unknown }).shotId).toBe("string");

    await sdk.dispose();
  });

  it("ingests capture-agent batches and blocks operations after dispose", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-agent-batch",
      injectHooks: false,
      useDefaultPlugins: false
    });

    await sdk.start();

    const agent = mockRuntime.instances.at(-1);
    expect(agent).toBeDefined();

    agent?.emitBatch([
      createRawEvent("keydown", {
        key: "Enter",
        code: "Enter"
      })
    ]);

    const exported = await sdk.export({ stopCapture: false });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(parsed.events.some((event) => event.type === "user.keydown")).toBe(true);

    await sdk.dispose();

    await expect(sdk.start()).rejects.toThrow(/disposed/i);
    expect(() => sdk.emitMarker("after-dispose")).toThrow(/disposed/i);
  });
});
