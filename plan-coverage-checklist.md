# WebBlackbox Plan Coverage Checklist

This checklist tracks implementation status against `plan.md`.

Legend:

- DONE: implemented and wired in current codebase
- PARTIAL: implemented baseline, advanced behavior still pending
- MISSING: not implemented yet

## Core Architecture

| Area                                          | Status  | Notes                                                                                                                    |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| MV3 extension foundation                      | DONE    | Service worker, content, injected, offscreen, popup/options/sessions are wired.                                          |
| Protocol v1 envelope/types                    | DONE    | `packages/protocol` constants/types/schemas/messages implemented with tests.                                             |
| Recorder normalization/redaction/action spans | DONE    | `packages/recorder` supports normalization, redaction, freeze policy, span assignment.                                   |
| Pipeline chunk/index/export                   | DONE    | `packages/pipeline` supports chunking, indexing, blob store, archive export/read.                                        |
| Offscreen lifecycle integration               | PARTIAL | Offscreen receives runtime/pipeline status and participates in runtime flow; primary pipeline orchestration still in SW. |

## Capture Plane

| Area                                                       | Status  | Notes                                                                                  |
| ---------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Lite capture (interaction/console/errors/perf/storage ops) | DONE    | Content/injected scripts capture key events, mutations, longtask, vitals, storage ops. |
| Full mode CDP attach/routing                               | DONE    | CDP router + debugger transport integrated into SW runtime.                            |
| Response body/sample capture                               | DONE    | `Network.getResponseBody` sampling and blob persistence implemented.                   |
| Screenshot and DOM snapshot artifacts                      | DONE    | Full-mode artifact capture stores screenshot/DOM snapshots as blobs.                   |
| WS/SSE advanced decoding and drilldown                     | PARTIAL | Event capture mapped; richer payload drilldown and UI decoding can be expanded.        |

## Playback Plane

| Area                                      | Status  | Notes                                                                               |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Player SDK archive open/query/search/blob | DONE    | `WebBlackboxPlayer` supports archive loading and query/search APIs.                 |
| Derived causality/action spans            | DONE    | SDK builds explicit and derived action spans.                                       |
| Network waterfall + request drilldown UI  | DONE    | Player app renders waterfall rows, request details, linked events.                  |
| Storage timeline UI                       | DONE    | Player app renders storage timeline event stream.                                   |
| Session compare and storage diff workflow | DONE    | Optional compare archive produces event/type/storage deltas.                        |
| DOM diff browser (tree-level visual diff) | PARTIAL | DOM snapshot/event capture exists; dedicated visual tree diff UX remains to deepen. |

## Export and Reporting

| Area                           | Status  | Notes                                                                       |
| ------------------------------ | ------- | --------------------------------------------------------------------------- |
| `.webblackbox` export          | DONE    | Pipeline exports zip-based archive with manifest/index/integrity sections.  |
| Bug report markdown export     | DONE    | SDK generates markdown report, player UI exports file.                      |
| HAR export                     | DONE    | SDK emits HAR 1.2-compatible structure, player UI exports file.             |
| cURL/fetch repro generation    | DONE    | SDK generates request-level cURL and fetch snippets; UI copy actions added. |
| Playwright repro script export | DONE    | SDK generates replay scaffold; player UI exports script.                    |
| Network mock generation depth  | PARTIAL | Script scaffold supports HAR replay; richer mock fixtures can be expanded.  |

## Extensibility and Runtime Hardening

| Area                                  | Status | Notes                                                                 |
| ------------------------------------- | ------ | --------------------------------------------------------------------- |
| Plugin system core hooks              | DONE   | Recorder plugin hooks (`onRawEvent`, `onEvent`) implemented.          |
| Sample plugins                        | DONE   | Route-context and error-fingerprint plugins included and tested.      |
| Plugin integration in runtime         | DONE   | Extension sessions enable default recorder plugins.                   |
| Options-to-recorder propagation       | DONE   | SW loads stored options and applies config per session start.         |
| Session runtime persistence hardening | DONE   | Active session metadata persists and is recovered/cleaned on SW boot. |

## Advanced/Optional Items

| Area                                            | Status  | Notes                                                                   |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Export encryption (AES-GCM passphrase)          | MISSING | Not implemented yet.                                                    |
| Heap snapshot/CPU profile full workflow         | PARTIAL | Perf trace artifact path exists; advanced profiling UX can be extended. |
| Team integrations (Jira/GitHub issue templates) | MISSING | Not implemented yet.                                                    |
| AI root-cause analyzer plugin                   | MISSING | Not implemented yet.                                                    |
