# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- ROOK-006 is implemented: the custom `pi-tui` shell renders Home and streamed Markdown; tools were initially kept disabled pending the enforced policy.
- ROOK-007 is implemented: the Pi adapter maps final messages, token usage, tool lifecycle, errors, and aborts; the TUI renders tool status without displaying raw arguments or outputs.
- ROOK-008 is implemented: `/model`, `/login`, `/logout`, and `/settings` use Pi's model/provider/auth APIs. Model and thinking selections persist through Pi; sign-in uses the documented Pi CLI handoff.
- ROOK-009 is implemented: the gateway uses Pi's `AgentSessionRuntime`; `/new` and `/sessions`/`/resume` replace sessions and rebind subscriptions. Resumed user/assistant text is restored without rendering raw tool data.
- ROOK-010 is implemented: plan/build permissions are enforced at Pi's `tool_call` boundary. Plan allows scoped reads/file discovery; build adds scoped workspace edits. Shell, content grep, sensitive paths, links, unknown tools, external extensions/skills, and concurrent mutations are denied; `/permissions` displays recent decisions. Pi's grep is disabled because it searches hidden files.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The permission policy is a host-side guard, not an OS/container sandbox; filesystem checks cannot eliminate hostile concurrent-process races. External Pi extensions and skills are disabled in the policy-controlled runtime.
- The repository-memory engine is not implemented yet.

## Pending

- ROOK-011 is next: implement Git repository identity and snapshots.
- Run a real-provider prompt when Pi credentials are available.
