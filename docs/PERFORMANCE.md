# SQLite FTS and reconciliation microbenchmark

Generated: 2026-11-17T12:00:00.000Z (fixed fixture timestamp; local timings are machine-specific)

Measurement runtime: Node v22.19.0, darwin/arm64; measured 2026-11-17T11:55:52.688Z.

Synthetic records are inserted directly through SQLite so the test measures FTS and reconciliation rather than application capture cost. Each memory has one evidence reference to the same small file, exercising path-hash deduplication. FTS measurements include warmup and 12 timed searches of the term `needle`.

| Memories | FTS p50 (ms) | FTS p95 (ms) | Reconcile all (ms) | Evidence checks |
| -------: | -----------: | -----------: | -----------------: | --------------: |
|    1,000 |         0.08 |         0.08 |              22.83 |           1,000 |
|   10,000 |         0.55 |         0.57 |             257.00 |          10,000 |

This is a focused local microbenchmark, not a cross-machine performance guarantee. It does not measure startup, provider latency, or unique-file hashing at 10k paths. No repository-wide file scan is performed; reconciliation visits only stored evidence paths.
