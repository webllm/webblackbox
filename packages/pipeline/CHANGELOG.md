# @webblackbox/pipeline

## 0.1.2

### Patch Changes

- fix player
- Updated dependencies
  - @webblackbox/protocol@0.1.2

## 0.1.1

### Patch Changes

- Reduced full-mode memory retention by rebuilding export indexes from persisted chunks instead of keeping the full session index resident in memory during recording.
- Made blob deduplication idempotent across storage backends so recovery, purge, and export flows handle repeated blob writes consistently.
- Updated dependencies
  - @webblackbox/protocol@0.1.1
