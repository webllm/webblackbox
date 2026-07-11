import { describe, expect, it, vi } from "vitest";

import type { ChromeApi, InjectionResult } from "../shared/chrome-api.js";
import { parseMainWorldControllerHint } from "../shared/main-world-controller.js";
import {
  bootstrapMainWorldDirectController,
  controlMainWorldDirectController,
  injectContentScript,
  injectRootPageAgentsForMode,
  seedMainWorldControllerHint
} from "./script-injection.js";

const CONTROLLER = parseMainWorldControllerHint({
  secret: "a".repeat(64),
  moduleNonce: `m1_${"b".repeat(64)}`,
  revision: 0,
  phase: "inactive",
  activationId: null
})!;

describe("script injection", () => {
  it.each([null, {}, { scripting: {} }])(
    "fails explicitly when scripting.executeScript is unavailable",
    async (chromeApi) => {
      await expect(
        injectContentScript(chromeApi as ChromeApi | null, { tabId: 7, allFrames: true })
      ).rejects.toThrow("Chrome scripting.executeScript API is unavailable.");
    }
  );

  it("injects isolated content into an exact document", async () => {
    const results: InjectionResult[] = [{ frameId: 4, documentId: "document-4" }];
    const executeScript = vi.fn().mockResolvedValue(results);

    await expect(
      injectContentScript({ scripting: { executeScript } } as ChromeApi, {
        tabId: 7,
        frameId: 4,
        documentId: "document-4"
      })
    ).resolves.toBe(results);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["document-4"] },
      world: "ISOLATED",
      files: ["content.js"]
    });
  });

  it("requires an exact isolated singleton ACK before MAIN bootstrap", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      kind: "content.main-world-controller-seeded",
      controller: CONTROLLER
    });
    const chromeApi = { tabs: { sendMessage } } as unknown as ChromeApi;

    await expect(
      seedMainWorldControllerHint(
        chromeApi,
        { tabId: 7, frameId: 4, documentId: "document-4" },
        CONTROLLER
      )
    ).resolves.toEqual(CONTROLLER);
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { kind: "sw.main-world-controller-seed", controller: CONTROLLER },
      { frameId: 4, documentId: "document-4" }
    );

    sendMessage.mockResolvedValueOnce({ kind: "content.main-world-controller-seed-rejected" });
    await expect(
      seedMainWorldControllerHint(
        chromeApi,
        { tabId: 7, frameId: 4, documentId: "document-4" },
        CONTROLLER
      )
    ).rejects.toThrow("rejected the exact");
  });

  it("bootstraps an opaque ESM instance with exact document func and privileged args", async () => {
    const executeScript = vi.fn().mockResolvedValue([
      {
        frameId: 4,
        documentId: "document-4",
        result: { kind: "installed", phase: "inactive", revision: 0 }
      }
    ]);
    const getURL = vi.fn(() => "chrome-extension://dynamic-id/injected.js");
    const chromeApi = {
      scripting: { executeScript },
      runtime: { getURL }
    } as unknown as ChromeApi;

    await expect(
      bootstrapMainWorldDirectController(
        chromeApi,
        { tabId: 7, frameId: 4, documentId: "document-4" },
        CONTROLLER
      )
    ).resolves.toEqual({ kind: "installed", phase: "inactive", revision: 0 });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["document-4"] },
      world: "MAIN",
      func: expect.any(Function),
      args: [
        `chrome-extension://dynamic-id/injected.js#${CONTROLLER.moduleNonce}`,
        CONTROLLER.secret
      ]
    });
    expect(executeScript.mock.calls[0]?.[0]).not.toHaveProperty("files");
  });

  it("strictly validates direct drain results from the exact document", async () => {
    const activationId = `a1_${"c".repeat(64)}`;
    const drain = {
      kind: "drained",
      activationId,
      revision: 2,
      events: [
        {
          activationId,
          seq: 1,
          rawType: "console",
          payload: { method: "info" },
          t: 1,
          mono: 2
        }
      ],
      producedThrough: 1,
      truncatedBefore: 0,
      degraded: false,
      replayed: false
    };
    const executeScript = vi
      .fn()
      .mockResolvedValue([{ frameId: 4, documentId: "document-4", result: drain }]);
    const chromeApi = {
      scripting: { executeScript },
      runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" }
    } as unknown as ChromeApi;

    await expect(
      controlMainWorldDirectController(
        chromeApi,
        { tabId: 7, frameId: 4, documentId: "document-4" },
        CONTROLLER,
        { kind: "drain", revision: 2, activationId }
      )
    ).resolves.toEqual(drain);

    executeScript.mockResolvedValueOnce([{ frameId: 5, documentId: "replacement", result: drain }]);
    await expect(
      controlMainWorldDirectController(
        chromeApi,
        { tabId: 7, frameId: 4, documentId: "document-4" },
        CONTROLLER,
        { kind: "drain", revision: 2, activationId }
      )
    ).rejects.toThrow("exact document target");
  });

  it("starts Full with only the isolated content agent", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, documentId: "root" }]);
    const result = await injectRootPageAgentsForMode(
      { scripting: { executeScript } } as ChromeApi,
      {
        mode: "full",
        contentTarget: { tabId: 7, allFrames: true },
        mainWorldTarget: { tabId: 7, frameId: 0 }
      }
    );

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(result.mainWorldResults).toEqual([]);
  });

  it("starts Lite in isolated-inject, exact-seed, then MAIN-bootstrap order", async () => {
    const order: string[] = [];
    const executeScript = vi.fn(async (options: { world?: string; args?: unknown[] }) => {
      order.push(options.world === "ISOLATED" ? "content" : "main");
      return options.world === "ISOLATED"
        ? [{ frameId: 0, documentId: "root" }]
        : [
            {
              frameId: 0,
              documentId: "root",
              result:
                options.args?.length === 3
                  ? {
                      kind: "probed",
                      phase: "inactive",
                      revision: 0,
                      activationId: null,
                      producedThrough: 0,
                      truncatedBefore: 0
                    }
                  : { kind: "installed", phase: "inactive", revision: 0 }
            }
          ];
    });
    const sendMessage = vi.fn(async (_tabId, message: { controller: unknown }) => {
      order.push("seed");
      return { kind: "content.main-world-controller-seeded", controller: message.controller };
    });
    const result = await injectRootPageAgentsForMode(
      {
        scripting: { executeScript },
        tabs: { sendMessage },
        runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" }
      } as unknown as ChromeApi,
      {
        mode: "lite",
        contentTarget: { tabId: 7, allFrames: false },
        mainWorldTarget: { tabId: 7, frameId: 0 }
      }
    );

    expect(order).toEqual(["content", "seed", "main", "main"]);
    expect(result.contentResults).toEqual([{ frameId: 0, documentId: "root" }]);
    expect(result.mainWorldResults).toHaveLength(1);
    expect(result.mainWorldResults[0]?.controller).toMatchObject({
      revision: 0,
      phase: "inactive",
      activationId: null
    });
  });

  it("recovers a seeded singleton after SW restart by bootstrapping and probing its exact module", async () => {
    const activationId = `a1_${"d".repeat(64)}`;
    const existing = parseMainWorldControllerHint({
      secret: "c".repeat(64),
      moduleNonce: `m1_${"d".repeat(64)}`,
      revision: 3,
      phase: "active",
      activationId
    })!;
    const executeScript = vi.fn(async (options: { world?: string; args?: unknown[] }) => {
      if (options.world === "ISOLATED") {
        return [{ frameId: 0, documentId: "root" }];
      }
      return [
        {
          frameId: 0,
          documentId: "root",
          result:
            options.args?.length === 3
              ? {
                  kind: "probed",
                  phase: "active",
                  revision: 3,
                  activationId,
                  producedThrough: 4,
                  truncatedBefore: 0
                }
              : { kind: "existing", phase: "active", revision: 3 }
        }
      ];
    });
    const result = await injectRootPageAgentsForMode(
      {
        scripting: { executeScript },
        tabs: {
          sendMessage: vi.fn().mockResolvedValue({
            kind: "content.main-world-controller-seeded",
            controller: existing
          })
        },
        runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" }
      } as unknown as ChromeApi,
      {
        mode: "lite",
        contentTarget: { tabId: 7, allFrames: false },
        mainWorldTarget: { tabId: 7, frameId: 0 }
      }
    );

    expect(result.mainWorldResults[0]?.controller).toEqual(existing);
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(executeScript.mock.calls[1]?.[0].args).toEqual([
      `chrome-extension://dynamic-id/injected.js#${existing.moduleNonce}`,
      existing.secret
    ]);
  });

  it("fails Lite closed when the isolated seed listener is unavailable", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, documentId: "root" }]);
    await expect(
      injectRootPageAgentsForMode(
        {
          scripting: { executeScript },
          tabs: { sendMessage: vi.fn().mockRejectedValue(new Error("no listener")) },
          runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" }
        } as unknown as ChromeApi,
        {
          mode: "lite",
          contentTarget: { tabId: 7, allFrames: false },
          mainWorldTarget: { tabId: 7, frameId: 0 }
        }
      )
    ).rejects.toThrow("no listener");
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
