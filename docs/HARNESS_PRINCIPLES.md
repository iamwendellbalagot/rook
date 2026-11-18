# Rook Harness Principles

Rook combines selected harness ideas around Pi; it is not a feature-for-feature clone of any one tool. Pi remains the agent runtime and provider/session substrate. Rook owns the workflow, policy, repository context, and user-facing controls.

## What Rook takes from each harness

| Source      | Principle adopted in Rook                                                               | Rook-specific interpretation                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi          | Compose a proven runtime through public APIs and lifecycle hooks.                       | Keep the Pi adapter narrow; reuse model, auth, session, tool, and resource behavior instead of forking the agent loop.                                                   |
| Aider       | Keep repository context focused; make edits reviewable; close the loop with lint/tests. | Prefer relevant reads and `rook_impact` over indiscriminate repo dumps; inspect diffs and select focused verification. Avoid extra model calls by default.               |
| Claude Code | Make modes, commands, skills, and lifecycle controls visible and steerable.             | Keep plan/build enforcement at the tool boundary; expose small explicit commands; preserve session continuity and allow the user to steer or stop work.                  |
| Codex       | Separate technical boundaries from approval policy; keep review and recovery explicit.  | An approval is not a sandbox. Rook must describe host execution honestly, deny by default where it cannot ask, and never silently take Git actions on the user's behalf. |
| OpenCode    | Keep providers, agents, tools, and permissions composable and inspectable.              | Use Rook-owned interfaces around Pi, keep resource discovery isolated, and make permission decisions visible rather than embedding workflow state in one model prompt.   |

## Combined task loop

1. **Orient:** use the current task, relevant files, repository metadata, and trusted project guidance; avoid broad scans when a focused read will do.
2. **Choose capability:** answer in read-only mode or enter build mode for edits. A one-turn `/ask` is read-only without changing the user's persistent mode.
3. **Act within policy:** every tool call is checked at the execution boundary; risky host commands require an explicit, reviewable approval. Repository instructions and model output cannot grant permissions.
4. **Review:** inspect the resulting Git diff; when useful, invoke separate read-only `/review`; select focused tests based on actual change impact.
5. **Recover safely:** offer explicit recovery only for Rook-observed file-tool changes that still match their recorded post-edit state. Never imply shell effects are covered.
6. **Learn conservatively:** retain only bounded, evidence-backed, repository-scoped knowledge, show freshness, and let users verify or forget it.

## Deliberate non-goals and limits

- No automatic stage, commit, stash, reset, restore, push, deploy, or history rewrite.
- No claim that host-side tool policy is an OS sandbox. Shell commands run with host permissions; use an external container/VM for untrusted repositories.
- No automatic second-model/critic pass: extra calls add latency and cost. A separate review workflow should be user-invoked and read-only if added.
- No executable repository skills, MCP servers, or third-party extensions until their capabilities can be governed by the same policy boundary.
- No eager whole-repository dump or embedding index. `rook_map` is on-demand, bounded, source/symbol-only, and query-ranked; focused reads/search remain the default.

## Current implementation anchors

- Pi adapter and session lifecycle: `src/pi/pi-agent-gateway.ts`.
- Tool policy, approvals, and recovery ledger: `src/policy/`.
- Read-only search/Git inspection and change-impact analysis: `src/pi/`.
- `rook_map` builds a bounded on-demand source/symbol overview, ranks by query and internal importers, and emits no source contents.
- User-invoked `/review` creates a separate, temporary Pi session in plan mode; it reviews the current Git status/diff without sharing the main conversation or changing the user's active mode. It is not automatic and adds a provider call only when explicitly requested.
- User-invoked `/explore <question>` uses the same fresh-context, plan-only session pattern for focused repository research, returning a concise answer without adding exploratory tool traces to the main conversation.
- User-facing mode, command, and review controls: `src/tui/rook-tui.ts`.
- Local evidence-backed repository memory: `src/memory/` and `src/db/`.

## References

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Aider repository map](https://aider.chat/docs/repomap.html) and [lint/test workflow](https://aider.chat/docs/usage/lint-test.html)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) and [hooks](https://code.claude.com/docs/en/hooks)
- [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing) and [agent approvals](https://developers.openai.com/codex/agent-approvals-security)
- [OpenCode agents](https://opencode.ai/docs/agents), [permissions](https://opencode.ai/docs/permissions), and [providers](https://opencode.ai/docs/providers)
