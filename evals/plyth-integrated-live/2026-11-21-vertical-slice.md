# PLYTH integrated live vertical slice

Status: plumbing demonstration only; not a comparative or effectiveness evaluation.

## Setup

- Rook mode: `integrated`; legacy PLYTH prediction mode: `off`.
- Model: `openai/gpt-6.1-sol`, high thinking.
- Fresh synthetic Git workspace; no user source or stopped pilot workspace was used.
- Task: implement `normalizeTags` with trim, case-insensitive stable deduplication, non-string/blank filtering, and input immutability.
- Independent fixed check: `node --test tests/feature.test.mjs` (3 tests).
- Per-attempt ceiling: 8 provider starts, 20 admitted tool calls, 2,048 output tokens/response, 10 minutes. Only the fixture source file was writable; Bash allowlist contained a bounded in-workspace listing and the exact focused test command.
- No standalone reviewer, additional model, or PLYTH-induced provider turn.

## Retained development attempts

| Attempt                  | Outcome                                    | Provider starts | Tool calls | Usage (input/output/cache-read) | Notes                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------ | --------------: | ---------: | ------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalize-tags-live-01` | Stopped before source edits                |               2 | 0 admitted |                 3,609 / 121 / 0 | Pilot guard denied an initial parent-directory discovery command. The harness also put Pi session storage inside the task repository, making runtime files look like source changes and causing an early checkpoint. No task completion claimed. |
| `normalize-tags-live-02` | Source repaired; model verification denied |               6 | 5 admitted |             7,289 / 445 / 5,120 | Checkpoint reached the post-edit model context. The exact test command was denied because the harness compared a symlinked workspace path rather than Rook's canonical path. Independent host-side check passed; tests were unchanged.           |
| `normalize-tags-live-03` | Completed successfully                     |               6 | 5 admitted |             5,916 / 421 / 6,528 | Fresh workspace/session. No guard violations. Exact test command was approved and passed; tests remained byte-for-byte unchanged.                                                                                                                |

The first two failures are retained in this report and are not counted as successful task runs. The third attempt used a fresh workspace. Its test fixture differed from the second only in whitespace formatting; these are development attempts, not matched experimental cells.

## Successful attempt evidence

- Final patch changed only `src/tags.mjs`; the three independent checks passed. The test file SHA-256 was `02545faa6cf4dc06a0827c23c684abd9e27b93f1e8923a55738b5bfed0dfbe1e` both before and after the model run.
- Pi's model-bound context trace had no PLYTH block in requests 1–3. After the edit tool completed, request 4 contained `plyth-integrated-context` and the task-local change checkpoint. The model then read the edited file and ran the focused tests; the Bash result completed successfully. This demonstrates delivery timing in one real Rook inference loop.
- Elapsed time: 31.4 seconds. Rook-reported usage: 5,916 input, 421 output, 6,528 cache-read tokens. These are usage counters, not billed cost.
- The task had no repeated failing test, so no recovery signal was expected or observed. The checkpoint's effect on the patch cannot be isolated from ordinary guidance/model behavior.

## Limits and next step

This is one task/problem and three harness attempts, not evidence of general task-quality or efficiency benefit. There is no off/prompt-only comparison yet. Keep integrated mode default-off. Before comparative runs, freeze new untouched cases, condition order, independent checks, and scoring under a separate protocol; retain all failures and do not reuse this development task as a scored case.
