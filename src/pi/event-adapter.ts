import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "./agent-gateway.js";
import { TASK_CHECKLIST_TOOL_NAME } from "./task-checklist.js";

export function adaptPiEvent(event: AgentSessionEvent): AgentEvent[] {
  switch (event.type) {
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? [{ type: "text_delta", text: event.assistantMessageEvent.delta }]
        : [];
    case "message_end": {
      if (event.message.role !== "assistant") return [];
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const mapped: AgentEvent[] = [];
      if (text) mapped.push({ type: "message_complete", text });
      if (event.message.usage) {
        mapped.push({
          type: "usage",
          inputTokens: event.message.usage.input,
          outputTokens: event.message.usage.output,
        });
      }
      if (event.message.stopReason === "error") {
        mapped.push({
          type: "error",
          message: event.message.errorMessage ?? "The model request failed.",
        });
      }
      return mapped;
    }
    case "tool_execution_start":
      if (event.toolName === TASK_CHECKLIST_TOOL_NAME) return [];
      return [
        {
          type: "tool_started",
          id: event.toolCallId,
          name: event.toolName,
          summary: summarizeTool(event.toolName, event.args),
        },
      ];
    case "tool_execution_end":
      if (event.toolName === TASK_CHECKLIST_TOOL_NAME) return [];
      return [
        {
          type: "tool_finished",
          id: event.toolCallId,
          status: event.isError ? "error" : "ok",
        },
      ];
    case "agent_settled":
      return [{ type: "run_settled", aborted: event.aborted }];
    default:
      return [];
  }
}

function summarizeTool(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : name;
}
