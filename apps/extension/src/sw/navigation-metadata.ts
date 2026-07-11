import type { WebBlackboxEvent } from "@webblackbox/protocol";

export type CurrentTabUrlPolicyDecision = "allowed" | "denied" | "stale";
export type ActiveCommittedDocumentKind = "top" | "child";

export function canUseExactLiteTopDocumentAuthorization(input: {
  mode: string;
  permissions: readonly string[] | undefined;
  hasWebNavigationApi: boolean;
  hasScriptingApi: boolean;
}): boolean {
  return (
    input.mode === "lite" &&
    input.permissions?.includes("webNavigation") === true &&
    input.hasWebNavigationApi &&
    input.hasScriptingApi
  );
}

export function classifyActiveCommittedDocument(input: {
  frameId: number;
  documentLifecycle?: string;
  frameType?: string;
}): ActiveCommittedDocumentKind | null {
  if (input.documentLifecycle !== "active") {
    return null;
  }

  if (input.frameType === "outermost_frame" && input.frameId === 0) {
    return "top";
  }

  if (input.frameType === "sub_frame" && input.frameId > 0) {
    return "child";
  }

  return null;
}

/**
 * Revalidates the visible tab URL after an asynchronous policy lookup. A late
 * B decision is stale once the tab has already advanced to C.
 */
export async function resolveCurrentTabUrlPolicyDecision(input: {
  candidateUrl: string;
  evaluateAllowed: () => boolean | Promise<boolean>;
  resolveCurrentUrl: () => string | null | Promise<string | null>;
}): Promise<CurrentTabUrlPolicyDecision> {
  const allowed = await input.evaluateAllowed();
  const currentUrl = await input.resolveCurrentUrl();

  if (currentUrl !== input.candidateUrl) {
    return "stale";
  }

  return allowed ? "allowed" : "denied";
}

export function shouldUpdateSessionMetadataFromNavigation(
  event: Pick<WebBlackboxEvent, "cdp">,
  payload: unknown
): boolean {
  if (event.cdp) {
    return false;
  }

  const frame = asRecord(asRecord(payload)?.frame);

  if (!frame) {
    return true;
  }

  return !hasString(frame.parentId) && !hasString(frame.parentFrameId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
