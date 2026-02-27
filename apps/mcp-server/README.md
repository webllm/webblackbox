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
