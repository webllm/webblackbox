import {
  evaluateCaptureScope,
  type CapturePolicy,
  type CaptureScopeDecision
} from "@webblackbox/protocol";

const CDP_SCOPE_MAX_REQUESTS = 2_000;

export type CdpCaptureScopeState = {
  policy: CapturePolicy | undefined;
  tabId: number;
  captureUrl: string;
  primed: boolean;
  generation: number;
  rootFrameId: string | undefined;
  rootUrl: string | undefined;
  childSessionSequence: number;
  childMutationRevision: number;
  childSessions: Map<string, CdpChildSessionState>;
  frameScopes: Map<string, boolean>;
  executionContextScopes: Map<number, boolean>;
  requestScopes: Map<string, boolean>;
};

export type CdpChildSessionStatus = "pending" | "ready" | "failed" | "denied" | "detached";

export type CdpChildSessionState = {
  token: number;
  sessionId: string;
  targetId: string | undefined;
  parentSessionId: string | undefined;
  parentToken: number | undefined;
  visual: boolean;
  status: CdpChildSessionStatus;
  baselineReady: boolean;
  navigationRevision: number;
  sessionAllowed: boolean;
  rootReprimeRequired: boolean;
  frameScopes: Map<string, boolean>;
  executionContextScopes: Map<number, CdpExecutionContextScope>;
};

type CdpExecutionContextScope = {
  allowed: boolean;
  frameId: string | undefined;
  origin: string | undefined;
};

export type CdpChildSessionClaim = Readonly<{
  sessionId: string;
  token: number;
  navigationRevision: number;
}>;

export type CdpCaptureScopeEvaluation = {
  allowed: boolean;
  globalFrameTreeMutation?: boolean;
  childSessionClaim?: CdpChildSessionClaim;
  fatalScopeViolation?: boolean;
  topNavigation?: {
    url: string;
    decision: CaptureScopeDecision;
  };
};

export function createCdpCaptureScopeState(
  policy: CapturePolicy | undefined,
  tabId: number,
  captureUrl: string
): CdpCaptureScopeState {
  return {
    policy,
    tabId,
    captureUrl,
    primed: false,
    generation: 0,
    rootFrameId: undefined,
    rootUrl: undefined,
    childSessionSequence: 0,
    childMutationRevision: 0,
    childSessions: new Map(),
    frameScopes: new Map(),
    executionContextScopes: new Map(),
    requestScopes: new Map()
  };
}

