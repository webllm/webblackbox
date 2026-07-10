import {
  evaluateCaptureScope,
  type CapturePolicy,
  type CaptureScopeDecision
} from "@webblackbox/protocol";

export type CaptureDocumentScopeInput = {
  url: string | null | undefined;
  tabId: number;
  frameId?: number;
  now?: number;
};

export type CaptureScopeEnterpriseOriginPolicyInput = {
  nextOrigin: string | null;
  isEnterpriseOriginAllowed: (origin: string) => boolean;
};

export function bindCapturePolicyToSession(
  policy: CapturePolicy,
  context: { tabId: number; origin: string }
): CapturePolicy {
  return {
    ...policy,
    scope: {
      ...policy.scope,
      tabId: context.tabId,
      origin: context.origin,
      allowedOrigins: [...policy.scope.allowedOrigins],
      deniedOrigins: [...policy.scope.deniedOrigins],
      excludedUrlPatterns: [...policy.scope.excludedUrlPatterns]
    }
  };
}

/** Applies the protocol scope model to a Chrome document/frame sender. */
export function evaluateCaptureDocumentScope(
  policy: CapturePolicy | null | undefined,
  input: CaptureDocumentScopeInput
): CaptureScopeDecision {
  const frameId = normalizeFrameId(input.frameId);

  return evaluateCaptureScope(policy, {
    url: input.url,
    tabId: input.tabId,
    frameId: frameId ?? -1,
    topLevel: frameId === 0,
    now: input.now
  });
}

/**
 * Second-line event defense for sources that carry a child-frame marker even
 * after the Chrome sender boundary has been checked.
 */
export function isCaptureEventFrameAllowed(
  policy: CapturePolicy | null | undefined,
  input: { source: string; frame?: string; cdpSessionId?: string }
): boolean {
  if (!policy) {
    return false;
  }

  if (policy.scope.includeSubframes) {
    return true;
  }

  if (input.cdpSessionId) {
    return false;
  }

  return input.frame === undefined || input.frame.length === 0;
}

export function resolveContentScriptInjectionTarget(
  policy: CapturePolicy | null | undefined,
  tabId: number
): { tabId: number; allFrames: boolean } {
  return {
    tabId,
    allFrames: policy?.scope.includeSubframes === true
  };
}

export function shouldStopForEnterpriseOriginPolicy(
  input: CaptureScopeEnterpriseOriginPolicyInput
): boolean {
  if (!input.nextOrigin) {
    return true;
  }

  return !input.isEnterpriseOriginAllowed(input.nextOrigin);
}

function normalizeFrameId(value: number | undefined): number | null {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}
