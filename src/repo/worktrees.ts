import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface ManagedWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  baseCommit?: string;
}

export async function createWorktree(
  repositoryPath: string,
  requestedPath?: string,
): Promise<ManagedWorktree> {
  const repository = await realpath(resolve(repositoryPath));
  const root = git(repository, ["rev-parse", "--show-toplevel"]).trim();
  const managedRoot = join(dirname(root), ".rook-worktrees");
  const worktreePath = resolve(
    requestedPath ?? join(managedRoot, `${basename(root)}-${randomUUID()}`),
  );
  if (dirname(worktreePath) !== managedRoot) {
    throw new Error(`Worktrees must be created under ${managedRoot}.`);
  }
  await mkdir(managedRoot, { recursive: true });
  const managedInfo = await lstat(managedRoot);
  if (!managedInfo.isDirectory() || managedInfo.isSymbolicLink()) {
    throw new Error("The managed worktree directory must be a real directory.");
  }
  if ((await realpath(managedRoot)) !== managedRoot) {
    throw new Error(
      "The managed worktree directory cannot resolve through a symlink.",
    );
  }
  try {
    await lstat(worktreePath);
    throw new Error(`Worktree destination already exists: ${worktreePath}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Worktree destination")
    )
      throw error;
    if (!isMissing(error)) throw error;
  }
  let created = false;
  try {
    await mkdir(worktreePath);
    created = true;
    git(worktreePath, ["init", "--template="]);
    const snapshot = git(root, ["rev-parse", "HEAD"]).trim();
    git(worktreePath, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      root,
      snapshot,
    ]);
    const fetchedSnapshot = git(worktreePath, [
      "rev-parse",
      "FETCH_HEAD",
    ]).trim();
    git(worktreePath, ["checkout", "--detach", fetchedSnapshot]);
    const marker = {
      format: 1,
      sourceRepository: root,
      baseCommit: fetchedSnapshot,
      id: randomUUID(),
    };
    await mkdir(join(worktreePath, ".git", "info"), { recursive: true });
    await writeFile(
      join(worktreePath, ".git", "info", "exclude"),
      "\n.rook-worktree.json\n",
      { flag: "a" },
    );
    await writeFile(
      join(worktreePath, ".rook-worktree.json"),
      `${JSON.stringify(marker)}\n`,
      { flag: "w", mode: 0o600 },
    );
    return {
      path: await realpath(worktreePath),
      branch: null,
      head: fetchedSnapshot,
    };
  } catch (error) {
    if (created) await rm(worktreePath, { recursive: true, force: true });
    throw new Error(
      `Could not create isolated worktree: ${errorMessage(error)}`,
    );
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function listWorktrees(
  repositoryPath: string,
): Promise<ManagedWorktree[]> {
  const root = await gitRoot(repositoryPath);
  const managedRoot = join(dirname(root), ".rook-worktrees");
  let names: string[];
  try {
    const info = await lstat(managedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    names = await readdir(managedRoot);
  } catch {
    return [];
  }
  const result: ManagedWorktree[] = [];
  for (const name of names) {
    const path = join(managedRoot, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const markerInfo = await lstat(join(path, ".rook-worktree.json"));
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) continue;
      const marker = JSON.parse(
        await readFile(join(path, ".rook-worktree.json"), "utf8"),
      ) as {
        format?: unknown;
        sourceRepository?: unknown;
        baseCommit?: unknown;
      };
      if (marker.format !== 1 || marker.sourceRepository !== root) continue;
      const canonical = await realpath(path);
      if (dirname(canonical) !== managedRoot) continue;
      result.push({
        path: canonical,
        branch: git(canonical, ["branch", "--show-current"]).trim() || null,
        head: git(canonical, ["rev-parse", "HEAD"]).trim(),
        ...(typeof marker.baseCommit === "string"
          ? { baseCommit: marker.baseCommit }
          : {}),
      });
    } catch {
      // Ignore unrelated folders and incomplete checkouts.
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  const root = await gitRoot(repositoryPath);
  const target = await realpath(resolve(worktreePath));
  const managedRoot = join(dirname(root), ".rook-worktrees");
  if (!isWithin(managedRoot, target)) {
    throw new Error(
      `Only Rook-managed worktrees under ${managedRoot} can be removed.`,
    );
  }
  const worktrees = await listWorktrees(root);
  if (!worktrees.some((worktree) => worktree.path === target)) {
    throw new Error("The requested path is not a registered Git worktree.");
  }
  if (target === root)
    throw new Error("The primary repository worktree cannot be removed.");
  const marker = JSON.parse(
    await readFile(join(target, ".rook-worktree.json"), "utf8"),
  ) as { id?: unknown };
  if (typeof marker.id !== "string") {
    throw new Error(
      "The managed worktree marker is invalid; refusing removal.",
    );
  }
  const status = git(target, ["status", "--porcelain"]);
  if (status)
    throw new Error(
      "The isolated checkout has uncommitted changes and will not be removed.",
    );
  const ignoredFiles = git(target, ["clean", "-ndx"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Would remove "))
    .map((line) => line.slice("Would remove ".length))
    .filter((path) => path !== ".rook-worktree.json");
  if (ignoredFiles.length) {
    throw new Error(
      "The isolated checkout contains ignored files and will not be removed.",
    );
  }
  await rm(target, { recursive: true });
  const parent = dirname(target);
  if (parent === managedRoot) {
    const remaining = await readdir(parent).catch(() => []);
    if (!remaining.length) await rm(parent, { recursive: true, force: true });
  }
}

export async function inspectWorktreeChanges(
  worktreePath: string,
): Promise<string> {
  const target = await realpath(resolve(worktreePath));
  const marker = JSON.parse(
    await readFile(join(target, ".rook-worktree.json"), "utf8"),
  ) as { baseCommit?: unknown; sourceRepository?: unknown };
  if (
    typeof marker.baseCommit !== "string" ||
    typeof marker.sourceRepository !== "string"
  ) {
    throw new Error("The worktree does not contain a valid Rook marker.");
  }
  const status = git(target, ["status", "--short", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean);
  const diff = git(target, ["diff", "--binary", marker.baseCommit, "--"]);
  return [
    `Rook worktree changes since ${marker.baseCommit}`,
    status.length
      ? `Changed paths:\n${status.join("\n")}`
      : "No working-tree changes.",
    diff || "No tracked diff.",
  ].join("\n\n");
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function gitRoot(repositoryPath: string): Promise<string> {
  const path = await realpath(resolve(repositoryPath));
  return git(path, ["rev-parse", "--show-toplevel"]).trim();
}

function git(cwd: string, args: string[]): string {
  const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return execFileSync("git", [`-c`, `core.hooksPath=${nullPath}`, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullPath,
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
