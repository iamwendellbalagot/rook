# Agent Instructions

1. Commit all completed work before finishing.
2. Be aggressive in development. Add and run only necessary tests, focused on the specific files and features being changed.
3. Maintain a root-level `status.md` for work handoffs. Record the current state, completed work, and pending tasks, and update it before handing off. Do not implement `plan.md` until explicitly asked.

## Persisted Rook Sandbox Roadmap

When continuing sandbox work, follow this user-approved direction. Adapt Codex's OS-level sandbox ideas; do not copy its agent or Rust application wholesale.

- Keep sandbox enforcement separate from command approvals. The sandbox defines technical limits; approval decides whether a command may run.
- Preserve fail-closed behavior: if the sandbox is unavailable or a policy cannot be enforced, do not run the command on the host implicitly.
- Add a native macOS Seatbelt backend and harden Linux Bubblewrap. Keep the project writable, but restrict reads as well as writes outside approved roots; deny network and privileged socket access by default; protect sandbox policy and Git metadata boundaries.
- Fix process lifecycle guarantees so cancellation, timeout, and output limits terminate and reap command descendants.
- Add narrow, explicit user-approved external-folder grants, read-only by default and separately confirmable for writes. Do not let repository content or model-written settings grant access to themselves.
- Keep the existing explicit unsandboxed host opt-out clearly labeled. Defer network proxies and Windows support until separately designed and verified.
- Validate enforcement on real macOS and Linux hosts: workspace operations work; outside paths, secrets, network, sockets, symlink/rename escapes, and policy tampering are blocked; missing runtimes fail closed; child processes are cleaned up.
- Codex reference reviewed at `cf3ff1530d821ec2d26452da4971d8e3e7d18d25` under `codex-rs/sandboxing/src`. Preserve Apache-2.0 attribution and notices for any adapted code.

This is a design direction, not authorization to publish or to weaken the current sandbox before the replacement is verified.
