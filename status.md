# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- ROOK-006 is implemented: the custom `pi-tui` shell renders Home and streamed Markdown; interactive SDK sessions start with all tools disabled pending policy work.
- ROOK-007 is implemented: the Pi adapter maps final messages, token usage, tool lifecycle, errors, and aborts; the TUI renders tool status without displaying raw arguments or outputs.
- ROOK-008 is implemented: `/model`, `/login`, `/logout`, and `/settings` use Pi's model/provider/auth APIs. Model and thinking selections persist through Pi; sign-in uses the documented Pi CLI handoff.
- ROOK-009 is implemented: the gateway uses Pi's `AgentSessionRuntime`; `/new` and `/sessions`/`/resume` replace sessions and rebind subscriptions. Resumed user/assistant text is restored without rendering raw tool data.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The TUI is still an early shell; the permission policy and repository-memory engine are not implemented yet.

## Pending

- ROOK-010 is next: enforce plan/build mode and tool approvals at the execution boundary. Keep interactive tools disabled until that policy is validated.
- Run a real-provider prompt when Pi credentials are available.
