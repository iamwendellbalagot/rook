# Harness reliability: implementation and evidence

Rook targets dependable Claude Code-class task execution with OpenCode-inspired permission controls. This is a target, not a measured parity claim.

## Implemented slices

- Shared permissions/policy authority for TUI and stdio; host execution requires approval by default. Persistent exact project grants cannot override configured denials.
- Repeated verification is permitted; receipts compare bounded Git fingerprints at check completion and receipt time. Unknown/partial fingerprints do not establish final verification.
- Streaming host execution separates output limits from termination. Logs retain up to 2 MiB per command; model output is bounded. Cancellation/timeout signal the process group and escalate after one second even if the leader closes early.
- Ignore-aware ripgrep search supports regex, case and glob options and per-file read authorization. Scoped guidance discovery follows tool paths, with bounded root-to-leaf context replacement rather than repeated transcript injection.
- Private per-session task state persists goal, constraints, decisions, remaining work, blockers and recent tool terminal states. Interrupted commands are never replayed automatically. File-tool undo persists per session and revalidates current content and edit permissions.
- Session-owned background commands and bounded read-only research delegation have cancellation and concurrency/request/time limits.
- Experimental stdio replay stores a bounded private session tail with monotonic cursor and explicit gap detection. It is not exactly-once delivery or a durable command-execution transaction log.
- PLYTH is explicitly opt-in; core dependency installation no longer references a sibling checkout. Runtime activation checks the supported export contract; optional PLYTH tests skip when incompatible/unavailable.

## Provider-free regression gate

Run `npm run test:harness`. It covers permission precedence, remembered grants, uninspectable shell syntax, stale approvals, mode boundaries, verbose process output, cancellation, instruction discovery, search filtering, handoff restart, background lifecycle, event replay and the pinned Pi adapter. These are component/integration checks, not a coding-quality benchmark. Existing `evals/coding` reports remain historical and are not rerun or replaced.

## Held-out coding comparison protocol (not run)

Before inference, freeze tasks, allowed paths, trusted acceptance checks, model/settings, budget, stop rules and scoring. Preserve every attempt, including interruptions and policy failures. Keep trusted checks outside agent-editable files. Use independent outcome assessment.

Required task families:

| Family                      | Acceptance criteria                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Multi-file bug fix          | Reproduce failure, preserve API, fix unchanged independent tests, stay in scope       |
| Dependency/API migration    | Update all affected callers, preserve compatibility and focused checks                |
| Large-repository discovery  | Find the responsible implementation and cite exact source without exhaustive dumping  |
| Dirty workspace             | Preserve seeded user edits; distinguish attribution from observed changes             |
| Concurrent editor           | Detect invalidated assumptions/checks; never overwrite diverged recovery targets      |
| Failing/flaky checks        | Diagnose boundedly, preserve tests, report uncertainty and actual outcomes            |
| Permissions/tool failure    | Honor denials, report blocked verification, avoid hidden capability escalation        |
| Steering/compaction/restart | Preserve constraints and pending work; inspect unknown side effects before continuing |

Compare matched models where available to isolate harness effects; separately compare complete Rook and Claude Code workflows. Report independently accepted task completion, regressions/scope violations, human interventions, time/cost per accepted solution, recovery success and unsupported completion claims. No provider budget is spent by the regression gate.

## Remaining gates and limitations

- Freeze and run representative provider-backed tasks and the independent Claude Code comparison only with an explicit budget. No current efficacy/parity conclusion.
- Editing subagents remain unimplemented until isolated ownership, safe integration and read-only delegation effectiveness are validated.
- Full power-loss/concurrent-session crash testing, approval-store locking/merge, artifact retention quotas, and real Linux/Windows host lifecycle verification remain pending. Process-group supervision does not guarantee cleanup of arbitrary daemonized/reparented descendants.
- Structured handoffs rely on model-maintained constraints/decisions and are not proof that every user requirement was captured. Compaction continuity needs provider-backed validation.
- Replay persists asynchronously; abrupt crashes can lose the newest events. The tail retains at most 500 events / 1 MiB. Reconnect does not keep a terminated stdio process running.
- Aggregate inspection under custom read restrictions is conservative, not fine-grained; authorized per-file navigation can be added later. The old sandbox-dependent Python/Go backend is not activated in standard host sessions.
- The old OS sandbox module is retained only for dormant experimental language-server infrastructure and its tests, not used by standard Bash/job execution. Removing that dormant infrastructure is a separate compatibility decision.
- Architecture is incrementally separated into permissions, process supervision, task state, background jobs and event journal modules. A complete gateway/TUI lifecycle refactor has not been performed.
- Optional PLYTH compatibility is export-checked, not a general semantic-version compatibility guarantee. Dedicated pinned optional-integration CI remains pending.
