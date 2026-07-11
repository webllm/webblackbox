import { describe, expect, it, vi } from "vitest";

import type { ChromeApi, InjectionResult } from "../shared/chrome-api.js";
import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import { injectPendingContentDocument } from "./dynamic-content-injection.js";

const TAB_ID = 7;
const FRAME_ID = 4;

describe("injectPendingContentDocument", () => {
  it("injects ISOLATED, seeds its singleton, then bootstraps MAIN by exact documentId", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-a");
    const executeScript = vi.fn(async (options: { target: { documentIds?: string[] } }) => [
      result(options.target.documentIds?.[0] ?? "")
    ]);

    await expect(
      injectPendingContentDocument({
        chromeApi: chromeWithExecuteScript(executeScript),
        authorization,
        document,
        isRuntimeActive: () => true,
        mode: "lite"
      })
    ).resolves.toMatchObject({
      status: "injected",
      mainWorldController: {
        revision: 0,
        phase: "inactive",
        activationId: null
      }
    });

    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: TAB_ID, documentIds: ["document-a"] },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: TAB_ID, documentIds: ["document-a"] },
      world: "MAIN",
      func: expect.any(Function),
      args: [
        expect.stringMatching(/injected\.js#m1_[0-9a-f]{64}$/u),
        expect.stringMatching(/^[0-9a-f]{64}$/u)
      ]
    });
    expect(executeScript).toHaveBeenNthCalledWith(3, {
      target: { tabId: TAB_ID, documentIds: ["document-a"] },
      world: "MAIN",
      func: expect.any(Function),
      args: [
        expect.stringMatching(/injected\.js#m1_[0-9a-f]{64}$/u),
        expect.stringMatching(/^[0-9a-f]{64}$/u),
        { kind: "probe" }
      ]
    });
    expect(authorization.get(FRAME_ID)).toBeNull();
    expect(authorization.getPending(FRAME_ID)?.documentId).toBe("document-a");
  });

  it("does not let a late B failure cancel C or inject B content", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const documentB = await pending(authorization, "document-b");
    const executeScript = vi.fn(
      async (options: { target: { documentIds?: string[] }; world?: string }) => {
        const documentId = options.target.documentIds?.[0] ?? "";
        return [result(documentId)];
      }
    );
    const chromeApi = chromeWithExecuteScript(executeScript);
    const injectionB = injectPendingContentDocument({
      chromeApi,
      authorization,
      document: documentB,
      isRuntimeActive: () => true,
      mode: "lite"
    });
    await Promise.resolve();

    const documentC = await pending(authorization, "document-c");
    await expect(
      injectPendingContentDocument({
        chromeApi,
        authorization,
        document: documentC,
        isRuntimeActive: () => true,
        mode: "lite"
      })
    ).resolves.toMatchObject({ status: "injected", mainWorldController: { revision: 0 } });

    await expect(injectionB).resolves.toEqual({ status: "stale" });

    expect(authorization.getPending(FRAME_ID)?.documentId).toBe("document-c");
    expect(
      executeScript.mock.calls.filter(
        ([options]) => options.target.documentIds?.[0] === "document-b"
      )
    ).toHaveLength(1);
    expect(
      executeScript.mock.calls.some(
        ([options]) => options.world === "MAIN" && options.target.documentIds?.[0] === "document-b"
      )
    ).toBe(false);
  });

  it("revokes an exact sender promoted before a failed content injection resolves", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-d");
    const contentError = new Error("content execution failed");
    const executeScript = vi.fn(
      async (options: { target: { documentIds?: string[] }; world?: string }) => {
        if (options.world === "ISOLATED") {
          authorization.authorize({ tabId: TAB_ID, ...document });
          throw contentError;
        }

        return [result("document-d")];
      }
    );

    await expect(
      injectPendingContentDocument({
        chromeApi: chromeWithExecuteScript(executeScript),
        authorization,
        document,
        isRuntimeActive: () => true,
        mode: "lite"
      })
    ).resolves.toEqual({
      status: "failed",
      failedCurrentNavigation: true,
      error: contentError
    });
    expect(authorization.get(FRAME_ID)).toBeNull();
  });

  it("does not inject after the runtime becomes inactive", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-e");
    const executeScript = vi.fn();

    await expect(
      injectPendingContentDocument({
        chromeApi: chromeWithExecuteScript(executeScript),
        authorization,
        document,
        isRuntimeActive: () => false,
        mode: "lite"
      })
    ).resolves.toEqual({ status: "stale" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("stops after an exact seed when the document is replaced before MAIN bootstrap", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-seed-old");
    const executeScript = vi.fn(async () => [result("document-seed-old")]);
    const chromeApi = {
      runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" },
      scripting: { executeScript },
      tabs: {
        sendMessage: vi.fn(async (_tabId: number, message: { controller: unknown }) => {
          await pending(authorization, "document-seed-new");
          return {
            kind: "content.main-world-controller-seeded",
            controller: message.controller
          };
        })
      }
    } as unknown as ChromeApi;

    await expect(
      injectPendingContentDocument({
        chromeApi,
        authorization,
        document,
        isRuntimeActive: () => true,
        mode: "lite"
      })
    ).resolves.toEqual({ status: "stale" });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("does not probe an old module after replacement during MAIN bootstrap", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-main-old");
    const executeScript = vi.fn(async (options: { world?: string }) => {
      if (options.world === "MAIN") {
        await pending(authorization, "document-main-new");
        return [
          {
            ...result("document-main-old"),
            result: { kind: "installed", phase: "inactive", revision: 0 }
          }
        ];
      }
      return [result("document-main-old")];
    });
    const chromeApi = {
      runtime: { getURL: () => "chrome-extension://dynamic-id/injected.js" },
      scripting: { executeScript },
      tabs: {
        sendMessage: vi.fn(async (_tabId: number, message: { controller: unknown }) => ({
          kind: "content.main-world-controller-seeded",
          controller: message.controller
        }))
      }
    } as unknown as ChromeApi;

    await expect(
      injectPendingContentDocument({
        chromeApi,
        authorization,
        document,
        isRuntimeActive: () => true,
        mode: "lite"
      })
    ).resolves.toEqual({ status: "stale" });
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it("injects only the isolated content agent in Full without touching page globals", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const document = await pending(authorization, "document-full");
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
    const executeScript = vi.fn(
      async (options: {
        target: { documentIds?: string[] };
        world?: "MAIN" | "ISOLATED";
        files?: string[];
      }) => {
        if (options.files?.includes("injected.js")) {
          pageGlobals.console = () => undefined;
          pageGlobals.fetch = () => Promise.reject(new Error("hooked"));
          pageGlobals.localStorage = { getItem: () => "hooked" };
        }

        return [result(options.target.documentIds?.[0] ?? "")];
      }
    );

    await expect(
      injectPendingContentDocument({
        chromeApi: chromeWithExecuteScript(executeScript),
        authorization,
        document,
        isRuntimeActive: () => true,
        mode: "full"
      })
    ).resolves.toEqual({ status: "injected" });

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: TAB_ID, documentIds: ["document-full"] },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(pageGlobals).toEqual({
      console: originalConsole,
      fetch: originalFetch,
      localStorage: originalStorage
    });
  });
});

async function pending(authorization: ContentDocumentAuthorization, documentId: string) {
  const prepared = await authorization.prepareCommittedNavigation(
    {
      tabId: TAB_ID,
      frameId: FRAME_ID,
      documentId,
      url: `https://widgets.example/${documentId}`
    },
    () => true
  );

  if (!prepared.prepared) {
    throw new Error(`Expected a pending document, received ${prepared.reason}.`);
  }

  return prepared.document;
}

function result(documentId: string): InjectionResult {
  return { frameId: FRAME_ID, documentId };
}

function chromeWithExecuteScript(
  executeScript: (options: {
    target: { documentIds?: string[] };
    world?: "MAIN" | "ISOLATED";
    files?: string[];
    func?: (...args: never[]) => unknown;
    args?: unknown[];
  }) => Promise<InjectionResult[]>
) {
  return {
    runtime: {
      getURL: () => "chrome-extension://dynamic-id/injected.js"
    },
    tabs: {
      sendMessage: async (_tabId: number, message: unknown) => ({
        kind: "content.main-world-controller-seeded",
        controller: (message as { controller: unknown }).controller
      })
    },
    scripting: {
      executeScript: async (options: {
        target: { documentIds?: string[] };
        world?: "MAIN" | "ISOLATED";
        files?: string[];
        func?: (...args: never[]) => unknown;
        args?: unknown[];
      }) => {
        const results = await executeScript(options);
        if (options.world === "MAIN" && options.func) {
          for (const result of results) {
            if (result.result === undefined) {
              result.result =
                options.args?.length === 3
                  ? {
                      kind: "probed",
                      phase: "inactive",
                      revision: 0,
                      activationId: null,
                      producedThrough: 0,
                      truncatedBefore: 0
                    }
                  : { kind: "installed", phase: "inactive", revision: 0 };
            }
          }
        }
        return results;
      }
    }
  } as unknown as ChromeApi;
}
