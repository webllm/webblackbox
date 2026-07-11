import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import { bootstrapCdpChildSession } from "./cdp-child-bootstrap.js";
import {
  canCaptureGlobalCdpArtifacts,
  createCdpCaptureScopeState,
  evaluateCdpCaptureScopeEvent,
  primeCdpCaptureFrameTree,
  type CdpChildSessionClaim
} from "./cdp-capture-scope.js";

function policy(): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    consent: {
      ...DEFAULT_CAPTURE_POLICY.consent,
      grantedAt: "2020-01-01T00:00:00.000Z"
    },
    scope: {
      ...DEFAULT_CAPTURE_POLICY.scope,
      tabId: 7,
      origin: "https://app.example",
      includeSubframes: true,
      allowedOrigins: ["https://app.example", "https://widgets.example"],
      deniedOrigins: ["https://blocked.example"]
    }
  };
}

function attached(type = "iframe", url = "https://widgets.example/embed") {
  const state = createCdpCaptureScopeState(policy(), 7, "https://app.example/home");
  const evaluation = evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { targetId: "child-frame", type, url }
  });

  return {
    state,
    claim: evaluation.childSessionClaim as CdpChildSessionClaim
  };
}

function successfulCommands(calls: string[] = []) {
  return {
    send: vi.fn(async (method: string): Promise<unknown> => {
      calls.push(method);

      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { id: "child-frame", url: "https://widgets.example/embed" } }
        };
      }

      return undefined;
    }),
    enableAutoAttach: vi.fn(async () => {
      calls.push("Target.setAutoAttach");
    })
  };
}

