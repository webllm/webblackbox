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
  sessionScopes: Map<string, boolean>;
  globalTargetScopes: Map<string, boolean>;
  pendingGlobalTargetSessions: Set<string>;
  frameScopes: Map<string, boolean>;
  executionContextScopes: Map<number, boolean>;
  requestScopes: Map<string, boolean>;
};

export type CdpCaptureScopeEvaluation = {
  allowed: boolean;
  globalFrameTreeMutation?: boolean;
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
    sessionScopes: new Map(),
    globalTargetScopes: new Map(),
    pendingGlobalTargetSessions: new Set(),
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
    const globalFrameTreeMutation = isPotentiallyVisualTarget(asString(targetInfo?.type));

    if (globalFrameTreeMutation) {
      invalidateCdpCaptureFrameTree(state);
    }

    if (childSessionId) {
      state.sessionScopes.set(childSessionId, allowed);

      if (globalFrameTreeMutation) {
        state.globalTargetScopes.set(childSessionId, allowed);
        state.pendingGlobalTargetSessions.add(childSessionId);
      }
    }

    return { allowed, globalFrameTreeMutation };
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = asString(payload?.sessionId);
    const globalFrameTreeMutation = childSessionId
      ? state.globalTargetScopes.has(childSessionId)
      : false;

    if (childSessionId) {
      state.sessionScopes.delete(childSessionId);
      state.globalTargetScopes.delete(childSessionId);
      state.pendingGlobalTargetSessions.delete(childSessionId);

      if (globalFrameTreeMutation) {
        invalidateCdpCaptureFrameTree(state);
      }
    }

    return { allowed: false, globalFrameTreeMutation };
  }

  if (method === "Page.frameNavigated") {
    const frame = asRecord(payload?.frame);
    const frameId = asString(frame?.id);
    const frameUrl = asString(frame?.url);
    const topLevel =
      !sessionId && typeof frame?.parentId !== "string" && typeof frame?.parentFrameId !== "string";

    invalidateCdpCaptureFrameTree(state);

    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    if (frameId) {
      state.frameScopes.set(frameId, decision.allowed);

      if (topLevel) {
        state.rootFrameId = frameId;
        state.rootUrl = frameUrl ?? undefined;
      }
    }

    if (sessionId) {
      state.sessionScopes.set(sessionId, decision.allowed);

      if (state.globalTargetScopes.has(sessionId)) {
        state.globalTargetScopes.set(sessionId, decision.allowed);
      }

      state.pendingGlobalTargetSessions.delete(sessionId);
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

    return { allowed: decision.allowed, globalFrameTreeMutation: true };
  }

  if (method === "Page.navigatedWithinDocument") {
    const frameId = asString(payload?.frameId);
    const frameUrl = asString(payload?.url);
    const topLevel = !sessionId && frameId !== null && frameId === state.rootFrameId;

    if (frameId) {
      invalidateCdpCaptureFrameTree(state);
    }

    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    if (frameId) {
      state.frameScopes.set(frameId, decision.allowed);

      if (topLevel) {
        state.rootUrl = frameUrl ?? undefined;
      }
    }

    if (sessionId) {
      state.sessionScopes.set(sessionId, decision.allowed);

      if (state.globalTargetScopes.has(sessionId)) {
        state.globalTargetScopes.set(sessionId, decision.allowed);
      }

      state.pendingGlobalTargetSessions.delete(sessionId);
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
      ...(frameId ? { globalFrameTreeMutation: true } : {})
    };
  }

  if (method === "Page.frameDetached") {
    const frameId = asString(payload?.frameId);

    if (frameId) {
      if (frameId === state.rootFrameId) {
        invalidateCdpCaptureFrameTree(state);
        state.rootFrameId = undefined;
        state.rootUrl = undefined;
      } else {
        invalidateCdpCaptureFrameTree(state);
      }
    }

    return { allowed: false, ...(frameId ? { globalFrameTreeMutation: true } : {}) };
  }

  if (method === "Runtime.executionContextsCleared") {
    state.executionContextScopes.clear();
    return { allowed: false };
  }

  if (method === "Runtime.executionContextDestroyed") {
    const executionContextId = asFiniteNumber(payload?.executionContextId);

    if (executionContextId !== null) {
      state.executionContextScopes.delete(executionContextId);
    }

    return { allowed: false };
  }

  if (sessionId && state.sessionScopes.get(sessionId) !== true) {
    return { allowed: false };
  }

  if (method === "Runtime.executionContextCreated") {
    const context = asRecord(payload?.context);
    const contextId = asFiniteNumber(context?.id);
    const auxData = asRecord(context?.auxData);
    const frameId = asString(auxData?.frameId);
    const contextOrigin = asString(context?.origin);
    const allowed = sessionId
      ? state.sessionScopes.get(sessionId) === true
      : frameId && state.frameScopes.has(frameId)
        ? state.frameScopes.get(frameId) === true
        : evaluateFrameDocument(
            state,
            contextOrigin,
            frameId !== null && frameId === state.rootFrameId
          ).allowed;

    if (contextId !== null) {
      state.executionContextScopes.set(contextId, allowed);
    }

    return { allowed };
  }

  const executionContextId = resolveExecutionContextId(method, payload);

  if (executionContextId !== null) {
    const contextScope = state.executionContextScopes.get(executionContextId);

    if (contextScope !== undefined) {
      return { allowed: contextScope };
    }

    if (method.startsWith("Runtime.")) {
      return { allowed: false };
    }
  }

  const requestId = asString(payload?.requestId);
  const requestScopeKey = requestId ? buildRequestScopeKey(requestId, sessionId) : null;

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
    const knownScope = state.frameScopes.get(frameId);

    if (knownScope !== undefined) {
      return {
        allowed: rememberRequestScope(state, method, requestScopeKey, knownScope)
      };
    }

    const documentUrl = asString(payload?.documentURL) ?? asString(asRecord(payload?.frame)?.url);

    if (!documentUrl) {
      const allowed = frameId === state.rootFrameId;
      state.frameScopes.set(frameId, allowed);
      return {
        allowed: rememberRequestScope(state, method, requestScopeKey, allowed)
      };
    }

    const allowed = evaluateFrameDocument(
      state,
      documentUrl,
      frameId === state.rootFrameId
    ).allowed;
    state.frameScopes.set(frameId, allowed);
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
  return canCaptureGlobalCdpArtifacts(state, generation);
}

