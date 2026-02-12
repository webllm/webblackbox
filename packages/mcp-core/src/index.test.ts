import { describe, expect, it } from "vitest";

import { addNumbers, echo } from "./index.js";

describe("mcp-core", () => {
  it("adds numbers", () => {
    expect(addNumbers({ a: 2, b: 3 })).toBe(5);
  });

  it("echoes text", () => {
    expect(echo({ text: "hello" })).toBe("hello");
  });
});
