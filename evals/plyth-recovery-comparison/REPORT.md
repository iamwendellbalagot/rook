# PLYTH persistent-failure recovery comparison — results

**Conclusion: the revised recovery mechanism remains unproven; do not expand or enable dynamic PLYTH.** The nine runs did not create a persistent-failure opportunity: each agent ran the failing starter test before editing, and its first post-edit test passed. Therefore the new recovery signal was delivered in **0/3 integrated cells**. This is not a failed recovery intervention; it is an inconclusive intervention test. The earlier six-task comparison still found no added benefit from generic dynamic checkpoints over prompt-only guidance. Further provider runs should wait for a concrete, naturally occurring use case rather than force failures.

## Frozen execution

- Freeze commit: `de4220a`; source snapshot Rook `428bda8`; PLYTH source `c1d8697`.
- Three fresh tasks × three arms, one run per cell; arm order and task prompts are frozen in `cases.json`.
- Model: `openai/gpt-6.1-sol`, high thinking. Each agent was instructed to run the named test before editing and after each source change. No second model or reviewer was used.
- All nine in-agent starter tests failed before edits; all nine first post-edit tests passed. A separate process then reran all nine final acceptance tests successfully. Tests stayed unchanged, all edits stayed in the single allowed source path, each exact test command received one-time approval, and no guard violation, provider failure, timeout, interruption, or replacement occurred.
- The tool trace confirms the requested order in 9/9 cells. There were 18 distinct model-run test executions (two per cell), not counting the offline preflight, final acceptance check, and separate audit reruns.
- Raw start/finish records: `runs.jsonl`, SHA-256 `5a1e39e225d9f836c3eaa2cfe8f2f90d3a74d9634b9782e3af151adba4efccad`.

## Results

| Arm         | Acceptance | Requests / tool calls | Mean elapsed | Median elapsed | Input tokens | Output tokens | Cache-read tokens | Persistent-failure opportunities | Signals delivered |
| ----------- | ---------: | --------------------: | -----------: | -------------: | -----------: | ------------: | ----------------: | -------------------------------: | ----------------: |
| Off         |        3/3 |               20 / 18 |      44.62 s |        31.09 s |       20,238 |         1,579 |            30,720 |                                0 |                 0 |
| Prompt-only |        3/3 |               19 / 17 |      45.59 s |        31.92 s |       15,613 |         1,567 |            33,408 |                                0 |                 0 |
| Integrated  |        3/3 |               19 / 18 |      46.41 s |        32.77 s |       20,391 |         1,804 |            30,720 |                                0 |                 0 |

Elapsed time includes isolated workspace setup and baseline/final local checks; with only three tasks and a long abort-delay test it is descriptive, not an efficiency estimate. Token categories are not converted into cost. Off, prompt-only, and integrated produced behaviorally equivalent fixes; prompt-only and integrated patches were identical on safe-redirect and abortable-delay. No condition reduced repeated failed work, because no test remained failing after an edit.

## Mechanism audit

- In every cell, the agent's first tool action was the exact failing test command. It then read source/tests, edited only the source, and ran the same test. All test outcomes after edits were passing.
- Integrated therefore observed no second failing result with persistent labels. The improved subset detector and revision-aware advice never activated. The context trace found no recovery signal in any model-bound context.
- This confirms the test-first workflow and final task completion, but **does not measure whether the revised signal changes agent behavior when it fires**.

## Decision

1. Keep dynamic integrated mode default-off. The earlier generic-checkpoint comparison found no advantage; this follow-up provides no evidence to reverse that decision.
2. Do not keep spending provider budget on synthetic repetitions or engineer artificial failures to force the mechanism to activate. The frozen protocol's natural-opportunity threshold was not met.
3. Treat automatic recovery guidance as experimental/unvalidated. A future study is worthwhile only if a real, naturally recurring failing-check workflow is available and can be compared against controls with independent scoring. Otherwise, stop dynamic PLYTH expansion and retain only components with demonstrated value.

This small study does not prove the revised signal ineffective; it establishes that no benefit was observed because there was no signal opportunity. Combined with the earlier controlled result, there is currently **no evidence that dynamic PLYTH improves coding outcomes**.
