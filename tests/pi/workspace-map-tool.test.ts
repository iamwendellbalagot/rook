import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceMapTool } from "../../src/pi/workspace-map-tool.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-workspace-map-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "entry.ts"),
    'import { usefulThing } from "./lib";\nexport function main() { return usefulThing(); }\n',
  );
  await writeFile(
    join(root, "src", "lib.ts"),
    "export function usefulThing() { return 1; }\n",
  );
  await writeFile(
    join(root, "src", "unrelated.ts"),
    "export class OtherThing {}\n",
  );
  await writeFile(join(root, ".env.local"), "export const token = 'secret';");
  return root;
}

async function run(root: string, input: Record<string, unknown> = {}) {
  return createWorkspaceMapTool(root).execute(
    "map",
    input,
    undefined,
    undefined,
    {} as never,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace symbol map", () => {
  it("maps source symbols and resolves extensionless imports within the workspace", async () => {
    const root = await fixture();
    const output = JSON.stringify(await run(root));
    expect(output).toContain("src/lib.ts");
    expect(output).toContain("usefulThing");
    expect(output).toContain("1 internal importers");
    expect(output).not.toContain(".env.local");
    expect(output).not.toContain("secret");
  });

  it("ranks matching symbols and rejects traversal", async () => {
    const root = await fixture();
    const output = JSON.stringify(
      await run(root, { query: "OtherThing", limit: 1 }),
    );
    expect(output).toContain("src/unrelated.ts");
    expect(output).not.toContain("src/entry.ts");
    await expect(run(root, { path: "../" })).rejects.toThrow(
      "within the workspace",
    );
  });
});
