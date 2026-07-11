import { describe, expect, it, vi } from "vitest";

import {
  claimRuntimeNavigation,
  isRuntimeNavigationClaimCurrent,
  snapshotRuntimeNavigation
} from "./runtime-navigation-claim.js";

type TestRuntime = {
  id: string;
  navigationRevision: number;
  open: boolean;
};

function createRuntime(id: string): TestRuntime {
  return {
    id,
    navigationRevision: 0,
    open: true
  };
}

describe("runtime navigation claims", () => {
  it("advances a monotonic revision and freezes each claim", () => {
    const runtime = createRuntime("runtime-a");
    const first = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/a");
    const second = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/b");

    expect(first).toMatchObject({ runtime, revision: 1, source: "tabs-url" });
    expect(second).toMatchObject({ runtime, revision: 2, source: "tabs-url" });
    expect(runtime.navigationRevision).toBe(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, "revision", 99)).toBe(false);
    expect(first.revision).toBe(1);
  });

  it("does not revive A1 after an A1 to B2 to A3 URL sequence", () => {
    const runtime = createRuntime("runtime-a");
    const isOpen = (candidate: TestRuntime) => candidate.open;
    const a1 = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/a");
    const b2 = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/b");
    const a3 = claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/a");

    expect(isRuntimeNavigationClaimCurrent(a1, runtime, isOpen)).toBe(false);
    expect(isRuntimeNavigationClaimCurrent(b2, runtime, isOpen)).toBe(false);
    expect(isRuntimeNavigationClaimCurrent(a3, runtime, isOpen)).toBe(true);
    expect(a1.candidateUrl).toBe(a3.candidateUrl);
    expect(a1.revision).not.toBe(a3.revision);
  });

  it("rejects a replacement runtime even when its revision is identical", () => {
    const original = createRuntime("runtime-a");
    const replacement = createRuntime("runtime-b");
    const claim = claimRuntimeNavigation(original, "tabs-complete");
    claimRuntimeNavigation(replacement, "tabs-complete");

    expect(original.navigationRevision).toBe(replacement.navigationRevision);
    expect(isRuntimeNavigationClaimCurrent(claim, replacement, () => true)).toBe(false);
    expect(isRuntimeNavigationClaimCurrent(claim, undefined, () => true)).toBe(false);
  });

  it("rejects an inactive runtime through the caller-provided open predicate", () => {
    const runtime = createRuntime("runtime-a");
    const claim = claimRuntimeNavigation(runtime, "content-navigation");

    runtime.open = false;

    expect(isRuntimeNavigationClaimCurrent(claim, runtime, (candidate) => candidate.open)).toBe(
      false
    );
  });

  it("snapshots child mutation work without advancing the top navigation", () => {
    const runtime = createRuntime("runtime-a");
    const root = claimRuntimeNavigation(runtime, "cdp-frame-navigated", "https://example.test/a");
    const child = snapshotRuntimeNavigation(
      runtime,
      "cdp-child-mutation",
      "https://child.example.test/frame"
    );

    expect(child.revision).toBe(root.revision);
    expect(runtime.navigationRevision).toBe(1);
    expect(isRuntimeNavigationClaimCurrent(child, runtime, () => true)).toBe(true);

    claimRuntimeNavigation(runtime, "cdp-within-document", "https://example.test/a#next");

    expect(isRuntimeNavigationClaimCurrent(child, runtime, () => true)).toBe(false);
  });

  it("does not consult the open predicate for stale ownership or revision", () => {
    const runtime = createRuntime("runtime-a");
    const replacement = createRuntime("runtime-b");
    const open = vi.fn(() => true);
    const claim = claimRuntimeNavigation(runtime, "tabs-url-complete");

    expect(isRuntimeNavigationClaimCurrent(claim, replacement, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();

    claimRuntimeNavigation(runtime, "tabs-url", "https://example.test/next");
    expect(isRuntimeNavigationClaimCurrent(claim, runtime, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects invalid or exhausted runtime revisions", () => {
    const invalid = createRuntime("invalid");
    invalid.navigationRevision = -1;
    expect(() => claimRuntimeNavigation(invalid, "tabs-url")).toThrow(
      "Runtime navigation revision must be a non-negative safe integer."
    );

    const exhausted = createRuntime("exhausted");
    exhausted.navigationRevision = Number.MAX_SAFE_INTEGER;
    expect(() => claimRuntimeNavigation(exhausted, "tabs-url")).toThrow(
      "Runtime navigation revision is exhausted."
    );
  });
});
