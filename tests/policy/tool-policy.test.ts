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
  it("allows routine sandboxed Build shell and preserves verification sequencing", async () => {
    const policy = new ToolPolicy(await workspace());
    let prompts = 0;
    policy.setExternalAccessPrompt(async (request) => {
      prompts++;
      expect(request).toMatchObject({
        access: "execute",
        timeoutSeconds: 120,
        sandboxed: true,
      });
      return "once";
    });
    expect(
      (await policy.check("bash", { command: "npm test" }, "plan")).allowed,
    ).toBe(false);
    expect(prompts).toBe(0);
    policy.setMode("build");
    expect(
      (await policy.check("bash", { command: "npm test" }, "shell1")).allowed,
    ).toBe(true);
    expect(prompts).toBe(0);
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "edit")).allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "parallel")).allowed,
    ).toBe(false);
    policy.finish("shell1", "bash", false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "duplicate"))
        .allowed,
    ).toBe(false);
    expect(
      (await policy.check("bash", { command: "npm run typecheck" }, "shell2"))
        .allowed,
    ).toBe(true);
    policy.finish("shell2", "bash", false);
    expect(prompts).toBe(0);
    expect(policy.getExternalAccessGrants()).toEqual([]);
    expect(
      (await policy.check("write", { path: "src/main.ts" }, "edit-again"))
        .allowed,
    ).toBe(true);
    policy.finish("edit-again", "write", false);
    expect(
      (await policy.check("bash", { command: "npm test" }, "stale-impact"))
        .allowed,
    ).toBe(true);
    policy.finish("stale-impact", "bash", false);
    expect(prompts).toBe(0);
  });

  it("reports whether the approved command is sandboxed in the approval request", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    let request: unknown;
    policy.setExternalAccessPrompt(async (value) => {
      request = value;
      return "once";
    });
    await policy.check("bash", { command: "node --version" }, "sandboxed");
    expect(request).toMatchObject({ access: "execute", sandboxed: true });
    policy.setSandboxShell(false);
    policy.finish("sandboxed", "bash", false);
    await policy.check("bash", { command: "node --version" }, "host");
    expect(request).toMatchObject({ access: "execute", sandboxed: false });
  });

  it("blocks shell approval when required sandbox runtime is absent", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    policy.setSandboxRuntimeAvailable(false);
    let prompted = false;
    policy.setExternalAccessPrompt(async () => {
      prompted = true;
      return "once";
    });
    const decision = await policy.check(
      "bash",
      { command: "touch outside" },
      "missing-runtime",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("will not fall back to host execution");
    expect(prompted).toBe(false);
  });

  it("prompts for unclassified tools and scopes session grants to one tool/source", async () => {
    const policy = new ToolPolicy(await workspace());
    expect(
      (await policy.check("unexpected_extension_tool", {}, "no-ui")).allowed,
    ).toBe(false);
    const requests: unknown[] = [];
    policy.setExternalAccessPrompt(async (request) => {
      requests.push(request);
      return "session";
    });
    expect(
      (
        await policy.check(
          "unexpected_extension_tool",
          { apiToken: "private" },
          "unknown",
        )
      ).allowed,
    ).toBe(true);
    expect(requests[0]).toMatchObject({
      access: "tool",
      sourceName: "registered:unexpected_extension_tool",
      inputSummary: '{"apiToken":"[redacted]"}',
    });
    expect(
      (await policy.check("unexpected_extension_tool", {}, "granted")).allowed,
    ).toBe(true);
    expect(
      (await policy.check("another_extension_tool", {}, "other")).allowed,
    ).toBe(true);
    expect(policy.getSessionPermissionGrants()).toHaveLength(2);
    expect(requests).toHaveLength(2);
    policy.clearSessionPermissionGrants();
    expect(
      (await policy.check("unexpected_extension_tool", {}, "expired")).allowed,
    ).toBe(true);
    expect(requests).toHaveLength(3);
    const grant = policy.getSessionPermissionGrants()[0]!;
    expect(policy.revokeExternalAccessGrant(grant.id)).toBe(true);
    expect(policy.getSessionPermissionGrants()).toHaveLength(0);
  });

  it("redacts credentials embedded in unclassified-tool string arguments", async () => {
    const policy = new ToolPolicy(await workspace());
    let inputSummary = "";
    policy.setExternalAccessPrompt(async (request) => {
      if (request.access === "tool") inputSummary = request.inputSummary;
      return "deny";
    });
    await policy.check(
      "plugin__upload",
      { note: "Authorization: Bearer abcdefghijklmnop token" },
      "redact-string",
    );
    expect(inputSummary).not.toContain("abcdefghijklmnop");
    expect(inputSummary).toContain("[redacted]");
  });

  it("prompts for unclear shell commands and supports exact-command session grants", async () => {
    const root = await workspace();
    const policy = new ToolPolicy(root);
    policy.setMode("build");
    expect(
      (await policy.check("bash", { command: "some-custom-script" }, "no-ui"))
        .allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "deny");
    expect(
      (await policy.check("bash", { command: "some-custom-script" }, "deny"))
        .allowed,
    ).toBe(false);
    policy.setExternalAccessPrompt(async () => "session");
    expect(
      (await policy.check("bash", { command: "some-custom-script" }, "session"))
        .allowed,
    ).toBe(true);
    policy.finish("session", "bash", false);
    expect(
      (await policy.check("bash", { command: "some-custom-script" }, "granted"))
        .allowed,
    ).toBe(true);
    expect(
      (
        await policy.check(
          "bash",
          { command: "some-custom-script --extra" },
          "different",
        )
      ).allowed,
    ).toBe(false);
    expect(policy.getSessionPermissionGrants()).toHaveLength(1);
    expect(policy.getSessionPermissionGrants()[0]?.workspace).toBe(
      await realpath(root),
    );
    policy.clearSessionPermissionGrants();
    expect(policy.getSessionPermissionGrants()).toHaveLength(0);
    policy.setExternalAccessPrompt(async () => "deny");
    policy.setExternalAccessPrompt(async () => {
      throw new Error("UI closed");
    });
    expect(
      (
        await policy.check(
          "bash",
          { command: "another-custom-script" },
          "closed",
        )
      ).allowed,
    ).toBe(false);
  });

  it("prompts rather than auto-allowing routine-looking commands with escaping paths", async () => {
    const policy = new ToolPolicy(await workspace());
    policy.setMode("build");
    let prompts = 0;
    policy.setExternalAccessPrompt(async (request) => {
      prompts++;
      expect(request).toMatchObject({ access: "execute", sandboxed: true });
      return "once";
    });
    expect(
      (await policy.check("bash", { command: "ls /etc" }, "outside")).allowed,
    ).toBe(true);
    policy.finish("outside", "bash", false);
    expect(
      (
        await policy.check(
          "bash",
          { command: "git diff -- ../private" },
          "traversal",
        )
      ).allowed,
    ).toBe(true);
    expect(prompts).toBe(2);
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
      (await policy.check("bash", { command: "node custom-script" }, "expired"))
        .allowed,
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

  it("allows MCP in plan mode after approval and scopes session grants by tool", async () => {
    const policy = new ToolPolicy(await workspace());
    let prompts = 0;
    policy.setExternalAccessPrompt(async (request) => {
      prompts++;
      expect(request.access).toBe("mcp");
      if (request.access !== "mcp") return "deny";
      if (request.serverName !== "docs") return "deny";
      if (request.toolName === "mcp__docs__search") {
        expect(request.inputSummary).toContain("[redacted]");
        return "session";
      }
      return request.toolName === "mcp__docs__fetch" ? "once" : "deny";
    });

    expect(
      (
        await policy.check(
          "mcp__docs__search",
          { query: "Pi SDK", apiToken: "secret-value" },
          "mcp1",
        )
      ).allowed,
    ).toBe(true);
    expect(prompts).toBe(1);
    expect((await policy.check("mcp__docs__search", {}, "mcp2")).allowed).toBe(
      true,
    );
    expect((await policy.check("mcp__docs__fetch", {}, "mcp2b")).allowed).toBe(
      true,
    );
    expect(prompts).toBe(2);
    expect(
      (await policy.check("mcp__github__create_issue", {}, "mcp3")).allowed,
    ).toBe(false);
    expect(prompts).toBe(3);

    policy.clearSessionPermissionGrants();
    expect((await policy.check("mcp__docs__fetch", {}, "mcp4")).allowed).toBe(
      true,
    );
    expect(prompts).toBe(4);
  });

  it("honors explicit MCP requests and denials without prompting", async () => {
    const policy = new ToolPolicy(await workspace());
    let prompts = 0;
    policy.setExternalAccessPrompt(async () => {
      prompts++;
      return "deny";
    });

    policy.setMcpUserAuthorization(
      "Use mcp__docs__search to find the SDK docs.",
    );
    expect(
      (await policy.check("mcp__docs__search", {}, "explicit")).allowed,
    ).toBe(true);
    expect(prompts).toBe(0);
    expect(
      (await policy.check("mcp__docs__fetch", {}, "other-explicit-tool"))
        .allowed,
    ).toBe(false);
    expect(prompts).toBe(1);

    policy.setMcpUserAuthorization("Do not use MCP for this task.");
    expect(
      (await policy.check("mcp__docs__search", {}, "negated")).allowed,
    ).toBe(false);
    expect(prompts).toBe(1);

    policy.setMcpUserAuthorization("Please use MCP for this task.");
    expect(
      (await policy.check("mcp__docs__search", {}, "broad-explicit")).allowed,
    ).toBe(true);
    expect(prompts).toBe(1);
    policy.setMcpUserAuthorization("Maybe use MCP if needed.");
    expect(
      (await policy.check("mcp__docs__search", {}, "uncertain")).allowed,
    ).toBe(false);
    expect(prompts).toBe(2);
    policy.clearMcpUserAuthorization();
    expect(
      (await policy.check("mcp__docs__search", {}, "cleared")).allowed,
    ).toBe(false);
    expect(prompts).toBe(3);
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
    policy.finish("search-ok");
    expect(
      (await policy.check("rook_map", { query: "symbol", limit: 10 }, "map-ok"))
        .allowed,
    ).toBe(true);
    policy.finish("map-ok");
    expect(
      (
        await policy.check(
          "rook_code",
          { action: "definition", path: "src/index.ts", line: 1, column: 1 },
          "code-ok",
        )
      ).allowed,
    ).toBe(true);
    policy.finish("code-ok");
    expect(
      (
        await policy.check(
          "rook_code",
          { action: "definition", path: "../outside.ts", line: 1, column: 1 },
          "code-bad",
        )
      ).allowed,
    ).toBe(false);
    expect(
      (await policy.check("rook_map", { path: "../outside" }, "map-bad"))
        .allowed,
    ).toBe(false);
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
