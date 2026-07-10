import { describe, expect, it } from "vitest";

import { sha256HexFromBytes, sha256HexFromText } from "./hash.js";

describe("sha256HexFromText", () => {
  it("returns deterministic sha256 hash for text input", async () => {
    const hash = await sha256HexFromText("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns deterministic sha256 hash for archive bytes", async () => {
    const hash = await sha256HexFromBytes(new Uint8Array([0x61, 0x62, 0x63]));
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
