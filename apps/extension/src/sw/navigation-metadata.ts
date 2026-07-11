import type { WebBlackboxEvent } from "@webblackbox/protocol";

export type CurrentTabUrlPolicyDecision = "allowed" | "denied" | "stale";
export type ActiveCommittedDocumentKind = "top" | "child";
export type CdpTopNavigationKind = "same-document" | "cross-document";
export type ExactInitialContentParent = Readonly<{ frameId: number; documentId: string }>;

const EXACT_TOP_NAVIGATION_OBSERVATION_LIMIT = 16;

export type ExactTopNavigationObservationState = {
  sequence: number;
  pendingCdp: Array<Readonly<{ url: string; restoreEpoch: number }>>;
  pendingWeb: Array<Readonly<{ token: number; url: string; restoreEpoch: number }>>;
  evictedWebUrls: string[];
};

export type ExactWebNavigationCommitObservation = Readonly<{
  token: number;
  restoreEpoch: number;
  cdpObserved: boolean;
  evictedWebTokens: readonly number[];
}>;

export type ExactCdpTopNavigationObservation =
  | Readonly<{
      kind: "current";
      restoreEpoch: number;
      matchedWebToken?: number;
      evictedWebTokens: readonly number[];
    }>
  | Readonly<{
      kind: "ignored-stale";
      ignoredWebToken?: number;
      evictedWebTokens: readonly number[];
    }>;

export interface CdpTopNavigationRestoreContract {
  readonly expectedChildMutationRevision: number;
  readonly expectedRestoreEpoch: number;
}

export type CdpTopNavigationOwnershipContract =
  | {
      readonly urlOwner: "web-navigation";
      readonly restore: null;
    }
  | {
      readonly urlOwner: "cdp";
      readonly restore: CdpTopNavigationRestoreContract;
    };

