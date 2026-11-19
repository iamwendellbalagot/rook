# Pi SDK Compatibility and Parity

## Verified baseline

- `@earendil-works/pi-coding-agent`: **1.5.2** (exactly pinned)
- `@earendil-works/pi-tui`: **1.5.2** (exactly pinned; not integrated before M1)
- Required Node.js: **22.19 or newer**
- SDK checked against the public SDK guide and `01-minimal.ts` example on 2026-11-16.

## M0 smoke coverage

| Capability                                 | Status              | Evidence / limitation                                                                                                            |
| ------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Create/dispose SDK session                 | Verified            | `tests/integration/pi-sdk.test.ts`                                                                                               |
| Stream text deltas                         | Implemented         | `src/pi/pi-agent-gateway.ts` maps `message_update` text deltas                                                                   |
| Prompt settles                             | Implemented         | `agent_settled` mapped to Rook event                                                                                             |
| Mock gateway without credentials           | Verified            | `tests/pi/mock-agent-gateway.test.ts`                                                                                            |
| Real provider prompt                       | Verified            | Single-argument one-shot prompt passed with the user's Pi login                                                                  |
| Auth, model selection, persistent sessions | Implemented         | Rook TUI uses Pi auth/model APIs and `AgentSessionRuntime`                                                                       |
| Workspace custom model providers           | Implemented         | Ignored `models.json` providers merge through `ModelRuntime.registerProvider`                                                    |
| Skills and prompt templates                | Implemented         | Rook-scoped skills only; `/skills`, `/prompts`, native commands                                                                  |
| Session fork and compaction                | Implemented         | `/fork` uses Pi's before-message fork; `/compact` calls SDK compact                                                              |
| Steer and follow-up messages               | Implemented         | `/steer` and `/follow-up` queue through Pi while a run is active                                                                 |
| MCP servers and codemode                   | Implemented         | Pi built-ins; MCP calls checked by Rook policy, with user-intent/approval gating                                                 |
| Third-party executable extensions          | Disabled            | Rook loads only its inline policy extensions and selected Pi built-ins                                                           |
| Tool permission sandbox                    | Implemented/limited | Shell is Bubblewrap-isolated on Linux; other Rook tools remain host-side                                                         |
| Terminal execution                         | Approval-gated      | Routine sandboxed commands are automatic; risky/unclassified commands prompt; 120s default / 300s max timeout                    |
| Plan-mode repository inspection            | Read-only           | `rook_inspect` runs fixed Git operations without exposing arbitrary shell                                                        |
| On-demand repository orientation           | Read-only           | `rook_map` emits bounded source/symbol metadata, query-ranked without source dumps                                               |
| Change-impact verification                 | Implemented         | `rook_impact` maps the diff to direct dependents, existing tests, and checks                                                     |
| Isolated read-only review/research         | Implemented         | `/review` and `/explore` use temporary plan-mode Pi sessions on explicit request                                                 |
| Architect/editor separation                | Implemented         | `/architect` returns an explicit read-only proposal; it never auto-applies it                                                    |
| Repository instruction files               | Implemented         | Scoped, bounded `AGENTS.md` only; `/instructions` lists applicable files                                                         |
| Sandboxed shell and isolated worktrees     | Implemented/limited | Bubblewrap on Linux, fail-closed elsewhere by default; managed detached worktrees                                                |
| Configurable project subagents             | Implemented/limited | `.rook/agents.json` profiles; fresh sessions restricted to fixed read-only tools                                                 |
| Coding-aware navigation/diagnostics        | Implemented/limited | `rook_code` TypeScript language service for TS/JS symbols and per-file diagnostics                                               |
| Extension and hook boundary                | Implemented/limited | Inline Rook hooks and selected Pi built-ins only; executable extensions ignored; unclassified tools require interactive approval |
| PLYTH prediction feedback pilot            | Observe-only        | Optional structured expectation on eligible Bash commands; in-memory counts via `/plyth`; no feedback or event ledger            |

## SDK-vs-CLI setup gaps

The SDK guide states that SDK sessions do not load CLI built-in `codemode`, `tool_search`, or MCP extensions automatically. Rook explicitly loads Pi's MCP, codemode, and tool-search built-ins; MCP wrappers are only active when MCP tools are registered, and all MCP tool calls pass through Rook's `tool_call` policy hook. Explicit user direction authorizes a named MCP tool, or all MCP tools when the prompt asks generally to use MCP; when Rook initiates MCP use, interactive approval is required (once or for that specific tool/source for the current session). Unclassified registered tools use the same approval flow and tool-scoped grants. Non-interactive runs deny calls requiring approval. Global and trusted-project MCP configs follow Pi's standard `~/.pi/agent/mcp.json` and `.pi/mcp.json` paths. Rook initializes only its inline extensions and selected Pi built-ins; project or global executable extension files are not loaded. A regression test verifies a project-configured executable extension is not initialized. Rook still filters Pi's discovered skills to `.rook/skills/` and `$ROOK_HOME/skills/`. `rook_code` uses pinned TypeScript 5.9 language-service APIs alongside the TypeScript 7 compiler because TypeScript 7 does not expose the legacy language-service API. Pi does not provide a process/filesystem permission sandbox; an MCP approval is not a sandbox for the server or its API actions.

Rook wraps Pi's public `createBashToolDefinition` and local execution backend to enforce timeouts while retaining output truncation and cancellation. Routine allowlisted Build commands run without prompts in Bubblewrap on Linux by default; destructive/unclassified commands require approval with exact-command/workspace grants. Unsupported/missing sandbox runtimes fail closed unless `.rook/policy.json` explicitly opts into host execution with `execution.sandbox_shell: false`. Plan mode blocks shell; unattended runs deny shell calls that require approval. See [terminal command safety](../README.md#terminal-commands).

The `rook-execution-policy` extension contributes mode-aware system guidance without replacing Pi's prompt. Plan mode exposes workspace read/search, a structured Git inspector, and authorized MCP calls; Build mode enables approved editing/shell, MCP, and the diff-aware impact analyzer. Recognized verification commands require a completed impact analysis after the last Rook file edit. Arbitrary shell execution prevents complete classification, so this workflow gate is not a security sandbox. `.rook/policy.json` provides a small validated override surface for workflow guidance and testing scope.

The real-provider smoke passed with the user's existing Pi login using `node bin/rook.mjs "Please reply exactly: Rook provider smoke passed."`. The smoke verified Rook's one-shot startup, Pi adapter, and streaming path. A CLI parser bug found during the check (single-argument prompts were dropped) is covered by `tests/app/cli-args.test.ts` and fixed.

## Upgrade rule

Do not change Pi versions without updating this matrix and passing the public-export and session-lifecycle tests. Do not import undocumented package internals.
