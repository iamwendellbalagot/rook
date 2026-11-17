# Rook

**A coding agent that grows with your codebase.**

Rook is in early development. Its full-screen TUI integrates Pi with repository-scoped memory and a host-side plan/build tool policy. This policy is not an OS sandbox; use an isolated container or VM for untrusted repositories. See the progress and benchmark documents for current limitations and measured retrieval behavior.

## Requirements

- Node.js 22.19 or newer
- npm

## Install from a source checkout

These commands work in macOS/Linux shells and Windows PowerShell or Command Prompt. Use Node.js 22.19.0 or newer and a recent Git installation.

```sh
git clone <repository-url> rook
cd rook
npm ci
npm run build
node bin/rook.mjs --mock
```

The project is still in early development and is not yet published as an npm release. For provider-backed use, configure Pi using its own documented authentication flow; never put provider secrets in the repository or command history.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:pty
npm run test:integration
npm run build
npm run smoke
npm run benchmark:memory
npm run benchmark:fts
```

To inspect the TUI without credentials, run `node bin/rook.mjs --mock`. Submit a prompt; use `/help` and `/exit`, or press Ctrl+C to leave. To use Pi's configured provider, run `node bin/rook.mjs`; Pi provider authentication and model configuration are inherited, and Rook does not collect credentials. The TUI starts in plan mode; `/build` enables policy-gated workspace edits and approval-gated terminal commands. A one-shot headless prompt is also available with `node bin/rook.mjs "Summarize this repository"`. `npm run smoke` exercises the credential-free mock gateway. The memory benchmark is deterministic and offline; it measures retrieval, not model-task success.

### Terminal commands

In `/build`, Rook can use Pi's `bash` tool to run tests, builds, and other terminal commands. Each command requires **Run command once** approval; Deny is selected by default. The prompt shows the command, working directory, and timeout. There is no blanket/session shell grant. Plan mode and non-interactive runs do not allow shell execution. Bash must be installed (Windows users need Bash, for example Git Bash).

**Approved commands run on your host, not in a sandbox.** They start in the project directory but can read or modify files elsewhere, access credentials, execute scripts, and use the network. File-tool path restrictions do not constrain shell commands. Review the complete command and repository scripts before approving; use an isolated container/VM for untrusted projects. If the full command and warning cannot fit in the approval panel, approval is disabled until the terminal is enlarged or a shorter command is requested.

Commands time out after 120 seconds by default; an explicit timeout must be positive and at most 300 seconds. Ctrl+C cancels the active run through Pi's process-tree cancellation. Pi truncates model-facing command output to 2,000 lines or 50 KiB and may save full output to a temporary file. These limits are not a resource/security sandbox or a disk-usage quota. Tool results go to the model; the transcript shows tool status rather than dumping raw output.

Rook only loads skills installed in its own directories, not ambient Pi/OpenCode skills: project skills live in `.rook/skills/`, and global skills live in `$ROOK_HOME/skills/` (default `~/.rook/skills/`). Run `node bin/rook.mjs skills install <path|git-url|owner/repo>` to install project skills, add `--global` for a global skill, and optionally pass `--skill NAME` to select one skill from a repository. GitHub tree URLs can target a skill subdirectory. Use `node bin/rook.mjs skills list` and `node bin/rook.mjs skills remove NAME [--global]` to manage installed skills. Skills are instruction files; installation does not enable Pi executable extensions or grant additional tools.

The TUI uses the visual references in [`tui_references/`](tui_references/README.md). See [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/PI_PARITY.md`](docs/PI_PARITY.md), and [`plan.md`](plan.md).

Rook keeps tool access inside the current project by default. In the interactive TUI, a tool request for an outside folder opens an approval prompt with one-time or session-only read/write choices. Session grants are listed and can be revoked with `/permissions` and `/permissions revoke <grant-id>`; headless runs deny outside-folder requests because they cannot ask interactively. macOS privacy permissions are separate: after approving in Rook, the terminal app may also need access under System Settings → Privacy & Security → Files & Folders.

Pi SDK/TUI attribution and license notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
