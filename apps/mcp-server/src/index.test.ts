import { describe, expect, it } from "vitest";

import { createServer } from "./index.js";

describe("mcp-server", () => {
  it("creates server instance", () => {
    expect(createServer()).toBeDefined();
  });
});
