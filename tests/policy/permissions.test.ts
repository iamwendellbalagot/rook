import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Permissions, matches } from "../../src/policy/permissions.js";
import { scanShell } from "../../src/policy/shell-scanner.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("matches whole values, literal metacharacters, and argument-free shell prefixes", () => {
  expect(matches("git status *", "git status")).toBe(true);
  expect(matches("*.env", "secrets/app.env")).toBe(true);
  expect(matches("file[1].ts", "file1.ts")).toBe(false);
  expect(matches("file[1].ts", "file[1].ts")).toBe(true);
  expect(matches("git status", "git status --short")).toBe(false);
});
it("uses last matching permission; policy allowance never grants ordinary access", async () => {
  const rules = Permissions.configured("/workspace", [
    {
      permissions: [
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status *", effect: "ask" },
      ],
      policies: [
        { action: "tool.use", resource: "shell:*", effect: "deny" },
        { action: "tool.use", resource: "shell:git status *", effect: "allow" },
      ],
    },
  ]);
  expect(rules.evaluate("shell", "git status")).toBe("ask");
  expect(rules.evaluate("shell", "git push")).toBe("deny");
  await rules.grant([{ action: "shell", resource: "git status" }], false);
  expect(rules.evaluate("shell", "git status")).toBe("allow");
});
it("persists exact project grants outside the workspace, supports revocation and never overrides deny", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-permissions-"));
  roots.push(root);
  vi.stubEnv("ROOK_HOME", join(root, "home"));
  await mkdir(join(root, "project"));
  const rules = await Permissions.load(join(root, "project"));
  await rules.grant([{ action: "shell", resource: "npm test" }], true);
  const restored = await Permissions.load(join(root, "project"));
  expect(restored.evaluate("shell", "npm test")).toBe("allow");
  expect(restored.evaluate("shell", "npm test -- other")).toBe("ask");
  await writeFile(
    join(root, "home/permissions.json"),
    JSON.stringify({
      permissions: [{ action: "shell", resource: "npm test", effect: "deny" }],
    }),
  );
  expect(
    (await Permissions.load(join(root, "project"))).evaluate(
      "shell",
      "npm test",
    ),
  ).toBe("deny");
  await restored.revoke(restored.listApprovals()[0]!.id);
  expect(restored.listApprovals()).toEqual([]);
});
it("rejects malformed configuration instead of silently dropping a denial", () => {
  expect(() =>
    Permissions.configured("/workspace", [
      { policies: [{ action: "typo", resource: "*", effect: "deny" }] },
    ]),
  ).toThrow();
});
it("scans quoted commands, compound syntax, external operands, and rejects dynamic evaluation", () => {
  expect(scanShell("git status && git 'push' origin")).toMatchObject({
    commands: ["git status", "git push origin"],
    complete: true,
  });
  expect(scanShell("cat '/outside/a b' | head").paths).toEqual([
    "/outside/a b",
  ]);
  for (const command of [
    "echo $(id)",
    "eval 'rm a'",
    "echo $HOME",
    "cd ../other && npm test",
    "if true; then rm a; fi",
    "echo 'unterminated",
  ])
    expect(scanShell(command).complete).toBe(false);
});
