import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "./agent-gateway.js";
import { TASK_CHECKLIST_TOOL_NAME } from "./task-checklist.js";
import { formatAgentError } from "./errors.js";

export function adaptPiEvent(event: AgentSessionEvent): AgentEvent[] {
  switch (event.type) {
    case "message_start":
      return event.message.role === "assistant"
        ? [{ type: "model_request_started" }]
        : [];
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
      if (text)
        mapped.push({
          type: "message_complete",
          text,
          stopReason: event.message.stopReason,
        });
      if (event.message.usage) {
        mapped.push({
          type: "usage",
          inputTokens: event.message.usage.input,
          outputTokens: event.message.usage.output,
          stopReason: event.message.stopReason,
        });
      }
      if (event.message.stopReason === "error") {
        mapped.push({
          type: "error",
          message: formatAgentError(
            event.message.errorMessage ?? "The model request failed.",
          ),
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
          ...(event.isError && event.toolName === "rook_inspect"
            ? { error: inspectionError(event.result) }
            : {}),
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
  if (name === "rook_inspect") {
    const action = (args as Record<string, unknown>).action;
    return typeof action === "string" ? action : name;
  }
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : name;
}

function inspectionError(result: unknown): string {
  // Categorize errors without exposing raw tool output or repository contents.
  const text = JSON.stringify(result) ?? "";
  if (/Revision must/.test(text))
    return "Use HEAD, HEAD~N, HEAD^N, or a commit hash.";
  if (/safe repository-relative path/.test(text))
    return "Use a safe repository-relative file path.";
  if (/files only/.test(text)) return "Expected a file, not a directory.";
  if (/not a git repository/i.test(text))
    return "This workspace is not a Git repository.";
  if (
    /invalid object|bad object|does not exist|not exist|unknown revision/i.test(
      text,
    )
  )
    return "Revision or file was not found.";
  return "Git inspection failed; check action, revision, and path.";
}
