import { describe, expect, it, vi } from "vitest";

import type { ChromeApi, InjectionResult } from "../shared/chrome-api.js";
import {
  injectContentScript,
  injectMainWorldHook,
  injectRootPageAgentsForMode
} from "./script-injection.js";

function chromeWithExecuteScript(
  executeScript: (options: unknown) => Promise<InjectionResult[]>
): ChromeApi {
  return {
    scripting: {
      executeScript
    }
  } as ChromeApi;
}

describe("script-injection", () => {
  it.each([null, {}, { scripting: {} }])(
    "fails explicitly when scripting.executeScript is unavailable",
    async (chromeApi) => {
      await expect(
        injectContentScript(chromeApi as ChromeApi | null, { tabId: 7, allFrames: true })
      ).rejects.toThrow("Chrome scripting.executeScript API is unavailable.");
    }
  );

  it("returns all content-script results when the main frame succeeded", async () => {
    const results: InjectionResult[] = [
      { frameId: 0, documentId: "root-document" },
      { frameId: 4, documentId: "child-document" }
    ];
    const executeScript = vi.fn().mockResolvedValue(results);

    await expect(
      injectContentScript(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        allFrames: true
      })
    ).resolves.toBe(results);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      world: "ISOLATED",
      files: ["content.js"]
    });
  });

  it("allows an all-frames request to succeed with only the main-frame result", async () => {
    const results: InjectionResult[] = [{ frameId: 0, documentId: "root-document" }];

    await expect(
      injectContentScript(chromeWithExecuteScript(vi.fn().mockResolvedValue(results)), {
        tabId: 7,
        allFrames: true
      })
    ).resolves.toBe(results);
  });

  it("rejects content-script injection when the main-frame result is missing", async () => {
    const results: InjectionResult[] = [{ frameId: 4, documentId: "child-document" }];

    await expect(
      injectContentScript(chromeWithExecuteScript(vi.fn().mockResolvedValue(results)), {
        tabId: 7,
        allFrames: true
      })
    ).rejects.toThrow("Content script injection did not succeed in the main frame.");
  });

  it("rejects content-script injection when the main-frame result contains an error", async () => {
    const results: InjectionResult[] = [
      { frameId: 0, documentId: "root-document", error: "Cannot access this page." },
      { frameId: 4, documentId: "child-document" }
    ];

    await expect(
      injectContentScript(chromeWithExecuteScript(vi.fn().mockResolvedValue(results)), {
        tabId: 7,
        allFrames: true
      })
    ).rejects.toThrow(
      "Content script injection did not succeed in the main frame. Cannot access this page."
    );
  });

  it("targets and validates the exact child document for content injection", async () => {
    const results: InjectionResult[] = [{ frameId: 4, documentId: "document-4" }];
    const executeScript = vi.fn().mockResolvedValue(results);

    await expect(
      injectContentScript(chromeWithExecuteScript(executeScript), {
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

  it("rejects an exact child content result for a replacement document", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValue([{ frameId: 4, documentId: "replacement-document" }]);

    await expect(
      injectContentScript(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        frameId: 4,
        documentId: "document-4"
      })
    ).rejects.toThrow("Content script injection did not succeed in its exact document target.");
  });

  it("targets the exact document for a main-world hook", async () => {
    const results: InjectionResult[] = [{ frameId: 4, documentId: "document-4" }];
    const executeScript = vi.fn().mockResolvedValue(results);

    await expect(
      injectMainWorldHook(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        frameId: 4,
        documentId: "document-4"
      })
    ).resolves.toBe(results);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["document-4"] },
      world: "MAIN",
      files: ["injected.js"]
    });
  });

  it("targets the exact frame when no document id is available", async () => {
    const results: InjectionResult[] = [{ frameId: 4 }];
    const executeScript = vi.fn().mockResolvedValue(results);

    await expect(
      injectMainWorldHook(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        frameId: 4
      })
    ).resolves.toBe(results);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [4] },
      world: "MAIN",
      files: ["injected.js"]
    });
  });

  it("propagates main-world executeScript rejection for caller policy", async () => {
    const injectionFailure = new Error("document was replaced");
    const executeScript = vi.fn().mockRejectedValue(injectionFailure);

    await expect(
      injectMainWorldHook(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        frameId: 4,
        documentId: "document-4"
      })
    ).rejects.toBe(injectionFailure);
  });

  it("rejects a resolved main-world result that does not match the exact target", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValue([{ frameId: 5, documentId: "replacement-document" }]);

    await expect(
      injectMainWorldHook(chromeWithExecuteScript(executeScript), {
        tabId: 7,
        frameId: 4,
        documentId: "document-4"
      })
    ).rejects.toThrow("Main-world hook injection did not succeed in its target.");
  });

  it("starts Full with only the isolated content agent and leaves page hooks untouched", async () => {
    const originalConsole = () => undefined;
    const originalFetch = () => Promise.resolve();
    const originalStorage = { getItem: () => null };
    const pageGlobals: {
      console: () => void;
      fetch: () => Promise<unknown>;
      localStorage: { getItem: () => string | null };
    } = {
      console: originalConsole,
      fetch: originalFetch,
      localStorage: originalStorage
    };
    const executeScript = vi.fn(async (rawOptions: unknown) => {
      const options = rawOptions as {
        target: { allFrames?: boolean; frameIds?: number[] };
        files?: string[];
        world?: "MAIN" | "ISOLATED";
      };

      if (options.files?.includes("injected.js")) {
        pageGlobals.console = () => undefined;
        pageGlobals.fetch = () => Promise.reject(new Error("hooked"));
        pageGlobals.localStorage = { getItem: () => "hooked" };
      }

      return [{ frameId: options.target.frameIds?.[0] ?? 0 }];
    });

    await injectRootPageAgentsForMode(chromeWithExecuteScript(executeScript), {
      mode: "full",
      contentTarget: { tabId: 7, allFrames: true },
      mainWorldTarget: { tabId: 7, frameId: 0 }
    });

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(pageGlobals).toEqual({
      console: originalConsole,
      fetch: originalFetch,
      localStorage: originalStorage
    });
  });

  it("starts Lite with isolated content followed by its MAIN-world hook", async () => {
    const executeScript = vi.fn(async (rawOptions: unknown) => {
      const options = rawOptions as {
        target: { allFrames?: boolean; frameIds?: number[] };
      };
      return [{ frameId: options.target.frameIds?.[0] ?? 0 }];
    });

    await injectRootPageAgentsForMode(chromeWithExecuteScript(executeScript), {
      mode: "lite",
      contentTarget: { tabId: 7, allFrames: false },
      mainWorldTarget: { tabId: 7, frameId: 0 }
    });

    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7, allFrames: false },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7, frameIds: [0] },
      world: "MAIN",
      files: ["injected.js"]
    });
  });
});
