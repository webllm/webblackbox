import {
  completeCdpChildFrameTreePrime,
  failCdpChildSessionAttachment,
  failCdpChildSessionClaim,
  isCdpChildSessionAttachmentCurrent,
  isCdpChildSessionBaselineReady,
  isCdpChildSessionClaimCurrent,
  markCdpChildSessionBaselineReady,
  type CdpCaptureScopeState,
  type CdpChildSessionClaim
} from "./cdp-capture-scope.js";

const CHILD_BASELINE_METHODS = [
  "Network.enable",
  "Runtime.enable",
  "Log.enable",
  "Page.enable"
] as const;

export type CdpChildBootstrapOutcome = "ready" | "denied" | "failed" | "stale";

export type CdpChildBootstrapCommands = {
  send: (method: string) => Promise<unknown>;
  enableAutoAttach: () => Promise<void>;
};

export async function bootstrapCdpChildSession(options: {
  state: CdpCaptureScopeState;
  claim: CdpChildSessionClaim;
  commands: CdpChildBootstrapCommands;
  isRuntimeCurrent: () => boolean;
}): Promise<CdpChildBootstrapOutcome> {
  const { state, claim, commands, isRuntimeCurrent } = options;
  const child = state.childSessions.get(claim.sessionId);

  if (!child || child.status === "detached" || !isRuntimeCurrent()) {
    return "stale";
  }

  if (child.status === "failed") {
    return "failed";
  }

  const isAttachmentCurrent = () =>
    isRuntimeCurrent() && isCdpChildSessionAttachmentCurrent(state, claim);
  const isClaimCurrent = () => isRuntimeCurrent() && isCdpChildSessionClaimCurrent(state, claim);

  if (!isCdpChildSessionBaselineReady(state, claim)) {
    for (const method of CHILD_BASELINE_METHODS) {
      if (!isAttachmentCurrent()) {
        return "stale";
      }

      try {
        await commands.send(method);
      } catch {
        if (isAttachmentCurrent()) {
          failCdpChildSessionAttachment(state, claim);
          return "failed";
        }

        return "stale";
      }
    }

    if (!isAttachmentCurrent()) {
      return "stale";
    }

    try {
      await commands.enableAutoAttach();
    } catch {
      if (isAttachmentCurrent()) {
        failCdpChildSessionAttachment(state, claim);
        return "failed";
      }

      return "stale";
    }

    if (!isAttachmentCurrent() || !markCdpChildSessionBaselineReady(state, claim)) {
      return "stale";
    }

    await commands.send("DOMStorage.enable").catch(() => undefined);
  }

  if (!isClaimCurrent()) {
    return "stale";
  }

  let response: unknown;

  try {
    response = await commands.send("Page.getFrameTree");
  } catch {
    if (isClaimCurrent()) {
      failCdpChildSessionClaim(state, claim);
      return "failed";
    }

    return "stale";
  }

  if (!isClaimCurrent()) {
    return "stale";
  }

  return completeCdpChildFrameTreePrime(state, claim, asRecord(response)?.frameTree);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
