import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/** Bounded local-file revision, never persisted. Unknown/linked/oversize inputs
 * make history unavailable, rather than treating missing evidence as unchanged.
 * Dependencies, .git and Rook runtime state are outside this workspace-only baseline.
 */
export function plythWorkspaceRevision(cwd: string): string | undefined {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW <= 0)
    return undefined;
  const hash = createHash("sha256");
  const started = performance.now();
  let files = 0;
  let bytes = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > 12 || performance.now() - started > 50)
      throw new Error("snapshot_budget");
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    if (entries.length > 512) throw new Error("snapshot_budget");
    for (const entry of entries) {
      if ([".git", ".rook", "node_modules"].includes(entry.name)) continue;
      if (performance.now() - started > 50) throw new Error("snapshot_budget");
      if (
        entry.name.startsWith(".") &&
        ![".gitignore", ".gitattributes", ".editorconfig"].includes(entry.name)
      )
        throw new Error("unknown_hidden_input");
      if (
        /(?:\.pem|\.key|\.p12|\.pfx|\.sqlite(?:-wal|-shm)?)$|^(?:id_rsa|id_ed25519)$|credentials|secrets/i.test(
          entry.name,
        )
      )
        throw new Error("sensitive_input");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("linked_input");
      hash.update(JSON.stringify([depth, entry.name, entry.isDirectory()]));
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || ++files > 256) throw new Error("snapshot_budget");
      const before = lstatSync(path);
      bytes += before.size;
      if (bytes > 2 * 1024 * 1024) throw new Error("snapshot_budget");
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs
        )
          throw new Error("changing_input");
        const buffer = Buffer.alloc(stat.size + 1);
        const count = readSync(fd, buffer, 0, buffer.length, 0);
        if (count !== stat.size) throw new Error("changing_input");
        hash.update(
          createHash("sha256").update(buffer.subarray(0, count)).digest(),
        );
        const after = fstatSync(fd);
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error("changing_input");
      } finally {
        closeSync(fd);
      }
    }
  };
  try {
    const root = lstatSync(cwd);
    if (!root.isDirectory() || root.isSymbolicLink()) return undefined;
    walk(cwd, 0);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
