import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CommandHistoryBaseline, SessionCounter } from "plyth";
import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  createPlythObserveExtension,
} from "../../src/pi/plyth-observe.js";

function eventHandlers(
  counter: SessionCounter,
  options?: Parameters<typeof createPlythObserveExtension>[1],
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
    expect(before.systemPrompt).toContain("PLYTH prediction guidance");
    expect(before.systemPrompt).toContain(
      "known test name or stable error label",
    );
    expect(before.systemPrompt).toContain(
      "when the result is genuinely uncertain",
    );

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
    const traces: unknown[] = [];
    const { handlers, ctx } = eventHandlers(counter, {
      feedback: true,
      trace: { append: (record) => traces.push(record) },
    });
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
    handlers.get("tool_execution_end")?.(
      { toolName: "bash", toolCallId: "feedback-miss", durationMs: 10 },
      ctx,
    );
    expect(traces[0]).toMatchObject({
      mode: "feedback",
      verdict: "miss",
      feedbackAppended: true,
    });
  });

  it("matches Node test evidence only against tests with matching status", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter, { feedback: true });
    const output = [
      "✔ accepts the lowest valid port (0.3ms)",
      "✖ rejects port zero (0.4ms)",
      "✔ rejects fractional ports (0.05ms)",
      "ℹ tests 3",
      "ℹ pass 2",
      "ℹ fail 1",
    ].join("\n");
    const passingOutput = [
      "✔ rejects port zero (0.3ms)",
      "✔ rejects fractional ports (0.05ms)",
      "ℹ tests 2",
      "ℹ pass 2",
      "ℹ fail 0",
    ].join("\n");

    const run = (
      toolCallId: string,
      outcome: "pass" | "fail",
      evidence: string,
      exitCode: number,
      resultOutput = output,
    ) => {
      handlers.get("tool_call")?.(
        {
          toolName: "bash",
          toolCallId,
          input: {
            command: "node --test tests/port.test.mjs",
            expect: { outcome, evidence },
          },
        },
        ctx,
      );
      return handlers.get("tool_result")?.(
        {
          toolName: "bash",
          toolCallId,
          input: {
            command: "node --test tests/port.test.mjs",
            expect: { outcome, evidence },
          },
          content: [{ type: "text", text: resultOutput }],
          structuredContent: {
            exit_code: exitCode,
            output: resultOutput,
            truncated: false,
          },
          isError: exitCode !== 0,
        },
        ctx,
      ) as { content: { text?: string }[] } | undefined;
    };

    const wrongStatusEvidence = run(
      "passing-test-evidence",
      "fail",
      "rejects fractional ports",
      1,
    );
    expect(wrongStatusEvidence?.content.at(-1)?.text).toContain("PLYTH:");

    expect(
      run("failing-test-evidence", "fail", "rejects port zero", 1),
    ).toBeUndefined();
    expect(
      run(
        "successful-test-evidence",
        "pass",
        "rejects fractional ports",
        0,
        passingOutput,
      ),
    ).toBeUndefined();
    expect(counter.predictionStats().verdicts).toEqual({
      hit: 2,
      miss: 1,
      vague: 0,
      none: 0,
      unscorable: 0,
    });
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

  it("does not turn an evidence-label budget limit into a false miss or feedback", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter, { feedback: true });
    const input = {
      command: "npm test",
      expect: { outcome: "fail", evidence: "case 17" },
    };
    handlers.get("tool_call")?.(
      { toolName: "bash", toolCallId: "limited", input },
      ctx,
    );
    const output = Array.from(
      { length: 18 },
      (_, i) => `✖ case ${i} (0.2ms)`,
    ).join("\n");
    expect(
      handlers.get("tool_result")?.(
        {
          toolName: "bash",
          toolCallId: "limited",
          input,
          content: [{ type: "text", text: output }],
          structuredContent: { exit_code: 1, output, truncated: false },
        },
        ctx,
      ),
    ).toBeUndefined();
    expect(counter.snapshot()).toMatchObject({ vague: 1, miss: 0 });
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

  it("compares unchanged command history, invalidates edits and exports only minimal trace fields", () => {
    const counter = new SessionCounter();
    const baseline = new CommandHistoryBaseline();
    const records: unknown[] = [];
    let revision = "a";
    const { handlers, ctx } = eventHandlers(counter, {
      baseline,
      workspaceRevision: () => revision,
      trace: { append: (record) => records.push(record) },
    });
    const run = (id: string) => {
      const input = {
        command: "node --test tests/private-name.test.mjs",
        expect: { outcome: "pass", evidence: "private test label" },
      };
      handlers.get("tool_call")?.(
        { toolName: "bash", toolCallId: id, input },
        ctx,
      );
      handlers.get("tool_result")?.(
        {
          toolName: "bash",
          toolCallId: id,
          input,
          content: [{ type: "text", text: "private test label" }],
          structuredContent: {
            exit_code: 0,
            output: "✔ private test label (0.2ms)",
            truncated: false,
          },
        },
        ctx,
      );
      handlers.get("tool_execution_end")?.(
        { toolName: "bash", toolCallId: id, durationMs: 123 },
        ctx,
      );
    };
    run("first");
    run("second");
    expect(baseline.snapshot()).toMatchObject({
      comparisons: 1,
      baselineCorrect: 1,
      agentCorrect: 1,
    });
    handlers.get("tool_call")?.(
      { toolName: "edit", toolCallId: "edit", input: { path: "src/a.ts" } },
      ctx,
    );
    run("after-edit");
    expect(baseline.snapshot().comparisons).toBe(1);
    revision = "external-change";
    run("after-external-change");
    expect(baseline.snapshot().comparisons).toBe(1);
    expect(records).toHaveLength(4);
    expect(records[1]).toMatchObject({
      protocol: "plyth/trace/1",
      verdict: "hit",
      baselineComparable: true,
      durationBucket: "lt1s",
    });
    expect(JSON.stringify(records)).not.toMatch(
      /private|test-session|node --test|src\/a/,
    );
    handlers.get("session_start")?.({}, ctx);
    run("new-session");
    expect(baseline.snapshot().comparisons).toBe(0);
    expect((records[4] as { sessionKey: string }).sessionKey).not.toBe(
      (records[0] as { sessionKey: string }).sessionKey,
    );
  });

  it("fails open when snapshots or trace storage fail, and ignores duplicate results", () => {
    const counter = new SessionCounter();
    const { handlers, ctx } = eventHandlers(counter, {
      workspaceRevision: () => {
        throw new Error("snapshot failed");
      },
      trace: {
        append: () => {
          throw new Error("disk failed");
        },
      },
    });
    const input = {
      command: "npm test",
      expect: { outcome: "pass", evidence: "done" },
    };
    handlers.get("tool_call")?.(
      { toolName: "bash", toolCallId: "one", input },
      ctx,
    );
    const result = {
      toolName: "bash",
      toolCallId: "one",
      input,
      content: [{ type: "text", text: "done" }],
      structuredContent: { exit_code: 0, output: "done", truncated: false },
    };
    expect(() => handlers.get("tool_result")?.(result, ctx)).not.toThrow();
    handlers.get("tool_result")?.(result, ctx);
    expect(() =>
      handlers.get("tool_execution_end")?.(
        { toolName: "bash", toolCallId: "one", durationMs: 1 },
        ctx,
      ),
    ).not.toThrow();
    expect(counter.snapshot().hit).toBe(1);
  });
});
