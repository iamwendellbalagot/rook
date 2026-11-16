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
- Otherwise proceed to ROOK-005: app state/event reducer, then build the basic TUI shell.
