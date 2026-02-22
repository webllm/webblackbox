# WebBlackbox MCP Server

Model Context Protocol (MCP) server for AI-assisted web session analysis.

## Overview

This server exposes WebBlackbox session data and analysis tools via the [Model Context Protocol](https://modelcontextprotocol.io/), enabling AI assistants to inspect, query, and reason about recorded web sessions.

## Technology Stack

- **Node.js / TypeScript**
- **@modelcontextprotocol/sdk** — MCP server framework
- **@webblackbox/mcp-core** — Core utility tools

## Development

```bash
cd apps/mcp-server
pnpm dev
```

## Build

```bash
cd apps/mcp-server
pnpm build
```

## Available Tools

The MCP server exposes tools from `@webblackbox/mcp-core`:

| Tool          | Description               |
| ------------- | ------------------------- |
| `health`      | Health check              |
| `add_numbers` | Add two numbers           |
| `now_utc`     | Get current UTC timestamp |
| `echo`        | Echo text back            |

Additional session analysis tools are planned for future releases.
