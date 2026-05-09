import { describe, expect, it, vi, beforeEach } from "vitest";

import { readWebBlackboxArchive } from "@webblackbox/pipeline";
import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
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
    INJECTED_CAPTURE_CONFIG_EVENT: "webblackbox:injected-config",
    installInjectedLiteCaptureHooks: mockRuntime.installInjectedLiteCaptureHooksMock
  };
});

vi.mock("./lite-capture-agent.js", () => {
  return {
    LiteCaptureAgent: mockRuntime.MockLiteCaptureAgent
  };
});

import { WebBlackboxLiteSdk } from "./lite-sdk.js";

function createRawEvent(
  rawType: string,
  payload: Record<string, unknown>,
  overrides: Partial<Pick<RawRecorderEvent, "source" | "tabId" | "sid" | "t" | "mono">> = {}
): RawRecorderEvent {
  const now = Date.now();

  return {
    source: overrides.source ?? "content",
    rawType,
    tabId: overrides.tabId ?? 99,
    sid: overrides.sid ?? "S-raw",
    t: overrides.t ?? now,
    mono: overrides.mono ?? now,
    payload
  };
}

function createNoisyPayload(size: number, seed: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = ((seed + 1) * 48_271) % 2_147_483_647;
  let output = "";

  for (let index = 0; index < size; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    const cursor = state % chars.length;
    output += chars[cursor] ?? "x";
  }

  return output;
}

const TRUSTED_LOCAL_DEBUG_EVIDENCE_REF = "local-attestation:test-fixture-0001";
const LOCAL_DEBUG_TEST_POLICY: CapturePolicy = {
  ...DEFAULT_CAPTURE_POLICY,
  captureContext: "local-debug",
  captureContextEvidenceRef: TRUSTED_LOCAL_DEBUG_EVIDENCE_REF,
  encryption: {
    localAtRest: "required",
    archive: "synthetic-local-debug-exempt",
    archiveKeyEnvelope: "none"
  }
};

