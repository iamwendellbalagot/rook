import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlythIntegratedExtension,
  PLYTH_INTEGRATED_GUIDANCE,
} from "../../src/pi/plyth-integrated.js";
import { resolvePlythIntegratedMode } from "../../src/pi/plyth-integrated-mode.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
  vi.unstubAllEnvs();
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-plyth-integrated-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

function mount(root: string, integrated = true) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const statuses: Array<[string, string | undefined]> = [];
  const extension = createPlythIntegratedExtension(root, undefined, integrated);
  if (typeof extension === "function")
    throw new Error("Expected extension object");
  extension.factory({
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      setStatus: (key: string, text: string | undefined) =>
        statuses.push([key, text]),
    },
  };
  return { handlers, ctx, statuses };
}

function startTask(
  handlers: Map<string, (...args: any[]) => unknown>,
  ctx: unknown,
  prompt = "Fix the request",
) {
  return handlers.get("before_agent_start")?.(
    { messageType: "user", prompt, systemPrompt: "base" },
    ctx,
  ) as { systemPrompt: string };
}

function toolCall(
  handlers: Map<string, (...args: any[]) => unknown>,
  ctx: unknown,
  id: string,
) {
  handlers.get("tool_call")?.(
    {
      toolName: "bash",
      toolCallId: id,
      input: { command: "npm test" },
    },
    ctx,
  );
}

function toolResult(
  handlers: Map<string, (...args: any[]) => unknown>,
  ctx: unknown,
  id: string,
) {
  return handlers.get("tool_result")?.(
    {
      toolName: "bash",
      toolCallId: id,
      input: { command: "npm test" },
      content: [{ type: "text", text: "failure" }],
      structuredContent: { exit_code: 1, output: "✖ rejects unsafe path" },
      isError: false,
    },
    ctx,
  );
}

describe("PLYTH integrated inference extension", () => {
  it("resolves off, prompt-only, and integrated as separate opt-in modes", () => {
    expect(resolvePlythIntegratedMode({})).toBe("off");
    expect(
      resolvePlythIntegratedMode({ ROOK_PLYTH_INTEGRATED: "prompt" }),
    ).toBe("prompt");
    expect(resolvePlythIntegratedMode({ ROOK_PLYTH_INTEGRATED: "1" })).toBe(
      "integrated",
    );
    expect(
      resolvePlythIntegratedMode({ ROOK_PLYTH_INTEGRATED: "integrated" }),
    ).toBe("integrated");
    expect(resolvePlythIntegratedMode({ ROOK_PLYTH_INTEGRATED: "true" })).toBe(
      "off",
    );
  });

  it("delivers a source checkpoint to the next inference and only once per task", async () => {
    const root = await repo();
    const { handlers, ctx, statuses } = mount(root);
    const started = startTask(handlers, ctx);
    expect(started.systemPrompt).toContain(PLYTH_INTEGRATED_GUIDANCE);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "change.ts"),
      "export const value = 1;\n",
    );
    const result = handlers.get("context")?.({ messages: [] }, ctx) as {
      messages: Array<{ customType?: string; content?: string }>;
    };
    expect(result.messages.at(-1)?.customType).toBe("plyth-integrated-context");
    expect(result.messages.at(-1)?.content).toContain("src/change.ts");
    expect(result.messages.at(-1)?.content).toContain(
      "task-local change checkpoint",
    );
    expect(handlers.get("context")?.({ messages: [] }, ctx)).toBeUndefined();
    expect(statuses).toContainEqual([
      "plyth-integrated",
      "PLYTH task checkpoint",
    ]);
  });

  it("excludes files already dirty before this task from its checkpoint", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "preexisting.ts"), "export {}\n");
    const { handlers, ctx } = mount(root);
    startTask(handlers, ctx);
    await writeFile(join(root, "src", "task-change.ts"), "export {}\n");
    const result = handlers.get("context")?.({ messages: [] }, ctx) as {
      messages: Array<{ content?: string }>;
    };
    const checkpoint = result.messages.at(-1)?.content ?? "";
    expect(checkpoint).toContain("src/task-change.ts");
    expect(checkpoint).not.toContain("src/preexisting.ts");
  });

  it("feeds an identical repeated failure into the tool result before the next decision", async () => {
    const root = await repo();
    const { handlers, ctx, statuses } = mount(root);
    startTask(handlers, ctx);
    toolCall(handlers, ctx, "call-1");
    expect(toolResult(handlers, ctx, "call-1")).toBeUndefined();
    toolCall(handlers, ctx, "call-2");
    const result = toolResult(handlers, ctx, "call-2") as {
      content: Array<{ text: string }>;
    };
    expect(result.content.at(-1)?.text).toContain("same test failure");
    expect(result.content.at(-1)?.text).toContain("rejects unsafe path");
    expect(statuses).toContainEqual([
      "plyth-integrated",
      "PLYTH recovery signal",
    ]);
  });

  it("prompt-only adds static guidance but never captures or injects task feedback", async () => {
    const root = await repo();
    const { handlers, ctx } = mount(root, false);
    const started = startTask(handlers, ctx);
    expect(started.systemPrompt).toContain(PLYTH_INTEGRATED_GUIDANCE);
    await writeFile(join(root, "changed.ts"), "export {}\n");
    expect(handlers.get("context")?.({ messages: [] }, ctx)).toBeUndefined();
    toolCall(handlers, ctx, "call-1");
    expect(toolResult(handlers, ctx, "call-1")).toBeUndefined();
  });

  it("clears task-local feedback when a session is switched or forked", async () => {
    const root = await repo();
    const { handlers, ctx } = mount(root);
    startTask(handlers, ctx);
    toolCall(handlers, ctx, "call-1");
    handlers.get("session_before_fork")?.({});
    expect(toolResult(handlers, ctx, "call-1")).toBeUndefined();
    expect(handlers.get("context")?.({ messages: [] }, ctx)).toBeUndefined();
  });

  it("rejects stale tool results after steering and after an aborted run", async () => {
    const root = await repo();
    const { handlers, ctx } = mount(root);
    startTask(handlers, ctx, "First request");
    toolCall(handlers, ctx, "old-task-call");
    startTask(handlers, ctx, "Steered follow-up");
    expect(toolResult(handlers, ctx, "old-task-call")).toBeUndefined();

    toolCall(handlers, ctx, "aborted-call");
    handlers.get("agent_settled")?.({ aborted: true }, ctx);
    expect(toolResult(handlers, ctx, "aborted-call")).toBeUndefined();
    expect(handlers.get("context")?.({ messages: [] }, ctx)).toBeUndefined();
  });
});
