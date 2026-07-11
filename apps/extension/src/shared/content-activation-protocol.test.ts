import { describe, expect, it, vi } from "vitest";

import {
  createContentActivationId,
  createContentEventBatchId,
  createContentReadyId,
  isContentActivationId,
  isContentReadyId,
  parseContentActivationId,
  parseContentEventBatchId,
  parseContentReadyId,
  parseExactContentActivationIdRecord,
  parseExactContentReadyIdRecord,
  parseExactPlainOwnDataRecord,
  type RandomValuesProvider
} from "./content-activation-protocol.js";

function deterministicRandom(offset = 0): RandomValuesProvider {
  return {
    getRandomValues(bytes) {
      bytes.forEach((_, index) => {
        bytes[index] = (index + offset) & 0xff;
      });
      return bytes;
    }
  };
}

describe("content activation ids", () => {
  it("creates versioned 256-bit lowercase crypto ids", () => {
    const readyId = createContentReadyId(deterministicRandom());
    const activationId = createContentActivationId(deterministicRandom(16));
    const batchId = createContentEventBatchId(deterministicRandom(32));

    expect(readyId).toBe("r1_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(activationId).toBe(
      "a1_101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f"
    );
    expect(batchId).toBe("b1_202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
    expect(isContentReadyId(readyId)).toBe(true);
    expect(isContentActivationId(activationId)).toBe(true);
  });

  it("accepts only fixed-width lowercase event batch ids", () => {
    expect(parseContentEventBatchId(`b1_${"c".repeat(64)}`)).not.toBeNull();
    expect(parseContentEventBatchId(`b1_${"C".repeat(64)}`)).toBeNull();
    expect(parseContentEventBatchId(`b1_${"c".repeat(63)}`)).toBeNull();
    expect(parseContentEventBatchId(`a1_${"c".repeat(64)}`)).toBeNull();
  });

  it.each([
    "r1_",
    `r1_${"a".repeat(63)}`,
    `r1_${"a".repeat(65)}`,
    `r1_${"A".repeat(64)}`,
    `a1_${"a".repeat(64)}`,
    `r2_${"a".repeat(64)}`,
    42,
    null
  ])("rejects an invalid ready id %#", (value) => {
    expect(parseContentReadyId(value)).toBeNull();
  });

  it.each([
    "a1_",
    `a1_${"f".repeat(63)}`,
    `a1_${"f".repeat(65)}`,
    `a1_${"F".repeat(64)}`,
    `r1_${"f".repeat(64)}`,
    `a2_${"f".repeat(64)}`,
    {},
    undefined
  ])("rejects an invalid activation id %#", (value) => {
    expect(parseContentActivationId(value)).toBeNull();
  });

  it("rejects a random provider that replaces the requested buffer", () => {
    expect(() =>
      createContentReadyId({
        getRandomValues: () => new Uint8Array(32)
      })
    ).toThrow("invalid activation id buffer");
  });
});

describe("strict own-data parsing", () => {
  it("returns a frozen detached null-prototype copy of exact own data", () => {
    const input = Object.freeze({ kind: "content.ready", readyId: `r1_${"a".repeat(64)}` });
    const parsed = parseExactPlainOwnDataRecord(input, ["kind", "readyId"]);

    expect(parsed).toEqual(input);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toBe(input);
  });

  it("accepts a null-prototype own-data record", () => {
    const input = Object.assign(Object.create(null), { value: 7 });
    expect(parseExactPlainOwnDataRecord(input, ["value"])).toEqual({ value: 7 });
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => `r1_${"b".repeat(64)}`);
    const input = {};
    Object.defineProperty(input, "readyId", { enumerable: true, get: getter });

    expect(parseExactPlainOwnDataRecord(input, ["readyId"])).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects symbol, extra, missing, hidden, inherited, class, and array input", () => {
    const symbol = Symbol("hidden");
    expect(parseExactPlainOwnDataRecord({ readyId: "x", [symbol]: true }, ["readyId"])).toBeNull();
    expect(parseExactPlainOwnDataRecord({ readyId: "x", extra: true }, ["readyId"])).toBeNull();
    expect(parseExactPlainOwnDataRecord({}, ["readyId"])).toBeNull();

    const hidden = {};
    Object.defineProperty(hidden, "readyId", { enumerable: false, value: "x" });
    expect(parseExactPlainOwnDataRecord(hidden, ["readyId"])).toBeNull();

    expect(parseExactPlainOwnDataRecord(Object.create({ readyId: "x" }), [])).toBeNull();
    expect(parseExactPlainOwnDataRecord(new (class Envelope {})(), [])).toBeNull();
    expect(parseExactPlainOwnDataRecord(["x"], ["0"])).toBeNull();
  });

  it("fails closed for hostile proxy reflection", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        }
      }
    );

    expect(parseExactPlainOwnDataRecord(proxy, [])).toBeNull();
  });

  it("parses branded ids only from exact own-data envelopes", () => {
    const readyId = `r1_${"c".repeat(64)}`;
    const activationId = `a1_${"d".repeat(64)}`;

    expect(parseExactContentReadyIdRecord({ readyId })?.readyId).toBe(readyId);
    expect(parseExactContentActivationIdRecord({ activationId })?.activationId).toBe(activationId);
    expect(parseExactContentReadyIdRecord({ readyId, extra: true })).toBeNull();
    expect(parseExactContentActivationIdRecord({ activationId: readyId })).toBeNull();
  });
});
