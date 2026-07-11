import { describe, expect, it, vi } from "vitest";

import type { ContentActivationId, ContentReadyId } from "../shared/content-activation-protocol.js";
import {
  ContentActivationRegistry,
  type ContentActivationBinding,
  type ContentActivationIdentity,
  type ContentActivationLookup,
  type ContentActivationParent,
  type ContentActivationPreparation
} from "./content-activation-registry.js";

type TestRuntime = { readonly name: string };
type TestFence = { readonly name: string };
type TestPort = { readonly name: string };
type TestMode = "lite" | "full";
type TestIdentity = ContentActivationIdentity<TestRuntime, TestFence, TestMode>;
type TestPreparation = ContentActivationPreparation<TestRuntime, TestFence, TestMode>;
type TestBinding = ContentActivationBinding<TestRuntime, TestFence, TestMode>;
type TestLookup = ContentActivationLookup<TestRuntime, TestFence, TestMode>;

function readyId(fill: string): ContentReadyId {
  return `r1_${fill.repeat(64)}` as ContentReadyId;
}

function activationId(sequence: number): ContentActivationId {
  return `a1_${sequence.toString(16).padStart(64, "0")}` as ContentActivationId;
}

function activationFactory(start = 1): () => ContentActivationId {
  let sequence = start;
  return () => activationId(sequence++);
}

function identity(overrides: Partial<TestIdentity> = {}): TestIdentity {
  return {
    runtime: overrides.runtime ?? { name: "runtime-a" },
    fence: overrides.fence ?? { name: "fence-a" },
    sid: overrides.sid ?? "S-activation",
    tabId: overrides.tabId ?? 7,
    frameId: overrides.frameId ?? 0,
    documentId: overrides.documentId ?? "document-a",
    url: overrides.url ?? "https://app.example/a",
    mode: overrides.mode ?? "lite"
  };
}

function prepareInput(
  exactIdentity: TestIdentity,
  ready: ContentReadyId,
  parent?: ContentActivationParent
): TestPreparation {
  return {
    ...exactIdentity,
    readyId: ready,
    ...(parent ? { parent } : {})
  };
}

function lookup(binding: TestBinding, overrides: Partial<TestLookup> = {}): TestLookup {
  return {
    runtime: overrides.runtime ?? binding.runtime,
    fence: overrides.fence ?? binding.fence,
    sid: overrides.sid ?? binding.sid,
    tabId: overrides.tabId ?? binding.tabId,
    frameId: overrides.frameId ?? binding.frameId,
    documentId: overrides.documentId ?? binding.documentId,
    url: overrides.url ?? binding.url,
    mode: overrides.mode ?? binding.mode,
    activationId: overrides.activationId ?? binding.activationId
  };
}

