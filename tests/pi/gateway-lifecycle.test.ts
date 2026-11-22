import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/pi/agent-gateway.js";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const fixture = vi.hoisted(() => {
  const entries: unknown[] = [];
  const savedSessions = new Map<string, unknown[]>();
  let rebindSession: ((session: any) => Promise<void>) | undefined;
  const session = {
    isIdle: true,
    isStreaming: false,
    sessionManager: {
      getBranch: () => entries,
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      }),
    },
    prompt: vi.fn(),
    followUp: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    model: { provider: "fixture", id: "review-model", name: "Review Model" },
    modelRuntime: {
      getModels: () => [
        { provider: "fixture", id: "review-model", name: "Review Model" },
      ],
    },
    agent: { streamFunction: vi.fn(), abort: vi.fn() },
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    getAllTools: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  return {
    session,
    dispose: vi.fn(),
    entries,
    savedSessions,
    setRebindSession(callback: typeof rebindSession) {
      rebindSession = callback;
    },
    async rebind() {
      await rebindSession?.(session);
    },
  };
});

const { session } = fixture;

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<object>()),
  createAgentSessionRuntime: async () => ({
    session,
    dispose: fixture.dispose,
    setBeforeSessionInvalidate() {},
    setRebindSession: fixture.setRebindSession,
    async newSession() {
      fixture.entries.length = 0;
      await fixture.rebind();
    },
    async fork() {
      await fixture.rebind();
      return { cancelled: false };
    },
    async switchSession(path: string) {
      fixture.entries.splice(
        0,
        fixture.entries.length,
        ...(fixture.savedSessions.get(path) ?? []),
      );
      await fixture.rebind();
      return { cancelled: false };
    },
  }),
}));

import { createPiAgentGateway } from "../../src/pi/pi-agent-gateway.js";
import { ReviewBudget } from "../../src/pi/review-budget.js";
import { PilotRunGuard } from "../../src/eval/pilot-run-guard.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  session.isIdle = true;
  session.isStreaming = false;
  session.agent.streamFunction = vi.fn();
  session.agent.abort.mockReset();
  session.prompt.mockReset();
  fixture.entries.length = 0;
  fixture.savedSessions.clear();
  session.sessionManager.appendCustomEntry.mockClear();
  fixture.setRebindSession(undefined);
});

