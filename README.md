# Rook

**A coding agent that grows with your codebase.**

Rook is an experimental coding harness built on Pi, with a full-screen TUI, repository memory, Plan/Build modes, and OpenCode-inspired permissions and policies. The goal is reliable Claude Code-class workflows; comparative parity has not been demonstrated.

**Shell execution runs on your host, not inside an OS sandbox.** Review commands and repository scripts before approval. Permissions decide whether a tool starts; they do not confine its filesystem/network access. Use an external container/VM if you need isolation.

## Install

Requires Node.js 22.19+ and Git; POSIX shell execution is validated on macOS. Search requires ripgrep in a standard system location (`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, or Pi's managed `bin` directory).

```sh
npm install --global rook-agent
rook
```

From a source checkout:

```sh
npm ci
npm run build
node bin/rook.mjs --mock
```

Use `/login` for provider authentication, then `/model` to choose a model. Pi owns credential persistence. Never put credentials into repository files. Optional workspace-root `models.json` supports OpenAI-compatible providers; see `models.example.json`. API keys must reference environment variables, not literal secrets or executable resolvers.

## Modes and permissions

Rook starts in Plan mode. `/build` or Shift+Tab enables Build. Plan blocks file mutations, shell execution, MCP calls and unknown-effect tools. Ordinary workspace reads and Build edits are allowed by default; shell and external-directory access ask. Headless operations requiring approval are denied.

Configure ordered `allow`, `ask`, `deny` rules in `.rook/permissions.json`. User and system policies can hard-deny project permissions and saved approvals. See [permissions and migration](docs/PERMISSIONS.md) for precedence, shell inspection, exact-match project approvals, and limitations.

```json
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "deny" }
  ]
}
```

Approval offers once, session, or remember for this project. `/permissions` lists decisions and grants; `/permissions revoke ID` revokes a grant. Remembered grants live outside the repository and never override configured denials. Natural-language requests such as “use MCP” are not blanket authorization.

Old `.rook/policy.json` workflow preferences still select focused verification and engineering guidance; `sandbox_shell` no longer selects shell isolation. Existing sandbox auto-allows are not migrated into host grants.

## Coding workflow

- **Discover:** `rook_search` provides ignore-aware literal/regex search, case control and file-glob filtering. `rook_map` maps bounded source symbols; `rook_code` navigates TypeScript/JavaScript definitions/references and diagnostics; `rook_inspect` provides structured read-only Git inspection. Restricted/omitted search content is reported as partial. Custom read restrictions conservatively disable aggregate inspection tools until per-file authorization is available.
- **Follow local guidance:** instructions load root-to-leaf from prompts and file-tool access. Each directory selects `AGENTS.md`, then `agents.md`, then `CLAUDE.md`. Instructions are bounded untrusted guidance, never permission authority. New scoped guidance blocks an otherwise unguided first edit until the next context. `/instructions` lists discovered guidance. Limits remain four files, 8 KiB/file and 12 KiB total.
- **Implement and verify:** reproduce bugs when practical, make focused edits, inspect the diff and run appropriate checks. Successful tests may be rerun; a previous pass is not proof of current workspace correctness. Build receipts distinguish observed file edits, unattributed dirty-state changes and check freshness.
- **Run commands:** output streams live; exceeding the presentation limit does not kill a build. Private logs retain up to 2 MiB under `$ROOK_HOME/output`; model-facing output is bounded. Timeouts default to 120 seconds, maximum 300. Cancellation escalates from TERM to KILL for the process group; arbitrary daemonized descendants are not guaranteed contained.
- **Background work:** `rook_job` starts, inspects, awaits or cancels session-owned commands using the same shell permissions as Bash. At most four jobs; each has the same 300-second maximum. Task cancellation, session changes and shutdown cancel owned jobs. Restart does not reattach or replay unknown commands.
- **Continue:** `rook_task` maintains bounded durable goals, constraints, decisions, remaining work and blockers. It survives compaction/resume independently of narrative summaries. Interrupted operations have unknown outcomes and must be investigated, not automatically retried. Restored state is untrusted reference; revalidate files.

Use `/diff` to inspect changes. `/undo` previews the latest supported file-tool edit; `/undo confirm` restores it only if its post-edit content still matches and current permissions allow. Supported recovery is persisted per session, excludes sensitive/linked/oversized files, and does not reverse shell side effects. It is not a backup system.

### Sessions and research

- `/new`: clean conversation, same workspace/model; saves existing session.
- `/compact [instructions]`: continuation summary with context usage estimates.
- `/ask QUESTION`: one read-only question, then restores the prior mode.
- `/explore QUESTION`: fresh read-only repository research.
- `/architect TASK`: fresh implementation proposal without edits.
- `/review`: fresh read-only Git change review.
- `/agents`: list profiles; `/agents NAME TASK` invokes a configured read-only profile.
- During a run, normal text queues follow-ups; `/steer` changes direction; `/cancel` or Ctrl+C stops work.

Profiles live in `.rook/agents.json` and select only fixed read-only tools. `rook_agent` lets the model request bounded research delegation, subject to `subagent` permissions: at most three children, 12 provider requests and two minutes per child. Editing subagents are not implemented.

`rook worktree create|list|diff|remove` manages detached independent clones beside the repository. Start Rook with `--cwd PATH` to use one. Worktrees separate changes, not host access; removal refuses dirty work. There is no automatic merge or publish.

### Repository memory and skills

Memory candidates require review/confirmation before reuse. `/memory verify ID` shows evidence; `/memory verify ID confirm` confirms it. File hashes indicate freshness, not truth. `/memory supplied` shows claims supplied to the latest context; `/memory forget ID` removes a memory. Relevant confirmed memories are withheld when evidence becomes stale.

Skills live in `.rook/skills/` and `$ROOK_HOME/skills/` (default `~/.rook/skills`). `rook skills install SOURCE [--global] [--skill NAME]`, `rook skills list`, and `rook skills remove NAME [--global]` manage instruction-only skills. Executable third-party extensions remain disabled.

Pi MCP configuration lives in `~/.pi/agent/mcp.json` and trusted-project `.pi/mcp.json`; `/mcp` manages servers. Local stdio servers run with host authority; remote servers act through their APIs. Server startup is not sandboxed by tool permissions. MCP calls require Build and their own permissions.

### Optional PLYTH

PLYTH is experimental and opt-in. Core installation/build does not require it or a sibling checkout. Install a compatible package separately, then explicitly select `ROOK_PLYTH_INTEGRATED=prompt|integrated`, or a compatible workspace configuration. `/plyth enable|disable` saves a restart-required selection. `ROOK_PLYTH_INTEGRATED=off` disables integration. Installed API exports are checked before activation; optional tests skip when unavailable/incompatible.

`/review simplicity` explicitly loads compatible PLYTH on demand. Trace persistence remains independently opt-in through `/plyth trace on|off|status|export|clear`. Prior studies did not demonstrate a dynamic coding benefit; no new effectiveness claim is made.

## Desktop protocol

`rook --stdio [--cwd PATH] [--mode ask|build]` provides experimental newline-delimited JSON-RPC, pinned modes, provider login/model selection, streamed events, sessions, permissions and bounded replay. Arbitrary MCP is not exposed through stdio. See [protocol v1](docs/STDIO_PROTOCOL.md).

## Development and evidence

```sh
npm run typecheck
npm run build
npm run smoke
npm run test:harness
npm test
```

`npm run test:pty` and `npm run test:integration` exercise TUI and Pi boundaries. Optional PLYTH tests need a compatible installation. `npm run benchmark:memory` and `npm run benchmark:fts` measure retrieval, not coding quality. Existing offline coding fixtures are documented in `evals/coding/README.md`; historical provider-backed results are not a Claude Code comparison.

See [harness reliability and remaining gates](docs/HARNESS_RELIABILITY.md), [harness principles](docs/HARNESS_PRINCIPLES.md), and `status.md` for the current handoff. License attribution is in `THIRD_PARTY_NOTICES.md`.
