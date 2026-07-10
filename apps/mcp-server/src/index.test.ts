import { describe, expect, it } from "vitest";

import {
  MAX_MCP_TEXT_PAYLOAD_BYTES,
  McpOutputLimitError,
  SERVER_NAME,
  createServer,
  nowUtcIsoString,
  toTextPayload
} from "./index.js";

describe("mcp-server", () => {
  it("creates server instance", () => {
    expect(createServer()).toBeDefined();
  });

  it("exposes stable server metadata helpers", () => {
    expect(SERVER_NAME).toBe("webblackbox-mcp-server");
    expect(nowUtcIsoString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("bounds serialized tool output by UTF-8 byte size", () => {
    expect(toTextPayload({ status: "ok" }).content[0]?.text).toContain('"status": "ok"');

    expect(() =>
      toTextPayload({ value: "\u754c".repeat(Math.ceil(MAX_MCP_TEXT_PAYLOAD_BYTES / 3)) })
    ).toThrow(McpOutputLimitError);
  });
});
