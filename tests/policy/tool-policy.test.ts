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
      (await policy.check("bash", { command: "npm test" }, "b1")).allowed,
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
