import { describe, expect, it } from "vitest";
import { parseContentActivationId } from "./content-activation-protocol.js";

import {
  advanceMainWorldControllerHint,
  createMainWorldControllerHint,
  parseMainWorldControllerHint,
  sameMainWorldControllerCapability
} from "./main-world-controller.js";

const ACTIVATION_ID = parseContentActivationId(`a1_${"a".repeat(64)}`)!;

describe("MAIN-world controller hints", () => {
  it("creates document-scoped capabilities from extension-owned randomness", () => {
    let fill = 1;
    const hint = createMainWorldControllerHint({
      getRandomValues(bytes) {
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(fill);
        fill += 1;
        return bytes;
      }
    });

    expect(hint).toEqual({
      secret: "01".repeat(32),
      moduleNonce: `m1_${"02".repeat(32)}`,
      revision: 0,
      phase: "inactive",
      activationId: null
    });
  });

  it("parses exact hints and advances only non-regressing state", () => {
    const initial = parseMainWorldControllerHint({
      secret: "a".repeat(64),
      moduleNonce: `m1_${"b".repeat(64)}`,
      revision: 0,
      phase: "inactive",
      activationId: null
    });
    expect(initial).not.toBeNull();
    expect(
      advanceMainWorldControllerHint(initial!, {
        revision: 1,
        phase: "active",
        activationId: ACTIVATION_ID
      })
    ).toMatchObject({ revision: 1, phase: "active", activationId: ACTIVATION_ID });
    expect(
      advanceMainWorldControllerHint(
        { ...initial!, revision: 2 },
        { revision: 1, phase: "inactive", activationId: null }
      )
    ).toBeNull();
    expect(
      advanceMainWorldControllerHint(initial!, {
        revision: 0,
        phase: "active",
        activationId: ACTIVATION_ID
      })
    ).toBeNull();
    expect(
      parseMainWorldControllerHint({
        ...initial!,
        revision: 2,
        phase: "drained",
        activationId: null
      })
    ).toBeNull();
  });

  it("rejects malformed state and compares only exact capabilities", () => {
    const base = parseMainWorldControllerHint({
      secret: "a".repeat(64),
      moduleNonce: `m1_${"b".repeat(64)}`,
      revision: 1,
      phase: "active",
      activationId: ACTIVATION_ID
    })!;
    expect(parseMainWorldControllerHint({ ...base, extra: true })).toBeNull();
    expect(parseMainWorldControllerHint({ ...base, activationId: null })).toBeNull();
    expect(sameMainWorldControllerCapability(base, { ...base })).toBe(true);
    expect(
      sameMainWorldControllerCapability(base, { ...base, moduleNonce: `m1_${"c".repeat(64)}` })
    ).toBe(false);
  });
});
