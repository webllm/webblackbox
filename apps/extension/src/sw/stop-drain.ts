import {
  parseContentActivationId,
  parseContentEventBatchId,
  type ContentActivationId,
  type ContentEventBatchId
} from "../shared/content-activation-protocol.js";
import { isStopDrainToken } from "../shared/stop-drain-token.js";

export const STOP_DRAIN_RAW_TYPES = [
  "snapshot",
  "localStorageSnapshot",
  "screenshot",
  "notice"
] as const;
export const STOP_DRAIN_ORDINARY_EVENT_MAX = 1_200;

export type StopDrainRawType = (typeof STOP_DRAIN_RAW_TYPES)[number];
export type StopDrainExpectedArtifact =
  | "main-world-tail"
  | "snapshot"
  | "localStorageSnapshot"
  | "screenshot";

type StopDrainFence = {
  blocked: boolean;
};

export type StopDrainCapability = {
  readonly token: string;
  readonly activationId: ContentActivationId;
  readonly sid: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentUrl: string;
  readonly documentId: string;
  readonly deadline: number;
  readonly ordinaryEventCutoff: number;
  readonly runtime: object;
  readonly fence: StopDrainFence;
  readonly now: () => number;
  valid: boolean;
  accepting: boolean;
  acknowledged: boolean;
  readonly claims: Map<StopDrainRawType, StopDrainClaim>;
  readonly ordinaryClaims: Set<StopDrainClaim>;
  readonly claimsByEvent: Map<string, StopDrainClaim>;
  readonly committedArtifactTypes: Set<StopDrainRawType>;
  droppedOrdinaryEvents: number;
};

export type StopDrainClaim = {
  readonly capability: StopDrainCapability;
  readonly rawType: string;
  readonly batchId: ContentEventBatchId;
  readonly eventIndex: number;
  readonly eventKey: string;
  readonly stopArtifact: boolean;
  readonly reason: unknown;
  readonly capturedAt: number | undefined;
  status: "reserved" | "committed" | "released";
};

export type StopDrainBinding = {
  runtime: object;
  fence: StopDrainFence;
  token: string | undefined;
  activationId: ContentActivationId | string;
  sid: string;
  tabId: number;
  frameId: number;
  documentUrl: string;
  documentId: string;
  capturedAt?: number;
};

export type StopDrainEventBinding = StopDrainBinding & {
  batchId: ContentEventBatchId | string;
  eventIndex: number;
  rawType: string;
  reason: unknown;
};

export function createStopDrainCapability(input: {
  runtime: object;
  fence: StopDrainFence;
  activationId: ContentActivationId | string;
  sid: string;
  tabId: number;
  frameId: number;
  documentUrl: string;
  documentId: string;
  deadline: number;
  ordinaryEventCutoff?: number;
  now?: () => number;
  tokenFactory?: () => string;
}): StopDrainCapability {
  const now = input.now ?? Date.now;
  const token = (input.tokenFactory ?? createStopDrainToken)();
  const activationId = parseContentActivationId(input.activationId);
  const ordinaryEventCutoff = input.ordinaryEventCutoff ?? now();
  const frameId = input.frameId ?? 0;

  if (
    !input.fence.blocked ||
    input.deadline <= now() ||
    !isStopDrainToken(token) ||
    !activationId ||
    !isNonEmptyString(input.documentId) ||
    !Number.isFinite(ordinaryEventCutoff) ||
    ordinaryEventCutoff < 0 ||
    !Number.isSafeInteger(frameId) ||
    frameId < 0
  ) {
    throw new Error("Stop-drain capability requires a blocked fence and a future deadline.");
  }

  return {
    token,
    activationId,
    sid: input.sid,
    tabId: input.tabId,
    frameId,
    documentUrl: input.documentUrl,
    documentId: input.documentId,
    deadline: input.deadline,
    ordinaryEventCutoff,
    runtime: input.runtime,
    fence: input.fence,
    now,
    valid: true,
    accepting: true,
    acknowledged: false,
    claims: new Map(),
    ordinaryClaims: new Set(),
    claimsByEvent: new Map(),
    committedArtifactTypes: new Set(),
    droppedOrdinaryEvents: 0
  };
}

