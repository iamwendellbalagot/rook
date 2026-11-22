# Rook

**A coding agent that grows with your codebase.**

Rook is in early development. Its full-screen TUI integrates Pi with repository-scoped memory, plan/build tool policy, and platform-limited shell isolation. See the progress and benchmark documents for current limitations and measured retrieval behavior.

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

The project is in early development. The npm package is `rook-agent`; its executable remains `rook`. For provider-backed use, sign in with `/login` from the Rook TUI. Pi stores credentials in its user-level auth store; never put provider secrets in the repository or command history.

### Local PLYTH development dependency

PLYTH is an optional peer integration. Install both tools globally once:

```sh
npm install --global rook-agent plyth-core
```

Rook resolves PLYTH from the active workspace first, then from the global npm
installation. Configure a workspace (including non-Node projects) with:

```sh
plyth-core install rook --project .
```

This writes `.rook/plyth.json` with integrated mode by default and does not add
a `package.json`, lockfile, or `node_modules`. Restart Rook after changing its
mode. `/plyth status` reports the current mode; `/plyth enable` selects
integrated mode; `/plyth disable` turns it off for this workspace. Existing
trace controls remain under `/plyth trace [status|on|off|export|clear]`.
`plyth-core status rook --project .` reports the installed package and
effective mode. `plyth-core uninstall rook --project .` disables PLYTH for the
workspace but leaves the globally installed package and saved traces intact.

Prompt-only mode remains supported through
`plyth-core install rook --project . --mode prompt`; the TUI does not toggle it.
An explicit `ROOK_PLYTH_INTEGRATED=off|prompt|integrated` environment setting
overrides the workspace configuration. For local development, clone `plyth`
beside `rook`; its `file:../plyth` reference is a development dependency only.

Integrated mode includes deterministic outcome observation, in-memory session counts, and an outcome-only command-history baseline. `/plyth status` reports agent/history accuracy on the same comparable outcomes; edits or changed/unavailable workspace snapshots invalidate history. Snapshot budgets are 256 files / 2 MiB / best-effort 50 ms; symlinks, unknown hidden/sensitive inputs or larger workspaces make the comparison unavailable. Dependencies, external state, `.git` and `.rook` runtime data are outside this workspace-file heuristic.

Set `ROOK_PLYTH_MODE=off` for a same-host B0 (no extension, prediction schema/guidance or snapshots), `observe` for B1, or `feedback` for experimental B2. An explicit mode overrides the compatibility flag `ROOK_PLYTH_FEEDBACK=1`. Feedback remains default-off, specific-miss-only, deduplicated and capped at five per session. Commands, permissions and required verification do not change.

Persistence is separately opt-in: `ROOK_PLYTH_TRACE=1` or `/plyth trace on`. `/plyth trace [status|on|off|export|clear]` controls the private local JSONL ledger at `$ROOK_HOME/plyth/trace.jsonl` (default `~/.rook/plyth/trace.jsonl`). It stores only coarse times/durations, enums, a random session pseudonym and baseline correctness flags—not commands, output, evidence, paths, prompts or host IDs. It is capped at 64 KiB, private on POSIX, and storage errors fail open. `off` preserves records; `clear` deletes the ledger and disables tracing in this process. Stop other tracing processes before deletion if you want it to stay empty. No ledger is written by default and no data is uploaded. See sibling Plyth `docs/rook.md` for capabilities, snapshot limits, retention, safe export and stale-lock recovery.

### Integrated PLYTH assistance (experimental)

`ROOK_PLYTH_INTEGRATED=integrated` opts into sparse assistance inside the existing Pi inference/tool loop. It adds concise behavioral guidance, one bounded task-local change checkpoint after observed source changes, and at most two recovery signals when the same supported test/build/diagnostic failure and evidence repeat. Checkpoints enter the next normal inference context; recovery advice is appended to the existing Bash result. It does not start a reviewer/provider turn, run tools, remove code, authorize actions, or claim a root cause. Task text and paths are escaped as untrusted context; task state and feedback are in-memory only. Session/fork/compaction boundaries clear task state.

