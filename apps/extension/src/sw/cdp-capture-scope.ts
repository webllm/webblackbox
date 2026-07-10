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
  rootFrameId?: string;
  sessionScopes: Map<string, boolean>;
  frameScopes: Map<string, boolean>;
  executionContextScopes: Map<number, boolean>;
  requestScopes: Map<string, boolean>;
};

export type CdpCaptureScopeEvaluation = {
  allowed: boolean;
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
    rootFrameId: undefined,
    sessionScopes: new Map(),
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

    if (childSessionId) {
      state.sessionScopes.set(childSessionId, allowed);
    }

    return { allowed };
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = asString(payload?.sessionId);

    if (childSessionId) {
      state.sessionScopes.delete(childSessionId);
    }

    return { allowed: false };
  }

  if (method === "Page.frameNavigated") {
    const frame = asRecord(payload?.frame);
    const frameId = asString(frame?.id);
    const frameUrl = asString(frame?.url);
    const topLevel =
      !sessionId && typeof frame?.parentId !== "string" && typeof frame?.parentFrameId !== "string";
    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    if (frameId) {
      state.frameScopes.set(frameId, decision.allowed);

      if (topLevel) {
        state.rootFrameId = frameId;
      }
    }

    if (sessionId) {
      state.sessionScopes.set(sessionId, decision.allowed);
    }

    if (topLevel && frameUrl) {
      if (decision.allowed) {
        state.captureUrl = frameUrl;
      }

      return {
        allowed: decision.allowed,
        topNavigation: {
          url: frameUrl,
          decision
        }
      };
    }

    return { allowed: decision.allowed };
  }

  if (method === "Page.navigatedWithinDocument") {
    const frameId = asString(payload?.frameId);
    const frameUrl = asString(payload?.url);
    const topLevel = !sessionId && frameId !== null && frameId === state.rootFrameId;
    const decision = evaluateFrameDocument(state, frameUrl, topLevel);

    if (frameId) {
      state.frameScopes.set(frameId, decision.allowed);
    }

    if (sessionId) {
      state.sessionScopes.set(sessionId, decision.allowed);
    }

    if (topLevel && frameUrl) {
      if (decision.allowed) {
        state.captureUrl = frameUrl;
      }

      return {
        allowed: decision.allowed,
        topNavigation: {
          url: frameUrl,
          decision
        }
      };
    }

    return { allowed: decision.allowed };
  }

  if (method === "Page.frameDetached") {
    const frameId = asString(payload?.frameId);

    if (frameId) {
      state.frameScopes.delete(frameId);
    }

    return { allowed: false };
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

export function primeCdpCaptureFrameTree(state: CdpCaptureScopeState, value: unknown): void {
  function visit(candidate: unknown, topLevel: boolean): void {
    const tree = asRecord(candidate);
    const frame = asRecord(tree?.frame);
    const frameId = asString(frame?.id);

    if (frameId) {
      state.frameScopes.set(
        frameId,
        evaluateFrameDocument(state, asString(frame?.url), topLevel).allowed
      );

      if (topLevel) {
        state.rootFrameId = frameId;
      }
    }

    const children = Array.isArray(tree?.childFrames) ? tree.childFrames : [];

    for (const child of children) {
      visit(child, false);
    }
  }

  visit(value, true);
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
  state.rootFrameId = undefined;
  state.sessionScopes.clear();
  state.frameScopes.clear();
  state.executionContextScopes.clear();
  state.requestScopes.clear();
}

export function hasDisallowedCdpFrames(state: CdpCaptureScopeState): boolean {
  for (const [frameId, allowed] of state.frameScopes) {
    if (frameId !== state.rootFrameId && !allowed) {
      return true;
    }
  }

  return false;
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

    return frameId === state.rootFrameId || state.frameScopes.get(frameId) === true;
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