export function claimStopDrainEvent(
  capability: StopDrainCapability,
  binding: StopDrainEventBinding
): StopDrainClaim | null {
  const batchId = parseContentEventBatchId(binding.batchId);
  if (!batchId || !Number.isSafeInteger(binding.eventIndex) || binding.eventIndex < 0) {
    return null;
  }

  const stopArtifact = binding.reason === "stop" && isStopDrainRawType(binding.rawType);
  const eventKey = createStopDrainEventKey(batchId, binding.eventIndex);
  const existingClaim = capability.claimsByEvent.get(eventKey);

  if (
    !canAdmitStopDrainBatch(capability, binding) ||
    (existingClaim ? !matchesReservedEvent(existingClaim, binding, stopArtifact) : false) ||
    (stopArtifact
      ? capability.claims.has(binding.rawType as StopDrainRawType) && !existingClaim
      : (!existingClaim && capability.ordinaryClaims.size >= STOP_DRAIN_ORDINARY_EVENT_MAX) ||
        typeof binding.capturedAt !== "number" ||
        !Number.isFinite(binding.capturedAt) ||
        binding.capturedAt > capability.ordinaryEventCutoff)
  ) {
    return null;
  }

  if (existingClaim) {
    return existingClaim;
  }

  const claim: StopDrainClaim = {
    capability,
    rawType: binding.rawType,
    batchId,
    eventIndex: binding.eventIndex,
    eventKey,
    stopArtifact,
    reason: binding.reason,
    capturedAt: binding.capturedAt,
    status: "reserved"
  };
  if (stopArtifact) {
    capability.claims.set(binding.rawType as StopDrainRawType, claim);
  } else {
    capability.ordinaryClaims.add(claim);
  }
  capability.claimsByEvent.set(eventKey, claim);
  return claim;
}

/** Drops only authenticated ordinary overflow/tail events so they cannot block final artifacts. */
export function dropUnclaimableStopDrainOrdinaryEvent(
  capability: StopDrainCapability,
  binding: StopDrainEventBinding
): boolean {
  const stopArtifact = binding.reason === "stop" && isStopDrainRawType(binding.rawType);
  if (
    stopArtifact ||
    !canAdmitStopDrainBatch(capability, binding) ||
    typeof binding.capturedAt !== "number" ||
    !Number.isFinite(binding.capturedAt) ||
    (binding.capturedAt <= capability.ordinaryEventCutoff &&
      capability.ordinaryClaims.size < STOP_DRAIN_ORDINARY_EVENT_MAX)
  ) {
    return false;
  }

  capability.droppedOrdinaryEvents = Math.min(
    Number.MAX_SAFE_INTEGER,
    capability.droppedOrdinaryEvents + 1
  );
  return true;
}

/**
 * Commits a successfully materialized event. Artifact types are only exposed
 * as committed after this transition, while ordinary events keep consuming
 * the bounded tail budget.
 */
export function commitStopDrainClaim(
  claim: StopDrainClaim,
  runtime: object,
  fence: StopDrainFence
): boolean {
  if (claim.status === "committed") {
    return isStopDrainClaimValid(claim, runtime, fence);
  }
  if (claim.status !== "reserved" || !isStopDrainClaimValid(claim, runtime, fence)) {
    return false;
  }

  claim.status = "committed";
  if (claim.stopArtifact) {
    claim.capability.committedArtifactTypes.add(claim.rawType as StopDrainRawType);
  }
  return true;
}

/** Releases a failed reservation so an exact replay can claim it again. */
export function releaseStopDrainClaim(claim: StopDrainClaim): boolean {
  if (claim.status !== "reserved" || !isStoredStopDrainClaim(claim)) {
    return false;
  }

  claim.status = "released";
  if (claim.capability.claimsByEvent.get(claim.eventKey) === claim) {
    claim.capability.claimsByEvent.delete(claim.eventKey);
  }
  if (claim.stopArtifact) {
    if (claim.capability.claims.get(claim.rawType as StopDrainRawType) === claim) {
      claim.capability.claims.delete(claim.rawType as StopDrainRawType);
    }
  } else {
    claim.capability.ordinaryClaims.delete(claim);
  }
  return true;
}

