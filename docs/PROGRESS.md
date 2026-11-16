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
- Proceed to ROOK-007: transcript, editor, and tool-event display. The live-provider smoke remains credential-gated.

## M1 — Custom TUI and coding workflow

### Completed

- ROOK-005: added the Rook app state/event reducer for lifecycle, run states, modes, streamed/final messages, tool activity, usage, errors, and shutdown. The headless CLI now uses it to gate prompts and track runs.
- Focused reducer tests cover startup/auth readiness, idle/running/settled/failed states, duplicate prompt/mode guards, authoritative final messages, tool/usage events, and shutdown.
- ROOK-006: added a custom `pi-tui` alternate-screen shell with a responsive header, home view, fixed multiline editor/footer, streaming Markdown, basic command handling, and terminal cleanup. Interactive SDK sessions disable all tools until the permission policy lands.
- TUI visual choices follow `tui_references/SCREEN_SPEC.md` and `tokens.json`; the design reference files remain untouched.

### Validation

- `npm run typecheck` — passed.
- `npx vitest run tests/app/state.test.ts` — passed (5 focused tests).
- `npm run test:pty` — passed (fake-terminal render, resize, prompt, and cleanup flow).
- `npm run test:integration` — passed (pinned Pi SDK session lifecycle).
- `npm run build` — passed.
- `node bin/rook.mjs --smoke` — passed with the mock gateway.
- `npm run lint` — passed.

### Next

- ROOK-007: deepen the transcript/editor/tool display using actual Pi events; keep tools disabled until ROOK-010 implements enforced mode-aware policy.
