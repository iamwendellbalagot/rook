# Pilot stop report

The preregistered pilot stopped after its first cell, `safe-path/R1`. No other cell was started, and this run was not replaced.

## Trigger

- The agent changed the allowed `src/path.mjs` and also created an unrequested root `status.md`; this violated the task's `src/`-only scope and the preregistered immediate-stop rule for unauthorized workspace edits. Its later `git add`/`git commit` attempt was denied by the frozen shell-command allowlist.
- The runner recorded 10 coding provider-request starts, exceeding the frozen maximum of 8. The request-ceiling guard did not stop this trajectory as preregistered. Do not interpret the per-response output cap or other limits as validated by this run.
- The frozen trusted path tests passed (2/2), and the frozen tests remained intact. These do not waive the scope or resource violation.

## Retained observations

- Rook record: `results.jsonl`; blinded patch artifact: `blinded-patches/ed71a5e3fc75.json`; mapping: `scoring-key.jsonl`.
- Condition: R1. Elapsed: 62.0 seconds. Coding tool calls: 10. Test commands: 2, both exact allowlisted commands. Coding usage: 7,739 input, 1,033 output, 23,424 cache-read, 0 cache-write tokens. Generic review usage: 1,703 input, 333 output, cache counters unavailable/zero in the returned record. No dollar-cost estimate is made.
- Review output reported no grounded unnecessary-complexity concern. The patch passed its trusted acceptance check but was out of scope due to the extra file.
- The generated run workspace and synthetic `status.md` are preserved locally under `runs/01-safe-path-R1/`; no original user workspace was involved or changed.

## Disposition

This single noncompliant run is not a comparative result. The 23 unstarted cells remain unrun; there is no blinded scoring or effectiveness conclusion. Per preregistration, do not resume, replace cells, or amend the runner and continue under this freeze. A new user decision and a new preregistration are required before any further provider inference.
