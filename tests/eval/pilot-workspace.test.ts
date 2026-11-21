import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoInheritedInstructions } from "../../src/eval/pilot-workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("isolated pilot workspace preflight", () => {
  it("rejects host instructions inherited from an ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-pilot-instructions-"));
    roots.push(root);
    const workspace = join(root, "runs", "cell");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "host instructions");

    await expect(assertNoInheritedInstructions(workspace)).rejects.toThrow(
      "Synthetic workspace inherits host instructions",
    );
  });

  it("rejects instructions copied into the fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-pilot-fixture-"));
    roots.push(root);
    const workspace = join(root, "cell");
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(
      join(workspace, "nested", "AGENTS.md"),
      "fixture instructions",
    );

    await expect(assertNoInheritedInstructions(workspace)).rejects.toThrow(
      "Synthetic fixture contains inherited instructions",
    );
  });

  it("accepts an instruction-free temporary workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-pilot-clean-"));
    roots.push(root);
    const workspace = join(root, "cell");
    await mkdir(workspace);

    await expect(
      assertNoInheritedInstructions(workspace),
    ).resolves.toBeUndefined();
  });
});
