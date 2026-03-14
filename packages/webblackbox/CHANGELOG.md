# webblackbox

## 0.1.1

### Patch Changes

- Substantially improved lite-mode responsiveness by deferring heavy capture work, reducing mutation and network pressure, coalescing scroll and input churn, and restoring controlled runtime screenshots with stop-time drain.
- Renamed the workspace directory from `packages/web-sdk` to `packages/webblackbox` while keeping the published package name `webblackbox`.
- Updated dependencies
  - @webblackbox/pipeline@0.1.1
  - @webblackbox/protocol@0.1.1
  - @webblackbox/recorder@0.1.1
