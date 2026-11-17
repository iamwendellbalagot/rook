# Memory Retrieval Benchmark

Generated: 2026-11-17T12:00:00.000Z (fixed fixture timestamp)

This is a deterministic offline retrieval benchmark, not a model-task success study. The disabled baseline injects no Rook context; enabled results measure retrieval precision/recall and estimated context tokens. No provider calls or network access are used.

## Fixture and cases

Three isolated fixtures: `repo-a` contains an AuthService decision, a bounded retry convention, and stale CookieSession evidence; `repo-b` contains conflicting AuthService/cookie claims; `repo-c` contains an unrelated LedgerRouter architecture. Thirty-seven prompts cover fresh architecture, convention, decision recall, stale architecture, after-fix behavior, off-topic and ambiguous-term abstention, and cross-repository/security-injection queries.

| Group                          | Prompts | Baseline retrieved | Memory expected hits | Memory false retrievals | Memory tokens |
| ------------------------------ | ------: | -----------------: | -------------------: | ----------------------: | ------------: |
| fresh architecture             |       5 |                  0 |                    5 |                       0 |           720 |
| convention recall              |       5 |                  0 |                    5 |                       0 |           745 |
| decision recall                |       5 |                  0 |                    5 |                       0 |           720 |
| stale architecture             |       5 |                  0 |                    0 |                       0 |             0 |
| after-fix behavior             |       5 |                  0 |                    5 |                       0 |           720 |
| off-topic abstention           |       5 |                  0 |                    0 |                       0 |             0 |
| ambiguous term abstention      |       2 |                  0 |                    0 |                       0 |             0 |
| cross-repository and injection |       5 |                  0 |                    0 |                       0 |             0 |

## Comparison

| Mode            | Precision@K | Recall@K | False retrieved memories | Estimated context tokens |
| --------------- | ----------: | -------: | -----------------------: | -----------------------: |
| Memory disabled |           — |     0.0% |                        0 |                        0 |
| Memory enabled  |      100.0% |   100.0% |                        0 |                     2905 |

## Cases needing review

All labeled cases matched their expected memory IDs.

## Limitations

This harness does not compare generated answers, task correctness, latency, API cost, or file-read counts. It verifies the memory retrieval layer only; model quality claims require a controlled provider run with identical prompts, tools, repository state, and scoring. Expected IDs are fixture labels, not human-graded answer quality.
