import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileChangeRecovery } from "../../src/policy/file-change-recovery.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-file-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Rook file change recovery", () => {
  it("persists session-scoped recovery and rechecks edit authorization after restart", async () => {
    const root = await workspace();
    vi.stubEnv("ROOK_HOME", join(root, "private-state"));
    const path = join(root, "file.txt");
    await writeFile(path, "before\n");
    const original = new FileChangeRecovery(root);
    await original.bindSession("session");
    await original.begin("edit", "edit", { path: "file.txt" });
    await writeFile(path, "after\n");
    await original.finish("edit", false);
    const restored = new FileChangeRecovery(root);
    await restored.bindSession("session");
    expect(restored.preview()).toContain("file.txt");
    expect(await restored.undo(async () => false)).toContain("blocked");
    expect(await readFile(path, "utf8")).toBe("after\n");
    expect(await restored.undo(async () => true)).toContain("Restored");
    expect(await readFile(path, "utf8")).toBe("before\n");
  });
  it("restores a verified Rook edit after explicit confirmation", async () => {
    const root = await workspace();
    const path = join(root, "file.txt");
    await writeFile(path, "before\n");
    const recovery = new FileChangeRecovery(root);

    await recovery.begin("edit-1", "edit", { path: "file.txt" });
    await writeFile(path, "after\n");
    await recovery.finish("edit-1", false);

    expect(recovery.preview()).toContain("file.txt");
    expect(await recovery.undo()).toContain("Restored");
    expect(await readFile(path, "utf8")).toBe("before\n");
  });

  it("refuses to overwrite a file changed after Rook's edit", async () => {
    const root = await workspace();
    const path = join(root, "file.txt");
    await writeFile(path, "before\n");
    const recovery = new FileChangeRecovery(root);

    await recovery.begin("edit-1", "edit", { path: "file.txt" });
    await writeFile(path, "rook edit\n");
    await recovery.finish("edit-1", false);
    await writeFile(path, "later user edit\n");

    expect(await recovery.undo()).toContain("file changed");
    expect(await readFile(path, "utf8")).toBe("later user edit\n");
  });

  it("removes a Rook-created file and ignores sensitive paths", async () => {
    const root = await workspace();
    const recovery = new FileChangeRecovery(root);
    await recovery.begin("new-file", "write", { path: "new.txt" });
    await writeFile(join(root, "new.txt"), "created\n");
    await recovery.finish("new-file", false);
    expect(await recovery.undo()).toContain("Restored");

    await recovery.begin("secret", "write", { path: ".env.local" });
    await writeFile(join(root, ".env.local"), "secret\n");
    await recovery.finish("secret", false);
    expect(recovery.preview()).toContain("No reversible");
  });

  it("does not record failed or unchanged operations", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "same\n");
    const recovery = new FileChangeRecovery(root);

    await recovery.begin("failed", "edit", { path: "file.txt" });
    await writeFile(join(root, "file.txt"), "changed\n");
    await recovery.finish("failed", true);
    expect(recovery.preview()).toContain("No reversible");

    await recovery.begin("unchanged", "edit", { path: "file.txt" });
    await recovery.finish("unchanged", false);
    expect(recovery.preview()).toContain("No reversible");
  });
});