export function getCommittedStopDrainArtifactTypes(
  capability: StopDrainCapability
): readonly StopDrainRawType[] {
  return STOP_DRAIN_RAW_TYPES.filter((rawType) => capability.committedArtifactTypes.has(rawType));
}

export function resolveStopDrainTimeoutEvidence(
  capability: StopDrainCapability,
  expectedArtifacts: readonly StopDrainExpectedArtifact[]
): Readonly<{
  expectedArtifacts: StopDrainExpectedArtifact[];
  emittedArtifacts: StopDrainExpectedArtifact[];
  omittedArtifacts: StopDrainExpectedArtifact[];
  unconfirmedArtifacts: StopDrainExpectedArtifact[];
}> {
  const committed = new Set(getCommittedStopDrainArtifactTypes(capability));
  return {
    expectedArtifacts: [...expectedArtifacts],
    emittedArtifacts: expectedArtifacts.filter(
      (artifact) => artifact !== "main-world-tail" && committed.has(artifact)
    ),
    omittedArtifacts: expectedArtifacts.filter(
      (artifact) => artifact !== "main-world-tail" && !committed.has(artifact)
    ),
    unconfirmedArtifacts: expectedArtifacts.filter((artifact) => artifact === "main-world-tail")
  };
}

export function commitStopDrainBatchClaims(
  capability: StopDrainCapability,
  batchId: ContentEventBatchId | string,
  runtime: object,
  fence: StopDrainFence
): boolean {
  const normalizedBatchId = parseContentEventBatchId(batchId);
  if (!normalizedBatchId) {
    return false;
  }

  const claims = [...capability.claimsByEvent.values()].filter(
    (claim) => claim.batchId === normalizedBatchId && claim.status === "reserved"
  );
  return claims.every((claim) => commitStopDrainClaim(claim, runtime, fence));
}

/**
 * Checks whether an exact draining content batch is allowed to attempt event
 * claims. This is intentionally side-effect free so an unauthenticated batch
 * cannot consume either an artifact slot or the bounded ordinary-event budget.
 */
export function canAdmitStopDrainBatch(
  capability: StopDrainCapability,
  binding: StopDrainBinding
): boolean {
  return (
    capability.valid &&
    capability.accepting &&
    !capability.acknowledged &&
    matchesStopDrainBinding(capability, binding)
  );
}

export function acknowledgeStopDrain(
  capability: StopDrainCapability,
  binding: StopDrainBinding
): boolean {
  if (
    !canAdmitStopDrainBatch(capability, binding) ||
    [...capability.claimsByEvent.values()].some((claim) => claim.status === "reserved")
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
  for (const claim of [...capability.claimsByEvent.values()]) {
    if (claim.status === "reserved") {
      releaseStopDrainClaim(claim);
    }
  }
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
    claim.status !== "released" &&
    isStoredStopDrainClaim(claim)
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
    capability.activationId === binding.activationId &&
    capability.sid === binding.sid &&
    capability.tabId === binding.tabId &&
    capability.frameId === binding.frameId &&
    capability.documentUrl === binding.documentUrl &&
    capability.documentId === binding.documentId
  );
}

function isStopDrainRawType(value: string): value is StopDrainRawType {
  return STOP_DRAIN_RAW_TYPES.some((rawType) => rawType === value);
}

function createStopDrainEventKey(batchId: ContentEventBatchId, eventIndex: number): string {
  return `${batchId}:${eventIndex}`;
}

function matchesReservedEvent(
  claim: StopDrainClaim,
  binding: StopDrainEventBinding,
  stopArtifact: boolean
): boolean {
  return (
    claim.status === "reserved" &&
    claim.rawType === binding.rawType &&
    claim.stopArtifact === stopArtifact &&
    Object.is(claim.reason, binding.reason) &&
    Object.is(claim.capturedAt, binding.capturedAt)
  );
}

function isStoredStopDrainClaim(claim: StopDrainClaim): boolean {
  return claim.stopArtifact
    ? claim.capability.claims.get(claim.rawType as StopDrainRawType) === claim
    : claim.capability.ordinaryClaims.has(claim);
}

function createStopDrainToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
