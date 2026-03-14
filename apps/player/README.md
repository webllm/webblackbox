# WebBlackbox Player

React-based session playback application for analyzing `.webblackbox` archives.

## Overview

The Player provides an interactive UI for exploring recorded web sessions with multiple analysis panels:

- **Timeline** — Chronological event visualization with filtering
- **Action Timeline** — Action cards with trigger/request/error/screenshot context
- **Network Waterfall** — HTTP request/response timing and details
- **Console** — Console log viewer with level filtering
- **Storage** — Cookie, localStorage, sessionStorage, IndexedDB, and cache operations
- **DOM Diff** — Visual comparison of DOM snapshots over time
- **Performance** — Web Vitals, long tasks, CPU profiles, heap snapshots
- **Screenshots** — Screenshot trail with pointer position overlay

## Technology Stack

- **React 19** — UI framework
- **@webblackbox/player-sdk** — Session analysis engine
- **@webblackbox/protocol** — Type definitions and validation
- **Custom CSS** — Player styling in `public/styles.css`
- **class-variance-authority** — Component variants
- **tsup** — Build/watch pipeline

## Development

```bash
cd apps/player
pnpm dev
```

## Build

```bash
cd apps/player
pnpm build
```

## GitHub Pages

Build a Pages-ready artifact:

```bash
cd apps/player
pnpm pages:build
```

This prepares `build/` for GitHub Pages by adding `.nojekyll` and `404.html`.

Deploy the Player to the repository Pages site:

```bash
cd apps/player
pnpm pages:deploy
```

The deploy script will:

- build the Player
- prepare the Pages artifact
- publish `apps/player/build` to the `gh-pages` branch
- verify `https://webllm.github.io/webblackbox/` is serving the Player

From the repo root you can also run:

```bash
pnpm player:pages:build
pnpm player:pages:deploy
```

## Usage

1. Open the Player application
2. Drag and drop a `.webblackbox` file (or use the file picker)
3. If the archive is encrypted, enter the passphrase
4. Explore the session using the interactive panels

## Features

### Event Timeline

- Chronological display of all captured events
- Filter by event type, level, and time range
- Full-text search across events
- Click events to view full details

### Action Timeline

- Card-based action spans from `getActionTimeline()`
- Trigger, duration, request/error counts, and screenshot context in one row
- Click-to-focus behavior links action cards to event details and request panel selection

### Network Panel

- Waterfall view of all HTTP requests
- Request/response headers and bodies
- Timing breakdown
- WebSocket and SSE stream analysis
- Generate curl/fetch commands for any request
- Export as HAR

### Console Panel

- All console output (log, info, warn, error, debug)
- Stack trace display for errors
- Source location links

### Storage Panel

- Cookie snapshots and operations
- localStorage/sessionStorage operations
- IndexedDB operations and snapshots
- Cache API operations
- Service Worker lifecycle events

### DOM Panel

- DOM snapshot timeline
- Diff view showing added, removed, and changed elements
- Path-based change tracking

### Performance Panel

- Core Web Vitals (LCP, CLS, INP, FID, TTFB)
- Long task detection
- CPU profile artifacts
- Heap snapshot artifacts
- Performance trace data

### Export

- Markdown bug reports
- Playwright test scripts
- Playwright mock scripts (with captured responses)
- GitHub issue templates
- Jira issue templates
- HAR export
- Share upload and link-based reload via `@webblackbox/share-server`

### Session Comparison

- Side-by-side comparison of two sessions
- Event count deltas by type
- Error and request rate comparison
- Storage operation comparison
- DOM snapshot diffing
