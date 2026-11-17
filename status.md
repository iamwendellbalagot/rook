# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- ROOK-006 is implemented: the custom `pi-tui` shell renders Home and streamed Markdown; tools were initially kept disabled pending the enforced policy.
- ROOK-007 is implemented: the Pi adapter maps final messages, token usage, tool lifecycle, errors, and aborts; the TUI renders tool status without displaying raw arguments or outputs.
- ROOK-008 is implemented: `/model`, `/login`, `/logout`, and `/settings` use Pi's model/provider/auth APIs. Model and thinking selections persist through Pi; sign-in uses the documented Pi CLI handoff.
- ROOK-009 is implemented: the gateway uses Pi's `AgentSessionRuntime`; `/new` and `/sessions`/`/resume` replace sessions and rebind subscriptions. Resumed user/assistant text is restored without rendering raw tool data.
- ROOK-010 is implemented: plan/build permissions are enforced at Pi's `tool_call` boundary. Plan allows scoped reads/file discovery; build adds scoped workspace edits. Shell, content grep, sensitive paths, links, unknown tools, external extensions/skills, and concurrent mutations are denied; `/permissions` displays recent decisions. Pi's grep is disabled because it searches hidden files.
- ROOK-011 is implemented: Git and directory workspaces receive stable generated IDs in an atomic local registry. Local renames retain IDs; separate clones remain distinct; worktrees get distinct IDs with a shared logical grouping ID. Git branch, HEAD, and dirty fingerprint snapshots are refreshed at startup and shown in the TUI. Remote credentials are stripped before fingerprinting; raw remote URLs are not stored.
- ROOK-012 is implemented: `better-sqlite3` works on the declared Node 22.19 minimum and current Node 26 runtime. A WAL database at `~/.rook/state.sqlite` receives repository identity and snapshot history at startup. Versioned migrations create constrained repository, snapshot, memory, evidence, revision, link, and event tables; FTS5 triggers/rebuild, memory search, backup, and JSON export are available. Soft deletion removes searchable content and clears copies in revision/evidence text; explicit purge cascades.
- ROOK-013 is implemented: repo-scoped memory create/get/list, evidence management, edit revision history, pinning, semantic-key deduplication, duplicate evidence suppression, secret screening, and explicit forget/purge are available through `RookStore`. Forget cascades memory, evidence, revisions, links, and FTS rows while retaining only a content-free forget event.
- ROOK-014 is implemented: retrieval is filtered to the exact repository and verified/possibly-stale memories with trusted sources and evidence, then ranked by query terms, FTS, path/symbol overlap, trust, recency, freshness, and pinning. A bounded context composer escapes untrusted text, labels freshness caveats, and emits nothing for unrelated queries. The optional Pi `before_agent_start` extension injects it as a hidden custom message, without replacing the system prompt; persisted retrieval events contain IDs/budget only.
- ROOK-015 is implemented: a Pi `agent_settled` extension captures at most three high-signal user-authored candidates per session, only with successful workspace read/edit/write evidence. Evidence paths are revalidated and bounded file hashes are stored instead of source content; sensitive paths and secret-like claims are rejected. `remember:` creates a pending explicit claim that must be confirmed. `/memory` exposes status/show/pending, pause/resume, project opt-out/in, confirmation/cancel, and confirmed forget. No background LLM extraction is used.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The permission policy is a host-side guard, not an OS/container sandbox; filesystem checks cannot eliminate hostile concurrent-process races. External Pi extensions and skills are disabled in the policy-controlled runtime.
- Automatic LLM memory extraction is not implemented; capture is deterministic and run-settled. Retrieval context injection is active for real workspaces. Project opt-out disables both. The JSON registry remains the stable local identity resolver; SQLite mirrors repository metadata and stores snapshots, controls, and memory records.

## Pending

- ROOK-016 is next: implement Git change impact and evidence invalidation.
- Run a real-provider prompt when Pi credentials are available.
