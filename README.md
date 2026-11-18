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

To inspect the TUI without credentials, run `node bin/rook.mjs --mock`. Submit a prompt; use `/help` and `/exit`, or press Ctrl+C to leave. To use Pi's configured provider, run `node bin/rook.mjs`; Pi provider authentication and model configuration are inherited, and Rook does not collect credentials. The TUI starts in plan mode; `/build` enables policy-gated workspace edits and approval-gated terminal commands. A one-shot headless prompt is also available with `node bin/rook.mjs "Summarize this repository"`. Startup options include `--mode plan|build`, `--model PROVIDER/MODEL`, and `--no-memory` (disable Rook memory capture/retrieval and avoid opening its SQLite store for that run). `npm run smoke` exercises the credential-free mock gateway. The memory benchmark is deterministic and offline; it measures retrieval, not model-task success.

Repository memory is conservative: high-signal user statements linked to successful workspace reads become reviewable candidates, and `remember:` claims require confirmation. `/memory verify <id>` displays the claim and evidence; inspect them before `/memory verify <id> confirm`. File hashes establish evidence freshness, not claim truth. Confirmed, relevant memories can be injected into later prompts and are withheld after their evidence changes until reviewed again.

### Workspace model providers

Rook loads an optional workspace-root `models.json` when starting and refreshes its provider definitions whenever `/model` opens. Start with the non-secret example, then edit the endpoint and model definitions for your service:

```sh
cp models.example.json models.json
```

`models.json` is git-ignored. Rook merges its providers into Pi's runtime, retaining Pi's built-in models, user-level custom providers, and credentials. Workspace configuration can only reference API keys through environment variables (for example, `$RDSEC_API_KEY`); literal keys and command-based secret resolvers are rejected. Set the variable before starting Rook. For short-lived RONE JWTs, generate a fresh token before launch, then export it as `RDSEC_API_KEY`. The example `RONE_Models` provider shows the OpenAI-compatible endpoint shape and Luna/Sol AWS model definitions; replace its placeholder endpoint with your configured service URL.

For example, after logging in with the RONE CLI, start Rook with a fresh token:

```sh
export RDSEC_API_KEY="$(rone token generate ai --quiet)"
node bin/rook.mjs
```

### Terminal commands

In `/build`, Rook can use Pi's `bash` tool to run tests, builds, and other terminal commands. Each command requires **Run command once** approval; Deny is selected by default. The prompt shows the command, working directory, and timeout. There is no blanket/session shell grant. Plan mode and non-interactive runs do not allow shell execution. Bash must be installed (Windows users need Bash, for example Git Bash).

**Approved commands run on your host, not in a sandbox.** They start in the project directory but can read or modify files elsewhere, access credentials, execute scripts, and use the network. File-tool path restrictions do not constrain shell commands. Review the complete command and repository scripts before approving; use an isolated container/VM for untrusted projects. If the full command and warning cannot fit in the approval panel, approval is disabled until the terminal is enlarged or a shorter command is requested.

Commands time out after 120 seconds by default; an explicit timeout must be positive and at most 300 seconds. Ctrl+C cancels the active run through Pi's process-tree cancellation. Pi truncates model-facing command output to 2,000 lines or 50 KiB and may save full output to a temporary file. These limits are not a resource/security sandbox or a disk-usage quota. Tool results go to the model; the transcript shows tool status rather than dumping raw output.

Plan mode provides `rook_search` for bounded literal content search that skips symlinks, sensitive paths, binaries, dependencies, and oversized files, plus `rook_inspect` for structured, read-only Git operations. Both modes support `summary` (status + recent commits), `status`, `diff`, `log`, `branches`, and `show`. `show` without a path returns commit metadata; with a repository-relative file path it returns the file contents at the revision (default `HEAD`). Plan mode does not expose arbitrary shell.

Use `/diff` for an interactive, read-only Git status and diff review. `/undo` previews recovery of the latest successful Rook `edit`/`write`; `/undo confirm` restores it only if the target still matches Rook's recorded post-edit content. Recovery is in-memory and session-local, covers only Rook file-tool operations (not shell side effects), and skips sensitive, linked, oversized, or unverifiable files. It is a convenience, not a replacement for version control or backups. Restoring a newly created file removes it only while its recorded content is unchanged.

Small tasks default to relevant reads → edit → inspect the diff → focused verification. Checklists and repository-wide exploration are discouraged for straightforward edits. Build mode's optional `rook_impact` analyzes the current diff, direct source dependents, and related tests; use it for shared code, broad changes, or uncertain dependencies, not as a prerequisite for every check. All shell commands still require one-time approval. Successful exact verification commands are not repeated until a Rook edit or non-verification shell command invalidates the record. This is best-effort workflow control, not a shell security boundary; arbitrary shell remains host access, and changes made outside Rook's tool events are not detected. Code-quality preferences are guidance; tool permissions and mode restrictions are enforced by Rook.

Assistant Markdown code fences use language-aware `highlight.js` syntax colors in the terminal. Unknown or unlabelled languages remain readable as plain code; oversized blocks skip highlighting to keep rendering responsive.

While a run is active, ordinary text is queued as a follow-up; `/steer` changes the current task and `/cancel` stops it. Provider errors do not prematurely release the active run while Pi is retrying. Mode changes are blocked until the run finishes. Timeout/HTML errors are summarized instead of displaying raw upstream markup. The status line distinguishes provider, tool, and approval waits. Completed-run stats include assistant request attempts (including retries), time to first visible text or tool activity, tool time excluding approval waits, approval wait time, and total duration. Queued follow-ups share the active run's totals; these live-session measurements are not persisted, and the existing tokens/sec figure includes all waits.

Optional project overrides can be set in `.rook/policy.json`:

```json
{
  "execution": { "minimize_tool_calls": true },
  "code_quality": {
    "prefer_simple_solutions": true,
    "minimize_comments": true,
    "allow_unrelated_refactors": false
  },
  "testing": {
    "strategy": "focused",
    "run_full_suite_by_default": false,
    "escalate_on_uncertainty": true
  }
}
```

Omitted options use conservative defaults. Configuration adjusts workflow guidance and impact escalation; it cannot disable tool-policy security checks. Test failures and missing verification must always be reported.

Rook only loads skills installed in its own directories, not ambient Pi/OpenCode skills: project skills live in `.rook/skills/`, and global skills live in `$ROOK_HOME/skills/` (default `~/.rook/skills/`). Run `node bin/rook.mjs skills install <path|git-url|owner/repo>` to install project skills, add `--global` for a global skill, and optionally pass `--skill NAME` to select one skill from a repository. GitHub tree URLs can target a skill subdirectory. Use `node bin/rook.mjs skills list` and `node bin/rook.mjs skills remove NAME [--global]` to manage installed skills. Skills are instruction files; installation does not enable Pi executable extensions or grant additional tools.

The TUI uses the visual references in [`tui_references/`](tui_references/README.md). See [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/PI_PARITY.md`](docs/PI_PARITY.md), and [`plan.md`](plan.md).

Rook keeps tool access inside the current project by default. In the interactive TUI, a tool request for an outside folder opens an approval prompt with one-time or session-only read/write choices. Session grants are listed and can be revoked with `/permissions` and `/permissions revoke <grant-id>`; headless runs deny outside-folder requests because they cannot ask interactively. macOS privacy permissions are separate: after approving in Rook, the terminal app may also need access under System Settings → Privacy & Security → Files & Folders.

Pi SDK/TUI attribution and license notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
