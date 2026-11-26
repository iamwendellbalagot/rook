# Tool permissions and policies

Rook uses OpenCode-inspired semantics, not an identical configuration format. **Shell commands execute on the host with the user's filesystem, process, environment, and network authority.** Permissions decide whether execution starts; they do not confine scripts, MCP servers, or children. Use an external VM/container if isolation is required.

## Configuration

Configuration loads at gateway creation, in order:

1. Project `.rook/permissions.json`.
2. `$ROOK_HOME/permissions.json` (default `~/.rook/permissions.json`).
3. System: `/etc/rook/permissions.json` on Linux, `/Library/Application Support/rook/permissions.json` on macOS, `%ProgramData%/rook/permissions.json` on Windows.

Restart after edits. Malformed rules fail closed. `.rook/policy.json` remains workflow guidance; its obsolete `sandbox_shell` setting no longer changes execution.

```json
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "deny" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
  ],
  "policies": [
    { "action": "tool.use", "resource": "shell:sudo *", "effect": "deny" }
  ]
}
```

Permissions use whole-value `*`/`?` wildcards, not regexes. Last matching permission wins. A shell pattern ending in ` *` also matches without arguments. Paths use `/`; internal paths are workspace-relative, external paths canonical absolute. Use absolute external patterns; home-variable expansion is not implemented.

Defaults allow workspace read/edit, glob/search, bounded inspection, checklist/task metadata and existing-job management. Shell, external-directory access, subagent invocation, MCP and unknown tools ask. `.env`-like reads ask, except `.env.example`. Plan always blocks edits, shell/job execution, MCP and unknown-effect tools even if allowed in configuration. This is stricter than OpenCode's Plan defaults.

Actions include `read`, `edit`, `glob`, `grep`, `shell`, `external_directory`, `subagent`, exact MCP names (`mcp__server__tool`), and exact Rook tool names. All checked resources must pass: any deny blocks; otherwise any ask prompts. OpenCode's provider/organization policy actions are not implemented.

Policies evaluate independently in project → user → system order. Last matching policy wins, so broader authority can override narrower authority. Policy `allow` only lifts a policy denial; ordinary permissions still apply. Configured permission denials and final policy denials override saved approvals.

## Approvals

Prompts show exact permission resources: allow once, allow for this session, remember for this project, or deny. Saved approvals are exact matches under private `$ROOK_HOME/approvals/<canonical-workspace-hash>.json`; they never silently broaden to command prefixes. `/permissions` lists decisions/session/saved approvals; `/permissions revoke ID` removes a grant. Revoking a session grant conservatively clears all session grants. Saved approvals are not copied between projects. Concurrent-process merge/locking remains pending.

Agent file tools cannot modify permission configuration or Rook's user-owned state. **An approved host command can still modify these files:** this is not OS enforcement.

## Shell inspection

Rook checks the full command and extracted, quote-normalized commands. It infers external access from recognizable absolute, home-relative and parent-relative operands. This is a conservative POSIX subset, not a complete shell parser. Dynamic expansion, redirects, control flow, directory changes and unsupported wrappers require unsaveable one-time approval. If shell denials exist and inspection is incomplete, execution is denied.

Inference cannot constrain arbitrary programs or script contents. Allowing `npm test` allows the repository's script with host authority. Denying `read` on a path does not prevent an approved shell command reading it. Review scripts before approval. Windows host execution is unverified.

Search filters contents through read permissions without prompting; omitted files produce partial-coverage reporting. Aggregate Git/map/navigation tools conservatively disable themselves when custom scoped read restrictions exist. Shell/MCP are separately authorized capabilities, not constrained filesystem readers.

## Migration

Previous sandbox availability, routine-command auto-allows, `sandbox_shell` settings and prose such as “use MCP” do not grant host execution. In-memory sandbox grants are not imported. Build reports host execution; the legacy protocol `sandbox` field remains `{ "enabled": false, "runtime": null, "available": true }` for compatibility.
