import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  inspectWorktreeChanges,
  listWorktrees,
  removeWorktree,
} from "../../src/repo/worktrees.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed isolated checkouts", () => {
  it("creates, lists, and removes a clean independent local clone", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rook-worktree-test-"));
    roots.push(parent);
    const repository = join(parent, "project");
    await mkdir(repository);
    await initializeRepository(repository);

    const worktree = await createWorktree(repository);
    expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe(
      "base\n",
    );
    expect((await listWorktrees(repository)).map(({ path }) => path)).toContain(
      worktree.path,
    );

    await writeFile(join(worktree.path, "README.md"), "worktree change\n");
    expect(await inspectWorktreeChanges(worktree.path)).toContain(
      "worktree change",
    );
    await expect(readFile(join(repository, "README.md"), "utf8")).resolves.toBe(
      "base\n",
    );
    await expect(removeWorktree(repository, worktree.path)).rejects.toThrow(
      "uncommitted changes",
    );
    execFileSync("git", ["checkout", "--", "README.md"], {
      cwd: worktree.path,
    });
    await removeWorktree(repository, worktree.path);
    expect(
      (await listWorktrees(repository)).map(({ path }) => path),
    ).not.toContain(worktree.path);
  });

  it("rejects paths outside the managed worktree directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rook-worktree-bounds-"));
    roots.push(parent);
    const repository = join(parent, "project");
    await mkdir(repository);
    await initializeRepository(repository);

    await expect(
      createWorktree(repository, join(parent, "outside")),
    ).rejects.toThrow("Worktrees must be created under");
    await expect(removeWorktree(repository, parent)).rejects.toThrow(
      "Only Rook-managed worktrees",
    );
  });
});

async function initializeRepository(repository: string): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "rook@example.test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Rook Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.useConfigOnly", "true"], {
    cwd: repository,
  });
  await writeFile(join(repository, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });
}