export function evaluateCdpCaptureScopeEvent(
  state: CdpCaptureScopeState,
  method: string,
  params: unknown,
  sessionId?: string
): CdpCaptureScopeEvaluation {
  const payload = asRecord(params);

  if (method === "Target.attachedToTarget") {
    const childSessionId = asString(payload?.sessionId);
    const targetInfo = asRecord(payload?.targetInfo);
    const allowed = evaluateFrameDocument(state, asString(targetInfo?.url), false).allowed;
    const visual = isPotentiallyVisualTarget(asString(targetInfo?.type));
    const replaced = childSessionId ? state.childSessions.get(childSessionId) : undefined;
    const replacementInvalidatedGlobal = replaced
      ? detachCdpChildSessionSubtree(state, replaced)
      : false;
    const globalFrameTreeMutation = visual || replacementInvalidatedGlobal;
    let childSessionClaim: CdpChildSessionClaim | undefined;

    if (globalFrameTreeMutation) {
      invalidateCdpCaptureFrameTree(state);
      state.childMutationRevision += 1;
    }

    if (visual && !childSessionId) {
      return {
        allowed: false,
        globalFrameTreeMutation: true,
        fatalScopeViolation: true
      };
    }

    if (childSessionId) {
      const parent = sessionId ? state.childSessions.get(sessionId) : undefined;

      const child: CdpChildSessionState = {
        token: (state.childSessionSequence += 1),
        sessionId: childSessionId,
        targetId: asString(targetInfo?.targetId) ?? undefined,
        parentSessionId: sessionId,
        parentToken: parent?.token,
        visual,
        status: "pending",
        baselineReady: false,
        navigationRevision: 0,
        sessionAllowed: allowed,
        rootReprimeRequired: globalFrameTreeMutation,
        frameScopes: new Map(),
        executionContextScopes: new Map()
      };
      state.childSessions.set(childSessionId, child);
      childSessionClaim = claimCdpChildSession(child);
    }

    return { allowed, globalFrameTreeMutation, childSessionClaim };
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = asString(payload?.sessionId);
    const detachedTargetId = asString(payload?.targetId);
    const candidate = childSessionId ? state.childSessions.get(childSessionId) : undefined;
    const parent = sessionId ? state.childSessions.get(sessionId) : undefined;
    const child =
      candidate &&
      candidate.parentSessionId === sessionId &&
      candidate.parentToken === parent?.token &&
      (!detachedTargetId || !candidate.targetId || candidate.targetId === detachedTargetId)
        ? candidate
        : undefined;
    const globalFrameTreeMutation = child ? detachCdpChildSessionSubtree(state, child) : false;

    if (globalFrameTreeMutation) {
      invalidateCdpCaptureFrameTree(state);
      state.childMutationRevision += 1;
    }

    return {
      allowed: false,
      globalFrameTreeMutation
    };
  }

  if (method === "Page.frameNavigated") {
    const frame = asRecord(payload?.frame);
    const frameId = asString(frame?.id);
    const frameUrl = asString(frame?.url);
    const parentFrameId = asString(frame?.parentId) ?? asString(frame?.parentFrameId);
    const topLevel =
      !sessionId && typeof frame?.parentId !== "string" && typeof frame?.parentFrameId !== "string";

    const child = sessionId ? state.childSessions.get(sessionId) : undefined;

    if (sessionId && !child) {
      registerUnknownVisualCdpChildSession(state, sessionId);
      return { allowed: false, globalFrameTreeMutation: true };
    }

    if (child && !isCdpChildFrameEventOwned(child, frameId, parentFrameId)) {
      return { allowed: false };
    }

    const globalFrameTreeMutation = !sessionId || child?.visual !== false;

    if (globalFrameTreeMutation) {
      invalidateCdpCaptureFrameTree(state);

      if (!topLevel) {
        state.childMutationRevision += 1;
      }

      if (child) {
        child.rootReprimeRequired = true;
      }
    }

    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    const childSessionClaim = child
      ? advanceCdpChildSessionNavigation(child, decision.allowed)
      : undefined;

    if (frameId) {
      (child?.frameScopes ?? state.frameScopes).set(frameId, decision.allowed);

      if (topLevel) {
        state.rootFrameId = frameId;
        state.rootUrl = frameUrl ?? undefined;
      }
    }

    if (topLevel && frameUrl) {
      if (decision.allowed) {
        state.captureUrl = frameUrl;
      }

      return {
        allowed: decision.allowed,
        globalFrameTreeMutation: true,
        topNavigation: {
          url: frameUrl,
          decision
        }
      };
    }

    return {
      allowed: decision.allowed,
      globalFrameTreeMutation,
      childSessionClaim
    };
  }

  if (method === "Page.navigatedWithinDocument") {
    const frameId = asString(payload?.frameId);
    const frameUrl = asString(payload?.url);
    const topLevel = !sessionId && frameId !== null && frameId === state.rootFrameId;

    const child = sessionId ? state.childSessions.get(sessionId) : undefined;

    if (sessionId && !child) {
      registerUnknownVisualCdpChildSession(state, sessionId);
      return { allowed: false, globalFrameTreeMutation: true };
    }

    if (child && !isCdpChildFrameEventOwned(child, frameId, null)) {
      return { allowed: false };
    }

    const globalFrameTreeMutation = Boolean(frameId) && (!sessionId || child?.visual !== false);

    if (globalFrameTreeMutation) {
      invalidateCdpCaptureFrameTree(state);

      if (!topLevel) {
        state.childMutationRevision += 1;
      }

      if (child) {
        child.rootReprimeRequired = true;
      }
    }

    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    const childSessionClaim = child
      ? advanceCdpChildSessionNavigation(child, decision.allowed)
      : undefined;

    if (frameId) {
      (child?.frameScopes ?? state.frameScopes).set(frameId, decision.allowed);

      if (topLevel) {
        state.rootUrl = frameUrl ?? undefined;
      }
    }

    if (topLevel && frameUrl) {
      if (decision.allowed) {
        state.captureUrl = frameUrl;
      }

      return {
        allowed: decision.allowed,
        globalFrameTreeMutation: true,
        topNavigation: {
          url: frameUrl,
          decision
        }
      };
    }

    return {
      allowed: decision.allowed,
      ...(globalFrameTreeMutation ? { globalFrameTreeMutation: true } : {}),
      ...(childSessionClaim ? { childSessionClaim } : {})
    };
  }

  if (method === "Page.frameDetached") {
    const frameId = asString(payload?.frameId);
    const child = sessionId ? state.childSessions.get(sessionId) : undefined;

    if (sessionId && !child) {
      registerUnknownVisualCdpChildSession(state, sessionId);
      return { allowed: false, globalFrameTreeMutation: true };
    }

    if (child && !isCdpChildFrameEventOwned(child, frameId, null)) {
      return { allowed: false };
    }

    const globalFrameTreeMutation = Boolean(frameId) && (!sessionId || child?.visual !== false);
    const childSessionClaim = child
      ? advanceCdpChildSessionNavigation(child, child.sessionAllowed)
      : undefined;

    if (frameId && child) {
      child.frameScopes.delete(frameId);
    }

    if (frameId && globalFrameTreeMutation) {
      if (sessionId || frameId !== state.rootFrameId) {
        state.childMutationRevision += 1;
      }

      if (frameId === state.rootFrameId) {
        invalidateCdpCaptureFrameTree(state);
        state.rootFrameId = undefined;
        state.rootUrl = undefined;
      } else {
        invalidateCdpCaptureFrameTree(state);
      }

      if (child) {
        child.rootReprimeRequired = true;
      }
    }

    return {
      allowed: false,
      ...(globalFrameTreeMutation ? { globalFrameTreeMutation: true } : {}),
      ...(childSessionClaim ? { childSessionClaim } : {})
    };
  }

  if (method === "Runtime.executionContextsCleared") {
    if (sessionId) {
      state.childSessions.get(sessionId)?.executionContextScopes.clear();
    } else {
      state.executionContextScopes.clear();
    }
    return { allowed: false };
  }

  if (method === "Runtime.executionContextDestroyed") {
    const executionContextId = asFiniteNumber(payload?.executionContextId);

    if (executionContextId !== null) {
      if (sessionId) {
        state.childSessions.get(sessionId)?.executionContextScopes.delete(executionContextId);
      } else {
        state.executionContextScopes.delete(executionContextId);
      }
    }

    return { allowed: false };
  }

  if (sessionId && state.childSessions.get(sessionId)?.sessionAllowed !== true) {
    return { allowed: false };
  }

  if (method === "Runtime.executionContextCreated") {
    const child = sessionId ? state.childSessions.get(sessionId) : undefined;
    const context = asRecord(payload?.context);
    const contextId = asFiniteNumber(context?.id);
    const auxData = asRecord(context?.auxData);
    const frameId = asString(auxData?.frameId);
    const contextOrigin = asString(context?.origin);
    const allowed = sessionId
      ? frameId && child?.frameScopes.has(frameId)
        ? child.frameScopes.get(frameId) === true
        : contextOrigin !== null
          ? evaluateFrameDocument(state, contextOrigin, false).allowed
          : false
      : frameId && state.frameScopes.has(frameId)
        ? state.frameScopes.get(frameId) === true
        : evaluateFrameDocument(
            state,
            contextOrigin,
            frameId !== null && frameId === state.rootFrameId
          ).allowed;

    if (contextId !== null) {
      if (child) {
        child.executionContextScopes.set(contextId, {
          allowed,
          frameId: frameId ?? undefined,
          origin: contextOrigin ?? undefined
        });
      } else if (!sessionId) {
        state.executionContextScopes.set(contextId, allowed);
      }
    }

    return { allowed };
  }

  const executionContextId = resolveExecutionContextId(method, payload);

  if (executionContextId !== null) {
    const contextScope = sessionId
      ? state.childSessions.get(sessionId)?.executionContextScopes.get(executionContextId)?.allowed
      : state.executionContextScopes.get(executionContextId);

    if (contextScope !== undefined) {
      return { allowed: contextScope };
    }

    if (method.startsWith("Runtime.")) {
      return { allowed: false };
    }
  }

  const requestId = asString(payload?.requestId);
  const requestScopeKey = requestId ? buildRequestScopeKey(state, requestId, sessionId) : null;

  if (requestScopeKey && method !== "Network.requestWillBeSent") {
    const requestScope = state.requestScopes.get(requestScopeKey);

    if (requestScope !== undefined) {
      if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        state.requestScopes.delete(requestScopeKey);
      }

      return { allowed: requestScope };
    }
  }

  const frameId = resolveFrameId(payload);

  if (frameId) {
    const knownScope = sessionId
      ? state.childSessions.get(sessionId)?.frameScopes.get(frameId)
      : state.frameScopes.get(frameId);

    if (knownScope !== undefined) {
      return {
        allowed: rememberRequestScope(state, method, requestScopeKey, knownScope)
      };
    }

    const documentUrl = asString(payload?.documentURL) ?? asString(asRecord(payload?.frame)?.url);

    if (!documentUrl) {
      const allowed = frameId === state.rootFrameId;
      if (sessionId) {
        state.childSessions.get(sessionId)?.frameScopes.set(frameId, allowed);
      } else {
        state.frameScopes.set(frameId, allowed);
      }
      return {
        allowed: rememberRequestScope(state, method, requestScopeKey, allowed)
      };
    }

    const allowed = evaluateFrameDocument(
      state,
      documentUrl,
      frameId === state.rootFrameId
    ).allowed;
    if (sessionId) {
      state.childSessions.get(sessionId)?.frameScopes.set(frameId, allowed);
    } else {
      state.frameScopes.set(frameId, allowed);
    }
    return {
      allowed: rememberRequestScope(state, method, requestScopeKey, allowed)
    };
  }

  if (
    method.startsWith("Network.") ||
    method.startsWith("Runtime.") ||
    method === "Log.entryAdded"
  ) {
    return { allowed: false };
  }

  return {
    allowed: evaluateFrameDocument(state, state.captureUrl, true).allowed
  };
}

