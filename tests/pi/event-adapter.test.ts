import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { adaptPiEvent } from "../../src/pi/event-adapter.js";

const piEvent = (event: object): AgentSessionEvent =>
  event as AgentSessionEvent;

describe("Pi event adapter", () => {
  it("counts assistant attempts without exposing thinking content", () => {
    expect(
      adaptPiEvent(
        piEvent({ type: "message_start", message: { role: "assistant" } }),
      ),
    ).toEqual([{ type: "model_request_started" }]);
    expect(
      adaptPiEvent(
        piEvent({ type: "message_start", message: { role: "user" } }),
      ),
    ).toEqual([]);
  });

  it("labels inspection actions and reports categorized failures without raw output", () => {
    expect(
      adaptPiEvent(
        piEvent({
          type: "tool_execution_start",
          toolCallId: "git",
          toolName: "rook_inspect",
          args: { action: "show" },
        }),
      ),
    ).toEqual([
      {
        type: "tool_started",
        id: "git",
        name: "rook_inspect",
        summary: "show",
      },
    ]);
    const events = adaptPiEvent(
      piEvent({
        type: "tool_execution_end",
        toolCallId: "git",
        toolName: "rook_inspect",
        isError: true,
        result: {
          content: [
            { type: "text", text: "fatal: invalid object HEAD:private-name" },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "tool_finished",
        id: "git",
        status: "error",
        error: "Revision or file was not found.",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-name");
  });
  it("maps text deltas and authoritative assistant messages", () => {
    expect(
      adaptPiEvent(
        piEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial" },
        }),
      ),
    ).toEqual([{ type: "text_delta", text: "partial" }]);

    expect(
      adaptPiEvent(
        piEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "final answer" },
              { type: "thinking", thinking: "private reasoning" },
            ],
            usage: { input: 12, output: 4 },
            stopReason: "stop",
          },
        }),
      ),
    ).toEqual([
      { type: "message_complete", text: "final answer" },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
    ]);
  });

  it("maps tool lifecycle without exposing raw arguments or results", () => {
    expect(
      adaptPiEvent(
        piEvent({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "write",
          args: { path: "src/index.ts", content: "sensitive" },
        }),
      ),
    ).toEqual([
      {
        type: "tool_started",
        id: "tool-1",
        name: "write",
        summary: "src/index.ts",
      },
    ]);
    expect(
      adaptPiEvent(
        piEvent({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "write",
          result: { content: "sensitive" },
          isError: true,
        }),
      ),
    ).toEqual([{ type: "tool_finished", id: "tool-1", status: "error" }]);
  });

  it("hides internal checklist tool lifecycle events", () => {
    expect(
      adaptPiEvent(
        piEvent({
          type: "tool_execution_start",
          toolCallId: "todo-1",
          toolName: "rook_todo",
          args: { tasks: [] },
        }),
      ),
    ).toEqual([]);
    expect(
      adaptPiEvent(
        piEvent({
          type: "tool_execution_end",
          toolCallId: "todo-1",
          toolName: "rook_todo",
          result: { content: [] },
          isError: false,
        }),
      ),
    ).toEqual([]);
  });

  it("preserves cancellation as an aborted settlement", () => {
    expect(
      adaptPiEvent(piEvent({ type: "agent_settled", aborted: true })),
    ).toEqual([{ type: "run_settled", aborted: true }]);
  });
});
