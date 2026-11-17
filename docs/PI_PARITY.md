# Pi SDK Compatibility and Parity

## Verified baseline

- `@earendil-works/pi-coding-agent`: **1.5.2** (exactly pinned)
- `@earendil-works/pi-tui`: **1.5.2** (exactly pinned; not integrated before M1)
- Required Node.js: **22.19 or newer**
- SDK checked against the public SDK guide and `01-minimal.ts` example on 2026-11-16.

## M0 smoke coverage

| Capability                                 | Status                | Evidence / limitation                                                             |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| Create/dispose SDK session                 | Verified              | `tests/integration/pi-sdk.test.ts`                                                |
| Stream text deltas                         | Implemented           | `src/pi/pi-agent-gateway.ts` maps `message_update` text deltas                    |
| Prompt settles                             | Implemented           | `agent_settled` mapped to Rook event                                              |
| Mock gateway without credentials           | Verified              | `tests/pi/mock-agent-gateway.test.ts`                                             |
| Real provider prompt                       | Verified              | Single-argument one-shot prompt passed with the user's Pi login                   |
| Auth, model selection, persistent sessions | Implemented           | Rook TUI uses Pi auth/model APIs and `AgentSessionRuntime`                        |
| Skills and prompt templates                | Implemented           | Rook-scoped skills only; `/skills`, `/prompts`, native commands                   |
| Session fork and compaction                | Implemented           | `/fork` uses Pi's before-message fork; `/compact` calls SDK compact               |
| Steer and follow-up messages               | Implemented           | `/steer` and `/follow-up` queue through Pi while a run is active                  |
| Executable extensions, codemode, MCP       | Disabled              | Deliberately excluded from the Rook tool-policy boundary                          |
| Tool permission sandbox                    | Rook host-side policy | Tool calls are gated; this is not an OS/container sandbox                         |
| Terminal execution                         | Approval-gated        | Pi bash in build mode only; approve each command, 120s default / 300s max timeout |

## SDK-vs-CLI setup gaps

The SDK guide states that SDK sessions do not load CLI built-in `codemode`, `tool_search`, or MCP extensions automatically. Rook keeps executable extensions disabled and filters Pi's discovered skills to its managed project/global directories (`.rook/skills/` and `$ROOK_HOME/skills/`). Skills and templates do not add tools; their instructions still run through Rook's policy-controlled agent. Pi does not provide a process/filesystem permission sandbox; Rook gates tool execution itself.

Rook wraps Pi's public `createBashToolDefinition` and local execution backend to enforce timeouts while retaining output truncation and cancellation. Approved shell commands run with the user's host permissions and can bypass file-tool path restrictions; see [terminal command safety](../README.md#terminal-commands). Plan mode and unattended runs deny shell execution.

The real-provider smoke passed with the user's existing Pi login using `node bin/rook.mjs "Please reply exactly: Rook provider smoke passed."`. The smoke verified Rook's one-shot startup, Pi adapter, and streaming path. A CLI parser bug found during the check (single-argument prompts were dropped) is covered by `tests/app/cli-args.test.ts` and fixed.

## Upgrade rule

Do not change Pi versions without updating this matrix and passing the public-export and session-lifecycle tests. Do not import undocumented package internals.
