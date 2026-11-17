# Implementation Progress

## M0 — SDK compatibility spike

### Completed in this slice

- ROOK-001 scaffold: strict TypeScript/ESM project, pinned Pi dependencies, npm scripts, launcher, and CI workflow.
- ROOK-002: headless Pi gateway maps streamed text and settled events; credential-free mock gateway is available with `--mock`.
- ROOK-003: initial Pi SDK parity and CLI-gap inventory in `docs/PI_PARITY.md`.
- ROOK-004: compile-time public SDK imports and an offline session lifecycle test.

### Validation

- `npm run typecheck` — passed.
- `npm test` — passed (2 test files, 2 tests; includes 100 streamed mock chunks with no duplication).
- `npm run test:integration` — passed (SDK session create/dispose without credentials).
- `npm run build` — passed.
- `npm run smoke` — passed using the mock gateway.
- `npm run lint` — passed.
- `node bin/rook.mjs --help` and `--version` — passed.
- Real provider prompt — not run; it requires a configured Pi provider credential and was not needed for offline validation.

### Remaining M0 caveat

M0 is implemented, but live-provider streaming remains credential-gated and unverified in this environment. Re-run `node bin/rook.mjs "Summarize this repository"` when Pi credentials are configured before treating the real-provider acceptance item as verified.

### Next

- Run the credential-gated live-provider smoke when Pi credentials are available.
- Continue M1 in roadmap order; live-provider smoke remains credential-gated.

## M1 — Custom TUI and coding workflow

### Completed

- ROOK-005: added the Rook app state/event reducer for lifecycle, run states, modes, streamed/final messages, tool activity, usage, errors, and shutdown. The headless CLI now uses it to gate prompts and track runs.
- Focused reducer tests cover startup/auth readiness, idle/running/settled/failed states, duplicate prompt/mode guards, authoritative final messages, tool/usage events, and shutdown.
- ROOK-006: added a custom `pi-tui` alternate-screen shell with a responsive header, home view, fixed multiline editor/footer, streaming Markdown, basic command handling, and terminal cleanup. Interactive tools were initially disabled pending ROOK-010.
- TUI visual choices follow `tui_references/SCREEN_SPEC.md` and `tokens.json`; the design reference files remain untouched.
- ROOK-007: mapped public Pi session events for streamed/final assistant text, usage, tool start/end, errors, and aborts. The TUI renders final text authoritatively and shows compact status-only tool rows; raw tool args/results are not exposed.
- ROOK-008: added Pi-backed model listing/selection, provider status/logout, and thinking-level settings. The TUI exposes `/model`, `/login`, `/logout`, and `/settings`; sign-in follows the documented Pi CLI handoff, while model and thinking changes persist through Pi.
- ROOK-009: moved the Pi gateway onto `AgentSessionRuntime`, added `/new` and `/sessions`/`/resume`, and rebound session subscriptions/extensions after replacement. Session selection shows saved-session metadata; resuming restores user/assistant text while omitting tool arguments and results.
- ROOK-010: added a Pi `tool_call` boundary policy. `/plan` allows scoped workspace reads and file discovery; `/build` additionally allows scoped `edit`/`write`. Shell, content grep, sensitive paths, symlink/hardlink paths, unknown tools, external extensions, skills, and concurrent mutations are denied. Pi's grep uses ripgrep `--hidden`, so it stays disabled rather than risk reading hidden credentials. `/permissions` shows recent decisions. Risky operations fail closed rather than prompting for approval.
- Security scope: this is a host-side policy, not an OS/container sandbox; filesystem checks cannot eliminate races with a hostile concurrent process. Use an isolated container/VM for untrusted repositories.
- ROOK-011: added Git and non-Git workspace identity in a locked, atomic, permission-restricted `~/.rook/repositories.json` registry (`ROOK_HOME` overrides the directory). Git working trees get generated IDs keyed by local Git metadata identity, so clones stay distinct and worktrees get distinct IDs with a common logical ID; path renames retain the ID. Credential-free remote fingerprints are hashed before storage. The registry retains the latest branch/HEAD/dirty snapshot, and the TUI displays the repository ID and initial snapshot. SQLite/history remains ROOK-012.
- ROOK-012: added `better-sqlite3` (Node 22.19+ verified) and transactional, versioned SQLite migrations with WAL, foreign keys, constraints, indexes, FTS5 triggers, and a rebuild operation. Real workspaces now persist generated repository identity and append snapshot history to `~/.rook/state.sqlite`; the ROOK-011 JSON registry remains the identity resolver. Added parameterized memory persistence/search, content-clearing soft delete and purge, SQLite backup, and JSON export. The database is created with owner-only file permissions.

### Validation

- `npm run typecheck` — passed.
- `npx vitest run tests/app/state.test.ts` — passed (5 focused tests).
- `npx vitest run tests/pi/event-adapter.test.ts tests/pi/mock-agent-gateway.test.ts` — passed (4 tests; event mapping, no raw tool data, and final-message deduplication).
- `npm test` — passed (8 files, 30 tests; includes policy traversal, sensitive path, link, tool-hook, mode/concurrency, repository identity/snapshot, migrations, FTS, backup, and export cases).
- Node 22.19 compatibility — passed: rebuilt the native driver under Node 22.19, verified FTS5, and ran all focused database tests.
- `npm run test:pty` — passed (fake-terminal render, resize, prompt, mode/session commands, and cleanup flow).
- `npm run test:integration` — passed (SDK lifecycle, tool allowlist/mode changes, and persistent session list/resume/new/rebind flow).
- `npm run build` — passed.
- `node bin/rook.mjs --smoke` — passed with the mock gateway.
- `npm run lint` — passed.

### Next

- ROOK-013: implement evidence-aware memory CRUD with revision, deduplication, and forget behavior on the ROOK-012 store.
