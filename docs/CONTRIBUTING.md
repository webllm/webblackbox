# Contributing

Guide for developing and contributing to WebBlackbox.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** 10.28.1

## Setup

```bash
# Clone and install
git clone <repository-url>
cd webblackbox
pnpm install

# Build all packages
pnpm build

# Run in development mode
pnpm dev
```

## Monorepo Structure

WebBlackbox uses **pnpm workspaces** with **Turborepo** for task orchestration:

```
webblackbox/
├── apps/              # Applications (extension, player, mcp-server)
├── packages/          # Shared libraries (protocol, recorder, pipeline, etc.)
├── turbo.json         # Task pipeline configuration
└── pnpm-workspace.yaml
```

### Task Dependencies

```
build  → depends on ^build (build dependencies first)
test   → depends on ^build (build dependencies before testing)
dev    → parallel, no caching
lint   → independent, no dependencies
typecheck → depends on ^typecheck
```

## Development Workflow

### Adding a New Package

1. Create directory under `packages/` or `apps/`
2. Add `package.json` with workspace name (`@webblackbox/your-package`)
3. Add `tsconfig.json` extending shared config
4. Add `tsup.config.ts` for bundling (if library)
5. Package will be auto-discovered by pnpm workspaces

### Adding Dependencies

```bash
# Add to a specific package
pnpm --filter @webblackbox/protocol add zod

# Add dev dependency to root
pnpm add -Dw typescript
```

### Running Commands for Specific Packages

```bash
# Build one package
pnpm --filter @webblackbox/protocol build

# Test one package
pnpm --filter @webblackbox/pipeline test

# Dev mode for extension
pnpm --filter @webblackbox/extension dev
```

## Code Quality

### Linting & Formatting

```bash
# Lint all packages
pnpm lint

# Format all files
pnpm format

# Check formatting
pnpm format:check
```

Pre-commit hooks (via Husky + lint-staged) automatically:

- Run Prettier on staged files
- Run ESLint with auto-fix on staged TypeScript/JavaScript files

### Type Checking

```bash
pnpm typecheck
```

### Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @webblackbox/pipeline test

# Run tests in watch mode
pnpm --filter @webblackbox/recorder test -- --watch
```

Tests use **Vitest** and are co-located with source files (`*.test.ts`).

## Versioning

WebBlackbox uses [Changesets](https://github.com/changesets/changesets) for version management:

```bash
# Create a changeset
pnpm changeset

# Apply changesets and bump versions
pnpm version-packages

# Publish packages
pnpm release
```

## Architecture Guidelines

### Adding New Event Types

1. Add the event type string to `WEBBLACKBOX_EVENT_TYPES` in `packages/protocol/src/constants.ts`
2. Add a Zod schema for the event payload in `packages/protocol/src/schemas.ts`
3. Register the schema in the `specializedDataSchemas` map
4. Add normalization logic in `packages/recorder/src/normalizer.ts`
5. Add indexing logic in `packages/pipeline/src/indexer.ts` (if searchable)
6. Add query support in `packages/player-sdk/src/index.ts`
7. Add tests for all layers

### Adding Recorder Plugins

Create a factory function that returns a `RecorderPlugin`:

```typescript
import type { RecorderPlugin } from "@webblackbox/recorder";

export function createMyPlugin(): RecorderPlugin {
  return {
    name: "my-plugin",
    onRawEvent(raw, ctx) {
      /* ... */ return raw;
    },
    onEvent(event, ctx) {
      /* ... */ return event;
    }
  };
}
```

### Modifying the Archive Format

1. Update schemas in `@webblackbox/protocol`
2. Update export logic in `@webblackbox/pipeline`
3. Update import logic in `@webblackbox/player-sdk`
4. Ensure backward compatibility with existing archives
5. Bump `WEBBLACKBOX_PROTOCOL_VERSION` if breaking

## Building the Extension

```bash
cd apps/extension
pnpm build
```

Then load the `apps/extension/build` directory as an unpacked extension in `chrome://extensions/`.

For development, use watch mode:

```bash
cd apps/extension
pnpm dev
```

After rebuilding, click the reload button on the extension card in `chrome://extensions/`.
