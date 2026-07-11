import { describe, expect, it, vi } from "vitest";

import { OffscreenDocumentLifecycle } from "./offscreen-document-lifecycle.js";

describe("OffscreenDocumentLifecycle", () => {
  it("shares one context check and creation across concurrent tab starts", async () => {
    const lifecycle = new OffscreenDocumentLifecycle();
    let releaseCreate!: () => void;
    const exists = vi.fn(async () => false);
    const create = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        })
    );

    const first = lifecycle.ensure({ exists, create });
    const second = lifecycle.ensure({ exists, create });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    releaseCreate();
    await Promise.all([first, second]);
    expect(exists).toHaveBeenCalledOnce();
  });

  it("rechecks owners after an in-flight creation before closing", async () => {
    const lifecycle = new OffscreenDocumentLifecycle();
    let releaseCreate!: () => void;
    let owned = false;
    const create = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        })
    );
    const close = vi.fn(async () => undefined);

    const ensure = lifecycle.ensure({ exists: async () => false, create });
    const pendingClose = lifecycle.closeIfUnused({ isUnused: () => !owned, close });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    owned = true;
    releaseCreate();
    await Promise.all([ensure, pendingClose]);
    expect(close).not.toHaveBeenCalled();
  });

  it("clears a failed creation so a later attempt can recover", async () => {
    const lifecycle = new OffscreenDocumentLifecycle();
    const create = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValue();

    await expect(lifecycle.ensure({ exists: async () => false, create })).rejects.toThrow(
      "create failed"
    );
    await expect(lifecycle.ensure({ exists: async () => false, create })).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
