import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import {
  addNumbers,
  addNumbersInput,
  echo,
  echoInput,
  nowUtcInput,
  nowUtcIsoString
} from "@webblackbox/mcp-core";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "webblackbox-mcp-server",
    version: "0.1.0"
  });

  server.tool("health", "Health check", {}, async () => {
    return {
      content: [
        {
          type: "text",
          text: "ok"
        }
      ]
    };
  });

  server.tool("add_numbers", "Add two numbers", addNumbersInput, async ({ a, b }) => {
    const result = addNumbers({ a, b });

    return {
      content: [
        {
          type: "text",
          text: String(result)
        }
      ]
    };
  });

  server.tool("now_utc", "Get current UTC time as an ISO string", nowUtcInput, async () => {
    return {
      content: [
        {
          type: "text",
          text: nowUtcIsoString()
        }
      ]
    };
  });

  server.tool("echo", "Echo plain text", echoInput, async ({ text }) => {
    return {
      content: [
        {
          type: "text",
          text: echo({ text })
        }
      ]
    };
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}
