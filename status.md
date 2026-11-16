# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- ROOK-006 is implemented: the custom `pi-tui` shell renders Home and streamed Markdown; interactive SDK sessions start with all tools disabled pending policy work.
- ROOK-007 is implemented: the Pi adapter maps final messages, token usage, tool lifecycle, errors, and aborts; the TUI renders tool status without displaying raw arguments or outputs.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The TUI is still an early shell; the permission policy and repository-memory engine are not implemented yet.

## Pending

- ROOK-008 is next: wire Pi-backed provider auth, model selection, and settings; keep interactive tools disabled until ROOK-010's enforced policy exists.
- Run a real-provider prompt when Pi credentials are available.
