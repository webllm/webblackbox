# Performance Benchmarks

This document explains how to benchmark the recorder and pipeline so regressions are visible before release.

## Why this exists

WebBlackbox sessions can run for long periods and produce large archives. We track:

- ingest throughput (events/sec)
- export latency (ms)
- archive size impact after filtering
- ring buffer pruning cost

In addition, runtime capture now prefers lower page-thread overhead:

- extension `lite` disables page-side response-body sampling by default; opt in only when network body payloads are required
- extension `lite` defers heavy start-of-recording DOM/storage/screenshot capture to avoid foreground-tab activation jank
- extension `full` mode keeps heavy screenshot/DOM/storage capture on the SW/CDP side
- content-script side in `full` mode skips page-thread SnapDOM/outerHTML/storage snapshot loops
- extension `full` mode does not inject fetch/xhr/console hooks into the page
- pipeline ingest is batched across SW ↔ offscreen and web-sdk recorder ↔ pipeline boundaries
- pipeline drain is chunked to avoid giant `postMessage` payloads during stop/export
- injected network body capture is rate-limited and gated by runtime config to reduce page jank
- extension `e2e:perf:lite` now gates not only request/hover pressure but also real document navigation, iframe-heavy pages, and contenteditable typing

## Quick start

From repo root:

```bash
pnpm bench
```

Run only recorder benchmarks:

```bash
pnpm bench:recorder
```

Run only pipeline benchmarks:

```bash
pnpm bench:pipeline
```

Run CI regression checks (uses conservative fixed thresholds from `benchmarks/ci-thresholds.json`):

```bash
pnpm bench:ci
```

## Recorder benchmark

Command:

```bash
pnpm --filter @webblackbox/recorder bench
```

It reports:

- ring buffer baseline (`splice` prune) vs optimized head-index prune
- `WebBlackboxRecorder.ingest` throughput
- `snapshotRingBuffer()` latency
- retained event count and heap delta

Environment knobs:

- `BENCH_RING_EVENTS` (default `120000`)
- `BENCH_RECORDER_EVENTS` (default `160000`)

## Pipeline benchmark

Command:

```bash
pnpm --filter @webblackbox/pipeline bench
```

It measures:

- long-session ingest throughput and chunk count
- full export latency/size
- filtered export latency/size using the same defaults as extension/web-sdk policy:
  - screenshots disabled
  - archive cap `100 MB`
  - recent window `20 minutes`
- parse latency and reduction ratios

Environment knobs:

- `BENCH_PIPELINE_EVENTS` (default `25000`)
- `BENCH_PAYLOAD_BYTES` (default `900`)
- `BENCH_SCREENSHOT_INTERVAL` (default `120`)
- `BENCH_BLOB_POOL` (default `24`)
- `BENCH_BLOB_BYTES` (default `24576`)
- `BENCH_MAX_ARCHIVE_MB` (default `100`)
- `BENCH_RECENT_MINUTES` (default `20`)

## Suggested regression gate

For release branches, keep a small baseline history in CI artifacts and fail if:

- ingest throughput drops >15%
- filtered export latency increases >20%
- filtered archive size increases unexpectedly for the same fixture input

Because benchmark noise exists across machines, compare trends on the same runner class instead of absolute numbers from laptops.

## Runtime Perf Logs

For live troubleshooting on real pages, enable optional perf logs:

- Extension SW: open service worker devtools, run `globalThis.__WEBBLACKBOX_PERF__ = true`
- Web SDK page: run `window.__WEBBLACKBOX_PERF__ = true`

When enabled, logs include:

- slow offscreen requests (`[WebBlackbox][perf] offscreen request`)
- pipeline batch flush/drain size
- dropped low-priority events under backpressure
