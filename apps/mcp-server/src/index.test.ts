import { describe, expect, it } from "vitest";

import { SERVER_NAME, createServer, nowUtcIsoString } from "./index.js";

describe("mcp-server", () => {
  it("creates server instance", () => {
    expect(createServer()).toBeDefined();
  });

  it("exposes stable server metadata helpers", () => {
    expect(SERVER_NAME).toBe("webblackbox-mcp-server");
    expect(nowUtcIsoString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