export function primeCdpCaptureFrameTree(state: CdpCaptureScopeState, value: unknown): boolean {
  const generation = invalidateCdpCaptureFrameTree(state);
  return completeCdpCaptureFrameTreePrime(state, generation, value);
}

export async function refreshCdpCaptureFrameTree(
  state: CdpCaptureScopeState,
  loadFrameTree: () => Promise<unknown>
): Promise<boolean> {
  const generation = invalidateCdpCaptureFrameTree(state);
  let value: unknown;

  try {
    value = await loadFrameTree();
  } catch {
    return false;
  }

  return completeCdpCaptureFrameTreePrime(state, generation, value);
}

export function invalidateCdpCaptureFrameTree(state: CdpCaptureScopeState): number {
  state.primed = false;
  state.generation += 1;
  state.frameScopes.clear();
  return state.generation;
}

function completeCdpCaptureFrameTreePrime(
  state: CdpCaptureScopeState,
  generation: number,
  value: unknown
): boolean {
  if (state.generation !== generation) {
    return false;
  }

  const frameScopes = new Map<string, boolean>();
  const frameIds = new Set<string>();
  let rootFrameId: string | undefined;
  let rootAllowed = false;

  function visit(candidate: unknown, topLevel: boolean): boolean {
    const tree = asRecord(candidate);
    const frame = asRecord(tree?.frame);
    const frameId = asString(frame?.id);
    const frameUrl = asString(frame?.url);

    if (!tree || !frame || !frameId || frameUrl === null || frameIds.has(frameId)) {
      return false;
    }

    frameIds.add(frameId);
    const allowed = evaluateFrameDocument(state, frameUrl, topLevel).allowed;
    frameScopes.set(frameId, allowed);

    if (topLevel) {
      rootFrameId = frameId;
      rootAllowed = allowed;
    }

    if (tree.childFrames !== undefined && !Array.isArray(tree.childFrames)) {
      return false;
    }

    const children = Array.isArray(tree.childFrames) ? tree.childFrames : [];

    for (const child of children) {
      if (!visit(child, false)) {
        return false;
      }
    }

    return true;
  }

  if (!visit(value, true) || !rootFrameId) {
    return false;
  }

  state.rootFrameId = rootFrameId;
  state.rootUrl = asString(asRecord(asRecord(value)?.frame)?.url) ?? undefined;

  for (const [frameId, allowed] of frameScopes) {
    state.frameScopes.set(frameId, allowed);
  }

  state.primed = rootAllowed;

  for (const child of state.childSessions.values()) {
    child.rootReprimeRequired = false;
  }

  return canCaptureGlobalCdpArtifacts(state, generation);
}

