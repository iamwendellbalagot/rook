import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkills,
  listInstalledSkills,
  parseGitSource,
  removeInstalledSkill,
} from "../../src/skills/manager.js";

describe("Rook skill manager", () => {
  it("installs, lists, and removes a local skill in project scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-skills-manager-"));
    const cwd = join(root, "project");
    const source = join(root, "local-skills");
    await mkdir(join(source, "code-review", "references"), { recursive: true });
    await writeFile(
      join(source, "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: Review code safely.\n---\nReview instructions.\n",
    );
    await writeFile(
      join(source, "code-review", "references", "guide.md"),
      "Reference guide.\n",
    );

    try {
      const installed = await installSkills(source, { cwd, scope: "project" });
      expect(installed).toHaveLength(1);
      expect(installed[0]?.name).toBe("code-review");
      expect(
        await readFile(
          join(cwd, ".rook", "skills", "code-review", "references", "guide.md"),
          "utf8",
        ),
      ).toBe("Reference guide.\n");
      expect(await listInstalledSkills(cwd)).toEqual([
        expect.objectContaining({ name: "code-review", scope: "project" }),
      ]);
      await expect(installSkills(source, { cwd })).rejects.toThrow(
        "already installed",
      );
      expect(await removeInstalledSkill("code-review", { cwd })).toBe(true);
      expect(await listInstalledSkills(cwd)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports GitHub shorthand and skill subdirectory URLs", () => {
    expect(parseGitSource("vercel-labs/agent-skills@main")).toEqual({
      url: "https://github.com/vercel-labs/agent-skills.git",
      ref: "main",
    });
    expect(
      parseGitSource(
        "https://github.com/vercel-labs/agent-skills/tree/main/skills/review",
      ),
    ).toEqual({
      url: "https://github.com/vercel-labs/agent-skills.git",
      ref: "main",
      subdirectory: "skills/review",
    });
  });

  it("installs a skill into the Rook global home when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-skills-global-"));
    const previousRookHome = process.env.ROOK_HOME;
    process.env.ROOK_HOME = join(root, "rook-home");
    const source = join(root, "global-skill");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "SKILL.md"),
        "---\nname: global-review\ndescription: Global test skill.\n---\nReview globally.\n",
      );
      const installed = await installSkills(source, {
        cwd: join(root, "project"),
        scope: "global",
      });
      expect(installed[0]?.scope).toBe("global");
      expect(await listInstalledSkills(join(root, "project"))).toEqual([
        expect.objectContaining({ name: "global-review", scope: "global" }),
      ]);
      expect(
        await removeInstalledSkill("global-review", {
          cwd: join(root, "project"),
          scope: "global",
        }),
      ).toBe(true);
    } finally {
      if (previousRookHome === undefined) delete process.env.ROOK_HOME;
      else process.env.ROOK_HOME = previousRookHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects insecure HTTP Git sources", () => {
    expect(() => parseGitSource("http://example.com/skills.git")).toThrow(
      "must use HTTPS or SSH",
    );
  });

  it("refuses skills that escape their source through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-skills-symlink-"));
    const source = join(root, "source", "linked-skill");
    const outside = join(root, "outside.md");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: linked-skill\ndescription: Test symlink handling.\n---\nInstructions.\n",
    );
    await writeFile(outside, "outside source content\n");
    await symlink(outside, join(source, "outside.md"));
    try {
      await expect(
        installSkills(join(root, "source"), {
          cwd: join(root, "project"),
        }),
      ).rejects.toThrow("symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
