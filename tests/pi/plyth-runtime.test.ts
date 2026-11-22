import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlythRuntime } from "../../src/pi/plyth-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("optional workspace PLYTH runtime", () => {
  it("returns unavailable when the workspace has no PLYTH package", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-no-plyth-module-"));
    roots.push(root);
    await expect(
      loadPlythRuntime(root, { globalNodeModulesRoot: null }),
    ).resolves.toBeUndefined();
  });

  it("loads PLYTH from the workspace even though it is a peer of Rook", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-workspace-plyth-"));
    roots.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      join(process.cwd(), "node_modules", "plyth-core"),
      join(root, "node_modules", "plyth-core"),
      "dir",
    );

    const runtime = await loadPlythRuntime(root, {
      globalNodeModulesRoot: null,
    });
    expect(runtime?.IntegratedPlythFlow).toBeTypeOf("function");
    expect(runtime?.SessionCounter).toBeTypeOf("function");
  });

  it("falls back to global PLYTH in a workspace without Node metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-global-plyth-workspace-"));
    roots.push(root);
    const globalNodeModules = join(root, "global", "node_modules");
    await mkdir(globalNodeModules, { recursive: true });
    await symlink(
      join(process.cwd(), "node_modules", "plyth-core"),
      join(globalNodeModules, "plyth-core"),
      "dir",
    );

    const runtime = await loadPlythRuntime(root, {
      globalNodeModulesRoot: globalNodeModules,
    });
    expect(runtime?.IntegratedPlythFlow).toBeTypeOf("function");
    expect(runtime?.SessionCounter).toBeTypeOf("function");
  });
});
