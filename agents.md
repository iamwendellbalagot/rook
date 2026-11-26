# Agent Instructions

1. Commit all completed work before finishing.
2. Be aggressive in development. Add and run only necessary tests, focused on the specific files and features being changed.
3. Maintain a root-level `status.md` for work handoffs. Record the current state, completed work, and pending tasks, and update it before handing off. Do not implement `plan.md` until explicitly asked.

## Persisted Harness Direction (supersedes sandbox roadmap)

The user authorized a Claude Code-class workflow with OpenCode-style permissions and policies, using host shell execution instead of built-in OS sandboxing.

- Tool permissions use ordered allow/ask/deny rules; broader-authority policies can hard-deny project rules and saved approvals. Repository guidance is never permission authority.
- Host commands have the user's filesystem/network authority. Shell inspection is best-effort approval routing, not isolation. Do not silently migrate sandbox auto-allows to host grants.
- Default shell and external-directory access require approval. Persist explicit exact project approvals outside repository content and support revocation. Plan blocks shell, mutations, MCP and unknown effects.
- Improve verification freshness, streaming output, process supervision, scoped instructions, search, durable handoffs/recovery, client replay, background jobs, and bounded delegation.
- Keep PLYTH opt-in and core installation independent of a sibling checkout. No effectiveness claims without held-out evidence.
- Editing subagents and comparative provider evaluations remain gated on validated ownership/recovery and explicit provider budget. Never claim Claude Code parity from unit tests.
- Preserve Apache-2.0 attribution/notices for adapted sandbox code retained for optional language-server infrastructure.
- Do not publish or push without explicit authorization. Preserve user-owned untracked files and historical evaluation artifacts.
