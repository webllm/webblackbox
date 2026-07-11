import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  canCaptureGlobalCdpArtifactsForRoot,
  createCdpCaptureScopeState,
  isCdpCaptureFrameTreePrimedForRoot,
  refreshCdpCaptureFrameTree
} from "./cdp-capture-scope.js";

import {
  CdpRootBootstrapError,
  bootstrapCdpRoot,
  cleanupAndRethrowCdpRootBootstrapFailure,
  type CdpRootBootstrapCommands,
  type CdpRootBootstrapStage
} from "./cdp-root-bootstrap.js";

function commands(overrides: Partial<CdpRootBootstrapCommands> = {}): CdpRootBootstrapCommands {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    clearExecutionContextScopes: vi.fn(),
    enableAutoAttach: vi.fn().mockResolvedValue(undefined),
    primeFrameTree: vi.fn().mockResolvedValue({
      globalCaptureReady: true,
      rootValid: true
    }),
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function expectStageFailure(
  task: Promise<unknown>,
  stage: CdpRootBootstrapStage,
  cause: Error
): Promise<void> {
  try {
    await task;
    throw new Error("Expected root CDP bootstrap to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(CdpRootBootstrapError);
    expect(error).toMatchObject({ stage, cause });
  }
}

describe("cdp-root-bootstrap", () => {
  it("runs the strict root bootstrap in dependency order", async () => {
    const calls: string[] = [];
    const rootCommands = commands({
      attach: vi.fn(async () => {
        calls.push("attach");
      }),
      clearExecutionContextScopes: vi.fn(() => {
        calls.push("clear-contexts");
      }),
      enableAutoAttach: vi.fn(async () => {
        calls.push("auto-attach");
      }),
      primeFrameTree: vi.fn(async () => {
        calls.push("prime-frame-tree");
        return {
          globalCaptureReady: true,
          rootValid: true
        };
      }),
      send: vi.fn(async (method: string) => {
        calls.push(method);
      })
    });

    await expect(
      bootstrapCdpRoot({
        cdpLevel: "full",
        commands: rootCommands,
        includeSubframes: true
      })
    ).resolves.toEqual({
      domStorageEnabled: true,
      globalCaptureReady: true,
      performanceEnabled: true
    });
    expect(calls).toEqual([
      "attach",
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Page.enable",
      "auto-attach",
      "prime-frame-tree",
      "clear-contexts",
      "Runtime.disable",
      "Runtime.enable",
      "DOMStorage.enable",
      "Performance.enable"
    ]);
  });

  it("preserves an attach failure as the debugger stage", async () => {
    const failure = new Error("another debugger owns the tab");

    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: commands({ attach: vi.fn().mockRejectedValue(failure) }),
        includeSubframes: false
      }),
      "debugger-attach",
      failure
    );
  });

  it.each([
    ["Network.enable", "network-enable"],
    ["Runtime.enable", "runtime-baseline-enable"],
    ["Log.enable", "log-enable"],
    ["Page.enable", "page-enable"]
  ] as const)("makes a rejected %s baseline command fatal", async (rejectedMethod, stage) => {
    const failure = new Error(`${rejectedMethod} rejected`);
    const rootCommands = commands({
      send: vi.fn(async (method: string) => {
        if (method === rejectedMethod) {
          throw failure;
        }
      })
    });

    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: rootCommands,
        includeSubframes: false
      }),
      stage,
      failure
    );
  });

  it("requires auto-attach only when subframes are included", async () => {
    const enableAutoAttach = vi.fn().mockRejectedValue(new Error("auto-attach rejected"));
    const withoutSubframes = commands({ enableAutoAttach });

    await expect(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: withoutSubframes,
        includeSubframes: false
      })
    ).resolves.toMatchObject({ performanceEnabled: false });
    expect(enableAutoAttach).not.toHaveBeenCalled();

    const failure = new Error("auto-attach rejected");

    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: commands({ enableAutoAttach: vi.fn().mockRejectedValue(failure) }),
        includeSubframes: true
      }),
      "subframe-auto-attach",
      failure
    );
  });

  it("treats a false strict frame-tree prime as fatal", async () => {
    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: commands({
          primeFrameTree: vi.fn().mockResolvedValue({
            globalCaptureReady: false,
            rootValid: false
          })
        }),
        includeSubframes: false
      }),
      "frame-tree-prime",
      expect.any(Error) as Error
    );
  });

  it.each([
    ["clear", "execution-context-clear"],
    ["disable", "runtime-disable"],
    ["enable", "runtime-enable"]
  ] as const)("makes Runtime context %s failure fatal", async (operation, stage) => {
    const failure = new Error(`Runtime ${operation} rejected`);
    const rootCommands = commands({
      clearExecutionContextScopes:
        operation === "clear"
          ? vi.fn(() => {
              throw failure;
            })
          : vi.fn(),
      send: vi.fn(async (method: string) => {
        if (
          (operation === "disable" && method === "Runtime.disable") ||
          (operation === "enable" && method === "Runtime.enable")
        ) {
          if (operation === "enable" && method === "Runtime.enable") {
            const runtimeEnableCalls = (
              rootCommands.send as ReturnType<typeof vi.fn>
            ).mock.calls.filter(([candidate]) => candidate === "Runtime.enable").length;

            if (runtimeEnableCalls === 1) {
              return;
            }
          }

          throw failure;
        }
      })
    });

    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: rootCommands,
        includeSubframes: false
      }),
      stage,
      failure
    );
  });

  it("keeps DOMStorage enablement best effort", async () => {
    const rootCommands = commands({
      send: vi.fn(async (method: string) => {
        if (method === "DOMStorage.enable") {
          throw new Error("DOMStorage unavailable");
        }
      })
    });

    await expect(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: rootCommands,
        includeSubframes: false
      })
    ).resolves.toEqual({
      domStorageEnabled: false,
      globalCaptureReady: true,
      performanceEnabled: false
    });
  });

  it("keeps a valid root bootstrap successful when a disabled child blocks global capture", async () => {
    const capturePolicy = {
      ...DEFAULT_CAPTURE_POLICY,
      consent: {
        ...DEFAULT_CAPTURE_POLICY.consent,
        grantedAt: "2020-01-01T00:00:00.000Z"
      },
      scope: {
        ...DEFAULT_CAPTURE_POLICY.scope,
        tabId: 7,
        origin: "https://app.example",
        includeSubframes: false
      }
    };
    const scope = createCdpCaptureScopeState(capturePolicy, 7, "https://app.example/home");
    const enableAutoAttach = vi.fn().mockResolvedValue(undefined);

    await expect(
      bootstrapCdpRoot({
        cdpLevel: "safe-subset",
        commands: commands({
          enableAutoAttach,
          primeFrameTree: async () => {
            await refreshCdpCaptureFrameTree(scope, async () => ({
              frame: { id: "root", url: "https://app.example/home" },
              childFrames: [{ frame: { id: "child", url: "https://widgets.example/embed" } }]
            }));

            return {
              globalCaptureReady: canCaptureGlobalCdpArtifactsForRoot(
                scope,
                "https://app.example/home",
                scope.generation
              ),
              rootValid: isCdpCaptureFrameTreePrimedForRoot(
                scope,
                "https://app.example/home",
                scope.generation
              )
            };
          }
        }),
        includeSubframes: false
      })
    ).resolves.toEqual({
      domStorageEnabled: true,
      globalCaptureReady: false,
      performanceEnabled: false
    });
    expect(enableAutoAttach).not.toHaveBeenCalled();
  });

  it.each(["off", "safe-subset"] as const)(
    "skips Performance for the %s CDP policy",
    async (cdpLevel) => {
      const send = vi.fn().mockResolvedValue(undefined);

      await bootstrapCdpRoot({
        cdpLevel,
        commands: commands({ send }),
        includeSubframes: false
      });

      expect(send).not.toHaveBeenCalledWith("Performance.enable");
    }
  );

  it("makes Performance enablement fatal for the full CDP policy", async () => {
    const failure = new Error("Performance unavailable");

    await expectStageFailure(
      bootstrapCdpRoot({
        cdpLevel: "full",
        commands: commands({
          send: vi.fn(async (method: string) => {
            if (method === "Performance.enable") {
              throw failure;
            }
          })
        }),
        includeSubframes: false
      }),
      "performance-enable",
      failure
    );
  });

  it("rethrows the original staged failure after successful cleanup", async () => {
    const failure = new CdpRootBootstrapError("page-enable", new Error("Page rejected"));
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await expect(cleanupAndRethrowCdpRootBootstrapFailure(failure, cleanup)).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("aggregates bootstrap and cleanup failures", async () => {
    const failure = new CdpRootBootstrapError("page-enable", new Error("Page rejected"));
    const cleanupFailure = new Error("detach rejected");

    try {
      await cleanupAndRethrowCdpRootBootstrapFailure(
        failure,
        vi.fn().mockRejectedValue(cleanupFailure)
      );
      throw new Error("Expected cleanup to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure, cleanupFailure]);
    }
  });
});
