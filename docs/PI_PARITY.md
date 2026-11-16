# Pi SDK Compatibility and Parity

## Verified baseline

- `@earendil-works/pi-coding-agent`: **1.5.2** (exactly pinned)
- `@earendil-works/pi-tui`: **1.5.2** (exactly pinned; not integrated before M1)
- Required Node.js: **22.19 or newer**
- SDK checked against the public SDK guide and `01-minimal.ts` example on 2026-11-16.

## M0 smoke coverage

| Capability                                 | Status                           | Evidence / limitation                                               |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| Create/dispose SDK session                 | Verified                         | `tests/integration/pi-sdk.test.ts`                                  |
| Stream text deltas                         | Implemented                      | `src/pi/pi-agent-gateway.ts` maps `message_update` text deltas      |
| Prompt settles                             | Implemented                      | `agent_settled` mapped to Rook event                                |
| Mock gateway without credentials           | Verified                         | `tests/pi/mock-agent-gateway.test.ts`                               |
| Real provider prompt                       | Manual/credential-gated          | `rook "prompt"`; uses Pi's configured model and credentials         |
| Auth, model selection, persistent sessions | Not yet wired                    | Later milestone; no parity claim                                    |
| TUI, skills/extensions, codemode/MCP       | Not yet wired                    | M1; SDK-created sessions do not load CLI built-ins automatically    |
| Tool permission sandbox                    | Not available from Pi by default | Must be implemented/enforced by Rook before enabling build workflow |

## SDK-vs-CLI setup gaps

The SDK guide states that SDK sessions do not load CLI built-in `codemode`, `tool_search`, or MCP extensions automatically. Resource loading and explicit extension setup must be verified against the pinned package before claiming parity. Pi does not provide a process/filesystem permission sandbox; Rook must gate tool execution itself.

## Upgrade rule

Do not change Pi versions without updating this matrix and passing the public-export and session-lifecycle tests. Do not import undocumented package internals.
