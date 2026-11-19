import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionCounter } from "plyth";
import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  createPlythObserveExtension,
} from "../../src/pi/plyth-observe.js";

function eventHandlers(
  counter: SessionCounter,
  options?: { feedback?: boolean },
) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const extension = createPlythObserveExtension(counter, options);
  if (typeof extension === "function")
    throw new Error("Expected a named extension.");
  extension.factory({
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    sessionManager: { getSessionId: () => "test-session" },
  };
  return { handlers, ctx };
}

describe("PLYTH Rook observe-only adapter", () => {
  it("classifies only simple supported test, build, and diagnostic commands", () => {
    expect(classifyCommand("npm test")).toBe("test");
    expect(classifyCommand("pnpm run test:unit")).toBe("test");
    expect(classifyCommand("node --test")).toBe("test");
    expect(classifyCommand("node --test tests/retry.test.mjs")).toBe("test");
    expect(classifyCommand("npm run build")).toBe("build");
    expect(classifyCommand("npx tsc --noEmit")).toBe("diagnostic");
    expect(classifyCommand("npm test && rm -rf build")).toBe("other");
    expect(
      classifyCommand("node --test tests/retry.test.mjs && rm -rf build"),
    ).toBe("other");
    expect(classifyCommand("npm\ntest")).toBe("other");
    expect(classifyCommand("git status")).toBe("other");
  });

  it("records verdicts and coverage without changing any tool result", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter);
    const before = handlers.get("before_agent_start")?.({
      systemPrompt: "base prompt",
    }) as { systemPrompt: string };
    expect(before.systemPrompt).toContain(
      "PLYTH observe-only prediction guidance",
    );
    expect(before.systemPrompt).toContain("Omit expect when uncertain");

    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: {
          command: "npm test",
          expect: { outcome: "pass", evidence: "suite passed" },
        },
      },
      ctx,
    );
    const event = {
      toolName: "bash",
      toolCallId: "call-1",
      input: {
        command: "npm test",
        expect: { outcome: "pass", evidence: "suite passed" },
      },
      content: [{ type: "text", text: "suite passed" }],
      structuredContent: {
        exit_code: 0,
        output: "suite passed",
        truncated: false,
      },
      isError: false,
    };
    expect(handlers.get("tool_result")?.(event, ctx)).toBeUndefined();
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "call-1",
        result: {},
        isError: false,
        durationMs: 50,
      },
      ctx,
    );
    expect(counter.predictionStats()).toEqual({
      eligibleCommands: 1,
      predictedCommands: 1,
      invalidPredictions: 0,
      specificPredictions: 1,
      durationMs: 50,
      durationSamples: 1,
      verdicts: { hit: 1, miss: 0, vague: 0, none: 0, unscorable: 0 },
    });

    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "call-2",
        input: {
          command: "npm run build",
          expect: { outcome: "fail", evidence: "compile error" },
        },
      },
      ctx,
    );
    handlers.get("tool_result")?.(
      {
        ...event,
        toolCallId: "call-2",
        input: {
          command: "npm run build",
          expect: { outcome: "fail", evidence: "compile error" },
        },
        structuredContent: {
          exit_code: 0,
          output: "build succeeded",
          truncated: false,
        },
      },
      ctx,
    );
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "call-2",
        result: {},
        isError: false,
        durationMs: 70,
      },
      ctx,
    );
    expect(counter.predictionStats().verdicts.miss).toBe(1);

    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "call-3",
        input: {
          command: "npx tsc --noEmit",
          expect: { outcome: "pass", evidence: "no diagnostics" },
        },
      },
      ctx,
    );
    handlers.get("tool_result")?.(
      {
        ...event,
        toolCallId: "call-3",
        structuredContent: undefined,
        isError: true,
      },
      ctx,
    );
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "call-3",
        result: { content: [] },
        isError: true,
      },
      ctx,
    );
    expect(counter.predictionStats().verdicts.unscorable).toBe(1);
  });

  it("adds bounded advisory feedback only when explicitly enabled", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter, { feedback: true });
    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "feedback-miss",
        input: {
          command: "npm run build",
          expect: { outcome: "fail", evidence: "compile error" },
        },
      },
      ctx,
    );
    const structuredContent = {
      exit_code: 0,
      output: "build succeeded",
      truncated: false,
    };
    const result = handlers.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "feedback-miss",
        input: {
          command: "npm run build",
          expect: { outcome: "fail", evidence: "compile error" },
        },
        content: [{ type: "text", text: "build succeeded" }],
        structuredContent,
        isError: false,
      },
      ctx,
    ) as {
      content: { type: string; text?: string }[];
      structuredContent: unknown;
    };

    expect(result.content).toHaveLength(2);
    const feedbackItem = result.content.at(1);
    expect(feedbackItem?.text).toContain("PLYTH:");
    expect(feedbackItem?.text).toContain("Expected `fail`");
    expect(result.structuredContent).toBe(structuredContent);
    expect(counter.predictionStats().verdicts.miss).toBe(1);
  });

  it("keeps truncated evidence vague and counts omitted predictions", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter);
    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "truncated",
        input: {
          command: "npm test",
          expect: { outcome: "pass", evidence: "retry passed" },
        },
      },
      ctx,
    );
    handlers.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "truncated",
        input: { command: "npm test" },
        content: [{ type: "text", text: "truncated output" }],
        structuredContent: {
          exit_code: 0,
          output: "[truncated]",
          truncated: true,
        },
        isError: false,
      },
      ctx,
    );
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "truncated",
        result: {},
        isError: false,
        durationMs: 123,
      },
      ctx,
    );

    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "unpredicted",
        input: { command: "npm test" },
      },
      ctx,
    );
    handlers.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "unpredicted",
        input: { command: "npm test" },
        content: [{ type: "text", text: "test output" }],
        structuredContent: {
          exit_code: 0,
          output: "test output",
          truncated: false,
        },
        isError: false,
      },
      ctx,
    );
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "unpredicted",
        result: {},
        isError: false,
        durationMs: 10,
      },
      ctx,
    );

    expect(counter.predictionStats()).toEqual({
      eligibleCommands: 2,
      predictedCommands: 1,
      invalidPredictions: 0,
      specificPredictions: 1,
      durationMs: 133,
      durationSamples: 2,
      verdicts: { hit: 0, miss: 0, vague: 1, none: 1, unscorable: 0 },
    });
  });

  it("counts malformed predictions without scoring or rejecting the tool call", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter);
    handlers.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "invalid",
        input: { command: "npm test", expect: { outcome: "later" } },
      },
      ctx,
    );
    handlers.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "invalid",
        input: { command: "npm test" },
        content: [{ type: "text", text: "test passed" }],
        structuredContent: {
          exit_code: 0,
          output: "test passed",
          truncated: false,
        },
        isError: false,
      },
      ctx,
    );
    handlers.get("tool_execution_end")?.(
      {
        toolName: "bash",
        toolCallId: "invalid",
        result: {},
        isError: false,
        durationMs: 25,
      },
      ctx,
    );
    expect(counter.predictionStats()).toMatchObject({
      eligibleCommands: 1,
      predictedCommands: 1,
      invalidPredictions: 1,
      specificPredictions: 0,
      verdicts: { unscorable: 1 },
    });
  });

  it("resets in-memory stats on a new session", () => {
    const counter = new SessionCounter();
    counter.recordEligible({ outcome: "pass", evidence: "done" });
    const { handlers, ctx } = eventHandlers(counter);
    handlers.get("session_start")?.(
      { type: "session_start", reason: "new" },
      ctx,
    );
    expect(counter.predictionStats()).toEqual({
      eligibleCommands: 0,
      predictedCommands: 0,
      invalidPredictions: 0,
      specificPredictions: 0,
      durationMs: 0,
      durationSamples: 0,
      verdicts: { hit: 0, miss: 0, vague: 0, none: 0, unscorable: 0 },
    });
  });
});
