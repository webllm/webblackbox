# MCP Engineering Monorepo

Production-ready MCP monorepo scaffold powered by `pnpm` + `turbo`.

## Stack

- `pnpm` workspaces for dependency management
- `turborepo` for task orchestration and cache
- `TypeScript` (strict mode) with shared config package
- `tsup` for fast ESM builds
- `vitest` for tests
- `eslint` + `prettier` for code quality
- `husky` + `lint-staged` for pre-commit checks
- `changesets` for versioning and release

## Project Structure

```text
.
├── apps
│   └── mcp-server
├── packages
│   ├── config-typescript
│   └── mcp-core
└── turbo.json
```

## Quick Start

```bash
pnpm install
pnpm dev
```

## Useful Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## MCP Server

Run the MCP server app:

```bash
pnpm --filter @webblackbox/mcp-server dev
```

Build and run:

```bash
pnpm --filter @webblackbox/mcp-server build
pnpm --filter @webblackbox/mcp-server start
```

Inspect with MCP Inspector:

```bash
pnpm --filter @webblackbox/mcp-server inspect
```

A Web Blackbox
