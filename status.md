# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- ROOK-006 is implemented: the custom `pi-tui` shell renders Home and streamed Markdown; interactive SDK sessions start with all tools disabled pending policy work.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The TUI is still an early shell; the permission policy and repository-memory engine are not implemented yet.

## Pending

- ROOK-007 is next: improve transcript/editor/tool display from real Pi events; keep interactive tools disabled until mode-aware policy is implemented.
- Run a real-provider prompt when Pi credentials are available.
