export const STOP_DRAIN_RAW_TYPES = ["snapshot", "localStorageSnapshot", "screenshot"] as const;

export type StopDrainRawType = (typeof STOP_DRAIN_RAW_TYPES)[number];

type StopDrainFence = {
  blocked: boolean;
};

export type StopDrainCapability = {
  readonly token: string;
  readonly sid: string;
  readonly tabId: number;
  readonly frameId: 0;
  readonly documentUrl: string;
  readonly deadline: number;
  readonly runtime: object;
  readonly fence: StopDrainFence;
  readonly now: () => number;
  valid: boolean;
  accepting: boolean;
  acknowledged: boolean;
  readonly claims: Map<StopDrainRawType, StopDrainClaim>;
};

export type StopDrainClaim = {
  readonly capability: StopDrainCapability;
  readonly rawType: StopDrainRawType;
};

export type StopDrainBinding = {
  runtime: object;
  fence: StopDrainFence;
  token: string;
  sid: string;
  tabId: number;
  frameId: number;
  documentUrl: string;
};

export function createStopDrainCapability(input: {
  runtime: object;
  fence: StopDrainFence;
  sid: string;
  tabId: number;
  documentUrl: string;
  deadline: number;
  now?: () => number;
  tokenFactory?: () => string;
}): StopDrainCapability {
  const now = input.now ?? Date.now;
  const token = (input.tokenFactory ?? createStopDrainToken)();

  if (!input.fence.blocked || input.deadline <= now() || !isStopDrainToken(token)) {
    throw new Error("Stop-drain capability requires a blocked fence and a future deadline.");
  }

  return {
    token,
    sid: input.sid,
    tabId: input.tabId,
    frameId: 0,
    documentUrl: input.documentUrl,
    deadline: input.deadline,
    runtime: input.runtime,
    fence: input.fence,
    now,
    valid: true,
    accepting: true,
    acknowledged: false,
    claims: new Map()
  };
}

export function claimStopDrainEvent(
  capability: StopDrainCapability,
  binding: StopDrainBinding & { rawType: string; reason: unknown }
): StopDrainClaim | null {
  if (
    !capability.accepting ||
    capability.acknowledged ||
    binding.reason !== "stop" ||
    !isStopDrainRawType(binding.rawType) ||
    capability.claims.has(binding.rawType) ||
    !matchesStopDrainBinding(capability, binding)
  ) {
    return null;
  }

  const claim: StopDrainClaim = {
    capability,
    rawType: binding.rawType
  };
  capability.claims.set(binding.rawType, claim);
  return claim;
}

export function acknowledgeStopDrain(
  capability: StopDrainCapability,
  binding: StopDrainBinding
): boolean {
  if (
    !capability.accepting ||
    capability.acknowledged ||
    !matchesStopDrainBinding(capability, binding)
  ) {
    return false;
  }

  capability.accepting = false;
  capability.acknowledged = true;
  return true;
}

export function closeStopDrain(capability: StopDrainCapability): void {
  capability.accepting = false;
  capability.valid = false;
}

export function isStopDrainClaimValid(
  claim: StopDrainClaim,
  runtime: object,
  fence: StopDrainFence
): boolean {
  const { capability } = claim;

  return (
    capability.valid &&
    capability.runtime === runtime &&
    capability.fence === fence &&
    fence.blocked &&
    capability.now() <= capability.deadline &&
    capability.claims.get(claim.rawType) === claim
  );
}

export async function runStopDrainBlobOperation<T>(
  claim: StopDrainClaim,
  runtime: object,
  fence: StopDrainFence,
  operation: () => Promise<T>
): Promise<T | null> {
  if (!isStopDrainClaimValid(claim, runtime, fence)) {
    return null;
  }

  const result = await operation();
  return isStopDrainClaimValid(claim, runtime, fence) ? result : null;
}

function matchesStopDrainBinding(
  capability: StopDrainCapability,
  binding: StopDrainBinding
): boolean {
  return (
    capability.valid &&
    capability.now() <= capability.deadline &&
    capability.runtime === binding.runtime &&
    capability.fence === binding.fence &&
    binding.fence.blocked &&
    capability.token === binding.token &&
    capability.sid === binding.sid &&
    capability.tabId === binding.tabId &&
    capability.frameId === binding.frameId &&
    capability.documentUrl === binding.documentUrl
  );
}

function isStopDrainRawType(value: string): value is StopDrainRawType {
  return STOP_DRAIN_RAW_TYPES.some((rawType) => rawType === value);
}

function createStopDrainToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
import { isStopDrainToken } from "../shared/stop-drain-token.js";
