import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/pi/agent-gateway.js";

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
    getAllTools: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  return {
    session,
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  session.isIdle = true;
  session.isStreaming = false;
  session.prompt.mockReset();
  fixture.entries.length = 0;
  fixture.savedSessions.clear();
  session.sessionManager.appendCustomEntry.mockClear();
  fixture.setRebindSession(undefined);
});

describe("gateway run lifecycle", () => {
  it("honors explicit PLYTH off mode and refuses enabling its trace recorder", async () => {
    vi.stubEnv("ROOK_PLYTH_MODE", "off");
    vi.stubEnv("ROOK_PLYTH_FEEDBACK", "1");
    const gateway = await createPiAgentGateway();
    expect(gateway.getPlythMode?.()).toBe("off");
    expect(gateway.controlPlythTrace?.("on")).toContain("PLYTH is off");
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
