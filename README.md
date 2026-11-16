# Rook

**A coding agent that grows with your codebase.**

Rook is in early development. The current implementation is an M0 headless Pi SDK compatibility spike; it is not yet the full interactive coding agent described in the implementation plan.

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

`npm run smoke` exercises the credential-free mock gateway. To try the Pi SDK with your configured provider, run `npm run build && node bin/rook.mjs "Summarize this repository"`. Pi provider authentication and model configuration are inherited from Pi; Rook does not collect credentials itself.

The current command is a headless smoke client, not the planned TUI. See [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/PI_PARITY.md`](docs/PI_PARITY.md), and [`plan.md`](plan.md).
