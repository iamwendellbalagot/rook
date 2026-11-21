# PLYTH simplicity finish evaluation: no-go

**Decision: no demonstrated advantage; stop expanding the PLYTH simplicity-review feature.** The frozen practical threshold was not met. This is a conclusion about these eight synthetic patches and this model, not a statistical claim about all code reviews.

## Run

- Model: `openai/gpt-6.1-sol`, high thinking.
- 8 fresh cases × 2 review conditions = all 16 preregistered attempts completed once; no retries. Alternated condition order.
- 4 removable single-use abstractions and 4 controls for retry/cancellation, path containment, TTL/singleflight caching, and cursor-pagination termination.
- All 16 initial fixture checks and all 4 predeclared simpler-candidate checks passed before inference.
- Limits: 32,000 UTF-8 byte units, 4 read/search calls, 4 provider requests, 8,000 output tokens/response, 120-second timeout.
- Exact inputs, raw final model output, diagnostics, token usage, and timing are preserved in `runs/RESULTS.jsonl`; setup and hashes are in `cases.mjs`, `scripts/simplicity-finish.ts`, and `freeze.json`.

## Paired scores

| Case                          | Class     | PLYTH                                                                           | Generic review                                                                   |
| ----------------------------- | --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| fixed-transform-pipeline      | Removable | Grounded direct-expression finding                                              | Grounded direct-expression finding                                               |
| single-use-query-adapters     | Removable | `invalid_json` after 4 requests                                                 | Grounded helper-removal finding                                                  |
| single-use-clamp-policy       | Removable | Grounded inline-comparisons finding                                             | Grounded inline-comparisons finding                                              |
| single-use-line-projection    | Removable | Grounded direct-reduction finding                                               | Grounded direct-reduction finding                                                |
| retry-cancellation-backoff    | Necessary | Suggested test formatting/separation; explicitly preserve policy and assertions | No unnecessary code complexity found; protect retry/cancellation semantics       |
| path-containment              | Necessary | Correctly suggested using `node:path.sep`; preserved escape protection          | Same targeted separator simplification; preserved guards                         |
| ttl-singleflight-cache        | Necessary | `invalid_json` after 4 requests                                                 | Suggested formatting for auditability; explicitly preserve identity guards/tests |
| cursor-pagination-termination | Necessary | No finding, partial report                                                      | No unnecessary-complexity concern                                                |

Scoring against the frozen rule: **PLYTH useful catches 3/4; generic 4/4. Harmful recommendations: 0/4 for both.** PLYTH did not exceed generic by the required two catches and had two invalid/empty reports versus none for generic. The four candidate rewrites passed their behavior tests. The separator recommendations on the path-security control were local, behavior-preserving simplifications, not harmful recommendations.

## Reliability and resource use

| Condition | Usable final reports | Provider requests | Read/search calls | Input / output / cache-read tokens | Elapsed review time |
| --------- | -------------------: | ----------------: | ----------------: | ---------------------------------: | ------------------: |
| PLYTH     |                  6/8 |                22 |                22 |            30,504 / 3,862 / 16,000 |             184.1 s |
| Generic   |                  8/8 |                 8 |                 0 |                 13,628 / 2,697 / 0 |             111.9 s |

PLYTH's two unusable reviews each consumed all four provider requests and ended after tool-use turns without a final response (`toolUse` followed by `aborted`). Expanding the budget from the prior two requests to four did not solve completion; the model used four inspection calls on both failed cases. PLYTH's six valid reports were all marked **partial** because this isolated harness used explicit paths without a task-start attribution boundary. That is a known experiment-integration limitation, but it also means the product did not demonstrate complete review coverage here.

## Interpretation

PLYTH can identify clear, removable single-use abstractions and generally preserved important control behavior. In this paired sample, however, generic review was at least as useful, returned a final report in every case, and used fewer requests, tokens, inspection calls, and elapsed time. The structured PLYTH contract did not improve the outcomes enough to justify the observed overhead/reliability cost.

**Final disposition:** keep prior code only as an explicitly invoked experimental feature if desired; do not expand its scope, add agents/adapters, or claim efficacy. The result does not justify another tuning round or automatic retries. Both stopped `phase4-pilot` runs remain untouched. The agent's rubric assessment is provisional, not an independent human score.
