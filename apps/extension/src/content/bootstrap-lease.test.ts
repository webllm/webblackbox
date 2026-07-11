import { describe, expect, it } from "vitest";

import { acquireContentBootstrapLease } from "./bootstrap-lease.js";

describe("content bootstrap lease", () => {
  it("allows only one runtime bootstrap in the same document world", () => {
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);

    expect(owner?.isActive()).toBe(true);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
    expect(owner?.isActive()).toBe(true);
  });

  it("keeps a canceled navigation on the existing active owner", () => {
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);

    // A cancelable beforeunload does not transition the lease. Only pagehide
    // drives suspension or disposal in the content runtime.
    expect(owner?.isActive()).toBe(true);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
  });

  it("suspends and resumes one owner across a back-forward cache transition", () => {
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);

    expect(owner?.suspend()).toBe(true);
    expect(owner?.isActive()).toBe(false);
    expect(owner?.suspend()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();

    expect(owner?.resume()).toBe(true);
    expect(owner?.isActive()).toBe(true);
    expect(owner?.resume()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
  });

  it("keeps a cleaned document terminal so duplicate execution cannot revive it", () => {
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);

    expect(owner?.dispose()).toBe(true);
    expect(owner?.dispose()).toBe(false);
    expect(owner?.isActive()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
  });

  it("cannot resume a suspended document after terminal cleanup", () => {
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);

    expect(owner?.suspend()).toBe(true);
    expect(owner?.dispose()).toBe(true);
    expect(owner?.resume()).toBe(false);
    expect(owner?.isActive()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
  });

  it("allows a new document world to bootstrap independently", () => {
    const previousDocument = {};
    const nextDocument = {};
    const previousOwner = acquireContentBootstrapLease(previousDocument);
    const nextOwner = acquireContentBootstrapLease(nextDocument);

    expect(previousOwner).not.toBeNull();
    expect(nextOwner).not.toBeNull();

    previousOwner?.dispose();

    expect(previousOwner?.isActive()).toBe(false);
    expect(nextOwner?.isActive()).toBe(true);
  });
});
