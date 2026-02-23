# Performance Benchmarks

This document explains how to benchmark the recorder and pipeline so regressions are visible before release.

## Why this exists

WebBlackbox sessions can run for long periods and produce large archives. We track:

- ingest throughput (events/sec)
- export latency (ms)
- archive size impact after filtering
- ring buffer pruning cost

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