describe("CDP child bootstrap", () => {
  it("requires the four baselines, recursive auto-attach, and a strict frame tree", async () => {
    const { state, claim } = attached();
    const calls: string[] = [];

    await expect(
      bootstrapCdpChildSession({
        state,
        claim,
        commands: successfulCommands(calls),
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("ready");
    expect(calls).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Page.enable",
      "Target.setAutoAttach",
      "DOMStorage.enable",
      "Page.getFrameTree"
    ]);
    expect(calls).not.toContain("Performance.enable");
    expect(state.childSessions.get("child")).toMatchObject({
      status: "ready",
      baselineReady: true
    });
  });

  it("bootstraps an allowed worker without requiring Page-domain commands", async () => {
    const { state, claim } = attached("worker", "https://widgets.example/worker.js");
    const calls: string[] = [];

    await expect(
      bootstrapCdpChildSession({
        state,
        claim,
        commands: successfulCommands(calls),
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("ready");
    expect(calls).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Log.enable",
      "Target.setAutoAttach",
      "DOMStorage.enable"
    ]);
    expect(calls).not.toContain("Page.enable");
    expect(calls).not.toContain("Page.getFrameTree");
    expect(state.childSessions.get("child")).toMatchObject({
      visual: false,
      status: "ready",
      baselineReady: true,
      sessionAllowed: true
    });
  });

  it.each(["Network.enable", "Runtime.enable", "Log.enable", "Page.enable"])(
    "keeps the child failed when %s rejects",
    async (failedMethod) => {
      const { state, claim } = attached();
      const commands = successfulCommands();
      commands.send.mockImplementation(async (method: string) => {
        if (method === failedMethod) {
          throw new Error(`${method} rejected`);
        }

        return undefined;
      });

      await expect(
        bootstrapCdpChildSession({
          state,
          claim,
          commands,
          isRuntimeCurrent: () => true
        })
      ).resolves.toBe("failed");
      expect(state.childSessions.get("child")?.status).toBe("failed");

      evaluateCdpCaptureScopeEvent(
        state,
        "Page.frameNavigated",
        {
          frame: {
            id: "child-frame",
            parentId: "root",
            url: "https://widgets.example/next"
          }
        },
        "child"
      );
      expect(state.childSessions.get("child")?.status).toBe("failed");
    }
  );

  it("treats recursive auto-attach as hard and DOMStorage as best effort", async () => {
    const autoAttachFailure = attached();

    await expect(
      bootstrapCdpChildSession({
        ...autoAttachFailure,
        commands: {
          ...successfulCommands(),
          enableAutoAttach: vi.fn().mockRejectedValue(new Error("auto attach rejected"))
        },
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("failed");
    expect(autoAttachFailure.state.childSessions.get("child")?.status).toBe("failed");

    const domStorageFailure = attached();
    const commands = successfulCommands();
    commands.send.mockImplementation(async (method: string) => {
      if (method === "DOMStorage.enable") {
        throw new Error("DOMStorage unavailable");
      }

      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { id: "child-frame", url: "https://widgets.example/embed" } }
        };
      }

      return undefined;
    });

    await expect(
      bootstrapCdpChildSession({
        ...domStorageFailure,
        commands,
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("ready");
  });

  it("keeps command and malformed frame-tree failures sticky until detach", async () => {
    const rejected = attached();
    const rejectedCommands = successfulCommands();
    rejectedCommands.send.mockImplementation(async (method: string) => {
      if (method === "Page.getFrameTree") {
        throw new Error("tree unavailable");
      }

      return undefined;
    });
    await expect(
      bootstrapCdpChildSession({
        ...rejected,
        commands: rejectedCommands,
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("failed");

    const malformed = attached();
    const malformedCommands = successfulCommands();
    malformedCommands.send.mockImplementation(async (method: string) =>
      method === "Page.getFrameTree" ? { frameTree: { frame: {} } } : undefined
    );
    await expect(
      bootstrapCdpChildSession({
        ...malformed,
        commands: malformedCommands,
        isRuntimeCurrent: () => true
      })
    ).resolves.toBe("failed");
    expect(malformed.state.childSessions.get("child")?.status).toBe("failed");
  });

  it("discards a frame tree that resolves after a newer child navigation", async () => {
    const { state, claim } = attached();
    let resolveTree: ((value: unknown) => void) | undefined;
    const commands = successfulCommands();
    commands.send.mockImplementation(async (method: string) => {
      if (method !== "Page.getFrameTree") {
        return undefined;
      }

      return new Promise<unknown>((resolve) => {
        resolveTree = resolve;
      });
    });
    const task = bootstrapCdpChildSession({
      state,
      claim,
      commands,
      isRuntimeCurrent: () => true
    });

    await vi.waitFor(() => expect(resolveTree).toBeTypeOf("function"));
    const navigation = evaluateCdpCaptureScopeEvent(
      state,
      "Page.frameNavigated",
      {
        frame: {
          id: "child-frame",
          parentId: "root",
          url: "https://widgets.example/next"
        }
      },
      "child"
    );
    resolveTree?.({
      frameTree: { frame: { id: "child-frame", url: "https://widgets.example/embed" } }
    });

    await expect(task).resolves.toBe("stale");
    expect(state.childSessions.get("child")?.status).toBe("pending");
    expect(navigation.childSessionClaim?.navigationRevision).toBe(1);
  });

  it("does not let an old promise mutate a replacement using the same session id", async () => {
    const { state, claim } = attached();
    let resolveNetwork: (() => void) | undefined;
    const commands = successfulCommands();
    commands.send.mockImplementation(async (method: string) => {
      if (method === "Network.enable") {
        await new Promise<void>((resolve) => {
          resolveNetwork = resolve;
        });
      }

      return undefined;
    });
    const task = bootstrapCdpChildSession({
      state,
      claim,
      commands,
      isRuntimeCurrent: () => true
    });
    await vi.waitFor(() => expect(resolveNetwork).toBeTypeOf("function"));

    evaluateCdpCaptureScopeEvent(state, "Target.detachedFromTarget", { sessionId: "child" });
    const replacement = evaluateCdpCaptureScopeEvent(state, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: {
        targetId: "replacement",
        type: "iframe",
        url: "https://widgets.example/replacement"
      }
    });
    resolveNetwork?.();

    await expect(task).resolves.toBe("stale");
    expect(state.childSessions.get("child")).toMatchObject({
      token: replacement.childSessionClaim?.token,
      status: "pending",
      baselineReady: false
    });
  });

  it("does not mutate child state after the owning runtime becomes stale", async () => {
    const { state, claim } = attached();
    let current = true;
    let resolveNetwork: (() => void) | undefined;
    const commands = successfulCommands();
    commands.send.mockImplementation(async (method: string) => {
      if (method === "Network.enable") {
        await new Promise<void>((resolve) => {
          resolveNetwork = resolve;
        });
      }

      return undefined;
    });
    const task = bootstrapCdpChildSession({
      state,
      claim,
      commands,
      isRuntimeCurrent: () => current
    });
    await vi.waitFor(() => expect(resolveNetwork).toBeTypeOf("function"));
    current = false;
    resolveNetwork?.();

    await expect(task).resolves.toBe("stale");
    expect(state.childSessions.get("child")).toMatchObject({
      status: "pending",
      baselineReady: false
    });
  });

  it("keeps global capture blocked until every visual child bootstrap is ready", async () => {
    const { state, claim } = attached();
    primeCdpCaptureFrameTree(state, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child-frame", url: "https://widgets.example/embed" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(state)).toBe(false);

    await bootstrapCdpChildSession({
      state,
      claim,
      commands: successfulCommands(),
      isRuntimeCurrent: () => true
    });
    primeCdpCaptureFrameTree(state, {
      frame: { id: "root", url: "https://app.example/home" },
      childFrames: [{ frame: { id: "child-frame", url: "https://widgets.example/embed" } }]
    });
    expect(canCaptureGlobalCdpArtifacts(state)).toBe(true);
  });
});
