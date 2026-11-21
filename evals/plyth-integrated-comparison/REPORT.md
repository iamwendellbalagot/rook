# PLYTH integrated comparison — results

**Conclusion: no demonstrated benefit from dynamic PLYTH over prompt-only guidance.** For these six small, fresh synthetic coding tasks, prompt-only matched integrated mode on acceptance and patch rubric, while integrated was marginally slower than prompt-only in paired elapsed time and did not reduce model/tool activity. Keep integrated mode default-off. The results do not establish general effectiveness or inefficacy.

## Frozen design and execution

- Freeze commit: `b376c99`; source snapshot Rook `518542d`; PLYTH `6ba019f`.
- Arms and case sequence: as frozen in `PROTOCOL.md`, `cases.json`, and `freeze.json`; six cases × three arms, one run per cell (18 total).
- Model: `openai/gpt-6.1-sol`, high thinking. No standalone reviewer or extra model call.
- Every cell used a new synthetic Git workspace. Only its listed source file was writable. The exact case test command was the only approved command; all 18 requests were approved, with zero guard violations.
- All 18 starter suites failed in offline preflight through assertions. All final acceptance suites passed; test files were unchanged byte-for-byte, all changed paths were exactly the allowed source path, and a separate post-run process independently reran all 18 acceptance suites successfully.
- There were 18/18 unique start/finish pairs, no timeout, interruption, replacement, blocked cell, or provider failure. Raw attempts: `runs.jsonl`, SHA-256 `78c121537a9f6053601b2a174ecdacdc4d260e7586353b7b11bf7949a53ae9c9`.

## Outcomes and resource use

| Arm         | Acceptance | Requests / tool calls | Mean elapsed | Median elapsed | Input tokens | Output tokens | Cache-read tokens |
| ----------- | ---------: | --------------------: | -----------: | -------------: | -----------: | ------------: | ----------------: |
| Off         |        6/6 |               36 / 30 |      30.22 s |        27.59 s |       33,195 |         2,367 |            37,376 |
| Prompt-only |        6/6 |               36 / 30 |      25.82 s |        25.23 s |       27,900 |         2,237 |            44,672 |
| Integrated  |        6/6 |               36 / 30 |      25.90 s |        25.23 s |       23,946 |         2,077 |            49,792 |

Elapsed time is full cell wall time, including isolated workspace setup and local baseline/final checks; treat these small samples as descriptive, not an efficiency benchmark. Integrated minus prompt-only paired elapsed time was +1.65, +2.10, +0.19, −5.85, +1.52, and +0.89 seconds (integrated slower on five of six tasks; mean +0.08 seconds, median +1.20 seconds). Both prompt-only and integrated were faster than off on most pairs, so the faster results do not identify a dynamic-feedback effect. Token counters are reported separately; no cost estimate is inferred from them.

Every cell made six provider requests and five tool calls. Each task used two reads, one edit, one post-edit read, and one approved focused test command. There was no reduction in calls, repeated failed test, or recovery cycle in any arm.

## Correctness and patch-quality review

The frozen primary condition was met in all 18 cells. Patches in every arm implemented the expected boundary/filtering/concurrency/cancellation behavior, and none changed tests or an out-of-scope path. Frozen rubric score from this agent's post-run diff review was **34/36 points in each arm**: full marks on attempt-limit, retry-policy, single-flight, and abort-delay; one point withheld each on stable-keys and parse-tags because all three arms reimplemented small existing helpers (`normalizeKey` / `normalizeList`) instead of reusing them. This is an AI-assessed, unblinded score, not an independent human rating. Crucially, there was no integrated-versus-prompt difference in these findings.

| Case          | Off  | Prompt-only | Integrated | Review note                                                                                                                             |
| ------------- | ---- | ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| attempt-limit | pass | pass        | pass       | Same boundary correction.                                                                                                               |
| retry-policy  | pass | pass        | pass       | Same retryable/cancellation/limit logic.                                                                                                |
| stable-keys   | pass | pass        | pass       | Same behavior; all omit the existing normalizer helper.                                                                                 |
| parse-tags    | pass | pass        | pass       | Same behavior; all omit the existing list helper.                                                                                       |
| single-flight | pass | pass        | pass       | Same-key coalescing and rejected-work cleanup retained.                                                                                 |
| abort-delay   | pass | pass        | pass       | All resolve, abort, and clear timer/listener behavior; integrated patch was slightly shorter, with no observed quality or outcome gain. |

## Did dynamic PLYTH intervene in time?

The context trace detected one task-local checkpoint in **all six integrated runs**, and none in off or prompt-only. In each integrated run it appeared in model-bound request 4, after the first source edit and before a follow-up read; the focused test was run in the subsequent request after that read. This verifies the frozen integration path, but every arm followed the same 5-tool sequence and produced equivalent patches/outcomes. Static guidance was sufficient for these tasks.

The two cases categorized as recovery tasks did not produce a model-observed failing test before editing: the failing starter was confirmed by offline preflight, and each model ran its focused test only after editing. Therefore **repeated-failure recovery signals were not exercised**. These results cannot support a conclusion about that PLYTH mechanism.

## Decision and limits

- **Prompt-only is sufficient for this sample; dynamic benefit is not demonstrated.** Integrated mode did not improve acceptance, the rubric review, or tool/request counts over prompt-only. It was about level in time and slightly higher in cache-read tokens; token categories do not establish cost.
- **Do not enable integrated mode by default or claim product effectiveness.** Its checkpoint delivery is verified, but delivery alone is not benefit.
- The study has only six small synthetic tasks, one model, one run per cell, and an unblinded AI rubric review. It is not representative or statistically powered; it does not evaluate natural repeated-failure recovery. Existing helper reuse was missed by all arms, suggesting a possible task/prompt opportunity, not a PLYTH-specific failure.
- A useful follow-up would need more realistic held-out changes with natural, observable failed-verification opportunities, independent blinded diff scoring, and predeclared measures for reduced rework. Do not tune against these six cases and call a repeat a holdout.
