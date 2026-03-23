# Contributing to WebBlackbox

This guide is for working on the monorepo itself: building apps locally, running tests, and making changes across the extension, Player, SDKs, and release tooling.

## Prerequisites

- Node.js `>= 22.0.0`
- pnpm `10.28.1`

## Setup

```bash
git clone https://github.com/webllm/webblackbox.git
cd webblackbox
pnpm install
pnpm build
```

For watch mode across the workspace:

```bash
pnpm dev
```

## Workspace Layout

```text
webblackbox/
├── apps/
│   ├── extension/      # Chrome extension
│   ├── player/         # Hosted archive player
│   ├── mcp-server/     # MCP server CLI
│   └── share-server/   # Optional sharing backend
├── packages/
│   ├── protocol/       # Shared schema and defaults
│   ├── recorder/       # Event normalization and ring buffer
│   ├── pipeline/       # Chunking, storage, export
│   ├── webblackbox/    # Browser lite capture SDK
│   ├── player-sdk/     # Archive loading and analysis APIs
│   └── cdp-router/     # Chrome DevTools Protocol routing
├── config/
│   └── typescript/     # Shared TypeScript config
└── docs/               # Architecture, performance, generated API docs
```

## Common Commands

| Command                 | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `pnpm build`            | Build the whole workspace                            |
| `pnpm dev`              | Run workspace watch tasks                            |
| `pnpm test`             | Run workspace tests                                  |
| `pnpm lint`             | Run ESLint across packages                           |
| `pnpm typecheck`        | Run TypeScript checks                                |
| `pnpm format`           | Format the repo with Prettier                        |
| `pnpm format:check`     | Verify formatting                                    |
| `pnpm changeset`        | Create a release changeset                           |
| `pnpm version-packages` | Apply changesets and sync extension manifest version |
| `pnpm release`          | Publish npm packages via Changesets                  |

Use `pnpm --filter <package-name> <script>` for package-specific work.

Examples:

```bash
pnpm --filter @webblackbox/extension build
pnpm --filter @webblackbox/player test
pnpm --filter @webblackbox/mcp-server build
pnpm --filter webblackbox typecheck
```

## Working on the Chrome Extension

Build once:

```bash
pnpm --filter @webblackbox/extension build
```

Watch during development:

```bash
pnpm --filter @webblackbox/extension dev
```

Then load `apps/extension/build` in `chrome://extensions/` with `Developer mode` enabled.

Useful extension commands:

```bash
pnpm --filter @webblackbox/extension e2e:check
pnpm --filter @webblackbox/extension e2e:fullchain:lite
pnpm --filter @webblackbox/extension e2e:perf:lite
pnpm --filter @webblackbox/extension package:chrome
```

## Working on the Player

```bash
pnpm --filter @webblackbox/player build
pnpm --filter @webblackbox/player serve
```

GitHub Pages helpers:

```bash
pnpm player:pages:build
pnpm player:pages:deploy
```

## Working on the MCP Server

```bash
pnpm --filter @webblackbox/mcp-server build
pnpm --filter @webblackbox/mcp-server test
pnpm --filter @webblackbox/mcp-server inspect
```

CLI smoke checks:

```bash
pnpm --filter @webblackbox/mcp-server exec node dist/cli.js --help
pnpm --filter @webblackbox/mcp-server exec node dist/cli.js --version
```

## Testing and Quality

Pre-commit hooks run:

- Prettier on staged files
- ESLint `--fix` on staged JS/TS files

Common targeted checks:

```bash
pnpm --filter @webblackbox/pipeline test
pnpm --filter @webblackbox/player-sdk test
pnpm --filter @webblackbox/recorder test
pnpm docs:api
```

## Versioning and Releases

WebBlackbox uses Changesets.

```bash
pnpm changeset
pnpm version-packages
pnpm release
```

Notes:

- `version-packages` also syncs the Chrome extension manifest version from `apps/extension/package.json`.
- Release automation publishes npm packages, uploads the Chrome extension ZIP to GitHub Releases, and deploys the hosted Player to GitHub Pages.

## Architecture Touchpoints

If you change a cross-cutting behavior, update all affected layers:

- New event type:
  Update `packages/protocol`, then `packages/recorder`, `packages/pipeline`, `packages/player-sdk`, and any app UI or MCP tools that expose it.
- Archive format:
  Update protocol schemas, pipeline export/import behavior, Player SDK loading, and backward-compatibility coverage.
- Extension capture behavior:
  Check `apps/extension`, `packages/webblackbox`, and the perf/fullchain scripts together.

## Reference Docs

- [Root README](README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Performance](docs/PERFORMANCE.md)
- [Extension Guide](apps/extension/README.md)
- [Player Guide](apps/player/README.md)
