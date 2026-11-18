import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRecentCommits,
  normalizeRemoteUrl,
  resolveWorkspace,
} from "../../src/repo/workspace.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-repo-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function initRepository(path: string, remote?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Rook Test");
  git(path, "config", "user.email", "rook@example.test");
  await writeFile(join(path, "README.md"), "initial\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
  if (remote) git(path, "remote", "add", "origin", remote);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace identity and Git snapshots", () => {
  it("lists recent commit subjects with their changed files", async () => {
    const root = await temporaryRoot();
    await initRepository(root);
    await writeFile(join(root, "src.ts"), "first\n");
    await writeFile(join(root, ".env.local"), "test-only-placeholder\n");
    git(root, "add", "src.ts");
    git(root, "add", ".env.local");
    git(root, "commit", "-m", "add source");

    expect(captureRecentCommits(root)).toEqual([
      { subject: "add source", files: ["src.ts"], fileCount: 1 },
      { subject: "initial", files: ["README.md"], fileCount: 1 },
    ]);
    expect(
      captureRecentCommits(root).flatMap((commit) => commit.files),
    ).not.toContain(".env.local");
    expect(captureRecentCommits(tmpdir())).toEqual([]);
  });

  it("keeps identity through a local rename and separates same-remote clones", async () => {
    const root = await temporaryRoot();
    const first = join(root, "clone-a", "same-name");
    const renamed = join(root, "renamed", "same-name");
    const second = join(root, "clone-b", "same-name");
    const registryPath = join(root, "rook", "repositories.json");
    const remote =
      "https://alice:supersecret@example.test/team/project.git?token=secret";
    await initRepository(first, remote);
    await initRepository(second, remote);

    const initial = await resolveWorkspace(first, registryPath);
    expect(initial.repository.kind).toBe("git");
    expect(initial.snapshot).toMatchObject({
      branch: "main",
      dirtyFingerprint: null,
    });
    await mkdir(join(root, "renamed"));
    await rename(first, renamed);
    const moved = await resolveWorkspace(renamed, registryPath);
    const clone = await resolveWorkspace(second, registryPath);

    expect(moved.repository.id).toBe(initial.repository.id);
    expect(moved.repository.root).toBe(await realpath(renamed));
    expect(clone.repository.id).not.toBe(initial.repository.id);
    expect(clone.repository.logicalId).not.toBe(initial.repository.logicalId);
    expect(moved.repository.remoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const registry = await readFile(registryPath, "utf8");
    expect(registry).not.toContain("supersecret");
    expect(registry).not.toContain("token=secret");
  });

  it("distinguishes worktrees while giving them a common logical identity", async () => {
    const root = await temporaryRoot();
    const repositoryPath = join(root, "repo");
    const worktreePath = join(root, "worktree");
    const registryPath = join(root, "rook", "repositories.json");
    await initRepository(repositoryPath);
    const main = await resolveWorkspace(repositoryPath, registryPath);
    git(repositoryPath, "worktree", "add", "-b", "feature", worktreePath);

    const worktree = await resolveWorkspace(worktreePath, registryPath);
    expect(worktree.repository.id).not.toBe(main.repository.id);
    expect(worktree.repository.logicalId).toBe(main.repository.logicalId);
    expect(worktree.snapshot?.branch).toBe("feature");
  });

  it("fingerprints tracked and untracked working-tree changes", async () => {
    const root = await temporaryRoot();
    const repositoryPath = join(root, "repo");
    const registryPath = join(root, "rook", "repositories.json");
    await initRepository(repositoryPath);

    const clean = await resolveWorkspace(repositoryPath, registryPath);
    await writeFile(join(repositoryPath, "README.md"), "tracked change\n");
    const tracked = await resolveWorkspace(repositoryPath, registryPath);
    await writeFile(
      join(repositoryPath, "README.md"),
      "different tracked change\n",
    );
    const changedTracked = await resolveWorkspace(repositoryPath, registryPath);
    await writeFile(join(repositoryPath, "README.md"), "initial\n");
    await writeFile(join(repositoryPath, "scratch.txt"), "first\n");
    const untracked = await resolveWorkspace(repositoryPath, registryPath);
    await writeFile(join(repositoryPath, "scratch.txt"), "second\n");
    const changedUntracked = await resolveWorkspace(
      repositoryPath,
      registryPath,
    );

    expect(clean.snapshot?.dirtyFingerprint).toBeNull();
    expect(tracked.snapshot?.dirtyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changedTracked.snapshot?.dirtyFingerprint).not.toBe(
      tracked.snapshot?.dirtyFingerprint,
    );
    expect(untracked.snapshot?.dirtyFingerprint).not.toBe(
      tracked.snapshot?.dirtyFingerprint,
    );
    expect(changedUntracked.snapshot?.dirtyFingerprint).not.toBe(
      untracked.snapshot?.dirtyFingerprint,
    );
  });

  it("normalizes remote URLs without retaining credentials", () => {
    expect(
      normalizeRemoteUrl(
        "https://alice:password@example.test/team/project.git?token=secret",
      ),
    ).toBe("https://example.test/team/project");
    expect(normalizeRemoteUrl("git@example.test:team/project.git")).toBe(
      "ssh://example.test/team/project",
    );
  });

  it("assigns stable path identities to non-Git workspaces", async () => {
    const root = await temporaryRoot();
    const first = join(root, "project-a", "same-name");
    const second = join(root, "project-b", "same-name");
    const registryPath = join(root, "rook", "repositories.json");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const firstIdentity = await resolveWorkspace(first, registryPath);
    const repeated = await resolveWorkspace(first, registryPath);
    const other = await resolveWorkspace(second, registryPath);

    expect(firstIdentity.repository.kind).toBe("directory");
    expect(firstIdentity.snapshot).toBeNull();
    expect(repeated.repository.id).toBe(firstIdentity.repository.id);
    expect(other.repository.id).not.toBe(firstIdentity.repository.id);
  });
});
