# Revision 2 pilot stop report

Revision 2 stopped after its first eligible cell, `cache/R0`. No subsequent cell was started. The excluded v1 cell `safe-path/R1` was not rerun or replaced.

## Stop trigger

- The coding session produced 13 `tool_started` calls against the registered maximum of 12. The guard record did not report a `tool_call_limit` violation, so tool-call enforcement/accounting did not match the preregistration.
- Root cause: the first `read README.md` attempt was denied by `ToolPolicy` because the fixture has no README. Pi short-circuits later `tool_call` handlers after a block, and the pilot budget guard was registered after `ToolPolicy`; that denied attempt was not charged, allowing 12 further calls. The guard has now been moved ahead of `ToolPolicy` so every attempt consumes the ceiling before any policy handler can short-circuit.
- The session reached the hard limit of 8 provider stream starts. A ninth start was attempted and denied by the provider-request guard. The cell was recorded as `run-guard-stop` with `provider_request_limit`.
- Stop immediately. Do not resume this freeze or retry/replace `cache/R0`.

## Retained run

- Cell/run: `cache/R0`, `bb977b05-7c27-4ec8-8d98-f3cba43aec53`.
- Result: `results.jsonl`; blinded patch: `blinded-patches/16e0b4ec88d7.json`; key row: `scoring-key.jsonl`.
- Elapsed: 49.447 seconds. Provider stream starts: 8; ninth attempt denied. Recorded usage: 11,814 input, 777 output, 21,376 cache-read, 0 cache-write tokens. `assistantResponses` was recorded as 0, so that metric was not useful for this run.
- Thirteen tool starts included two executions of the exact approved combined test command. The frozen trusted check passed all 6 tests; test integrity was intact, and there were no changed-file scope violations.
- Disposable workspace: `/var/folders/t1/4j_nb0s16n36560v_106389r0000gn/T/rook-pilot-workspaces-f7bI6K/02-cache-R0`.

## Disposition

This is a stopped, noncompliant run—not an accepted patch-quality observation. No review condition was involved and no comparative or effectiveness conclusion can be drawn. The other 22 eligible revision-2 cells remain unstarted. The post-stop guard-order fix changes a frozen source hash, so `freeze.v2.json` is stale. Any further inference requires a new user decision and preregistration. Preserve both freeze files and all prior stop artifacts.
