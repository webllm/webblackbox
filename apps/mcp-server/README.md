<p align="center">
  <a href="https://github.com/webllm/webblackbox"><img src="https://raw.githubusercontent.com/webllm/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/mcp-server</h1>

<p align="center">
  MCP server for AI-assisted web session analysis.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@webblackbox/mcp-server"><img src="https://img.shields.io/npm/v/@webblackbox/mcp-server.svg?color=f97316" alt="npm version" /></a>
  <a href="https://github.com/webllm/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@webblackbox/mcp-server?color=374151" alt="License" /></a>
  <a href="https://github.com/webllm/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

Model Context Protocol (MCP) server for AI-assisted web session analysis. Exposes WebBlackbox session data and analysis tools via the [Model Context Protocol](https://modelcontextprotocol.io/), enabling AI assistants (Claude, ChatGPT, etc.) to inspect, query, and reason about recorded web sessions.

## Run With npx

```bash
npx @webblackbox/mcp-server --help
npx @webblackbox/mcp-server
```

The package starts over stdio by default, which is the mode expected by MCP clients.

Example MCP client entry:

```json
{
  "command": "npx",
  "args": ["-y", "@webblackbox/mcp-server"]
}
```

## Technology Stack

- **Node.js / TypeScript**
- **@modelcontextprotocol/sdk** — MCP server framework
- **@webblackbox/player-sdk** — Archive loading and analysis

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

To inspect the packaged CLI locally:

```bash
cd apps/mcp-server
node dist/cli.js --help
node dist/cli.js --version
```

## Available Tools

### Utility tools

| Tool      | Description               |
| --------- | ------------------------- |
| `health`  | Health check              |
| `now_utc` | Get current UTC timestamp |

### Session analysis tools

| Tool                         | Description                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `list_archives`              | Scan a directory for `.webblackbox` / `.zip` archives                                               |
| `session_summary`            | Open one archive and return totals, top event types, top errors, slow/fails                         |
| `query_events`               | Query events by text/type/level/request/time range with pagination                                  |
| `network_issues`             | Return failed and slow network requests sorted by severity                                          |
| `generate_bug_report`        | Generate markdown + GitHub/Jira issue artifacts from one archive                                    |
| `export_har`                 | Export HAR JSON from an archive (optionally scoped by mono range)                                   |
| `generate_playwright`        | Generate a Playwright script from captured actions (optional range/start URL/HAR replay wiring)     |
| `summarize_actions`          | Summarize action spans with trigger/duration plus request, error, and screenshot context            |
| `find_root_cause_candidates` | Find likely root-cause signals around errors (nearby failed requests, warn/error console, AI hints) |
| `compare_sessions`           | Compare two archives (event/action/error/network/perf/storage deltas + endpoint-level regressions)  |

## Notes

- Archive paths are resolved from the current working directory if relative.
- Encrypted archives require `passphrase`.
- `query_events` defaults to payload-hidden output (`includeData=false`) to avoid huge responses.
- Range-scoped tools (`monoStart` / `monoEnd`) preload only intersecting chunks when opening archives.

## License

[MIT](https://github.com/webllm/webblackbox/blob/main/LICENSE)
