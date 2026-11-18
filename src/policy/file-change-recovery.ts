import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const MAX_RECOVERY_BYTES = 1024 * 1024;

interface FileSnapshot {
  path: string;
  before: Buffer | null;
  beforeMode?: number;
}

interface ReversibleChange extends FileSnapshot {
  afterHash: string;
}

export class FileChangeRecovery {
  private readonly pending = new Map<string, FileSnapshot>();
  private latest: ReversibleChange | undefined;

  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = realpathSync(workspace);
  }

  async begin(id: string, toolName: string, input: unknown): Promise<void> {
    if (toolName !== "edit" && toolName !== "write") return;
    this.latest = undefined;
    if (!input || typeof input !== "object") return;
    const path = (input as { path?: unknown }).path;
    if (typeof path !== "string") return;
    const target = resolve(this.workspace, path);
    if (!isWithin(this.workspace, target) || isSensitivePath(target)) return;
    try {
      await realpathDirectory(target, this.workspace);
      let before: Buffer | null = null;
      let beforeMode: number | undefined;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
        if (info.size > MAX_RECOVERY_BYTES) return;
        before = await readFile(target);
        beforeMode = info.mode;
      } catch (error) {
        if (!isMissing(error)) return;
      }
      this.pending.set(id, {
        path: relative(this.workspace, target),
        before,
        ...(beforeMode === undefined ? {} : { beforeMode }),
      });
    } catch {
      // Recovery is best-effort and never changes tool authorization.
    }
  }

  async finish(id: string, isError: boolean): Promise<void> {
    const snapshot = this.pending.get(id);
    this.pending.delete(id);
    if (!snapshot || isError) return;
    const target = resolve(this.workspace, snapshot.path);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
      if (info.size > MAX_RECOVERY_BYTES) return;
      const after = await readFile(target);
      if (snapshot.before?.equals(after)) return;
      this.latest = { ...snapshot, afterHash: hash(after) };
    } catch {
      // If the tool deleted or moved a file, there is no safe recovery record.
    }
  }

  preview(): string {
    return this.latest
      ? `Rook can restore its last file edit: ${this.latest.path}. Use /undo confirm to apply it, provided the file has not changed since.`
      : "No reversible Rook file edit is available in this session.";
  }

  async undo(): Promise<string> {
    const change = this.latest;
    if (!change) return this.preview();
    const target = resolve(this.workspace, change.path);
    try {
      await realpathDirectory(target, this.workspace);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        return "Recovery stopped: the target is no longer a regular, unlinked file.";
      }
      if (info.size > MAX_RECOVERY_BYTES) {
        return "Recovery stopped: the target is larger than the recovery limit.";
      }
      const current = await readFile(target);
      if (hash(current) !== change.afterHash) {
        return "Recovery stopped: the file changed after Rook's edit. Review it manually; no content was changed.";
      }
      if (change.before === null) {
        await rm(target);
      } else {
        await writeFile(target, change.before, { mode: change.beforeMode });
      }
      this.latest = undefined;
      return `Restored Rook's last edit to ${change.path}.`;
    } catch {
      return "Recovery failed safely; the file could not be verified or restored.";
    }
  }
}

async function realpathDirectory(
  target: string,
  workspace: string,
): Promise<void> {
  const parent = await realpath(resolve(target, ".."));
  if (!isWithin(workspace, parent)) throw new Error("Outside workspace");
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("Symlink target");
    if (!isWithin(workspace, await realpath(target)))
      throw new Error("Outside workspace");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower === ".git" ||
      lower === "node_modules" ||
      lower === ".ssh" ||
      lower === ".aws" ||
      lower === ".azure" ||
      lower === ".gnupg" ||
      lower === ".config" ||
      lower === ".pi" ||
      lower === "credentials" ||
      lower.startsWith(".env") ||
      /\.(?:pem|key|p12|pfx)$/i.test(lower)
    );
  });
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
