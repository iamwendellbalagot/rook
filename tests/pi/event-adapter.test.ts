import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { adaptPiEvent } from "../../src/pi/event-adapter.js";

const piEvent = (event: object): AgentSessionEvent =>
  event as AgentSessionEvent;

describe("Pi event adapter", () => {
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

  it("preserves cancellation as an aborted settlement", () => {
    expect(
      adaptPiEvent(piEvent({ type: "agent_settled", aborted: true })),
    ).toEqual([{ type: "run_settled", aborted: true }]);
  });
});