export function isCdpChildSessionAttachmentCurrent(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);
  return child?.token === claim.token && child.status !== "detached";
}

export function getCdpChildSessionClaim(
  state: CdpCaptureScopeState,
  sessionId: string
): CdpChildSessionClaim | null {
  const child = state.childSessions.get(sessionId);
  return child ? claimCdpChildSession(child) : null;
}

export function isCdpChildSessionClaimCurrent(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);
  return (
    child?.token === claim.token &&
    child.navigationRevision === claim.navigationRevision &&
    child.status !== "detached"
  );
}

export function isCdpChildSessionBaselineReady(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);
  return child?.token === claim.token && child.baselineReady;
}

export function markCdpChildSessionBaselineReady(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);

  if (!child || child.token !== claim.token || child.status === "detached") {
    return false;
  }

  child.baselineReady = true;
  return true;
}

export function failCdpChildSessionAttachment(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);

  if (!child || child.token !== claim.token || child.status === "detached") {
    return false;
  }

  setCdpChildSessionStatus(state, child, "failed");
  return true;
}

export function failCdpChildSessionClaim(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim
): boolean {
  const child = state.childSessions.get(claim.sessionId);

  if (!isCdpChildSessionClaimCurrent(state, claim) || !child) {
    return false;
  }

  setCdpChildSessionStatus(state, child, "failed");
  return true;
}

