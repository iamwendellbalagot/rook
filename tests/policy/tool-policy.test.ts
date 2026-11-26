import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolPolicy } from "../../src/policy/tool-policy.js";
import {
  Permissions,
  type PermissionConfiguration,
} from "../../src/policy/permissions.js";

const roots: string[] = [];
async function workspace(layers: PermissionConfiguration[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rook-policy-")));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "export {};");
  return {
    root,
    policy: new ToolPolicy(root, Permissions.configured(root, layers)),
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("host tool permissions", () => {
  it("rejects invalid approval responses and reserves execution across async path checks", async () => {
    const { policy } = await workspace();
    policy.setMode("build");
    policy.setExternalAccessPrompt(async () => undefined as never);
    expect(
      (await policy.check("bash", { command: "npm test" }, "invalid")).allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "once");
    const decisions = await Promise.all([
      policy.check("bash", { command: "cat /outside/missing" }, "one"),
      policy.check("bash", { command: "npm test" }, "two"),
    ]);
    expect(decisions.filter((item) => item.allowed)).toHaveLength(1);
  });
  it("requires shell approval, never automatically migrates routine sandbox grants, and allows test reruns", async () => {
    const { policy } = await workspace();
    expect(
      (await policy.check("bash", { command: "npm test" }, "plan")).allowed,
    ).toBe(false);
    policy.setMode("build");
    expect(
      (await policy.check("bash", { command: "npm test" }, "headless")).allowed,
    ).toBe(false);
    const requests: any[] = [];
    policy.setExternalAccessPrompt(async (request) => {
      requests.push(request);
      return "session";
    });
    expect(
      (await policy.check("bash", { command: "npm test" }, "first")).allowed,
    ).toBe(true);
    expect(requests[0]).toMatchObject({
      sandboxed: false,
      permissionResources: [{ action: "shell", resource: "npm test" }],
    });
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "concurrent"))
        .allowed,
    ).toBe(false);
    policy.finish("first", "bash", false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "again")).allowed,
    ).toBe(true);
    policy.finish("again");
    expect(requests).toHaveLength(1);
    expect(
      (await policy.check("bash", { command: "npm run build" }, "different"))
        .allowed,
    ).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("enforces higher authority policies and checks every extracted command", async () => {
    const { policy } = await workspace([
      {
        permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        policies: [
          { action: "tool.use", resource: "shell:git push *", effect: "allow" },
        ],
      },
      {
        policies: [
          { action: "tool.use", resource: "shell:git push *", effect: "deny" },
        ],
      },
    ]);
    policy.setMode("build");
    expect(
      (
        await policy.check(
          "bash",
          { command: "git status && git 'push' origin" },
          "push",
        )
      ).allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "git status" }, "status")).allowed,
    ).toBe(true);
  });

  it("fails closed on uninspectable syntax when shell denials exist", async () => {
    const { policy } = await workspace([
      {
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "shell", resource: "rm *", effect: "deny" },
        ],
      },
    ]);
    policy.setMode("build");
    for (const command of [
      "echo $(rm a)",
      "if true; then rm a; fi",
      "eval 'rm a'",
      "echo hi > output",
    ])
      expect((await policy.check("bash", { command }, command)).allowed).toBe(
        false,
      );
  });

  it("requires unsaveable one-time approval for dynamic syntax even with broad allow", async () => {
    const { policy } = await workspace([
      {
        permissions: [
          { action: "shell", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
        ],
      },
    ]);
    policy.setMode("build");
    policy.setExternalAccessPrompt(async (request) => {
      expect(request.rememberAllowed).toBe(false);
      return "session";
    });
    expect(
      (await policy.check("bash", { command: "echo $HOME" }, "dynamic"))
        .allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "once");
    expect(
      (await policy.check("bash", { command: "echo $HOME" }, "once")).allowed,
    ).toBe(true);
  });

  it("does not authorize MCP from prose and blocks MCP in Plan", async () => {
    const { policy } = await workspace();
    policy.setMcpUserAuthorization("use MCP, specifically mcp__github__delete");
    policy.setExternalAccessPrompt(async () => "session");
    expect(
      (await policy.check("mcp__github__delete", {}, "plan")).allowed,
    ).toBe(false);
    policy.setMode("build");
    policy.setExternalAccessPrompt(undefined);
    expect(
      (await policy.check("mcp__github__delete", {}, "host")).allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "session");
    expect((await policy.check("mcp__github__read", {}, "grant")).allowed).toBe(
      true,
    );
    policy.setExternalAccessPrompt(undefined);
    expect(
      (await policy.check("mcp__github__read", {}, "granted")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("mcp__github__delete", {}, "other")).allowed,
    ).toBe(false);
  });

  it("expires approvals when mode changes and releases execution reservations", async () => {
    const { policy } = await workspace();
    policy.setMode("build");
    policy.setExternalAccessPrompt(async () => {
      policy.setMode("plan");
      return "once";
    });
    expect(
      (await policy.check("bash", { command: "npm test" }, "expired")).allowed,
    ).toBe(false);
    policy.setMode("build");
    expect(
      (await policy.check("edit", { path: "src/main.ts" }, "edit")).allowed,
    ).toBe(true);
  });

  it("checks canonical external paths, including links, and protects permission files", async () => {
    const { root, policy } = await workspace();
    const { root: outside } = await workspace();
    await symlink(outside, join(root, "linked"));
    expect(
      (await policy.check("read", { path: "linked/src/main.ts" }, "outside"))
        .allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async (request) => {
      expect(request.permissionResources).toContainEqual({
        action: "external_directory",
        resource: `${outside}/src/*`,
      });
      return "once";
    });
    expect(
      (await policy.check("read", { path: "linked/src/main.ts" }, "approved"))
        .allowed,
    ).toBe(true);
    policy.setMode("build");
    expect(
      (
        await policy.check(
          "write",
          { path: ".rook/permissions.json" },
          "config",
        )
      ).allowed,
    ).toBe(false);
  });

  it("redacts nested secrets in unknown tool requests", async () => {
    const { policy } = await workspace();
    policy.setMode("build");
    policy.setExternalAccessPrompt(async (request) => {
      expect(JSON.stringify(request)).not.toContain("private-token");
      return "deny";
    });
    expect(
      (
        await policy.check(
          "plugin_upload",
          { nested: { apiToken: "private-token" } },
          "secret",
        )
      ).allowed,
    ).toBe(false);
  });
});
