import { describe, expect, it, vi } from "vitest";

import type { ChromeApi, InjectionResult } from "../shared/chrome-api.js";
import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import { injectPendingContentDocument } from "./dynamic-content-injection.js";

const TAB_ID = 7;
const FRAME_ID = 4;

describe("injectPendingContentDocument", () => {
  it("injects MAIN then ISOLATED by exact documentId and leaves authorization pending", async () => {
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
        isRuntimeActive: () => true
      })
    ).resolves.toEqual({ status: "injected" });

    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: TAB_ID, documentIds: ["document-a"] },
      world: "MAIN",
      files: ["injected.js"]
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: TAB_ID, documentIds: ["document-a"] },
      world: "ISOLATED",
      files: ["content.js"]
    });
    expect(authorization.get(FRAME_ID)).toBeNull();
    expect(authorization.getPending(FRAME_ID)?.documentId).toBe("document-a");
  });

  it("does not let a late B failure cancel C or inject B content", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const documentB = await pending(authorization, "document-b");
    const bMain = deferred<InjectionResult[]>();
    const executeScript = vi.fn(
      async (options: { target: { documentIds?: string[] }; world?: string }) => {
        const documentId = options.target.documentIds?.[0] ?? "";

        if (documentId === "document-b" && options.world === "MAIN") {
          return bMain.promise;
        }

        return [result(documentId)];
      }
    );
    const chromeApi = chromeWithExecuteScript(executeScript);
    const injectionB = injectPendingContentDocument({
      chromeApi,
      authorization,
      document: documentB,
      isRuntimeActive: () => true
    });
    await Promise.resolve();

    const documentC = await pending(authorization, "document-c");
    await expect(
      injectPendingContentDocument({
        chromeApi,
        authorization,
        document: documentC,
        isRuntimeActive: () => true
      })
    ).resolves.toEqual({ status: "injected" });

    const bError = new Error("document B was replaced");
    bMain.reject(bError);
    await expect(injectionB).resolves.toEqual({ status: "failed", error: bError });

    expect(authorization.getPending(FRAME_ID)?.documentId).toBe("document-c");
    expect(
      executeScript.mock.calls.some(
        ([options]) =>
          options.world === "ISOLATED" && options.target.documentIds?.[0] === "document-b"
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
        isRuntimeActive: () => true
      })
    ).resolves.toEqual({ status: "failed", error: contentError });
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
        isRuntimeActive: () => false
      })
    ).resolves.toEqual({ status: "stale" });
    expect(executeScript).not.toHaveBeenCalled();
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
  }) => Promise<InjectionResult[]>
) {
  return {
    scripting: { executeScript }
  } as ChromeApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
