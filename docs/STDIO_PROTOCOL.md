# Rook stdio protocol v1 (experimental)

Rook exposes a newline-delimited JSON-RPC 2.0 interface for desktop clients. The
protocol is experimental and may change before a stable protocol version is
announced. It uses Rook's existing provider configuration, credentials,
sessions, tools, and permission policy. Native provider/model methods are
advertised in `initialize`; older Rook versions that omit them remain
Ask-compatible but require sign-in/model selection in Rook.

## Requirements and launch

- Node.js 22.19.0 or newer.
- Provider setup may use native stdio sign-in or Rook's supported CLI/TUI login.
- Launch the installed executable with `node <rook-bin> --stdio [--cwd PATH] [--mode ask|build]`.
  The process working directory is used when `--cwd` is omitted. Mode defaults
  to `ask` and is pinned for the lifetime of the process.
- stdin and stdout are reserved for protocol frames. Each frame is one UTF-8
  JSON value followed by a newline. Diagnostics go to stderr.

The CLI remains usable without `--stdio`; this mode does not start the TUI.

## Lifecycle

Send `initialize` first:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": 1 }
}
```

The result includes `protocolVersion`, `rookVersion`, `nodeVersion`, a
canonical `workspaceId`, provider configuration status, and capabilities. A
version mismatch returns error `-32010`. Only one initialization is accepted
per process.

Create a session matching the process's pinned mode (`ask` or `build`):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": { "mode": "ask" }
}
```

The result includes `workspaceId`, `sessionId`, and `mode`. An `ask` process
pins read-only tools (`immutableReadOnlyTools`) and rejects `mode: "build"` with
`-32011`. A `build` process pins `buildTools` (`read`, `find`, `ls`, `edit`,
`write`, `bash`, and Rook workspace tools), advertises `buildSessions: true` and
effective `sandbox` status (`{ enabled, runtime, available }`), and rejects
`mode: "ask"` with `-32011`. Mode changes cannot widen a running process.
Arbitrary MCP and executable extension tools are not exposed through this
interface (`arbitraryMcp: false`).

Other session methods:

- `session/list` returns up to 100 persisted sessions, `truncated`, and
  `currentSessionId` (an empty in-memory session may not yet be persisted).
- `session/load` takes a workspace-local `sessionId`; it does not accept a
  filesystem path.
- `session/history` returns the latest 1–200 messages (default 200), plus
  `truncated`.

## Providers, models, and authentication

`initialize` advertises `providerControls`, `modelCatalog`, and
`modelSelection`. It reports effective providers, workspace source/endpoint,
and the active model. Methods are `provider/list`, `provider/login`,
`provider/logout`, `model/list`, and `model/select`. Workspace-defined
providers require a Laplace project-trust decision and a matching
`workspace/allow_provider` endpoint fingerprint before sign-in, model selection,
or prompting. A changed or unreadable `models.json` blocks provider use until
the updated endpoint is reviewed and explicitly approved again.

`provider/login` accepts a client-chosen `loginId`. Rook requests interactive
values with `provider/auth_prompt` (text, secret, manual code, or select); the
client responds to the request ID with `{ "result": { "value": "..." } }`.
The secret is transient protocol input only; it is not emitted as an event.
`provider/auth_event` relays browser/device-code/progress notices. Clients may
cancel with `provider/auth_cancel` and `loginId`. Rook/Pi owns auth persistence.

## Prompts, events, and cancellation

Submit one prompt at a time:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "text": "Explain the request flow",
    "context": "Optional untrusted context"
  }
}
```

`text` is required. Optional context is bounded and explicitly delimited as
untrusted data in the prompt sent to Rook. The response settles after the run;
intermediate `session/update` notifications carry workspace/session/run IDs,
monotonic per-run sequence numbers, timestamps, and the underlying Rook event.
Events include available text deltas, tool activity, usage, and run settlement.
There is no durable event replay after disconnect.

Cancel the active prompt using its `runId`:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/cancel",
  "params": { "runId": "run-1" }
}
```

The cancellation acknowledgement is separate from the eventual prompt
settlement event. Cancellation is not a live pause; a later client may load the
persisted session but must not replay the prompt automatically.

## Permissions

When Rook's policy requires approval for an external read, it sends a
`session/request_permission` JSON-RPC request with a peer-prefixed ID and a
bounded timeout. Reply to that request ID with one of `once`, `session`, or
`deny`:

```json
{ "jsonrpc": "2.0", "id": "rook:permission:1", "result": { "choice": "deny" } }
```

The `session/permission_response` method is also accepted with
`permissionRequestId` and `choice`. Missing, invalid, expired, or disconnected
clients are denied. Permission is enforced again by Rook's tool policy; a
client response is not itself filesystem authorization.

## Limits, errors, and shutdown

- Maximum inbound frame: 1 MiB. Oversized frames are rejected and discarded
  through their newline so later frames can still be processed.
- Maximum prompt: 64,000 characters; optional context: 32,000 characters.
- Maximum history response: 200 messages.
- Only one prompt is active per process. A concurrent prompt or session switch
  during a run is rejected.
- JSON-RPC errors use standard parse/request/method/parameter codes and
  protocol-specific `-320xx` codes. Errors are returned as JSON-RPC objects;
  diagnostics do not go to stdout.
- Send `shutdown` to cancel current work, deny pending permissions, dispose
  the gateway, and exit. stdin EOF also cancels and disposes.

Protocol v1 does not support arbitrary MCP, remote execution, durable event
replay, or automatic prompt replay. On macOS (Seatbelt) and Linux (Bubblewrap),
sandboxed Build shell commands keep the workspace writable with `.git`
write-protected and network disabled; if the OS sandbox is unavailable (such as
Windows), Rook fails closed on shell execution and reports `sandbox.available:
false` in `initialize`.