export function isCdpSessionWithinScope(state: CdpCaptureScopeState, sessionId: string): boolean {
  return state.sessionScopes.get(sessionId) === true;
}

export function forgetCdpSessionScope(state: CdpCaptureScopeState, sessionId: string): void {
  state.sessionScopes.delete(sessionId);
}

export function forgetCdpRequestScope(
  state: CdpCaptureScopeState,
  requestId: string,
  sessionId?: string
): void {
  state.requestScopes.delete(buildRequestScopeKey(requestId, sessionId));
}

export function clearCdpCaptureScopeState(state: CdpCaptureScopeState): void {
  invalidateCdpCaptureFrameTree(state);
  state.rootFrameId = undefined;
  state.rootUrl = undefined;
  state.sessionScopes.clear();
  state.globalTargetScopes.clear();
  state.pendingGlobalTargetSessions.clear();
  state.executionContextScopes.clear();
  state.requestScopes.clear();
}

export function hasDisallowedCdpFrames(state: CdpCaptureScopeState): boolean {
  for (const allowed of state.frameScopes.values()) {
    if (!allowed) {
      return true;
    }
  }

  for (const allowed of state.globalTargetScopes.values()) {
    if (!allowed) {
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
    state.pendingGlobalTargetSessions.size === 0 &&
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
    areEquivalentCaptureUrls(state.rootUrl, expectedRootUrl)
  );
}

function areEquivalentCaptureUrls(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }

  try {
    return new URL(left).href === new URL(right).href;
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

function buildRequestScopeKey(requestId: string, sessionId?: string): string {
  return sessionId ? `cdp:${sessionId}:${requestId}` : requestId;
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
