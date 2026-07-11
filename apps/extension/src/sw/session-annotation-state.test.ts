import { describe, expect, it, vi } from "vitest";

import {
  commitSessionAnnotationMutation,
  mergePersistedSessionAnnotation,
  SessionAnnotationMutationCoordinator
} from "./session-annotation-state.js";

describe("session annotation restoration", () => {
  it("prefers the separately durable annotation after a runtime checkpoint write failed", () => {
    expect(
      mergePersistedSessionAnnotation(
        { sid: "session-1", tags: ["old"], note: "old note" },
        { tags: ["new"], note: "new note" }
      )
    ).toEqual({ sid: "session-1", tags: ["new"], note: "new note" });
  });

  it("allows a durable annotation row to clear an older note", () => {
    expect(
      mergePersistedSessionAnnotation(
        { sid: "session-1", tags: ["old"], note: "remove me" },
        { tags: [] }
      )
    ).toEqual({ sid: "session-1", tags: [] });
  });

  it("rolls back the visible annotation when its combined checkpoint fails", async () => {
    let annotation = "old";

    await expect(
      commitSessionAnnotationMutation({
        apply: () => {
          annotation = "new";
        },
        rollback: () => {
          annotation = "old";
        },
        persist: () => Promise.reject(new Error("storage failed"))
      })
    ).rejects.toThrow("storage failed");
    expect(annotation).toBe("old");
  });
});

describe("SessionAnnotationMutationCoordinator", () => {
  it("does not let an older failed rollback clobber a newer same-sid mutation", async () => {
    const coordinator = new SessionAnnotationMutationCoordinator();
    let value = "old";
    let release!: () => void;
    const first = coordinator.run("S-one", () =>
      commitSessionAnnotationMutation({
        apply: () => {
          value = "first";
        },
        rollback: () => {
          value = "old";
        },
        persist: () =>
          new Promise<void>((_resolve, reject) => {
            release = () => reject(new Error("first failed"));
          })
      })
    );
    const second = coordinator.run("S-one", () =>
      commitSessionAnnotationMutation({
        apply: () => {
          value = "second";
        },
        rollback: () => {
          value = "old";
        },
        persist: async () => undefined
      })
    );

    await vi.waitFor(() => expect(value).toBe("first"));
    release();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBeUndefined();
    expect(value).toBe("second");
  });

  it("serializes different sids because they share one persisted annotation object", async () => {
    const coordinator = new SessionAnnotationMutationCoordinator();
    const order: string[] = [];
    let release!: () => void;
    const first = coordinator.run("S-first", async () => {
      order.push("first:begin");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first:end");
    });
    const second = coordinator.run("S-second", async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first:begin"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:begin", "first:end", "second"]);
  });

  it("does not let an annotation queued behind disposal recreate a removed session row", async () => {
    const coordinator = new SessionAnnotationMutationCoordinator();
    let release!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let present = true;
    let annotation: string | undefined = "old";
    const removal = coordinator.run("S-disposed", async () => {
      present = false;
      annotation = undefined;
      await removalGate;
    });
    const annotate = coordinator.run("S-disposed", async () => {
      if (present) {
        annotation = "new";
      }
    });

    await vi.waitFor(() => expect(present).toBe(false));
    release();
    await Promise.all([removal, annotate]);
    expect(annotation).toBeUndefined();
  });
});