export type CdpChildFrameTreePrimeOutcome = "ready" | "denied" | "failed" | "stale";

export function completeCdpChildFrameTreePrime(
  state: CdpCaptureScopeState,
  claim: CdpChildSessionClaim,
  value: unknown
): CdpChildFrameTreePrimeOutcome {
  const child = state.childSessions.get(claim.sessionId);

  if (!child || !isCdpChildSessionClaimCurrent(state, claim)) {
    return "stale";
  }

  if (child.status === "failed") {
    return "failed";
  }

  if (!child.baselineReady) {
    setCdpChildSessionStatus(state, child, "failed");
    return "failed";
  }

  const frameScopes = new Map<string, boolean>();
  const frameIds = new Set<string>();
  let rootAllowed: boolean | undefined;
  let allAllowed = true;

  function visit(candidate: unknown, root: boolean): boolean {
    const tree = asRecord(candidate);
    const frame = asRecord(tree?.frame);
    const frameId = asString(frame?.id);
    const frameUrl = asString(frame?.url);

    if (!tree || !frame || !frameId || frameUrl === null || frameIds.has(frameId)) {
      return false;
    }

    frameIds.add(frameId);
    const allowed = evaluateFrameDocument(state, frameUrl, false).allowed;
    frameScopes.set(frameId, allowed);
    allAllowed &&= allowed;

    if (root) {
      rootAllowed = allowed;
    }

    if (tree.childFrames !== undefined && !Array.isArray(tree.childFrames)) {
      return false;
    }

    for (const nested of Array.isArray(tree.childFrames) ? tree.childFrames : []) {
      if (!visit(nested, false)) {
        return false;
      }
    }

    return true;
  }

  if (!visit(value, true) || rootAllowed === undefined) {
    setCdpChildSessionStatus(state, child, "failed");
    return "failed";
  }

  child.frameScopes = frameScopes;
  refreshCdpChildExecutionContextScopes(state, child);

  child.sessionAllowed = rootAllowed;
  const nextStatus = allAllowed ? "ready" : "denied";

  setCdpChildSessionStatus(state, child, nextStatus);
  return nextStatus;
}

export function isCdpSessionWithinScope(state: CdpCaptureScopeState, sessionId: string): boolean {
  return state.childSessions.get(sessionId)?.sessionAllowed === true;
}

export function forgetCdpRequestScope(
  state: CdpCaptureScopeState,
  requestId: string,
  sessionId?: string
): void {
  const key = buildRequestScopeKey(state, requestId, sessionId);

  if (key) {
    state.requestScopes.delete(key);
  }
}

