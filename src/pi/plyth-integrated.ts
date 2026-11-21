import { createHash } from "node:crypto";
import {
  isBashToolResult,
  isToolCallEventType,
  type ExtensionContext,
  type ExtensionAPI,
  type InlineExtension,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  captureChangeReview,
  captureReviewBoundary,
  type ReviewBoundary,
} from "./plan-inspection-tool.js";
import { classifyCommand, evidenceLabelsFromOutput } from "./plyth-observe.js";
import type { PlythRuntime } from "./plyth-contracts.js";

type IntegratedCommandClass = "test" | "build" | "diagnostic";
interface IntegratedContextBlock {
  kind: "change-checkpoint" | "recovery" | "verification-stale";
  key: string;
  text: string;
}

export const PLYTH_INTEGRATED_GUIDANCE =
  "Make the smallest change that satisfies the request. Reuse existing project facilities when they fit; do not add speculative abstractions, dependencies, or tests. Preserve correctness, security, compatibility, concurrency, cancellation, cleanup, observability, and meaningful coverage. Do not remove behavior or tests merely to reduce code.";

interface PendingCommand {
  taskId: string;
  commandKey: string;
  commandClass: IntegratedCommandClass;
}

type ToolResultExtensionAPI = Pick<ExtensionAPI, "on"> & {
  on(
    event: "tool_result",
    handler: (event: ToolResultEvent, ctx: ExtensionContext) => unknown,
  ): () => void;
};

export function createPlythIntegratedExtension(
  cwd: string,
  plyth: PlythRuntime,
  flow = new plyth.IntegratedPlythFlow(),
  integrated = true,
): InlineExtension {
  return {
    name: "rook-plyth-integrated",
    factory(pi: ExtensionAPI) {
      let taskId: string | undefined;
      let taskText = "";
      let boundary: ReviewBoundary | undefined;
      let sequence = 0;
      const pendingCommands = new Map<string, PendingCommand>();
      const maxPendingCommands = 64;

      const clear = () => {
        taskId = undefined;
        taskText = "";
        boundary = undefined;
        pendingCommands.clear();
        flow.clear();
      };

      const currentScope = () => {
        if (!taskId || !boundary) return undefined;
        try {
          return captureChangeReview(cwd, taskText, boundary);
        } catch {
          return undefined;
        }
      };

      pi.on("session_start", clear);
      pi.on("session_before_switch", clear);
      pi.on("session_before_fork", clear);
      pi.on("session_before_compact", clear);
      pi.on("agent_settled", (event) => {
        if (event.aborted) clear();
      });

      pi.on("before_agent_start", (event, ctx) => {
        if (event.messageType !== "user") return;
        const guidance = {
          systemPrompt: `${event.systemPrompt}\n\nPLYTH integrated guidance: ${PLYTH_INTEGRATED_GUIDANCE}`,
        };
        if (!integrated) return guidance;
        clear();
        sequence++;
        taskId = `${ctx.sessionManager.getSessionId()}:${sequence}`;
        taskText = event.prompt.slice(0, 6_000);
        try {
          boundary = captureReviewBoundary(cwd);
          const initial = captureChangeReview(cwd, taskText, boundary);
          flow.beginTask(taskId, taskText, initial.scope.revision);
        } catch {
          boundary = undefined;
          flow.beginTask(taskId, taskText);
        }
        return guidance;
      });

      pi.on("tool_call", (event) => {
        if (
          !integrated ||
          !taskId ||
          pendingCommands.size >= maxPendingCommands ||
          !isToolCallEventType("bash", event)
        )
          return;
        const command = event.input.command;
        if (typeof command !== "string") return;
        const commandClass = classifyCommand(command);
        if (commandClass === "other") return;
        pendingCommands.set(event.toolCallId, {
          taskId,
          commandClass,
          commandKey: digest(command.trim().replace(/[ \t]+/g, " ")),
        });
      });

      (pi as ToolResultExtensionAPI).on("tool_result", (event, ctx) => {
        if (!integrated) return;
        if (!isBashToolResult(event)) return;
        const pending = pendingCommands.get(event.toolCallId);
        pendingCommands.delete(event.toolCallId);
        if (!pending || pending.taskId !== taskId || event.isError) return;
        const structured = asRecord(event.structuredContent);
        const exitCode = structured?.exit_code;
        const output = structured?.output;
        if (
          typeof exitCode !== "number" ||
          !Number.isInteger(exitCode) ||
          typeof output !== "string" ||
          structured?.truncated === true
        )
          return;

        const scope = currentScope();
        if (scope)
          flow.observeWorkspace(
            pending.taskId,
            scope.scope.revision,
            scope.scope.paths,
          );
        const parsed = evidenceLabelsFromOutput(
          output,
          pending.commandClass,
          exitCode === 0 ? "pass" : "fail",
        );
        if (!parsed || parsed.limited || !parsed.labels.length) return;
        const block = flow.observeCommandResult({
          taskId: pending.taskId,
          commandKey: pending.commandKey,
          commandClass: pending.commandClass,
          outcome: exitCode === 0 ? "pass" : "fail",
          fingerprint: digest(`${exitCode}\0${parsed.labels.join("\0")}`),
          ...(scope ? { revision: scope.scope.revision } : {}),
          evidenceLabels: parsed.labels,
        });
        if (!block) return;
        setInterventionStatus(ctx, block);
        return appendAdvice(event.content, event.structuredContent, block);
      });

      pi.on("context", (event, ctx) => {
        if (!integrated || !taskId || !boundary) return;
        const scope = currentScope();
        if (!scope) return;
        flow.observeWorkspace(taskId, scope.scope.revision, scope.scope.paths);
        const block =
          flow.takeChangeCheckpoint(taskId) ??
          flow.takeVerificationFreshness(taskId);
        if (!block) return;
        setInterventionStatus(ctx, block);
        return {
          messages: [
            ...event.messages,
            {
              role: "custom",
              customType: "plyth-integrated-context",
              content: block.text,
              display: false,
              timestamp: Date.now(),
            },
          ],
        };
      });

      pi.on("turn_end", (_event, ctx) => {
        ctx.ui.setStatus("plyth-integrated", undefined);
      });
    },
  };
}

function appendAdvice(
  content: ToolResultEvent["content"],
  structuredContent: unknown,
  block: IntegratedContextBlock,
) {
  return {
    content: [...content, { type: "text" as const, text: block.text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function setInterventionStatus(
  ctx: ExtensionContext,
  block: IntegratedContextBlock,
): void {
  ctx.ui.setStatus(
    "plyth-integrated",
    block.kind === "recovery"
      ? "PLYTH recovery signal"
      : block.kind === "verification-stale"
        ? "PLYTH verification stale"
        : "PLYTH task checkpoint",
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
