import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/pi/agent-gateway.js";

const session = vi.hoisted(() => ({
  isIdle: true,
  isStreaming: false,
  sessionManager: {
    getBranch: () => [],
    appendCustomEntry: vi.fn(),
  },
  prompt: vi.fn(),
  followUp: vi.fn(),
  steer: vi.fn(),
  abort: vi.fn(),
  setActiveToolsByName: vi.fn(),
  bindExtensions: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<object>()),
  createAgentSessionRuntime: async () => ({
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
  }),
}));

import { createPiAgentGateway } from "../../src/pi/pi-agent-gateway.js";

afterEach(() => {
  vi.clearAllMocks();
  session.isIdle = true;
  session.isStreaming = false;
  session.prompt.mockReset();
});

describe("gateway run lifecycle", () => {
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

  it("records a checklist reset at the start of a new user task", async () => {
    const gateway = await createPiAgentGateway();
    const events: AgentEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    events.length = 0;

    await gateway.send("a new task");

    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "rook_task_checklist",
      { tasks: [] },
    );
    expect(events).toContainEqual({ type: "todo_updated", tasks: [] });
  });
});