export function clearCdpCaptureScopeState(state: CdpCaptureScopeState): void {
  invalidateCdpCaptureFrameTree(state);
  state.rootFrameId = undefined;
  state.rootUrl = undefined;

  for (const child of state.childSessions.values()) {
    child.status = "detached";
  }

  state.childMutationRevision += 1;
  state.childSessions.clear();
  state.executionContextScopes.clear();
  state.requestScopes.clear();
}

export function hasDisallowedCdpFrames(state: CdpCaptureScopeState): boolean {
  for (const allowed of state.frameScopes.values()) {
    if (!allowed) {
      return true;
    }
  }

  return false;
}

export function hasBlockingVisualCdpChildSessions(state: CdpCaptureScopeState): boolean {
  for (const child of state.childSessions.values()) {
    if (child.visual && child.status !== "ready") {
      return true;
    }
  }

  return false;
}

function isPotentiallyVisualTarget(targetType: string | null): boolean {
  return (
    targetType === null ||
    targetType === "iframe" ||
    targetType === "page" ||
    targetType === "webview"
  );
}

export function canCaptureGlobalCdpArtifacts(
  state: CdpCaptureScopeState,
  expectedGeneration?: number
): boolean {
  return (
    state.primed &&
    (expectedGeneration === undefined || state.generation === expectedGeneration) &&
    !hasBlockingVisualCdpChildSessions(state) &&
    !hasDisallowedCdpFrames(state)
  );
}

export function canCaptureGlobalCdpArtifactsForRoot(
  state: CdpCaptureScopeState,
  expectedRootUrl: string,
  expectedGeneration?: number
): boolean {
  return (
    canCaptureGlobalCdpArtifacts(state, expectedGeneration) &&
    isCdpCaptureFrameTreePrimedForRoot(state, expectedRootUrl, expectedGeneration)
  );
}

/**
 * Distinguishes a structurally valid, in-scope root prime from global artifact
 * readiness. A denied or still-pending child may block screenshots and tab
 * recording without invalidating the root Full-CDP baseline.
 */
export function isCdpCaptureFrameTreePrimedForRoot(
  state: CdpCaptureScopeState,
  expectedRootUrl: string,
  expectedGeneration?: number
): boolean {
  return (
    state.primed &&
    (expectedGeneration === undefined || state.generation === expectedGeneration) &&
    areEquivalentCaptureUrls(state.rootUrl, expectedRootUrl)
  );
}

function areEquivalentCaptureUrls(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }

  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);

    if (leftUrl.href === rightUrl.href) {
      return true;
    }

    // Page.getFrameTree may omit a hash-router fragment even though
    // Page.navigatedWithinDocument reported the exact current route. Accept
    // only that one-sided omission: all network-relevant URL components must
    // still match, and two conflicting non-empty routes remain fail closed.
    if (leftUrl.hash && rightUrl.hash) {
      return false;
    }

    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

export function filterCdpSnapshotDocuments(
  state: CdpCaptureScopeState,
  value: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> => {
    const document = asRecord(entry);
    const frameId = asString(document?.frameId);

    if (!document || !frameId) {
      return false;
    }

    return state.frameScopes.get(frameId) === true;
  });
}

function claimCdpChildSession(child: CdpChildSessionState): CdpChildSessionClaim {
  return {
    sessionId: child.sessionId,
    token: child.token,
    navigationRevision: child.navigationRevision
  };
}

function registerUnknownVisualCdpChildSession(
  state: CdpCaptureScopeState,
  sessionId: string
): void {
  invalidateCdpCaptureFrameTree(state);
  state.childMutationRevision += 1;
  state.childSessions.set(sessionId, {
    token: (state.childSessionSequence += 1),
    sessionId,
    targetId: undefined,
    parentSessionId: undefined,
    parentToken: undefined,
    visual: true,
    status: "failed",
    baselineReady: false,
    navigationRevision: 0,
    sessionAllowed: false,
    rootReprimeRequired: true,
    frameScopes: new Map(),
    executionContextScopes: new Map()
  });
}