describe("content activation registry", () => {
  it("requires arm before activate and follows prepared-active-draining-revoked", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const exactIdentity = identity();
    const prepared = registry.prepare(prepareInput(exactIdentity, readyId("1")))!;

    expect(prepared).toMatchObject({ state: "prepared", armed: false });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(registry.activate(prepared)).toBeNull();
    expect(registry.arm(prepared)).toMatchObject({ state: "prepared", armed: true });
    expect(registry.activate(prepared)).toMatchObject({ state: "active", armed: true });
    expect(registry.activate(prepared)).toMatchObject({ state: "active" });
    expect(registry.validate(lookup(prepared))).toMatchObject({ state: "active" });
    expect(registry.drain(prepared)).toMatchObject({ state: "draining" });
    expect(registry.drain(prepared)).toMatchObject({ state: "draining" });
    expect(registry.validate(lookup(prepared))).toBeNull();
    expect(registry.validate(lookup(prepared), ["draining"])?.state).toBe("draining");
    expect(registry.revoke(prepared)).toBe(true);
    expect(registry.revoke(prepared)).toBe(false);
    expect(registry.activate(prepared)).toBeNull();
    expect(registry.validate(lookup(prepared), ["revoked"])).toBeNull();
  });

  it("closes ordinary admission while retaining an exact revocation binding", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const prepared = registry.prepare(prepareInput(identity(), readyId("e")))!;
    const active = registry.activate(registry.arm(prepared)!)!;

    expect(registry.beginRevocation(active)).toMatchObject({
      activationId: active.activationId,
      state: "revoking",
      armed: false
    });
    expect(registry.lookupByActivationId(active.activationId)).toBeNull();
    expect(registry.lookupByActivationId(active.activationId, ["revoking"])).toMatchObject({
      activationId: active.activationId
    });
    expect(registry.revoke(active)).toBe(true);
    expect(registry.lookupByActivationId(active.activationId, ["revoking"])).toBeNull();
  });

  it("requires explicit revocation before A can be replaced by B", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const exactIdentity = identity();
    const a = registry.prepare(prepareInput(exactIdentity, readyId("a")))!;
    registry.arm(a);
    registry.activate(a);
    const oldPort = { name: "old-port" };
    expect(registry.bindPort(oldPort, a)).toBe(true);

    expect(registry.prepare(prepareInput(exactIdentity, readyId("b")))).toBeNull();
    registry.beginRevocation(a);
    expect(registry.prepare(prepareInput(exactIdentity, readyId("b")))).toBeNull();
    registry.revoke(a);
    const b = registry.prepare(prepareInput(exactIdentity, readyId("b")))!;

    expect(b.activationId).not.toBe(a.activationId);
    expect(registry.validate(lookup(a))).toBeNull();
    expect(registry.activate(a)).toBeNull();
    expect(registry.validatePort(oldPort, lookup(a))).toBeNull();
    expect(registry.currentForDocument(exactIdentity, ["prepared"])?.readyId).toBe(b.readyId);
    expect(registry.arm(b)?.readyId).toBe(b.readyId);
    expect(registry.activate(b)?.state).toBe("active");
  });

  it("treats a duplicate current ready as idempotent but never revives a revoked ready", () => {
    const createId = vi.fn(activationFactory());
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      createId
    );
    const exactIdentity = identity();
    const input = prepareInput(exactIdentity, readyId("c"));
    const first = registry.prepare(input)!;
    const duplicate = registry.prepare(input)!;

    expect(duplicate.activationId).toBe(first.activationId);
    expect(createId).toHaveBeenCalledOnce();
    expect(registry.revoke(first)).toBe(true);
    expect(registry.prepare(input)).toBeNull();
    expect(registry.arm(first)).toBeNull();
    expect(registry.activate(first)).toBeNull();
  });

  it("validates every runtime, fence, and serialized identity field exactly", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const prepared = registry.prepare(prepareInput(identity(), readyId("d")))!;
    registry.arm(prepared);
    registry.activate(prepared);

    const mismatches: Partial<TestLookup>[] = [
      { runtime: { name: "runtime-replacement" } },
      { fence: { name: "fence-replacement" } },
      { sid: "S-replacement" },
      { tabId: prepared.tabId + 1 },
      { frameId: prepared.frameId + 1 },
      { documentId: "document-replacement" },
      { url: "https://app.example/replacement" },
      { mode: "full" },
      { activationId: activationId(999) }
    ];

    for (const mismatch of mismatches) {
      expect(registry.validate(lookup(prepared, mismatch))).toBeNull();
    }

    expect(registry.validate(lookup(prepared))?.activationId).toBe(prepared.activationId);
  });

  it("binds a port to one exact activation and invalidates stale bindings", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const exactIdentity = identity();
    const first = registry.prepare(prepareInput(exactIdentity, readyId("e")))!;
    const port = { name: "content-port" };
    const otherPort = { name: "other-port" };

    expect(registry.bindPort(port, first)).toBe(true);
    expect(registry.validatePort(port, lookup(first))).toBeNull();
    expect(registry.validatePort(port, lookup(first), ["prepared"])?.readyId).toBe(first.readyId);
    expect(registry.validatePort(otherPort, lookup(first), ["prepared"])).toBeNull();

    registry.arm(first);
    registry.activate(first);
    expect(registry.validatePort(port, lookup(first))?.state).toBe("active");
    expect(registry.validatePort(port, lookup(first, { url: "https://evil.example/" }))).toBeNull();

    expect(registry.prepare(prepareInput(exactIdentity, readyId("f")))).toBeNull();
    registry.beginRevocation(first);
    registry.revoke(first);
    const replacement = registry.prepare(prepareInput(exactIdentity, readyId("f")))!;
    expect(registry.validatePort(port, lookup(first), ["revoked"])).toBeNull();
    expect(registry.bindPort(port, replacement)).toBe(true);
    expect((registry as unknown as { byPort: WeakMap<TestPort, unknown> }).byPort.get(port)).toBe(
      replacement.activationId
    );
    expect(registry.unbindPort(port, first)).toBe(false);
    expect(registry.unbindPort(port, replacement)).toBe(true);
    expect(registry.validatePort(port, lookup(replacement), ["prepared"])).toBeNull();
  });

  it("requires an already-armed exact parent and rejects orphan or self-parent children", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const runtime = { name: "runtime-parent" };
    const fence = { name: "fence-parent" };
    const root = registry.prepare(
      prepareInput(identity({ runtime, fence, documentId: "root" }), readyId("1"))
    )!;
    const childIdentity = identity({
      runtime,
      fence,
      frameId: 4,
      documentId: "child",
      url: "https://app.example/child"
    });

    expect(
      registry.prepare(
        prepareInput(childIdentity, readyId("2"), { frameId: 0, documentId: "root" })
      )
    ).toBeNull();
    registry.arm(root);
    expect(
      registry.prepare(
        prepareInput(childIdentity, readyId("3"), { frameId: 4, documentId: "child" })
      )
    ).toBeNull();
    expect(
      registry.prepare(
        prepareInput(childIdentity, readyId("4"), { frameId: 9, documentId: "missing" })
      )
    ).toBeNull();
    expect(
      registry.prepare(
        prepareInput(childIdentity, readyId("5"), { frameId: 0, documentId: "root" })
      )
    ).not.toBeNull();
  });

  it("cascades parent replacement and rejects a prepared child's late arm", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const runtime = { name: "runtime-parent-replacement" };
    const fence = { name: "fence-parent-replacement" };
    const rootIdentity = identity({ runtime, fence, documentId: "root" });
    const root = registry.prepare(prepareInput(rootIdentity, readyId("8")))!;
    registry.arm(root);
    registry.activate(root);
    const child = registry.prepare(
      prepareInput(
        identity({
          runtime,
          fence,
          frameId: 4,
          documentId: "child",
          url: "https://app.example/child"
        }),
        readyId("9"),
        { frameId: 0, documentId: "root" }
      )
    )!;

    expect(registry.prepare(prepareInput(rootIdentity, readyId("a")))).toBeNull();
    registry.beginRevocation(root);
    registry.revoke(root);
    const replacement = registry.prepare(prepareInput(rootIdentity, readyId("a")))!;

    expect(replacement.activationId).not.toBe(root.activationId);
    expect(registry.lookupByActivationId(root.activationId)).toBeNull();
    expect(registry.lookupByActivationId(child.activationId)).toBeNull();
    expect(registry.arm(child)).toBeNull();
    expect(registry.activate(child)).toBeNull();
    expect(registry.listRuntime(runtime, fence, ["prepared"])).toEqual([replacement]);
  });

  it("refreshes same-document history without changing activation or port ownership", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const original = registry.prepare(prepareInput(identity(), readyId("0")))!;
    const port = { name: "history-port" };
    registry.arm(original);
    registry.activate(original);
    registry.bindPort(port, original);

    const refreshed = registry.refreshUrl({
      runtime: original.runtime,
      fence: original.fence,
      sid: original.sid,
      tabId: original.tabId,
      frameId: original.frameId,
      documentId: original.documentId,
      mode: original.mode,
      activationId: original.activationId,
      url: "https://app.example/a#history"
    })!;

    expect(refreshed.activationId).toBe(original.activationId);
    expect(refreshed.readyId).toBe(original.readyId);
    expect(refreshed.url).toBe("https://app.example/a#history");
    expect(registry.validate(lookup(original))).toBeNull();
    expect(registry.validate(lookup(refreshed))?.state).toBe("active");
    expect(registry.validatePort(port, lookup(refreshed))?.url).toBe(refreshed.url);
    expect(
      registry.refreshUrl({
        runtime: { name: "runtime-attacker" },
        fence: refreshed.fence,
        sid: refreshed.sid,
        tabId: refreshed.tabId,
        frameId: refreshed.frameId,
        documentId: refreshed.documentId,
        mode: refreshed.mode,
        activationId: refreshed.activationId,
        url: "https://evil.example/"
      })
    ).toBeNull();
  });

  it("looks up ids and lists only exact live runtime/fence snapshots", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const runtime = { name: "runtime-list" };
    const fenceA = { name: "fence-a" };
    const fenceB = { name: "fence-b" };
    const first = registry.prepare(
      prepareInput(identity({ runtime, fence: fenceA, documentId: "list-a" }), readyId("b"))
    )!;
    const second = registry.prepare(
      prepareInput(identity({ runtime, fence: fenceB, documentId: "list-b" }), readyId("c"))
    )!;

    expect(registry.lookupByReadyId(first.readyId)?.activationId).toBe(first.activationId);
    expect(registry.lookupByActivationId(second.activationId)?.readyId).toBe(second.readyId);
    expect(registry.lookupByReadyId("invalid")).toBeNull();
    expect(registry.listRuntime(runtime)).toHaveLength(2);
    expect(registry.listRuntime(runtime, fenceA).map((entry) => entry.documentId)).toEqual([
      "list-a"
    ]);
    expect(registry.revoke(first)).toBe(true);
    expect(registry.lookupByActivationId(first.activationId)).toBeNull();
    expect(registry.lookupByActivationId(first.activationId, ["revoked"])).toBeNull();
    expect(registry.listRuntime(runtime)).toHaveLength(1);
  });

  it("isolates a restored runtime that reuses the same sid", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const oldRuntime = { name: "runtime-old" };
    const newRuntime = { name: "runtime-restored" };
    const oldFence = { name: "fence-old" };
    const newFence = { name: "fence-restored" };
    const oldIdentity = identity({ runtime: oldRuntime, fence: oldFence, documentId: "old-doc" });
    const newIdentity = identity({ runtime: newRuntime, fence: newFence, documentId: "new-doc" });
    const oldActivation = registry.prepare(prepareInput(oldIdentity, readyId("2")))!;
    const restoredActivation = registry.prepare(prepareInput(newIdentity, readyId("3")))!;
    registry.arm(oldActivation);
    registry.activate(oldActivation);
    registry.arm(restoredActivation);
    registry.activate(restoredActivation);

    expect(registry.revokeRuntime(oldRuntime, oldFence)).toBe(1);
    expect(registry.validate(lookup(oldActivation))).toBeNull();
    expect(registry.validate(lookup(restoredActivation))?.state).toBe("active");
    expect(registry.revokeRuntime(oldRuntime)).toBe(0);
  });

  it("does not let an old runtime revoke a same-document restored activation", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const oldRuntime = { name: "runtime-old" };
    const restoredRuntime = { name: "runtime-restored" };
    const oldIdentity = identity({ runtime: oldRuntime, fence: { name: "old-fence" } });
    const restoredIdentity = identity({
      runtime: restoredRuntime,
      fence: { name: "restored-fence" }
    });
    const oldActivation = registry.prepare(prepareInput(oldIdentity, readyId("4")))!;
    registry.beginRevocation(oldActivation);
    registry.revoke(oldActivation);
    const restoredActivation = registry.prepare(prepareInput(restoredIdentity, readyId("5")))!;

    expect(registry.revokeDocument(oldIdentity)).toBe(false);
    expect(registry.arm(oldActivation)).toBeNull();
    expect(registry.currentForDocument(restoredIdentity, ["prepared"])?.activationId).toBe(
      restoredActivation.activationId
    );
  });

  it("revokes an exact parent activation and its known descendant tree", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const runtime = { name: "runtime-tree" };
    const fence = { name: "fence-tree" };
    const rootIdentity = identity({ runtime, fence, documentId: "root", frameId: 0 });
    const childIdentity = identity({
      runtime,
      fence,
      documentId: "child",
      frameId: 4,
      url: "https://app.example/child"
    });
    const grandchildIdentity = identity({
      runtime,
      fence,
      documentId: "grandchild",
      frameId: 8,
      url: "https://app.example/grandchild"
    });
    const root = registry.prepare(prepareInput(rootIdentity, readyId("d")))!;
    registry.arm(root);
    registry.activate(root);
    const child = registry.prepare(
      prepareInput(childIdentity, readyId("e"), { frameId: 0, documentId: "root" })
    )!;
    registry.arm(child);
    registry.activate(child);
    const grandchild = registry.prepare(
      prepareInput(grandchildIdentity, readyId("f"), {
        frameId: 4,
        documentId: "child"
      })
    )!;

    expect(registry.revokeParent(rootIdentity)).toBe(3);
    expect(registry.validate(lookup(root), ["revoked"])).toBeNull();
    expect(registry.validate(lookup(child), ["revoked"])).toBeNull();
    expect(registry.validate(lookup(grandchild), ["revoked"])).toBeNull();
    expect(registry.listRuntime(runtime)).toEqual([]);
  });

  it("does not finalize a revoking parent before its child controller is gone", () => {
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      activationFactory()
    );
    const runtime = { name: "runtime-revoking-tree" };
    const fence = { name: "fence-revoking-tree" };
    const root = registry.prepare(
      prepareInput(identity({ runtime, fence, documentId: "root" }), readyId("b"))
    )!;
    registry.arm(root);
    registry.activate(root);
    const child = registry.prepare(
      prepareInput(
        identity({
          runtime,
          fence,
          frameId: 2,
          documentId: "child",
          url: "https://app.example/child"
        }),
        readyId("c"),
        { frameId: 0, documentId: "root" }
      )
    )!;
    registry.beginRevocation(root);
    registry.beginRevocation(child);

    expect(registry.finalizeRevocation(root)).toBe(false);
    expect(registry.finalizeRevocation(child)).toBe(true);
    expect(registry.finalizeRevocation(root)).toBe(true);
  });

  it("rejects reused ready ids across documents and invalid preparation identities", () => {
    const createId = vi.fn(activationFactory());
    const registry = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      createId
    );
    const firstIdentity = identity();
    const reusedReady = readyId("6");

    expect(registry.prepare(prepareInput(firstIdentity, reusedReady))).not.toBeNull();
    expect(
      registry.prepare(
        prepareInput(identity({ documentId: "other-document", frameId: 2 }), reusedReady, {
          frameId: 0,
          documentId: firstIdentity.documentId
        })
      )
    ).toBeNull();
    expect(
      registry.prepare({
        ...prepareInput(firstIdentity, readyId("7")),
        tabId: -1
      })
    ).toBeNull();
    expect(createId).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid or repeatedly colliding activation factories", () => {
    const invalid = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      () => "invalid" as ContentActivationId
    );
    expect(() => invalid.prepare(prepareInput(identity(), readyId("8")))).toThrow(
      "factory returned an invalid id"
    );

    const collision = activationId(1);
    const colliding = new ContentActivationRegistry<TestRuntime, TestFence, TestPort, TestMode>(
      () => collision
    );
    expect(colliding.prepare(prepareInput(identity(), readyId("9")))).not.toBeNull();
    expect(() =>
      colliding.prepare(prepareInput(identity({ documentId: "document-b" }), readyId("a")))
    ).toThrow("Unable to allocate a unique content activation id");
  });
});
