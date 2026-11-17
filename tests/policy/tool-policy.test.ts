import {
  access,
  link,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createToolPolicyExtension,
  ToolPolicy,
} from "../../src/policy/tool-policy.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-policy-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};");
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ToolPolicy", () => {
  it("requires build mode and explicit one-time approval for every shell command", async () => {
    const policy = new ToolPolicy(await workspace());
    let prompts = 0;
    policy.setExternalAccessPrompt(async (request) => {
      prompts++;
      expect(request).toMatchObject({
        access: "execute",
        command: "npm test",
        timeoutSeconds: 120,
      });
      return "once";
    });
    expect(
      (await policy.check("bash", { command: "npm test" }, "plan")).allowed,
    ).toBe(false);
    expect(prompts).toBe(0);
    policy.setMode("build");
    expect(
      (await policy.check("bash", { command: "npm test" }, "before-impact"))
        .allowed,
    ).toBe(false);
    expect(prompts).toBe(0);
    expect((await policy.check("rook_impact", {}, "impact")).allowed).toBe(
      true,
    );
    policy.finish("impact", "rook_impact", false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "shell1")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "edit")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "parallel")).allowed,
    ).toBe(false);
    policy.finish("shell1");
    expect(
      (await policy.check("bash", { command: "npm test" }, "shell2")).allowed,
    ).toBe(true);
    policy.finish("shell2");
    expect(prompts).toBe(2);
    expect(policy.getExternalAccessGrants()).toEqual([]);
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "edit-again"))
        .allowed,
    ).toBe(true);
    policy.finish("edit-again", "write", false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "stale-impact"))
        .allowed,
    ).toBe(false);
  });

  it("denies shell execution without an approval UI, after denial, or with a session grant", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    expect(
      (await policy.check("bash", { command: "echo ok" }, "no-ui")).allowed,
    ).toBe(false);
    for (const choice of ["deny", "session"] as const) {
      policy.setExternalAccessPrompt(async () => choice);
      expect(
        (await policy.check("bash", { command: "echo ok" }, choice)).allowed,
      ).toBe(false);
    }
    policy.setExternalAccessPrompt(async () => {
      throw new Error("UI closed");
    });
    expect(
      (await policy.check("bash", { command: "echo ok" }, "closed")).allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "once");
    expect(
      (await policy.check("bash", { command: "echo ok" }, "retry")).allowed,
    ).toBe(true);
  });

  it("rejects invalid commands and timeouts before requesting approval", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    let prompts = 0;
    policy.setExternalAccessPrompt(async () => {
      prompts++;
      return "once";
    });
    const impact = await policy.check("rook_impact", {}, "impact");
    expect(impact.allowed).toBe(true);
    policy.finish("impact", "rook_impact", false);
    for (const command of ["", " ", "a".repeat(4097), "echo \x1b[31m"]) {
      expect((await policy.check("bash", { command }, command)).allowed).toBe(
        false,
      );
    }
    for (const timeout of [0, -1, Infinity, NaN, 301, "120"]) {
      expect(
        (
          await policy.check(
            "bash",
            { command: "npm test", timeout },
            String(timeout),
          )
        ).allowed,
      ).toBe(false);
    }
    expect(prompts).toBe(0);
  });

  it("expires pending shell approval when switching to plan mode", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    const impact = await policy.check("rook_impact", {}, "impact");
    expect(impact.allowed).toBe(true);
    policy.finish("impact", "rook_impact", false);
    policy.setExternalAccessPrompt(async () => {
      policy.setMode("plan");
      return "once";
    });
    expect(
      (await policy.check("bash", { command: "npm test" }, "expired")).allowed,
    ).toBe(false);
    policy.setMode("build");
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "retry")).allowed,
    ).toBe(true);
  });

  it("allows workspace reads in plan mode and blocks mutation and shell tools", async () => {
    const root = await workspace();
    const policy = new ToolPolicy(root);

    expect(
      (await policy.check("read", { path: "src/main.ts" }, "r1")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("grep", { path: ".", pattern: "token" }, "g1"))
        .allowed,
    ).toBe(false);
    expect(
      (await policy.check("edit", { path: "src/main.ts" }, "e1")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "touch marker" }, "b1")).allowed,
    ).toBe(false);
    expect((await policy.check("custom_tool", {}, "c1")).allowed).toBe(false);
  });

  it("allows only structured Git inspection in plan mode and impact analysis in build mode", async () => {
    const policy = new ToolPolicy(await workspace());
    expect(
      (await policy.check("rook_inspect", { action: "status" }, "inspect"))
        .allowed,
    ).toBe(true);
    policy.finish("inspect");
    expect(
      (await policy.check("rook_search", { query: "symbol" }, "search-ok"))
        .allowed,
    ).toBe(true);
    expect(
      (
        await policy.check(
          "rook_inspect",
          { action: "exec", command: "touch x" },
          "unsafe",
        )
      ).allowed,
    ).toBe(false);
    expect((await policy.check("rook_impact", {}, "impact-plan")).allowed).toBe(
      false,
    );
    policy.finish("search-ok");
    policy.setMode("build");
    expect(
      (await policy.check("rook_impact", {}, "impact-build")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "during-impact"))
        .allowed,
    ).toBe(false);
    policy.finish("impact-build");
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "after-impact"))
        .allowed,
    ).toBe(true);
  });

  it("returns a blocking result from Pi's pre-execution tool hook", async () => {
    const policy = new ToolPolicy(await workspace());
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const extension = createToolPolicyExtension(policy);
    if (typeof extension === "function")
      throw new Error("Expected named extension");
    extension.factory({
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    } as unknown as ExtensionAPI);

    const result = await handlers.get("tool_call")?.({
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "src/main.ts", content: "mutated" },
    });
    expect(result).toMatchObject({ block: true });
    expect(policy.getDecisions()[0]).toMatchObject({
      toolName: "write",
      allowed: false,
    });
    policy.setMode("build");
    const impact = await policy.check("rook_impact", {}, "impact");
    expect(impact.allowed).toBe(true);
    policy.finish("impact", "rook_impact", false);
    policy.setExternalAccessPrompt(async () => "once");
    expect(
      await handlers.get("tool_call")?.({
        toolName: "bash",
        toolCallId: "bash-hook",
        input: { command: "npm test" },
      }),
    ).toBeUndefined();
    handlers.get("tool_execution_end")?.({
      toolCallId: "bash-hook",
      toolName: "bash",
      isError: false,
    });
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "after-shell"))
        .allowed,
    ).toBe(true);
  });

  it("allows build edits only for ordinary workspace files", async () => {
    const root = await workspace();
    const policy = new ToolPolicy(root);
    policy.setMode("build");

    expect(
      (await policy.check("edit", { path: "src/main.ts" }, "e1")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("write", { path: ".env.local" }, "w1")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("write", { path: "node_modules/pkg/file.js" }, "w2"))
        .allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "echo ok" }, "b1")).allowed,
    ).toBe(false);
  });

  it("rejects traversal, outside paths, and symlinks escaping the workspace", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "rook-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "external"));
    await link(
      join(outside, "secret.txt"),
      join(root, "src", "linked-secret.txt"),
    );
    const policy = new ToolPolicy(root);
    policy.setMode("build");

    expect(
      (await policy.check("read", { path: "../secret.txt" }, "r1")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("read", { path: join(outside, "secret.txt") }, "r2"))
        .allowed,
    ).toBe(false);
    expect(
      (await policy.check("write", { path: "external/new.txt" }, "w1")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("write", { path: "src/linked-secret.txt" }, "w2"))
        .allowed,
    ).toBe(false);
    await expect(access(join(outside, "new.txt"))).rejects.toThrow();
  });

  it("requests outside read approval and supports a session-scoped folder grant", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "rook-approved-"));
    roots.push(outside);
    await writeFile(join(outside, "notes.txt"), "approved content");
    const policy = new ToolPolicy(root);
    const requests: unknown[] = [];
    policy.setExternalAccessPrompt(async (request) => {
      requests.push(request);
      return "session";
    });

    expect(
      (await policy.check("read", { path: join(outside, "notes.txt") }, "r1"))
        .allowed,
    ).toBe(true);
    expect(requests).toEqual([
      {
        toolName: "read",
        path: join(outside, "notes.txt"),
        folderPath: outside,
        access: "read",
      },
    ]);
    expect((await policy.check("ls", { path: outside }, "l1")).allowed).toBe(
      true,
    );
    expect(policy.getExternalAccessGrants()).toHaveLength(1);
    expect(policy.getExternalAccessGrants()[0]?.access).toBe("read");
  });

  it("requires separate read/write approval, supports one-time grants, and revokes session grants", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "rook-approved-"));
    roots.push(outside);
    await writeFile(join(outside, "notes.txt"), "existing");
    const policy = new ToolPolicy(root);
    policy.setMode("build");
    const choices = ["once", "session", "deny"] as const;
    let requests = 0;
    policy.setExternalAccessPrompt(async () => choices[requests++] ?? "deny");

    expect(
      (await policy.check("write", { path: join(outside, "new.txt") }, "w1"))
        .allowed,
    ).toBe(true);
    policy.finish("w1");
    expect(policy.getExternalAccessGrants()).toHaveLength(0);
    expect(
      (await policy.check("write", { path: join(outside, "newer.txt") }, "w2"))
        .allowed,
    ).toBe(true);
    const grant = policy.getExternalAccessGrants()[0];
    expect(grant).toMatchObject({
      path: await realpath(outside),
      access: "write",
    });
    expect(
      (await policy.check("read", { path: join(outside, "notes.txt") }, "r1"))
        .allowed,
    ).toBe(false);
    expect(grant && policy.revokeExternalAccessGrant(grant.id)).toBe(true);
    expect(policy.getExternalAccessGrants()).toHaveLength(0);
  });

  it("denies external access if no interactive approval handler is installed", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "rook-unapproved-"));
    roots.push(outside);
    await writeFile(join(outside, "notes.txt"), "private");
    const decision = await new ToolPolicy(root).check(
      "read",
      { path: join(outside, "notes.txt") },
      "r1",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no interactive approval");
  });

  it("asks before touching an outside path and does not inspect it after denial", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "rook-denied-"));
    roots.push(outside);
    let prompted = false;
    const policy = new ToolPolicy(root);
    policy.setExternalAccessPrompt(async () => {
      prompted = true;
      return "deny";
    });

    const decision = await policy.check(
      "read",
      { path: join(outside, "missing.txt") },
      "r1",
    );
    expect(prompted).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("access was denied");
  });

  it("serializes mutating tool calls and releases the slot at tool completion", async () => {
    const root = await workspace();
    const policy = new ToolPolicy(root);
    policy.setMode("build");

    expect(
      (await policy.check("write", { path: "src/new.ts" }, "w1")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("edit", { path: "src/main.ts" }, "e1")).allowed,
    ).toBe(false);
    policy.finish("w1");
    expect(
      (await policy.check("edit", { path: "src/main.ts" }, "e2")).allowed,
    ).toBe(true);
  });

  it("does not race concurrent mutation checks", async () => {
    const root = await workspace();
    const policy = new ToolPolicy(root);
    policy.setMode("build");

    const decisions = await Promise.all([
      policy.check("write", { path: "src/one.ts" }, "w1"),
      policy.check("write", { path: "src/two.ts" }, "w2"),
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(1);
  });
});
