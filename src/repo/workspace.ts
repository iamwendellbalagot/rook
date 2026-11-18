import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readlink,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface RepositoryIdentity {
  id: string;
  logicalId: string;
  kind: "git" | "directory";
  root: string;
  displayName: string;
  remoteFingerprint: string | null;
}

export interface GitSnapshot {
  repoId: string;
  branch: string | null;
  headCommit: string | null;
  dirtyFingerprint: string | null;
  capturedAt: string;
}

export interface RecentCommit {
  subject: string;
  files: string[];
  fileCount: number;
}

export interface WorkspaceContext {
  repository: RepositoryIdentity;
  snapshot: GitSnapshot | null;
}

interface RegistryEntry {
  id: string;
  logicalId: string;
  kind: RepositoryIdentity["kind"];
  identityKey: string;
  commonIdentityKey: string;
  canonicalRoot: string;
  remoteFingerprint: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastSnapshot: GitSnapshot | null;
}

interface Registry {
  version: 1;
  repositories: RegistryEntry[];
}

interface WorkspaceProbe {
  kind: RepositoryIdentity["kind"];
  root: string;
  identityKey: string;
  commonIdentityKey: string;
  remoteFingerprint: string | null;
  snapshot: Omit<GitSnapshot, "repoId"> | null;
}

const LOCK_RETRIES = 200;

export function defaultRepositoryRegistryPath(): string {
  return join(
    resolve(process.env.ROOK_HOME || join(homedir(), ".rook")),
    "repositories.json",
  );
}

export async function resolveWorkspace(
  cwd: string,
  registryPath = defaultRepositoryRegistryPath(),
): Promise<WorkspaceContext> {
  const probe = await probeWorkspace(cwd);
  const entry = await withRegistryLock(registryPath, async (registry) => {
    let current = registry.repositories.find(
      (item) =>
        item.kind === probe.kind && item.identityKey === probe.identityKey,
    );
    const now = new Date().toISOString();

    if (current) {
      current.canonicalRoot = probe.root;
      current.commonIdentityKey = probe.commonIdentityKey;
      current.remoteFingerprint = probe.remoteFingerprint;
      current.lastSeenAt = now;
      current.lastSnapshot = probe.snapshot
        ? { ...probe.snapshot, repoId: current.id }
        : null;
    } else {
      const logical = registry.repositories.find(
        (item) =>
          item.kind === probe.kind &&
          item.commonIdentityKey === probe.commonIdentityKey,
      );
      current = {
        id: randomUUID(),
        logicalId: logical?.logicalId ?? randomUUID(),
        kind: probe.kind,
        identityKey: probe.identityKey,
        commonIdentityKey: probe.commonIdentityKey,
        canonicalRoot: probe.root,
        remoteFingerprint: probe.remoteFingerprint,
        createdAt: now,
        lastSeenAt: now,
        lastSnapshot: null,
      };
      current.lastSnapshot = probe.snapshot
        ? { ...probe.snapshot, repoId: current.id }
        : null;
      registry.repositories.push(current);
    }
    return { ...current };
  });

  return {
    repository: {
      id: entry.id,
      logicalId: entry.logicalId,
      kind: entry.kind,
      root: entry.canonicalRoot,
      displayName: basename(entry.canonicalRoot) || entry.canonicalRoot,
      remoteFingerprint: entry.remoteFingerprint,
    },
    snapshot: entry.lastSnapshot,
  };
}

async function probeWorkspace(cwd: string): Promise<WorkspaceProbe> {
  const absoluteCwd = await realpath(resolve(cwd));
  let gitRoot: string;
  try {
    gitRoot = git(absoluteCwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return {
      kind: "directory",
      root: absoluteCwd,
      identityKey: `directory:${absoluteCwd}`,
      commonIdentityKey: `directory:${absoluteCwd}`,
      remoteFingerprint: null,
      snapshot: null,
    };
  }

  const root = await realpath(resolve(absoluteCwd, gitRoot));
  const gitDir = await realpath(
    git(absoluteCwd, ["rev-parse", "--absolute-git-dir"]).trim(),
  );
  const commonDirOutput = git(absoluteCwd, [
    "rev-parse",
    "--git-common-dir",
  ]).trim();
  const commonDir = await realpath(
    isAbsolute(commonDirOutput)
      ? commonDirOutput
      : resolve(absoluteCwd, commonDirOutput),
  );
  const [gitKey, commonKey, remoteFingerprint, snapshot] = await Promise.all([
    filesystemIdentity(gitDir),
    filesystemIdentity(commonDir),
    readRemoteFingerprint(root),
    captureGitSnapshot(root),
  ]);

  return {
    kind: "git",
    root,
    identityKey: `git:${gitKey}`,
    commonIdentityKey: `git-common:${commonKey}`,
    remoteFingerprint,
    snapshot,
  };
}

async function filesystemIdentity(path: string): Promise<string> {
  const info = await stat(path);
  return info.ino > 0 ? `${info.dev}:${info.ino}` : `path:${path}`;
}

async function readRemoteFingerprint(root: string): Promise<string | null> {
  const names = git(root, ["remote"]).split(/\r?\n/).filter(Boolean);
  const remotes: string[] = [];
  for (const name of names) {
    try {
      const urls = git(root, ["config", "--get-all", `remote.${name}.url`])
        .split(/\r?\n/)
        .filter(Boolean)
        .map(normalizeRemoteUrl);
      remotes.push(...urls);
    } catch {
      // A remote without a URL contributes no identity metadata.
    }
  }
  if (remotes.length === 0) return null;
  return createHash("sha256")
    .update([...new Set(remotes)].sort().join("\n"))
    .digest("hex");
}

export function normalizeRemoteUrl(remote: string): string {
  const value = remote.trim();
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      return pathToFileURL(resolve(value)).toString().replace(/\/$/, "");
    }
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (scp) {
      const host = scp[1]!.toLowerCase();
      const path = scp[2]!.replace(/\/+$/, "").replace(/\.git$/i, "");
      return `ssh://${host}/${path}`;
    }
    return pathToFileURL(resolve(value)).toString().replace(/\/$/, "");
  }
}

