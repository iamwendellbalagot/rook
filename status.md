# Work Handoff Status

## Current state

- M0 (ROOK-001 through ROOK-004) is implemented: TypeScript/ESM scaffold, pinned Pi 1.5.2 adapter, mock gateway, parity matrix, CLI smoke path, and CI workflow.
- ROOK-005 is implemented: a tested app state/event reducer is wired into the headless CLI.
- Offline validation passes: typecheck, unit/integration tests, build, mock smoke, and Prettier check. See `docs/PROGRESS.md` for command results.
- Live-provider streaming still needs a credential-configured smoke run.
- The UI is intentionally still headless; no TUI or memory implementation has started.

## Pending

- ROOK-006 is next: implement the minimal custom TUI shell using the reducer/state contract and `tui_references/` as read-only design input. Follow its README/SPEC/HANDOFF read order and treat screenshot content as illustrative.
- Run a real-provider prompt when Pi credentials are available.
