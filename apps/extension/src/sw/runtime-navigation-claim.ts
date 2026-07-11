export type RuntimeNavigationOwner = {
  navigationRevision: number;
};

export type RuntimeNavigationSource =
  | "tabs-url"
  | "tabs-complete"
  | "tabs-url-complete"
  | "cdp-frame-navigated"
  | "cdp-within-document"
  | "content-navigation"
  | "cdp-child-mutation";

export type RuntimeNavigationClaim<Runtime extends RuntimeNavigationOwner> = Readonly<{
  runtime: Runtime;
  revision: number;
  source: RuntimeNavigationSource;
  /** Diagnostic context only. A URL is never evidence that a claim is current. */
  candidateUrl?: string;
}>;

/**
 * Claims a new top-level navigation for a runtime.
 *
 * Revisions are monotonic for the lifetime of the runtime, so returning to the
 * same URL cannot revive work from an earlier navigation.
 */
export function claimRuntimeNavigation<Runtime extends RuntimeNavigationOwner>(
  runtime: Runtime,
  source: RuntimeNavigationSource,
  candidateUrl?: string
): RuntimeNavigationClaim<Runtime> {
  const currentRevision = validateRuntimeNavigationRevision(runtime.navigationRevision);

  if (currentRevision === Number.MAX_SAFE_INTEGER) {
    throw new Error("Runtime navigation revision is exhausted.");
  }

  runtime.navigationRevision = currentRevision + 1;
  return createRuntimeNavigationClaim(runtime, source, candidateUrl);
}

/**
 * Snapshots the current top-level navigation without advancing it.
 *
 * This is intended for child-frame or target work that must be abandoned when
 * any later top-level navigation is claimed.
 */
export function snapshotRuntimeNavigation<Runtime extends RuntimeNavigationOwner>(
  runtime: Runtime,
  source: RuntimeNavigationSource,
  candidateUrl?: string
): RuntimeNavigationClaim<Runtime> {
  validateRuntimeNavigationRevision(runtime.navigationRevision);
  return createRuntimeNavigationClaim(runtime, source, candidateUrl);
}

/**
 * Validates both runtime ownership and navigation generation before consulting
 * the caller's runtime-specific active/open predicate.
 */
export function isRuntimeNavigationClaimCurrent<Runtime extends RuntimeNavigationOwner>(
  claim: RuntimeNavigationClaim<Runtime>,
  currentRuntime: Runtime | null | undefined,
  isOpen: (runtime: Runtime) => boolean
): boolean {
  return (
    currentRuntime === claim.runtime &&
    claim.runtime.navigationRevision === claim.revision &&
    isOpen(claim.runtime)
  );
}

function createRuntimeNavigationClaim<Runtime extends RuntimeNavigationOwner>(
  runtime: Runtime,
  source: RuntimeNavigationSource,
  candidateUrl?: string
): RuntimeNavigationClaim<Runtime> {
  return Object.freeze({
    runtime,
    revision: runtime.navigationRevision,
    source,
    ...(candidateUrl === undefined ? {} : { candidateUrl })
  });
}

function validateRuntimeNavigationRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Runtime navigation revision must be a non-negative safe integer.");
  }

  return revision;
}