export function canUseExactLiteTopDocumentAuthorization(input: {
  mode: string;
  permissions: readonly string[] | undefined;
  hasWebNavigationApi: boolean;
  hasSameDocumentNavigationApi: boolean;
  hasScriptingApi: boolean;
}): boolean {
  return (
    input.mode === "lite" &&
    input.permissions?.includes("webNavigation") === true &&
    input.hasWebNavigationApi &&
    input.hasSameDocumentNavigationApi &&
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
 * Resolves the single owner of a top-document CDP navigation. In exact mode,
 * webNavigation owns cross-document URL adoption and the matching CDP event
 * must not launch a competing restore. CDP remains the owner of
 * same-document navigation because it has the exact frame identity there.
 */
export function resolveCdpTopNavigationOwnership(input: {
  navigationKind: CdpTopNavigationKind;
  usesExactWebNavigationDocumentOwnership: boolean;
  childMutationRevision: number;
  restoreEpoch: number;
}): CdpTopNavigationOwnershipContract {
  if (input.navigationKind === "cross-document" && input.usesExactWebNavigationDocumentOwnership) {
    return {
      urlOwner: "web-navigation",
      restore: null
    };
  }

  return {
    urlOwner: "cdp",
    restore: captureCdpTopNavigationRestoreContract({
      childMutationRevision: input.childMutationRevision,
      restoreEpoch: input.restoreEpoch
    })
  };
}

/**
 * Takes the child-frame revision snapshot at navigation observation time so a
 * queued top-navigation restore cannot silently absorb a later child mutation.
 */
export function captureCdpTopNavigationRestoreContract(input: {
  childMutationRevision: number;
  restoreEpoch: number;
}): CdpTopNavigationRestoreContract {
  return Object.freeze({
    expectedChildMutationRevision: input.childMutationRevision,
    expectedRestoreEpoch: input.restoreEpoch
  });
}

/**
 * Advances the document-generation guard used by serialized CDP restores.
 * This is deliberately independent from URL and child-frame generations: an
 * exact cross-document replacement can keep both values unchanged while an
 * older restore is still in flight.
 */
export function advanceCdpRestoreEpoch(input: { cdpRestoreEpoch: number }): number {
  if (
    !Number.isSafeInteger(input.cdpRestoreEpoch) ||
    input.cdpRestoreEpoch < 0 ||
    input.cdpRestoreEpoch === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("CDP restore epoch is invalid or exhausted.");
  }

  input.cdpRestoreEpoch += 1;
  return input.cdpRestoreEpoch;
}

export function isCdpRestoreEpochCurrent(
  input: { cdpRestoreEpoch: number },
  expectedRestoreEpoch: number
): boolean {
  return (
    Number.isSafeInteger(expectedRestoreEpoch) &&
    expectedRestoreEpoch >= 0 &&
    input.cdpRestoreEpoch === expectedRestoreEpoch
  );
}

/**
 * Correlates the two independently delivered observations of one exact
 * cross-document navigation. Matching by final URL handles redirects while
 * the FIFO tie-breaker keeps same-URL document replacements distinct.
 */
export function createExactTopNavigationObservationState(): ExactTopNavigationObservationState {
  return {
    sequence: 0,
    pendingCdp: [],
    pendingWeb: [],
    evictedWebUrls: []
  };
}

export function observeExactWebNavigationCommit(
  state: ExactTopNavigationObservationState,
  url: string,
  allocateRestoreEpoch: () => number
): ExactWebNavigationCommitObservation {
  const observationUrl = normalizeExactTopNavigationObservationUrl(url);
  const matchedCdpIndex = state.pendingCdp.findIndex(
    (candidate) => candidate.url === observationUrl
  );
  const matchedCdp =
    matchedCdpIndex >= 0 ? state.pendingCdp.splice(matchedCdpIndex, 1)[0] : undefined;
  const token = advanceExactTopNavigationObservationSequence(state);
  const restoreEpoch = matchedCdp?.restoreEpoch ?? allocateRestoreEpoch();

  if (!matchedCdp) {
    state.pendingWeb.push(Object.freeze({ token, url: observationUrl, restoreEpoch }));
  }

  return Object.freeze({
    token,
    restoreEpoch,
    cdpObserved: matchedCdp !== undefined,
    evictedWebTokens: trimExactTopNavigationObservations(state)
  });
}

export function observeExactCdpTopNavigation(
  state: ExactTopNavigationObservationState,
  url: string,
  allocateRestoreEpoch: () => number,
  isMatchedWebCurrent: (token: number, restoreEpoch: number) => boolean = () => true
): ExactCdpTopNavigationObservation {
  const observationUrl = normalizeExactTopNavigationObservationUrl(url);
  const matchedWebIndex = state.pendingWeb.findIndex(
    (candidate) => candidate.url === observationUrl
  );
  const matchedWeb =
    matchedWebIndex >= 0 ? state.pendingWeb.splice(matchedWebIndex, 1)[0] : undefined;

  if (matchedWeb) {
    if (!isMatchedWebCurrent(matchedWeb.token, matchedWeb.restoreEpoch)) {
      return Object.freeze({
        kind: "ignored-stale",
        ignoredWebToken: matchedWeb.token,
        evictedWebTokens: trimExactTopNavigationObservations(state)
      });
    }

    return Object.freeze({
      kind: "current",
      // A CDP event delivered after webNavigation may invalidate a restore
      // already in flight. Transfer the matched transaction to a fresh epoch
      // so that old continuation becomes stale and a compensating restore can
      // run without waiting for it.
      restoreEpoch: allocateRestoreEpoch(),
      matchedWebToken: matchedWeb.token,
      evictedWebTokens: trimExactTopNavigationObservations(state)
    });
  }

  const evictedIndex = state.evictedWebUrls.indexOf(observationUrl);
  if (evictedIndex >= 0) {
    state.evictedWebUrls.splice(evictedIndex, 1);
    return Object.freeze({
      kind: "ignored-stale",
      evictedWebTokens: trimExactTopNavigationObservations(state)
    });
  }

  const restoreEpoch = allocateRestoreEpoch();
  state.pendingCdp.push(Object.freeze({ url: observationUrl, restoreEpoch }));
  return Object.freeze({
    kind: "current",
    restoreEpoch,
    evictedWebTokens: trimExactTopNavigationObservations(state)
  });
}

export function cancelExactWebNavigationCommitObservation(
  state: ExactTopNavigationObservationState,
  token: number
): void {
  const index = state.pendingWeb.findIndex((candidate) => candidate.token === token);
  if (index >= 0) {
    state.pendingWeb.splice(index, 1);
  }
}

function advanceExactTopNavigationObservationSequence(
  state: ExactTopNavigationObservationState
): number {
  if (
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 0 ||
    state.sequence === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Exact top-navigation observation sequence is invalid or exhausted.");
  }

  state.sequence += 1;
  return state.sequence;
}

function trimExactTopNavigationObservations(
  state: ExactTopNavigationObservationState
): readonly number[] {
  const evictedWebTokens: number[] = [];

  while (state.pendingCdp.length > EXACT_TOP_NAVIGATION_OBSERVATION_LIMIT) {
    state.pendingCdp.shift();
  }
  while (state.pendingWeb.length > EXACT_TOP_NAVIGATION_OBSERVATION_LIMIT) {
    const evicted = state.pendingWeb.shift();
    if (evicted) {
      evictedWebTokens.push(evicted.token);
      state.evictedWebUrls.push(evicted.url);
    }
  }
  while (state.evictedWebUrls.length > EXACT_TOP_NAVIGATION_OBSERVATION_LIMIT) {
    state.evictedWebUrls.shift();
  }

  return evictedWebTokens;
}

function normalizeExactTopNavigationObservationUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Serializes restores only within one document epoch; a replacement must not
 * wait forever behind an abandoned restore owned by the previous document. */
export function resolveCdpRestorePredecessor(input: {
  tail: Promise<void>;
  tailEpoch: number;
  expectedRestoreEpoch: number;
}): Promise<void> {
  return input.tailEpoch === input.expectedRestoreEpoch ? input.tail : Promise.resolve();
}

/**
 * Content senders may adopt a top URL only in the legacy fallback path. Exact
 * document authorization leaves URL ownership with webNavigation.
 */
export function shouldContentSenderClaimCaptureUrl(input: {
  frameId: number;
  senderUrl: string;
  currentCaptureUrl: string;
  usesExactTopDocumentAuthorization: boolean;
}): boolean {
  return (
    input.frameId === 0 &&
    !input.usesExactTopDocumentAuthorization &&
    input.senderUrl !== input.currentCaptureUrl
  );
}

/** Requires webNavigation and scripting to agree on both child and parent
 * document identities; frame ids alone are reusable and never sufficient. */
export function resolveExactInitialContentParent(input: {
  frameId: number;
  parentFrameId: number;
  documentId?: string;
  parentDocumentId?: string;
  injectedDocumentId?: string;
  injectedParentDocumentId?: string;
}): ExactInitialContentParent | null {
  return input.frameId > 0 &&
    input.parentFrameId >= 0 &&
    typeof input.documentId === "string" &&
    input.documentId.length > 0 &&
    input.documentId === input.injectedDocumentId &&
    typeof input.parentDocumentId === "string" &&
    input.parentDocumentId.length > 0 &&
    input.parentDocumentId === input.injectedParentDocumentId
    ? { frameId: input.parentFrameId, documentId: input.parentDocumentId }
    : null;
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