describe("gateway run lifecycle", () => {
  it("caps review stream output without changing ordinary gateway configuration", async () => {
    const stream = vi.fn();
    session.agent.streamFunction = stream;
    await createPiAgentGateway(undefined, {
      reviewBudget: new ReviewBudget("small prompt"),
      readOnlyTools: ["read", "rook_search"],
    });
    session.agent.streamFunction(session.model, {}, { maxTokens: 9_000 });
    expect(stream).toHaveBeenCalledWith(
      session.model,
      {},
      { maxTokens: 1_000 },
    );
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "rook_search",
    ]);
    session.agent.streamFunction = stream;
    await createPiAgentGateway();
    expect(session.agent.streamFunction).toBe(stream);
  });
  it("blocks the ninth provider request and accounts for exactly eight starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-request-limit-"));
    try {
      const stream = vi.fn(() => "stream-result");
      session.agent.streamFunction = stream;
      const onProviderRequest = vi.fn();
      const violations: unknown[] = [];
      const guard = new PilotRunGuard(
        root,
        ["read", "edit", "write"],
        ["src/allowed.mjs"],
        12,
        8,
        (violation) => violations.push(violation),
      );
      await createPiAgentGateway(root, {
        pilotRunGuard: guard,
        isolatedEvaluation: true,
        maxOutputTokensPerResponse: 1000,
        onProviderRequest,
      });

      for (let request = 0; request < 8; request++)
        session.agent.streamFunction(session.model, {}, { maxTokens: 2000 });
      expect(() =>
        session.agent.streamFunction(session.model, {}, { maxTokens: 2000 }),
      ).toThrow("provider-request ceiling");

      expect(stream).toHaveBeenCalledTimes(8);
      expect(onProviderRequest).toHaveBeenCalledTimes(8);
      expect(onProviderRequest).toHaveBeenLastCalledWith(8);
      expect(guard.requestCount()).toBe(8);
      expect(violations).toEqual([
        { kind: "provider_request_limit", limit: 8 },
      ]);
      expect(session.agent.abort).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("activates only the pilot allowlist and denies out-of-scope mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-tool-allowlist-"));
    try {
      const violations: unknown[] = [];
      const guard = new PilotRunGuard(
        root,
        ["read", "edit", "write"],
        ["src/allowed.mjs"],
        12,
        8,
        (violation) => violations.push(violation),
      );
      await createPiAgentGateway(root, {
        pilotRunGuard: guard,
        isolatedEvaluation: true,
      });

      expect(session.setActiveToolsByName).toHaveBeenLastCalledWith([
        "read",
        "edit",
        "write",
      ]);
      expect(guard.admitToolCall("write", { path: "status.md" })).toBe(false);
      expect(guard.admitToolCall("bash", { command: "anything" })).toBe(false);
      expect(violations).toEqual([
        {
          kind: "write_path_not_allowed",
          toolName: "write",
          path: "status.md",
        },
        { kind: "tool_not_allowed", toolName: "bash" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(["newSession", "fork", "resumeSession", "compact", "send"] as const)(
    "discards late review delivery after %s changes the task/session",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), "rook-review-lifecycle-"));
      try {
        await mkdir(join(root, "node_modules"), { recursive: true });
        await symlink(
          join(process.cwd(), "node_modules", "plyth-core"),
          join(root, "node_modules", "plyth-core"),
          "dir",
        );
        execFileSync("git", ["init", "-q"], { cwd: root });
        await writeFile(join(root, "source.ts"), "export const value = 1;\n");
        execFileSync("git", ["add", "source.ts"], { cwd: root });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "initial",
          ],
          { cwd: root },
        );
        await writeFile(join(root, "source.ts"), "export const value = 2;\n");
        const gateway = await createPiAgentGateway(root);
        let finish!: () => void;
        session.prompt.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
        const pending = gateway.reviewGitChanges({
          focus: "simplicity",
          paths: ["source.ts"],
          taskContext: "Update value.",
        });
        await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
        if (action === "fork") await gateway.fork("entry");
        else if (action === "resumeSession")
          await gateway.resumeSession("saved");
        else if (action === "send")
          await gateway.send("Different requirements.");
        else await gateway[action]();
        finish();
        expect(await pending).toContain("Review discarded:");
        expect(gateway.isRunning()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("honors explicit PLYTH off mode and refuses enabling its trace recorder", async () => {
    vi.stubEnv("ROOK_PLYTH_INTEGRATED", "off");
    vi.stubEnv("ROOK_PLYTH_MODE", "off");
    vi.stubEnv("ROOK_PLYTH_FEEDBACK", "1");
    const gateway = await createPiAgentGateway();
    expect(gateway.getPlythMode?.()).toBe("off");
    expect(gateway.controlPlythTrace?.("on")).toContain("PLYTH is disabled");
    expect(gateway.getPlythStats().baseline).toMatchObject({
      comparisons: 0,
      unavailable: 0,
    });
  });
  it("owns preflight busy state, keeps follow-ups explicit, and releases failed runs", async () => {
    const gateway = await createPiAgentGateway();
    let rejectRun!: (error: Error) => void;
    session.prompt.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectRun = reject;
        }),
    );
    const events: AgentEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    expect(gateway.isRunning()).toBe(false);
    const pending = gateway.send("small edit");
    expect(gateway.isRunning()).toBe(true);
    expect(() => gateway.setMode("build")).toThrow("active run");
    expect(session.prompt).toHaveBeenCalledWith("small edit", {
      streamingBehavior: "followUp",
    });
    session.isStreaming = true;
    session.isIdle = false;
    await gateway.send("next task", "follow_up");
    expect(session.followUp).toHaveBeenCalledWith("next task");
    expect(gateway.isRunning()).toBe(true);
    rejectRun(new Error("504 <html>Gateway Time-out</html>"));
    await expect(pending).rejects.toThrow("Provider timed out (504)");
    // A rejected call alone does not override Pi's own busy state.
    expect(gateway.isRunning()).toBe(true);
    session.isStreaming = false;
    session.isIdle = true;
    expect(gateway.isRunning()).toBe(false);
    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        message: expect.stringContaining("Provider timed out (504)"),
      },
    ]);
    gateway.setMode("build");
  });

  it("does not mark an active run failed when a queue operation is rejected", async () => {
    const gateway = await createPiAgentGateway();
    const events: AgentEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    events.length = 0;
    await expect(gateway.send("correction", "steer")).rejects.toThrow(
      "only available",
    );
    expect(events).toEqual([]);
  });

  it("restores incomplete checklists on resume and keeps them across prompts", async () => {
    const tasks = [
      { id: "implement", title: "Implement change", status: "in_progress" },
    ];
    fixture.savedSessions.set("saved-session", [
      {
        type: "custom",
        customType: "rook_task_checklist",
        data: { tasks },
      },
    ]);
    const gateway = await createPiAgentGateway();
    const events: AgentEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    events.length = 0;

    await gateway.resumeSession("saved-session");
    expect(events).toContainEqual({ type: "todo_updated", tasks });

    events.length = 0;
    session.sessionManager.appendCustomEntry.mockClear();
    await gateway.send("continue implementing");
    expect(session.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({ type: "todo_updated", tasks: [] });
  });

  it("clears completed checklists for a new task and isolates new and forked sessions", async () => {
    const completedTasks = [
      { id: "done", title: "Finished task", status: "completed" },
    ];
    fixture.savedSessions.set("completed-session", [
      {
        type: "custom",
        customType: "rook_task_checklist",
        data: { tasks: completedTasks },
      },
    ]);
    const gateway = await createPiAgentGateway();
    const events: AgentEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    await gateway.resumeSession("completed-session");
    events.length = 0;

    await gateway.send("a new task");

    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "rook_task_checklist",
      { tasks: [] },
    );
    expect(events).toContainEqual({ type: "todo_updated", tasks: [] });

    const activeTasks = [
      { id: "next", title: "Next task", status: "in_progress" },
    ];
    session.sessionManager.appendCustomEntry("rook_task_checklist", {
      tasks: activeTasks,
    });
    await gateway.fork("fork-point");
    expect(events.at(-1)).toEqual({ type: "todo_updated", tasks: [] });
    expect(
      events.filter((event) => event.type === "todo_updated"),
    ).not.toContainEqual({ type: "todo_updated", tasks: activeTasks });
    expect(fixture.entries.at(-1)).toMatchObject({
      customType: "rook_task_checklist",
      data: { tasks: [] },
    });

    session.sessionManager.appendCustomEntry("rook_task_checklist", {
      tasks: activeTasks,
    });
    await gateway.newSession();
    expect(events.at(-1)).toEqual({ type: "todo_updated", tasks: [] });
  });
});
