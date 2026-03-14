<p align="center">
  <a href="https://github.com/webllm/webblackbox"><img src="https://raw.githubusercontent.com/webllm/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/mcp-core</h1>

<p align="center">
  Shared utility helpers and input schemas for WebBlackbox MCP integrations.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@webblackbox/mcp-core"><img src="https://img.shields.io/npm/v/@webblackbox/mcp-core.svg?color=f97316" alt="npm version" /></a>
  <a href="https://github.com/webllm/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@webblackbox/mcp-core?color=374151" alt="License" /></a>
  <a href="https://github.com/webllm/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

Small utility helpers and shared [Zod](https://zod.dev/) input schemas for the WebBlackbox MCP (Model Context Protocol) server and related integrations.

## Installation

```bash
npm install @webblackbox/mcp-core
```

## Usage

Each utility exports a Zod-based input schema (for MCP tool registration) and a corresponding function:

```typescript
import {
  addNumbersInput,
  addNumbers,
  nowUtcInput,
  nowUtcIsoString,
  echoInput,
  echo
} from "@webblackbox/mcp-core";

// Arithmetic helper
addNumbers({ a: 1, b: 2 }); // 3

// UTC timestamp
nowUtcIsoString(); // "2026-03-14T12:00:00.000Z"

// Echo
echo({ text: "hello" }); // "hello"
```

## Exported Utilities

| Function               | Input Schema      | Description                                       |
| ---------------------- | ----------------- | ------------------------------------------------- |
| `addNumbers({ a, b })` | `addNumbersInput` | Add two finite numbers                            |
| `nowUtcIsoString()`    | `nowUtcInput`     | Return the current UTC time as an ISO 8601 string |
| `echo({ text })`       | `echoInput`       | Echo back the provided text (1–10,000 chars)      |

Each `*Input` export is a plain object of Zod schemas, ready to pass as the `inputSchema` when registering an MCP tool.

## License

[MIT](https://github.com/webllm/webblackbox/blob/main/LICENSE)
