import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorkspaceSearchTool } from "../../src/pi/workspace-search-tool.js";
it("supports regex, glob and case options, honors ignores and filters unauthorized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-search-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/noise.ts"), "Alpha123");
    await writeFile(join(root, "src/main.ts"), "Alpha123\nalphaXYZ\n");
    await writeFile(join(root, "src/private.ts"), "AlphaSECRET\n");
    const tool = createWorkspaceSearchTool(
      root,
      async (path) => !path.includes("private"),
    );
    const result = await tool.execute(
      "search",
      { query: "Alpha[0-9]+", regex: true, glob: "*.ts" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("src/main.ts:1:"),
    });
    expect(JSON.stringify(result.content)).not.toContain("SECRET");
    expect(JSON.stringify(result.content)).not.toContain("noise.ts");
    const insensitive = await tool.execute(
      "case",
      { query: "ALPHAXYZ", caseSensitive: false },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(insensitive.content)).toContain("alphaXYZ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
