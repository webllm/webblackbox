import {
  evaluateCdpCaptureScopeEvent,
  getCdpChildSessionClaim,
  isCdpChildSessionClaimCurrent,
  type CdpCaptureScopeEvaluation,
  type CdpCaptureScopeState,
  type CdpChildSessionClaim
} from "./cdp-capture-scope.js";
import { buildRequestMetaKey } from "./request-meta.js";

export function isCdpFollowupClaimCurrent(
  state: CdpCaptureScopeState,
  sessionId: string | undefined,
  childClaim: CdpChildSessionClaim | null
): boolean {
  return sessionId === undefined
    ? childClaim === null
    : childClaim !== null && isCdpChildSessionClaimCurrent(state, childClaim);
}

export function buildCdpFollowupRequestMetaKey(
  requestId: string,
  sessionId: string | undefined,
  childClaim: CdpChildSessionClaim | null
): string {
  if (!sessionId || !childClaim) {
    return buildRequestMetaKey(requestId, sessionId);
  }

  return buildRequestMetaKey(
    requestId,
    `${sessionId}:${childClaim.token}:${childClaim.navigationRevision}`
  );
}

export function evaluateCdpTargetControlScopeEvent(
  state: CdpCaptureScopeState,
  method: "Target.attachedToTarget" | "Target.detachedFromTarget",
  params: unknown,
  sourceSessionId?: string
): CdpCaptureScopeEvaluation | null {
  const sourceClaim = sourceSessionId ? getCdpChildSessionClaim(state, sourceSessionId) : null;

  if (!isCdpFollowupClaimCurrent(state, sourceSessionId, sourceClaim)) {
    return null;
  }

  const payload = asRecord(params);
  const affectedSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
  const existing = affectedSessionId ? state.childSessions.get(affectedSessionId) : undefined;

  if (
    affectedSessionId === sourceSessionId ||
    (existing &&
      (existing.parentSessionId !== sourceSessionId || existing.parentToken !== sourceClaim?.token))
  ) {
    return null;
  }

  return evaluateCdpCaptureScopeEvent(state, method, params, sourceSessionId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