function detachCdpChildSessionSubtree(
  state: CdpCaptureScopeState,
  root: CdpChildSessionState
): boolean {
  const pending = [root];
  const visited = new Set<string>();
  let invalidatedGlobal = false;

  while (pending.length > 0) {
    const child = pending.pop()!;

    if (visited.has(child.sessionId) || state.childSessions.get(child.sessionId) !== child) {
      continue;
    }

    visited.add(child.sessionId);

    for (const candidate of state.childSessions.values()) {
      if (candidate.parentSessionId === child.sessionId && candidate.parentToken === child.token) {
        pending.push(candidate);
      }
    }

    invalidatedGlobal ||= child.visual || child.rootReprimeRequired;
    child.status = "detached";
    state.childSessions.delete(child.sessionId);
  }

  return invalidatedGlobal;
}

function refreshCdpChildExecutionContextScopes(
  state: CdpCaptureScopeState,
  child: CdpChildSessionState
): void {
  for (const context of child.executionContextScopes.values()) {
    context.allowed =
      context.frameId && child.frameScopes.has(context.frameId)
        ? child.frameScopes.get(context.frameId) === true
        : context.origin !== undefined
          ? evaluateFrameDocument(state, context.origin, false).allowed
          : false;
  }
}

function isCdpChildFrameEventOwned(
  child: CdpChildSessionState,
  frameId: string | null,
  parentFrameId: string | null
): boolean {
  if (!frameId) {
    return false;
  }

  if (!child.targetId && child.frameScopes.size === 0) {
    return true;
  }

  return (
    frameId === child.targetId ||
    child.frameScopes.has(frameId) ||
    (parentFrameId !== null && child.frameScopes.has(parentFrameId))
  );
}

function setCdpChildSessionStatus(
  state: CdpCaptureScopeState,
  child: CdpChildSessionState,
  status: CdpChildSessionStatus
): void {
  if (child.status === status) {
    return;
  }

  child.status = status;

  if (child.visual) {
    child.rootReprimeRequired = true;
    invalidateCdpCaptureFrameTree(state);
    state.childMutationRevision += 1;
  }
}

function advanceCdpChildSessionNavigation(
  child: CdpChildSessionState,
  allowed: boolean
): CdpChildSessionClaim | undefined {
  if (child.status === "detached") {
    return undefined;
  }

  child.navigationRevision += 1;
  child.sessionAllowed = allowed;
  child.frameScopes.clear();
  child.executionContextScopes.clear();

  if (child.status !== "failed") {
    child.status = "pending";
  }

  return claimCdpChildSession(child);
}

function evaluateFrameDocument(
  state: CdpCaptureScopeState,
  url: string | null | undefined,
  topLevel: boolean
): CaptureScopeDecision {
  return evaluateCaptureScope(state.policy, {
    url,
    tabId: state.tabId,
    frameId: topLevel ? 0 : 1,
    topLevel
  });
}

function resolveFrameId(payload: Record<string, unknown> | null): string | null {
  return (
    asString(payload?.frameId) ??
    asString(asRecord(payload?.frame)?.id) ??
    asString(asRecord(payload?.request)?.frameId)
  );
}

function resolveExecutionContextId(
  method: string,
  payload: Record<string, unknown> | null
): number | null {
  if (method === "Runtime.exceptionThrown") {
    return asFiniteNumber(asRecord(payload?.exceptionDetails)?.executionContextId);
  }

  return asFiniteNumber(payload?.executionContextId);
}

function rememberRequestScope(
  state: CdpCaptureScopeState,
  method: string,
  requestScopeKey: string | null,
  allowed: boolean
): boolean {
  if (requestScopeKey && method === "Network.requestWillBeSent") {
    if (state.requestScopes.size >= CDP_SCOPE_MAX_REQUESTS) {
      const oldestKey = state.requestScopes.keys().next().value;

      if (typeof oldestKey === "string") {
        state.requestScopes.delete(oldestKey);
      }
    }

    state.requestScopes.set(requestScopeKey, allowed);
  }

  return allowed;
}

function buildRequestScopeKey(
  state: CdpCaptureScopeState,
  requestId: string,
  sessionId?: string
): string | null {
  if (!sessionId) {
    return requestId;
  }

  const child = state.childSessions.get(sessionId);

  return child ? `cdp:${sessionId}:${child.token}:${child.navigationRevision}:${requestId}` : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
