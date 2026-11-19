# Pi SDK Compatibility and Parity

## Verified baseline

- `@earendil-works/pi-coding-agent`: **1.5.2** (exactly pinned)
- `@earendil-works/pi-tui`: **1.5.2** (exactly pinned; not integrated before M1)
- Required Node.js: **22.19 or newer**
- SDK checked against the public SDK guide and `01-minimal.ts` example on 2026-11-16.

## M0 smoke coverage

| Capability                                 | Status              | Evidence / limitation                                                              |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------- |
| Create/dispose SDK session                 | Verified            | `tests/integration/pi-sdk.test.ts`                                                 |
| Stream text deltas                         | Implemented         | `src/pi/pi-agent-gateway.ts` maps `message_update` text deltas                     |
| Prompt settles                             | Implemented         | `agent_settled` mapped to Rook event                                               |
| Mock gateway without credentials           | Verified            | `tests/pi/mock-agent-gateway.test.ts`                                              |
| Real provider prompt                       | Verified            | Single-argument one-shot prompt passed with the user's Pi login                    |
| Auth, model selection, persistent sessions | Implemented         | Rook TUI uses Pi auth/model APIs and `AgentSessionRuntime`                         |
| Workspace custom model providers           | Implemented         | Ignored `models.json` providers merge through `ModelRuntime.registerProvider`      |
| Skills and prompt templates                | Implemented         | Rook-scoped skills only; `/skills`, `/prompts`, native commands                    |
| Session fork and compaction                | Implemented         | `/fork` uses Pi's before-message fork; `/compact` calls SDK compact                |
| Steer and follow-up messages               | Implemented         | `/steer` and `/follow-up` queue through Pi while a run is active                   |
| MCP servers and codemode                   | Implemented         | Pi built-ins; MCP calls checked by Rook policy, with user-intent/approval gating   |
| Third-party executable extensions          | Disabled            | Rook loads only its inline policy extensions and selected Pi built-ins             |
| Tool permission sandbox                    | Implemented/limited | Shell is Bubblewrap-isolated on Linux; other Rook tools remain host-side           |
| Terminal execution                         | Approval-gated      | Pi bash in build mode only; approve each command, 120s default / 300s max timeout  |
| Plan-mode repository inspection            | Read-only           | `rook_inspect` runs fixed Git operations without exposing arbitrary shell          |
| On-demand repository orientation           | Read-only           | `rook_map` emits bounded source/symbol metadata, query-ranked without source dumps |
| Change-impact verification                 | Implemented         | `rook_impact` maps the diff to direct dependents, existing tests, and checks       |
| Isolated read-only review/research         | Implemented         | `/review` and `/explore` use temporary plan-mode Pi sessions on explicit request   |
| Architect/editor separation                | Implemented         | `/architect` returns an explicit read-only proposal; it never auto-applies it      |
| Repository instruction files               | Implemented         | Scoped, bounded `AGENTS.md` only; `/instructions` lists applicable files           |
| Sandboxed shell and isolated worktrees     | Implemented/limited | Bubblewrap on Linux, fail-closed elsewhere by default; managed detached worktrees  |

## SDK-vs-CLI setup gaps

The SDK guide states that SDK sessions do not load CLI built-in `codemode`, `tool_search`, or MCP extensions automatically. Rook explicitly loads Pi's MCP, codemode, and tool-search built-ins; MCP wrappers are only active when MCP tools are registered, and all MCP tool calls pass through Rook's `tool_call` policy hook. Explicit user direction authorizes a named MCP tool, or all MCP tools when the prompt asks generally to use MCP; when Rook initiates MCP use, interactive approval is required (once or for that server for the current session). Plan mode allows approved MCP calls; non-interactive runs deny assistant-initiated MCP calls. Global and trusted-project MCP configs follow Pi's standard `~/.pi/agent/mcp.json` and `.pi/mcp.json` paths. Rook still filters Pi's discovered skills to `.rook/skills/` and `$ROOK_HOME/skills/`, and does not load arbitrary extension files. Pi does not provide a process/filesystem permission sandbox; an MCP approval is not a sandbox for the server or its API actions.

Rook wraps Pi's public `createBashToolDefinition` and local execution backend to enforce timeouts while retaining output truncation and cancellation. Approved shell commands run with the user's host permissions and can bypass file-tool path restrictions; see [terminal command safety](../README.md#terminal-commands). Plan mode and unattended runs deny shell execution.

The `rook-execution-policy` extension contributes mode-aware system guidance without replacing Pi's prompt. Plan mode exposes workspace read/search, a structured Git inspector, and authorized MCP calls; Build mode enables approved editing/shell, MCP, and the diff-aware impact analyzer. Recognized verification commands require a completed impact analysis after the last Rook file edit. Arbitrary shell execution prevents complete classification, so this workflow gate is not a security sandbox. `.rook/policy.json` provides a small validated override surface for workflow guidance and testing scope.

The real-provider smoke passed with the user's existing Pi login using `node bin/rook.mjs "Please reply exactly: Rook provider smoke passed."`. The smoke verified Rook's one-shot startup, Pi adapter, and streaming path. A CLI parser bug found during the check (single-argument prompts were dropped) is covered by `tests/app/cli-args.test.ts` and fixed.

## Upgrade rule

Do not change Pi versions without updating this matrix and passing the public-export and session-lifecycle tests. Do not import undocumented package internals.
