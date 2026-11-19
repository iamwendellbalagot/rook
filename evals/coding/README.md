# Coding-task evaluation

This first evaluation slice provides fixed offline tasks, disposable fixtures, deterministic focused checks, and a transparent human-scored report. It does not call a model, grade answers with another model, or claim model quality. Provider-backed execution is intentionally separate follow-up work.

## Run the offline suite

```sh
npm run eval:coding -- prepare
npm run eval:coding -- check retry-boundary <prepared-directory>/retry-boundary
npm run eval:coding -- check normalize-labels <prepared-directory>/normalize-labels
npm run eval:coding -- verify-fixtures
```

`prepare` copies four small fixtures to a new temporary directory and prints its path. Alternatively, provide an explicit output directory. It writes `TASKS.md` with prompts and rubrics. Perform each task manually in its own workspace. Exploration and review tasks are read-only and have no automated checks. The two coding tasks have fixed Node.js test files.

`verify-fixtures` is the automated CI gate: it confirms the starter implementations for both coding tasks fail their trusted task tests, so the fixtures still exercise the requested change. It does not solve or score the tasks.

The exploratory task's miniature fixture is for evaluating the agent's navigation and citation behavior, not its knowledge of the Rook source. The review task's seeded issue is that a negative `requestedDelayMs` makes `retryDelay` return a negative delay; its only source file is `src/retry.mjs`.

The check command executes only Node's built-in test runner against the task's fixture tests. Before execution it verifies the submitted workspace's test files exactly match the checked-in fixture tests; it rejects symlinked or unexpected entries. The implementation under test is task workspace code, so use disposable workspaces and do not run checks on untrusted content. Check commands have a 30-second timeout.

## Score and report a run

```sh
npm run eval:coding -- template /tmp/rook-coding-results.json fixture node
```

Fill out the generated JSON with the model response, actual changed files, each required check result, human rubric scores (0 = incorrect/missing, 1 = partial, 2 = correct), tool-call count, and any measured elapsed time or token counts. Then score it:

```sh
npm run eval:coding -- score /tmp/rook-coding-results.json docs/CODING_EVALUATION.md
```

The scorer validates task IDs, completeness, check names, rubric ranges, and nonnegative metrics. Task success requires at least 70% rubric points, all fixed checks passed, and no changes outside the task's allowlist. It reports overall and per-task scores, success rate, check/scope failures, aggregate tool calls, available timing/token metrics, and HTML-escaped model responses. It does not execute commands while scoring.

To compare runs, use the same task set, prompts, fixture revision, model/provider configuration, and scoring rules. Record each run separately; this report is descriptive and a small number of runs is not statistical evidence. Latency and token totals are omitted when any task lacks that metric. `docs/BENCHMARKS.md` remains the independent memory-retrieval benchmark.

## Tasks and rubric

The task catalog and schema live in `src/eval/coding-evaluation.ts`; fixture files live in `evals/coding/fixtures/`. Add a focused task with a fixed prompt, isolated fixture, explicit changed-file allowlist, deterministic checks where appropriate, and observable rubric criteria. Keep evaluation tests separate from the task workspace's editable files.