The workspace installer persists this selection in `.rook/plyth.json` (`{"schemaVersion":1,"integrationVersion":1,"mode":"off|prompt|integrated"}`). Integrated mode is the default when PLYTH is installed; use `/plyth disable` or `ROOK_PLYTH_INTEGRATED=off` to turn it off. An explicit `ROOK_PLYTH_INTEGRATED` environment setting overrides the workspace value.

`ROOK_PLYTH_INTEGRATED=prompt` enables only the same static guidance. An explicit `off` disables the integrated path. Legacy `ROOK_PLYTH_MODE=off|observe|feedback` and `ROOK_PLYTH_FEEDBACK=1` behavior remains available when integrated mode is off. `/plyth status` reports the active mode. No live/provider-backed effectiveness evaluation has been run for this feature; it remains experimental.

Rook-first feature completion does **not** establish feedback benefit. The earlier bounded Phase 3 evaluation found insufficient benefit evidence and predates the completed baseline/trace features. Other coding-agent adapters are deferred.

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
npm run eval:coding -- prepare /tmp/rook-coding-eval
npm run eval:coding -- verify-fixtures
```

To inspect the TUI without credentials, run `node bin/rook.mjs --mock`. Submit a prompt; use `/help` and `/exit`, or press Ctrl+C to leave. To use a provider, run `node bin/rook.mjs` and use `/login` to choose a supported OAuth subscription/account flow or API-key flow in Rook; `/logout` removes a provider credential. Provider and model configuration are inherited from Pi, and authentication is handled by Pi's runtime. The TUI starts in plan mode; `/build` enables policy-gated workspace edits and approval-gated terminal commands. A one-shot headless prompt is also available with `node bin/rook.mjs "Summarize this repository"`. `npm run smoke` exercises the credential-free mock gateway. The memory benchmark is deterministic and offline; it measures retrieval, not model-task success.

The footer's context meter shows the current conversation estimate against the selected model's context window; it is not cumulative token usage or provider billing. `/compact [instructions]` summarizes older context into a continuation handoff and refreshes the meter (the estimate may be approximate until the next model response). `/new` saves the current session and starts a clean one while keeping the workspace and selected model. Completed multi-step checklists disappear after a successful run; cancelled or incomplete work remains visible.

Rook's fixture-based coding-task evaluation suite is also offline and credential-free: tasks are completed manually in disposable workspaces, focused checks are run explicitly, and a validated results JSON is scored against a human rubric. It does not automatically call a provider or claim model quality. See [`evals/coding/README.md`](evals/coding/README.md).

Create a Rook-managed detached worktree with `rook worktree create`; list worktrees with `rook worktree list`, review changes with `rook worktree diff <path>`, and remove a clean managed checkout with `rook worktree remove <path>`. Worktrees are full independent clones under `.rook-worktrees/` beside the repository. Uncommitted changes prevent removal. Start Rook in the returned checkout with `rook --cwd <path>` to isolate file changes for review; worktrees do not sandbox process access on their own.

### Repository instructions

Rook loads applicable `AGENTS.md` files as bounded project guidance: the repository root, directories from the current working directory to the root, and nested directories containing file paths named in the user prompt. At most four files and 12 KiB total are injected; files over 8 KiB are skipped. Symlinks, paths outside the workspace, unreadable files, and empty files are ignored. `/instructions` lists the files applicable to the current workspace. Instruction contents are untrusted reference context and cannot grant tools or change Rook's permission policy. `CLAUDE.md` and other instruction-file formats are not loaded.

Repository memory is conservative: high-signal user statements linked to successful workspace reads become reviewable candidates, and `remember:` claims require confirmation. `/memory verify <id>` displays the claim and evidence; inspect them before `/memory verify <id> confirm`. File hashes establish evidence freshness, not claim truth. Confirmed, relevant memories can be injected into later prompts and are withheld after their evidence changes until reviewed again. When new memories are supplied to a run's model context, Rook shows the count. `/memory supplied` shows the latest supplied claims and evidence in the current run, with the existing verify and forget commands. Supply does not mean the model relied on a claim; the indicator is not saved with the transcript.

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

In `/build`, Rook can use Pi's `bash` tool to run tests, builds, and other terminal commands. Conservative routine commands run without prompts inside the sandbox; destructive and unclassified commands require approval, with Deny selected by default. The prompt shows why approval is required, the exact command, working directory, sandbox boundary, and timeout. A session grant applies only to that exact command, workspace, and sandbox mode. Plan mode blocks shell, and unattended runs deny commands requiring approval. Bash must be installed.

Commands run inside Bubblewrap on Linux or macOS Seatbelt. Both backends deny network access by default and expose the selected workspace as writable while restricting other filesystem access; Linux builds a private root with system runtime trees mounted read-only, and macOS uses a deny-by-default Seatbelt profile. Git metadata is read-only under both backends. Bubblewrap also isolates user and PID namespaces and provides a private `/tmp`; Seatbelt creates a per-command private temporary directory. Rook exposes the workspace at its normal absolute path for tool compatibility. Rook fails closed if the OS sandbox is unavailable or the workspace cannot be safely mounted; it never silently retries on the host. Other platforms have no built-in sandbox runtime, so Build-mode shell commands fail closed unless the project explicitly sets `"sandbox_shell": false` in `.rook/policy.json`. That opt-out runs commands with the user's host permissions and can access other files, credentials, and the network; routine commands still require approval in host mode. External-folder grants are not implemented yet.

Review the complete command and repository scripts before approving. If the complete command and sandbox boundary cannot fit in the approval panel, approval is disabled until the terminal is enlarged or a shorter command is requested. For stronger isolation of the entire coding session, use a container/VM and a Rook-managed worktree.

Commands time out after 120 seconds by default; an explicit timeout must be positive and at most 300 seconds. Ctrl+C cancels the active run. Pi truncates model-facing command output to 2,000 lines or 50 KiB and may save full output to a temporary file. Tool results go to the model; the transcript shows tool status rather than dumping raw output.

Create a detached Git worktree for a separate reviewable working copy with `rook worktree create`; use `rook worktree list` and `rook worktree remove <path>` to inspect and remove Rook-managed worktrees. By default they live beside the repository under `.rook-worktrees/`. Start Rook in the printed path with `rook --cwd <path>`. Worktree edits are separate from the original checkout and remain available for inspection until explicitly removed; they are not automatically merged or committed.

Plan mode provides `rook_search` for bounded literal content search, `rook_map` for an on-demand source/symbol overview ranked by query and internal imports, `rook_code` for TypeScript/JavaScript definition/reference navigation and focused diagnostics, and `rook_inspect` for structured, read-only Git operations. `rook_code` uses a pinned TypeScript 5.9 language service alongside Rook's TypeScript 7 compiler, project `tsconfig.json` compiler options where safe, and accepts a workspace-relative source path plus one-based line/column for symbol queries. Diagnostics report syntactic and semantic issues in the selected file; it does not emit fixes or write files. Project source scanning and result output are bounded. These tools skip sensitive paths and links; the map omits file contents and skips generated/dependency output. `rook_inspect` supports `summary` (status + recent commits), `status`, `diff`, `log`, `branches`, and `show`. `show` without a path returns commit metadata; with a repository-relative file path it returns the file contents at the revision (default `HEAD`). Plan mode does not expose arbitrary shell.

#### Optional Python and Go navigation (experimental)

`rook_code` also supports Python (`.py`, `.pyi`) and Go (`.go`) definitions, references, and file diagnostics in Linux Build mode with sandboxing enabled. Install a trusted Pyright language server or `gopls` yourself and set `ROOK_PYRIGHT_LANGUAGE_SERVER` or `ROOK_GOPLS` to its absolute executable path. The resolved executable must be under `/usr`; its runtime must also be available there (Node for Pyright, Go for `gopls`). The integration looks for Bubblewrap in `/usr/bin` and `/usr/local/bin`. There is no automatic install or unsandboxed fallback. If unavailable, use `rook_map` and `rook_search` for workspace exploration.

Servers see only a read-only projection of bounded, safe source files with network disabled and a private temporary directory. The Go adapter requires an enclosing `go.mod` and uses only its module path and Go version, not its dependencies or directives. Workspace configuration, dependency trees, and project build hooks are omitted, so results are explicitly partial. The TypeScript/JavaScript backend is unchanged and remains available in Plan mode. With both language servers configured, run the opt-in integration fixtures on a Linux development host: `ROOK_TEST_LANGUAGE_SERVERS=1 npx vitest run tests/pi/code-intelligence-tool.test.ts`.

#### Task receipts and change review

Each interactive Build run ends with a task receipt, including failures and cancellations. It lists successful Rook file-tool operations, safe paths that were already dirty, and observed dirty-state changes it cannot attribute. It also lists outcomes for recognized standalone checks, omitting command arguments. A reported pass is the outcome of that command when it ran, not proof that the final diff is verified. The bounded Git comparison can be partial (for example, after a commit, when safe limits are exceeded, or outside a Git checkout). It does not detect all concurrent, ignored, or index-only changes and does not attribute whole diffs to Rook.

Use `/diff` for an interactive, read-only Git status and diff review. `/undo` previews recovery of the latest successful Rook `edit`/`write`; `/undo confirm` restores it only if the target still matches Rook's recorded post-edit content. Recovery is in-memory and session-local, covers only Rook file-tool operations (not shell side effects), and skips sensitive, linked, oversized, or unverifiable files. It is a convenience, not a replacement for version control or backups. Restoring a newly created file removes it only while its recorded content is unchanged.

Read-only workflows are explicit: `/ask <question>` answers one question in plan mode and restores the prior mode; `/explore <question>` researches in a fresh, temporary plan-mode session; `/architect <task>` returns a separate implementation proposal without executing it; `/review` sends the current Git status/diff to a read-only review session; `/review simplicity` questions unjustified complexity, optionally scoped with repeated `--file repo/path` options. These workflows invoke provider inference only when requested and do not add their tool trace to the main conversation. Their tool restrictions are enforced by Rook; prompt wording alone is not the security boundary.

Simplicity review captures a task-start change boundary, excludes previously dirty files by default, and includes safe untracked contents. Explicit mixed-file scope or a missing boundary is labelled attribution-unknown and partial. Its version-1 result identifies scope/revision, validates up to three findings, reports actual token usage, and warns about stale files. A review-only guard allows at most four `read`/`rook_search` calls, bounds prompt plus supplementary text to 32,000 conservative UTF-8 byte units, allows up to four provider requests, and sets an 8,000-output-token limit per response. Oversized initial scope is rejected; omitted supplementary context forces partial coverage. Existing system/tool context and repeated provider turns can add input usage. Explicit evaluation metrics can include the bounded raw model response, stop reasons, tools used, and errors; callers are responsible for safe handling of response text. Task/session changes discard pending findings. Generic `/review` retains its ordinary free-form behavior. Live paired evaluation is recorded under `evals/simplicity-finish/`; it does not establish broader effectiveness beyond the tested cases. See sibling Plyth `docs/rook.md` for limits, privacy and attribution semantics.

Projects can define focused read-only subagents in `.rook/agents.json`:

```json
{
  "agents": [
    {
      "name": "api-reviewer",
      "description": "Review API changes for compatibility",
      "instructions": "Focus on request/response contracts and cite relevant files.",
      "tools": ["read", "rook_inspect", "rook_search"]
    }
  ]
}
```

Use `/agents` to list profiles or `/agents api-reviewer <task>` to run one in a fresh session. Profiles default to bounded read-only workspace/Git tools; configuration cannot enable file writes, shell, MCP, or executable extensions. Profile instructions are untrusted task guidance and cannot change the tool boundary. Profiles are loaded when Rook starts.

Small tasks default to relevant reads → edit → inspect the diff → focused verification. Checklists and repository-wide exploration are discouraged for straightforward edits. Build mode's optional `rook_impact` analyzes the current diff, direct source dependents, and related tests; use it for shared code, broad changes, or uncertain dependencies, not as a prerequisite for every check. Routine allowlisted shell commands run without prompts inside the default OS sandbox. Destructive and unclassified commands require approval; session approval is limited to the exact command and workspace. The sandbox keeps network disabled, limits writes to the workspace and private temporary directory, and fails closed when unavailable. An explicit host-shell opt-out remains unsandboxed. Successful exact verification commands are not repeated until a Rook edit or non-verification shell command invalidates the record. Command classification routes prompts; it is not a security boundary. Code-quality preferences are guidance; tool permissions and mode restrictions are enforced by Rook.

Assistant Markdown code fences use language-aware `highlight.js` syntax colors in the terminal. Unknown or unlabelled languages remain readable as plain code; oversized blocks skip highlighting to keep rendering responsive.

While a run is active, ordinary text is queued as a follow-up; `/steer` changes the current task and `/cancel` stops it. Provider errors do not prematurely release the active run while Pi is retrying. Mode changes are blocked until the run finishes. Timeout/HTML errors are summarized instead of displaying raw upstream markup. The status line distinguishes provider, tool, and approval waits. Completed-run stats include assistant request attempts (including retries), time to first visible text or tool activity, tool time excluding approval waits, approval wait time, and total duration. Queued follow-ups share the active run's totals; these live-session measurements are not persisted, and the existing tokens/sec figure includes all waits.

Optional project overrides can be set in `.rook/policy.json`:

```json
{
  "execution": { "minimize_tool_calls": true, "sandbox_shell": true },
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

Omitted options use conservative defaults. Set `execution.sandbox_shell` to `false` only when host shell access is intentional; this disables the OS sandbox and is reported in command approvals. Other configuration adjusts workflow guidance and impact escalation; it cannot disable tool-policy security checks. Test failures and missing verification must always be reported.

Rook only loads skills installed in its own directories, not ambient Pi/OpenCode skills: project skills live in `.rook/skills/`, and global skills live in `$ROOK_HOME/skills/` (default `~/.rook/skills/`). Run `node bin/rook.mjs skills install <path|git-url|owner/repo>` to install project skills, add `--global` for a global skill, and optionally pass `--skill NAME` to select one skill from a repository. GitHub tree URLs can target a skill subdirectory. Use `node bin/rook.mjs skills list` and `node bin/rook.mjs skills remove NAME [--global]` to manage installed skills. Skills are instruction files; installation does not enable Pi executable extensions or grant additional tools. Executable third-party extensions remain disabled because their initialization can run outside tool-call approvals.

### MCP servers

Rook loads Pi's built-in MCP, Code Mode, tool-search, and server manager extensions. Configure global MCP servers in `~/.pi/agent/mcp.json`; trusted projects can also use `.pi/mcp.json`. The JSON format uses a top-level `mcpServers` object and supports Pi's stdio and HTTP server options. Use `/mcp` in the TUI to inspect servers, authenticate, enable/disable, or change exposure. Local stdio servers execute on the host with the user's permissions; remote servers can access data and perform actions through their APIs.

MCP tools are available in both Plan and Build. If the user explicitly names a tool (for example, “use `mcp__docs__search`”), that tool is authorized for the request without another approval; “use MCP” authorizes MCP tools for that request. If Rook recommends MCP and tries to call a server without explicit user direction, the TUI asks first; a session grant applies only to that specific tool and server. Unknown registered tools also require approval and receive grants scoped to that tool/source. Input summaries are bounded and redact secret-like fields. Non-interactive runs deny calls that require approval. Approval is not a sandbox, and server/tool behavior is not inferred to be safe from its description. Pi's global MCP configuration is shared with Pi; Rook does not load arbitrary third-party extension files.

The TUI uses the visual references in [`tui_references/`](tui_references/README.md). See [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/PI_PARITY.md`](docs/PI_PARITY.md), and the [harness principles](docs/HARNESS_PRINCIPLES.md).

Rook keeps file-tool access inside the current project by default. In the interactive TUI, a tool request for an outside folder opens an approval prompt with one-time or session-only read/write choices. `/permissions` lists folder, exact-command shell, and specific-tool session grants; `/permissions revoke <grant-id>` revokes any listed grant. Grants end with the session, and headless runs deny requests that need approval. macOS privacy permissions are separate: after approving in Rook, the terminal app may also need access under System Settings → Privacy & Security → Files & Folders.

Pi SDK/TUI attribution and license notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
