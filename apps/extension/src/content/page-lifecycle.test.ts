import { describe, expect, it, vi } from "vitest";

import { acquireContentBootstrapLease } from "./bootstrap-lease.js";
import { bindContentPageLifecycle } from "./page-lifecycle.js";

describe("content page lifecycle", () => {
  it("ignores a canceled beforeunload and keeps the singleton active", () => {
    const target = new EventTarget();
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);
    const dispose = vi.fn(() => owner?.dispose());
    const unbind = bindContentPageLifecycle(target, {
      dispose,
      resume: vi.fn(),
      suspend: vi.fn()
    });

    target.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    expect(dispose).not.toHaveBeenCalled();
    expect(owner?.isActive()).toBe(true);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
    unbind();
  });

  it("suspends one owner for BFCache and resynchronizes it on persisted pageshow", () => {
    const target = new EventTarget();
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);
    const resync = vi.fn();
    const unbind = bindContentPageLifecycle(target, {
      dispose: () => owner?.dispose(),
      resume: () => {
        if (owner?.resume()) {
          resync();
        }
      },
      suspend: () => owner?.suspend()
    });

    target.dispatchEvent(pageTransition("pagehide", true));

    expect(owner?.isActive()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();

    target.dispatchEvent(pageTransition("pageshow", true));

    expect(owner?.isActive()).toBe(true);
    expect(resync).toHaveBeenCalledOnce();
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
    unbind();
  });

  it("disposes only on a non-persisted pagehide", () => {
    const target = new EventTarget();
    const documentWorld = {};
    const owner = acquireContentBootstrapLease(documentWorld);
    const unbind = bindContentPageLifecycle(target, {
      dispose: () => owner?.dispose(),
      resume: () => owner?.resume(),
      suspend: () => owner?.suspend()
    });

    target.dispatchEvent(pageTransition("pagehide", false));
    target.dispatchEvent(pageTransition("pageshow", true));

    expect(owner?.isActive()).toBe(false);
    expect(owner?.resume()).toBe(false);
    expect(acquireContentBootstrapLease(documentWorld)).toBeNull();
    unbind();
  });
});

function pageTransition(type: "pagehide" | "pageshow", persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}
