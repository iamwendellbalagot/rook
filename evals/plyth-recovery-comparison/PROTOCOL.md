# PLYTH persistent-failure recovery comparison

Status: draft; no comparison inference until protocol, cases, fixtures, runner, and source hashes are frozen in a commit.

## Question

Does PLYTH's revision-aware signal about persistent failing checks help the same coding agent recover more effectively than off or static prompt-only guidance?

## Arms and fixed setup

- **off:** `ROOK_PLYTH_INTEGRATED=off`, `ROOK_PLYTH_MODE=off`.
- **prompt:** `ROOK_PLYTH_INTEGRATED=prompt`, `ROOK_PLYTH_MODE=off`.
- **integrated:** `ROOK_PLYTH_INTEGRATED=integrated`, `ROOK_PLYTH_MODE=off`.

Prompt and integrated receive the same static PLYTH guidance; only integrated receives dynamic persistent-failure context. Model/provider is `openai/gpt-6.1-sol`, high thinking. No reviewer/second model. Each cell uses a clean fixture copy, fresh session, identical task/checks/permissions/budgets, with only its listed source path writable and exactly its focused test command permitted for execution.

## Tasks and recovery opportunity

Three fresh synthetic tasks (9 cells): retry policy, same-origin redirect validation, and abortable delay. Exact prompts, source/test files, frozen rubrics, and balanced arm order are in `cases.json`. Prompts require the exact failing starter test **before editing**, followed by the same test after each implementation change. The runner records tool order and commands. A recovery opportunity exists only when the agent ran the frozen test before editing and a later test run still contains at least one of the same failing test labels. Merely delivering a message is not a successful recovery.

## Limits and stop rules

- Per cell: 24 provider starts, 48 tool attempts, 8,000 output tokens per response, 10 minutes.
- Only exact frozen test and bounded in-workspace inspection commands may run. Writes outside the one source path are denied. Every Bash execution requires one-time approval.
- Each cell runs once. Preserve any timeout, provider failure, guard violation, test edit, initial-test-order deviation, or interruption. Never replace a cell. Stop after any guard violation, timeout, or provider-request ceiling.
- Record initial-test-before-edit compliance, every test result/label set, persistent-label opportunity, dynamic message delivery, patch/path/test integrity, rubric evidence, tool/provider counts, usage, elapsed time, and failure reason. Do not store hidden reasoning or credentials.

## Outcomes and decision threshold

Primary success requires passing frozen tests, unchanged tests, and source edits confined to the allowlist. Report it separately from protocol compliance and recovery opportunities.

Score each frozen three-point rubric 0–2 per criterion. AI assessment is provisional unless a blinded independent human reviews anonymized diffs. Record count of persistent failures, number of unchanged reruns, and actions after the signal. A dynamic benefit requires no loss of primary success and a concrete correctness-preserving improvement in recovery/patch quality or reduced repeated work on at least two distinct tasks versus **both** controls. If integrated has fewer than two natural opportunities, or all arms recover similarly, conclude “no demonstrated recovery benefit”; do not force additional opportunities or claim effectiveness from message delivery. Keep integrated mode default-off absent that evidence.

## Freeze

Commit this protocol, `cases.json`, exact fixtures, runner, and `freeze.json` before cell 1. Freeze source commit IDs and SHA-256 hashes. Any correction after the freeze invalidates this study; retain records and preregister a separate run rather than silently replacing cells.
