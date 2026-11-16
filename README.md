# Rook

**A coding agent that grows with your codebase.**

Rook is in early development. Its current full-screen TUI is a minimal shell; tool execution is deliberately disabled until the permission policy is implemented. It is not yet the full interactive coding agent described in the implementation plan.

## Requirements

- Node.js 22.19 or newer
- npm

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

To inspect the TUI without credentials, build and run `node bin/rook.mjs --mock`. Submit a prompt; use `/help` and `/exit`, or press Ctrl+C to leave. To use Pi's configured provider, run `node bin/rook.mjs`; interactive TUI mode has tools disabled for safety at this stage. A one-shot headless prompt is also available with `node bin/rook.mjs "Summarize this repository"`. Pi provider authentication and model configuration are inherited from Pi; Rook does not collect credentials itself. `npm run smoke` exercises the credential-free mock gateway.

The TUI uses the visual references in [`tui_references/`](tui_references/README.md). See [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/PI_PARITY.md`](docs/PI_PARITY.md), and [`plan.md`](plan.md).
