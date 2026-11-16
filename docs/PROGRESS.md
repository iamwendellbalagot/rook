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
- Proceed to ROOK-006: build the basic TUI shell on the reducer/state contract.

## M1 — Custom TUI and coding workflow

### Completed

- ROOK-005: added the Rook app state/event reducer for lifecycle, run states, modes, streamed/final messages, tool activity, usage, errors, and shutdown. The headless CLI now uses it to gate prompts and track runs.
- Focused reducer tests cover startup/auth readiness, idle/running/settled/failed states, duplicate prompt/mode guards, authoritative final messages, tool/usage events, and shutdown.

### Validation

- `npm run typecheck` — passed.
- `npx vitest run tests/app/state.test.ts` — passed (5 focused tests).
- `npm run build` — passed.
- `node bin/rook.mjs --smoke` — passed.
- `npm run lint` — passed.

### Next

- ROOK-006: read `tui_references/README.md`, `SCREEN_SPEC.md`, and `IMPLEMENTATION_HANDOFF.md`, inspect the individual reference screens and tokens, then implement/test the minimal custom TUI shell with application state outside view components.