async function captureGitSnapshot(
  root: string,
): Promise<Omit<GitSnapshot, "repoId">> {
  let branch: string | null = null;
  try {
    branch =
      git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || null;
  } catch {
    // Detached HEAD is represented by a null branch.
  }
  let headCommit: string | null = null;
  try {
    headCommit = git(root, ["rev-parse", "--verify", "HEAD"]).trim() || null;
  } catch {
    // An unborn repository has no HEAD commit yet.
  }

  const status = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  let dirtyFingerprint: string | null = null;
  if (status.length > 0) {
    const hash = createHash("sha256");
    hash.update(status);
    const changedPaths = headCommit
      ? git(root, ["diff", "--name-only", "-z", "HEAD", "--"])
      : [
          git(root, ["diff", "--name-only", "-z", "--cached", "--"]),
          git(root, ["diff", "--name-only", "-z", "--"]),
        ].join("\0");
    for (const path of new Set(changedPaths.split("\0").filter(Boolean))) {
      hash.update(path);
      hash.update(git(root, ["ls-files", "--stage", "-z", "--", path]));
      await hashWorkingPath(hash, root, path);
    }
    for (const entry of status.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const path = entry.slice(3);
      hash.update(`untracked:${path}`);
      await hashWorkingPath(hash, root, path);
    }
    dirtyFingerprint = hash.digest("hex");
  }

  return {
    branch,
    headCommit,
    dirtyFingerprint,
    capturedAt: new Date().toISOString(),
  };
}

export async function captureWorkspaceSnapshot(
  repository: RepositoryIdentity,
): Promise<GitSnapshot | null> {
  if (repository.kind !== "git") return null;
  return {
    ...(await captureGitSnapshot(repository.root)),
    repoId: repository.id,
  };
}

export function captureRecentCommits(root: string): RecentCommit[] {
  let commits: string[];
  try {
    commits = git(root, ["log", "-5", "--format=%H%x1f%s"])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  return commits.map((entry) => {
    const [hash, subject] = entry.split("\x1f", 2);
    if (!hash || !subject) return { subject: entry, files: [], fileCount: 0 };
    let files: string[] = [];
    try {
      files = git(root, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        hash,
      ])
        .split("\0")
        .filter(Boolean)
        .filter(isSafeCommitPath);
    } catch {
      // Keep the commit visible if Git cannot list its changed paths.
    }
    return { subject, files, fileCount: files.length };
  });
}

function isSafeCommitPath(path: string): boolean {
  const sensitiveSegments = new Set([
    ".aws",
    ".azure",
    ".config",
    ".gnupg",
    ".pi",
    ".ssh",
    "credentials",
    "node_modules",
  ]);
  return (
    !path
      .split("/")
      .some(
        (segment) =>
          sensitiveSegments.has(segment.toLowerCase()) ||
          /^\.env(?:\.|$)/i.test(segment),
      ) && !/\.(?:pem|key|p12|pfx)$/i.test(path)
  );
}

async function hashWorkingPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
): Promise<void> {
  try {
    const absolutePath = resolve(root, path);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      hash.update(`symlink:${await readlink(absolutePath)}`);
    } else if (info.isFile()) {
      hash.update(git(root, ["hash-object", "--", path]).trim());
    } else {
      hash.update(`mode:${info.mode}:size:${info.size}`);
    }
  } catch {
    hash.update("missing-or-unreadable");
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function withRegistryLock<T>(
  registryPath: string,
  update: (registry: Registry) => T,
): Promise<T> {
  const directory = dirname(registryPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${registryPath}.lock`;
  let lock;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(`${process.pid}\n`);
      } catch (error) {
        await candidate.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      lock = candidate;
      break;
    } catch (error) {
      if (!isAlreadyExists(error) || attempt >= LOCK_RETRIES) throw error;
      await removeStaleLock(lockPath);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  try {
    const registry = await readRegistry(registryPath);
    const result = update(registry);
    await writeRegistry(registryPath, registry);
    return result;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function readRegistry(path: string): Promise<Registry> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Rook repository registry must be a regular file.");
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("repositories" in parsed) ||
      !Array.isArray(parsed.repositories)
    ) {
      throw new Error("Rook repository registry has an unsupported format.");
    }
    return parsed as Registry;
  } catch (error) {
    if (isMissing(error)) return { version: 1, repositories: [] };
    throw error;
  }
}

async function writeRegistry(path: string, registry: Registry): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function removeStaleLock(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < 60_000) return;
    const pid = Number((await readFile(path, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if (!isProcessGone(error)) return;
      }
    }
    await rm(path, { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isProcessGone(error: unknown): boolean {
  return hasErrorCode(error, "ESRCH");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
