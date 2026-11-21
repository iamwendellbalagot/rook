# PLYTH integrated coding comparison

Status: preregistration draft; no comparison inference may begin until this file, `cases.json`, fixtures, and the runner are frozen in a commit.

## Question

Does dynamic, task-local PLYTH feedback improve coding outcomes beyond ordinary Rook and the same static behavioral guidance?

## Arms

- **off:** `ROOK_PLYTH_INTEGRATED=off`, `ROOK_PLYTH_MODE=off`.
- **prompt:** `ROOK_PLYTH_INTEGRATED=prompt`, `ROOK_PLYTH_MODE=off`.
- **integrated:** `ROOK_PLYTH_INTEGRATED=integrated`, `ROOK_PLYTH_MODE=off`.

The prompt and integrated arms receive identical PLYTH static guidance. Only integrated receives dynamic context/result messages. No separate reviewer or second model is used. User task text, host fixture constraints, model, thinking, tools, permissions, command approvals, resource ceilings, and independent checks are fixed across arms.

## Cases and sequence

Six new synthetic tasks, each once per arm (18 cells): two recovery defects, two small maintainability/behavior tasks with a reusable existing helper, and two necessary-complexity controls for concurrency and cancellation. Exact prompts, writable paths, commands, rubric, and alternating arm order are frozen in `cases.json`. Each cell gets an independent copy of the same starter fixture and a fresh Rook session. Development tasks in the prior vertical-slice report are excluded.

## Controls and stop rules

- Model/provider: the already configured `openai/gpt-6.1-sol`, high thinking.
- Per-cell ceilings: 24 provider starts, 48 tool attempts, 8,000 output tokens per response, and 10 minutes.
- Only the listed source paths are writable. Tests and fixture policy are immutable. Bash is restricted to the bounded in-workspace listing command and the one exact case test command; those commands require one-time approval. Other tools and writes are denied by `PilotRunGuard`.
- Run each cell once. Any guard violation, timeout, provider failure, or test-integrity violation is retained as a failed cell; stop that cell and do not replace it. Continue only with the next preregistered cell if no global safety issue occurred.
- Record every cell immediately: condition/order, model settings, provider/tool counts, token/cache usage, duration, context delivery opportunity, final answer, changed paths/diff, trusted test result/hash, guard/approval outcomes, and failure reason. Do not persist hidden reasoning or credentials.

## Outcomes and scoring

Primary per-cell success requires all frozen tests passing, unchanged tests, and source changes confined to the allowlist. A cell failing any requirement is unsuccessful; no imputation or replacement.

For every diff, score the frozen three-point case rubric from 0 (miss/regression) to 2 (fully met) per criterion. These scores are provisional AI-assessed unless an independent human reviews the diff and evidence. Separately count failed/blocked tool attempts, verification after edits, repeated failing checks, provider starts, input/output/cache-read tokens, and elapsed time.

Compare paired task outcomes and rubric/diff findings across all three arms. A dynamic benefit requires integrated to be no worse than both controls on primary correctness/test integrity and to show concrete correctness-preserving patch-quality or materially reduced failed/repeated work on at least two distinct tasks versus **both** controls. More messages, checkpoint delivery, prediction metrics, or one favorable task do not qualify. If prompt matches integrated without such advantages, conclude “prompt-only sufficient.” If too few natural intervention opportunities or mixed/negative results, conclude “no demonstrated dynamic benefit.” No result supports a general efficacy claim.

## Freeze requirements

Before cell 1, commit this protocol, exact cases/fixtures, runner, and source versions. Record commit IDs and SHA-256 hashes in `freeze.json`. Do not edit product code, prompts, fixtures, scoring, or limits after the freeze. Any necessary correction invalidates the comparison; retain the interrupted attempt and create a new separately authorized protocol rather than silently restarting.
