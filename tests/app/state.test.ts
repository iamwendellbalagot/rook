import { describe, expect, it } from "vitest";
import { initialAppState, reduceAppState } from "../../src/app/state.js";

describe("app state reducer", () => {
  it("moves through startup, ready, and auth-required phases", () => {
    const startup = initialAppState();
    expect(startup.phase).toBe("startup");
    expect(reduceAppState(startup, { type: "startup_complete" }).phase).toBe(
      "ready",
    );
    expect(reduceAppState(startup, { type: "auth_required" }).phase).toBe(
      "auth_required",
    );
    expect(
      reduceAppState(reduceAppState(startup, { type: "auth_required" }), {
        type: "auth_complete",
      }).phase,
    ).toBe("ready");
  });

  it("handles running, settled, and idle states and ignores late deltas", () => {
    const ready = reduceAppState(initialAppState(), {
      type: "startup_complete",
    });
    const running = reduceAppState(ready, { type: "prompt_submitted" });
    const streamed = reduceAppState(running, {
      type: "text_delta",
      text: "answer",
    });
    const settled = reduceAppState(streamed, {
      type: "run_state",
      state: "settled",
    });

    expect(running.runState).toBe("running");
    expect(settled.runState).toBe("settled");
    expect(settled.response).toBe("answer");
    expect(
      reduceAppState(settled, { type: "text_delta", text: " late" }).response,
    ).toBe("answer");
    expect(
      reduceAppState(settled, { type: "run_state", state: "idle" }).runState,
    ).toBe("idle");
  });

  it("blocks overlapping prompts and mode changes during a run", () => {
    const ready = reduceAppState(initialAppState(), {
      type: "startup_complete",
    });
    const running = reduceAppState(ready, { type: "prompt_submitted" });

    expect(reduceAppState(running, { type: "prompt_submitted" })).toBe(running);
    expect(
      reduceAppState(running, { type: "mode_changed", mode: "plan" }).mode,
    ).toBe("build");
  });

  it("records final messages, tools, usage, and failure state", () => {
    let state = reduceAppState(initialAppState(), { type: "startup_complete" });
    state = reduceAppState(state, { type: "prompt_submitted" });
    state = reduceAppState(state, {
      type: "text_delta",
      text: "partial",
    });
    state = reduceAppState(state, {
      type: "message_complete",
      text: "final",
    });
    state = reduceAppState(state, {
      type: "tool_started",
      tool: { id: "tool-1", name: "read", summary: "Read file" },
    });
    state = reduceAppState(state, {
      type: "tool_finished",
      id: "tool-1",
      status: "ok",
    });
    state = reduceAppState(state, {
      type: "usage",
      inputTokens: 12,
      outputTokens: 4,
    });

    expect(state.response).toBe("final");
    expect(state.tools[0]?.status).toBe("ok");
    expect(state.usage).toEqual({ inputTokens: 12, outputTokens: 4 });

    const failed = reduceAppState(state, {
      type: "error",
      message: "provider unavailable",
    });
    expect(failed.runState).toBe("failed");
    expect(failed.error).toBe("provider unavailable");
    expect(reduceAppState(failed, { type: "prompt_submitted" }).runState).toBe(
      "running",
    );
  });

  it("ignores events after shutdown", () => {
    const disposed = reduceAppState(initialAppState(), { type: "shutdown" });
    expect(reduceAppState(disposed, { type: "startup_complete" })).toBe(
      disposed,
    );
  });
});