const HIGH_FIDELITY_TEST_POLICY: CapturePolicy = {
  ...LOCAL_DEBUG_TEST_POLICY,
  mode: "debug",
  categories: {
    ...LOCAL_DEBUG_TEST_POLICY.categories,
    dom: "allow",
    screenshots: "allow",
    network: "body-allowlist",
    console: "allow",
    storage: "allow",
    cdp: "full"
  }
};

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
    expect(mockRuntime.installInjectedLiteCaptureHooksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        flag: "__WB_TEST_FLAG__",
        active: false,
        bodyCaptureMaxBytes: 0,
        capturePolicy: expect.objectContaining({
          mode: "private"
        })
      })
    );

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
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: HIGH_FIDELITY_TEST_POLICY
      }
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

    const exported = await sdk.export({ includeScreenshots: true });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    const clickEvent = parsed.events.find((event) => event.type === "user.click");
    const screenshotEvent = parsed.events.find((event) => event.type === "screen.screenshot");

    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(clickEvent).toBeDefined();
    expect(clickEvent?.sid).toBe("S-sdk-export");
    expect(clickEvent?.tab).toBe(0);

    expect(screenshotEvent).toBeDefined();
    expect(screenshotEvent?.data).toMatchObject({
      w: 320,
      h: 180,
      reason: "action:click"
    });
    expect(typeof (screenshotEvent?.data as { shotId?: unknown }).shotId).toBe("string");

    await sdk.dispose();
  });

  it("normalizes rrweb raw events into dom.rrweb.event entries", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-rrweb",
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: LOCAL_DEBUG_TEST_POLICY
      }
    });

    await sdk.start();

    sdk.ingestRawEvent(
      createRawEvent("rrweb", {
        schema: "rrweb-lite/v1",
        event: {
          type: "incremental-snapshot",
          source: "mutation-summary",
          data: {
            count: 3
          }
        }
      })
    );

    const exported = await sdk.export();
    const parsed = await readWebBlackboxArchive(exported.bytes);
    const rrwebEvent = parsed.events.find((event) => event.type === "dom.rrweb.event");

    expect(rrwebEvent).toBeDefined();
    expect((rrwebEvent?.data as { schema?: unknown }).schema).toBe("rrweb-lite/v1");

    await sdk.dispose();
  });

  it("requires encryption for default real-user exports", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-real-user-export",
      injectHooks: false,
      useDefaultPlugins: false
    });

    await sdk.start();
    sdk.ingestRawEvent(
      createRawEvent("click", {
        target: {
          selector: "button#export"
        }
      })
    );

    await expect(sdk.export()).rejects.toThrow(/must be encrypted|required by the active/i);
    await sdk.dispose();
  });

  it("exports materialized DOM snapshots as html blobs", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-dom-html",
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: HIGH_FIDELITY_TEST_POLICY
      }
    });

    await sdk.start();
    sdk.ingestRawEvent(
      createRawEvent("snapshot", {
        html: "<html><body><main><section>hello</section></main></body></html>",
        snapshotId: "D-sdk-html",
        nodeCount: 4,
        reason: "interval"
      })
    );

    const exported = await sdk.export();
    const parsed = await readWebBlackboxArchive(exported.bytes);
    const snapshotEvent = parsed.events.find((event) => event.type === "dom.snapshot");
    const contentHash = (snapshotEvent?.data as { contentHash?: unknown })?.contentHash;

    expect(typeof contentHash).toBe("string");
    expect(parsed.integrity?.files[`blobs/sha256-${contentHash}.html`]).toMatch(/[a-f0-9]{64}/);
    expect(parsed.integrity?.files[`blobs/sha256-${contentHash}.bin`]).toBeUndefined();

    await sdk.dispose();
  });

  it("normalizes invalid tab ids to non-negative values", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-tab-id",
      tabId: -42,
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: LOCAL_DEBUG_TEST_POLICY
      }
    });

    expect(sdk.getSessionMetadata().tabId).toBe(0);

    await sdk.start();
    sdk.ingestRawEvent(
      createRawEvent("click", {
        x: 10,
        y: 20,
        target: {
          selector: "button#tab"
        }
      })
    );

    const exported = await sdk.export();
    const parsed = await readWebBlackboxArchive(exported.bytes);
    const click = parsed.events.find((event) => event.type === "user.click");
    expect(click?.tab).toBe(0);

    await sdk.dispose();
  });

  it("ingests capture-agent batches and blocks operations after dispose", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-agent-batch",
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: LOCAL_DEBUG_TEST_POLICY
      }
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

  it("uses safer lite defaults and skips resource-error freeze", async () => {
    const freezeSpy = vi.fn();
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-safe-defaults",
      injectHooks: false,
      useDefaultPlugins: false,
      recorderHooks: {
        onFreeze: freezeSpy
      }
    });

    const config = sdk.getRecorderConfig();
    expect(config.freezeOnError).toBe(true);
    expect(config.freezeOnNetworkFailure).toBe(false);
    expect(config.freezeOnLongTaskSpike).toBe(false);
    expect(config.sampling).toMatchObject({
      mousemoveHz: 14,
      scrollHz: 10,
      domFlushMs: 160,
      snapshotIntervalMs: 30_000,
      screenshotIdleMs: 0,
      bodyCaptureMaxBytes: 0
    });

    await sdk.start();

    sdk.ingestRawEvent(
      createRawEvent("resourceError", {
        selector: "img.hero",
        url: "https://cdn.example.com/hero.webp"
      })
    );

    await sdk.flush();
    expect(freezeSpy).not.toHaveBeenCalled();

    await sdk.dispose();
  });

  it("respects explicit perf-freeze overrides", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-freeze-override",
      injectHooks: false,
      useDefaultPlugins: false,
      config: {
        freezeOnNetworkFailure: true,
        freezeOnLongTaskSpike: true
      }
    });

    const config = sdk.getRecorderConfig();
    expect(config.freezeOnNetworkFailure).toBe(true);
    expect(config.freezeOnLongTaskSpike).toBe(true);

    await sdk.dispose();
  });

  it("applies default export policy and allows screenshot/window override", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-export-policy",
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: HIGH_FIDELITY_TEST_POLICY
      }
    });
    const now = Date.now();
    const old = now - 30 * 60 * 1000;
    const recent = now - 5 * 60 * 1000;

    await sdk.start();

    sdk.ingestRawEvent(
      createRawEvent(
        "click",
        {
          x: 12,
          y: 24,
          target: {
            selector: "button.old"
          }
        },
        {
          t: old,
          mono: old
        }
      )
    );
    sdk.ingestRawEvent(
      createRawEvent(
        "click",
        {
          x: 48,
          y: 96,
          target: {
            selector: "button.recent"
          }
        },
        {
          t: recent,
          mono: recent
        }
      )
    );
    sdk.ingestRawEvent(
      createRawEvent(
        "screenshot",
        {
          dataUrl: `data:image/png;base64,${Buffer.from([11, 22, 33, 44]).toString("base64")}`,
          w: 320,
          h: 180,
          reason: "action:click"
        },
        {
          t: recent + 1,
          mono: recent + 1
        }
      )
    );

    const exportedDefault = await sdk.export({ stopCapture: false });
    const parsedDefault = await readWebBlackboxArchive(exportedDefault.bytes);
    expect(parsedDefault.events.some((event) => event.t < now - 20 * 60 * 1000)).toBe(false);
    expect(parsedDefault.events.some((event) => event.type === "screen.screenshot")).toBe(false);

    const exportedWithScreenshots = await sdk.export({
      stopCapture: false,
      includeScreenshots: true,
      recentWindowMs: 60 * 60 * 1000
    });
    const parsedWithScreenshots = await readWebBlackboxArchive(exportedWithScreenshots.bytes);
    expect(parsedWithScreenshots.events.some((event) => event.type === "screen.screenshot")).toBe(
      true
    );
    expect(parsedWithScreenshots.events.some((event) => event.t < now - 20 * 60 * 1000)).toBe(true);

    const exportedNoScreenshot = await sdk.export({
      stopCapture: false,
      includeScreenshots: false,
      recentWindowMs: 60 * 60 * 1000
    });
    const parsedNoScreenshot = await readWebBlackboxArchive(exportedNoScreenshot.bytes);
    expect(parsedNoScreenshot.events.some((event) => event.type === "screen.screenshot")).toBe(
      false
    );

    await sdk.dispose();
  });

  it("enforces maxArchiveBytes export policy", async () => {
    const sdk = new WebBlackboxLiteSdk({
      sid: "S-sdk-export-size-cap",
      injectHooks: false,
      useDefaultPlugins: false,
      trustedPlaintextExemptionEvidenceRefs: [TRUSTED_LOCAL_DEBUG_EVIDENCE_REF],
      config: {
        capturePolicy: LOCAL_DEBUG_TEST_POLICY
      }
    });

    await sdk.start();

    const now = Date.now();

    for (let index = 0; index < 50; index += 1) {
      sdk.ingestRawEvent(
        createRawEvent(
          "marker",
          {
            message: `M-${index}`,
            payload: createNoisyPayload(4096, index)
          },
          {
            t: now + index,
            mono: now + index
          }
        )
      );
    }

    const exported = await sdk.export({
      stopCapture: false,
      maxArchiveBytes: 64 * 1024,
      recentWindowMs: 60 * 60 * 1000,
      includeScreenshots: true
    });
    const parsed = await readWebBlackboxArchive(exported.bytes);

    expect(exported.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(parsed.events.length).toBeLessThan(50);

    await sdk.dispose();
  });
});
