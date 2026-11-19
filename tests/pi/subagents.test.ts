import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSubagentPrompt,
  loadSubagentProfiles,
} from "../../src/pi/subagents.js";

describe("configurable subagents", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("loads read-only profiles with bounded default tools and composes a constrained prompt", async () => {
    root = await mkdtemp(join(tmpdir(), "rook-subagents-"));
    await mkdir(join(root, ".rook"));
    await writeFile(
      join(root, ".rook", "agents.json"),
      JSON.stringify({
        agents: [
          {
            name: "api-reviewer",
            description: "Review API changes",
            instructions: "Focus on contract compatibility.",
          },
        ],
      }),
    );

    const [profile] = await loadSubagentProfiles(root);
    expect(profile?.tools).toEqual([
      "read",
      "find",
      "ls",
      "rook_inspect",
      "rook_search",
      "rook_map",
      "rook_code",
    ]);
    const prompt = buildSubagentPrompt(profile!, "Review this change");
    expect(prompt).toContain("Do not edit files, run shell commands");
    expect(prompt).toContain("Focus on contract compatibility.");
    expect(prompt).toContain("<user_task>\nReview this change");
  });

  it("rejects unknown or mutating tools", async () => {
    root = await mkdtemp(join(tmpdir(), "rook-subagents-"));
    await mkdir(join(root, ".rook"));
    await writeFile(
      join(root, ".rook", "agents.json"),
      JSON.stringify({
        agents: [
          {
            name: "writer",
            description: "Try a write-capable agent",
            instructions: "Write changes.",
            tools: ["read", "write"],
          },
        ],
      }),
    );
    await expect(loadSubagentProfiles(root)).rejects.toThrow(
      "unsupported or duplicate tools",
    );
  });
});
