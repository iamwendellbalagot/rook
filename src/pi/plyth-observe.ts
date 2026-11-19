import {
  judgeEvents,
  parseCommandStarted,
  parseCommandFinished,
  SessionCounter,
  type CommandClass,
  type CommandStarted,
} from "plyth";
import {
  isBashToolResult,
  isToolCallEventType,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

const GUIDANCE =
  "For test, build, and diagnostic bash commands, optionally predict expect.outcome (pass, fail, or error) and a short discriminating expect.evidence label before execution. Omit expect when uncertain; it never changes the command.";

export function createPlythObserveExtension(
  counter: SessionCounter,
): InlineExtension {
  return {
    name: "rook-plyth-observe",
    factory(pi: ExtensionAPI) {
      const pending = new Map<string, unknown>();
      const tracked = new Set<string>();
      const maxPending = 256;
      const maxTracked = 256;

      const finish = (
        sessionId: string,
        callId: string,
        event: unknown,
      ): void => {
        const key = `${sessionId}\0${callId}`;
        const start = pending.get(key);
        if (!start) return;
        pending.delete(key);
        const judgment = judgeEvents(start, event);
        counter.record(judgment);
      };

      pi.on("session_start", () => {
        pending.clear();
        tracked.clear();
        counter.reset();
      });

      pi.on("tool_call", (event, ctx) => {
        if (!isToolCallEventType("bash", event)) return;
        const input = record(event.input);
        if (typeof input?.command !== "string") return;
        const commandClass = classifyCommand(input.command);
        if (commandClass === "other") return;
        const sessionId = ctx.sessionManager.getSessionId();
        const key = `${sessionId}\0${event.toolCallId}`;
        if (tracked.has(key)) return;
        counter.recordEligible(
          predictionFromInput(input.expect),
          input.expect !== undefined,
        );
        if (pending.size >= maxPending || tracked.size >= maxTracked) return;
        const start: Record<string, unknown> = {
          protocol: "plyth/event/1",
          sessionId,
          callId: event.toolCallId,
          adapter: "rook-pi",
          commandClass,
          ...(input.expect === undefined ? {} : { prediction: input.expect }),
        };
        const parsed = parseCommandStarted(start);
        tracked.add(key);
        pending.set(key, parsed.ok ? parsed.value : start);
      });

      pi.on("tool_result", (event, ctx) => {
        if (!isBashToolResult(event)) return;
        const sessionId = ctx.sessionManager.getSessionId();
        const structured = record(event.structuredContent);
        const prediction = record(
          record(pending.get(`${sessionId}\0${event.toolCallId}`))?.prediction,
        );
        const normalized =
          typeof structured?.exit_code === "number" &&
          Number.isInteger(structured.exit_code)
            ? structured.exit_code === 0
              ? "pass"
              : "fail"
            : undefined;
        const output = structured?.output;
        const truncated = structured?.truncated === true;
        const evidenceLabels =
          !truncated && typeof output === "string"
            ? output
                .split(/\r?\n/)
                .map((line: string) =>
                  line
                    .trim()
                    .replace(/[\u0000-\u001f\u007f]/g, " ")
                    .slice(0, 160),
                )
                .filter(Boolean)
                .slice(0, 16)
            : undefined;
        const finishEvent: Record<string, unknown> = {
          protocol: "plyth/event/1",
          sessionId,
          callId: event.toolCallId,
          ...(normalized ? { outcome: normalized } : {}),
          ...(evidenceLabels ? { evidenceLabels } : {}),
          ...(truncated || (prediction?.evidence && !evidenceLabels)
            ? { evidenceUnavailable: true }
            : {}),
          ...(!normalized
            ? { unscorableReason: "host_did_not_return_exit_code" }
            : {}),
        };
        finish(sessionId, event.toolCallId, finishEvent);
      });

      pi.on("tool_execution_end", (event, ctx) => {
        if (event.toolName !== "bash") return;
        const sessionId = ctx.sessionManager.getSessionId();
        const key = `${sessionId}\0${event.toolCallId}`;
        const isObservedCommand = tracked.delete(key);
        if (isObservedCommand && typeof event.durationMs === "number")
          counter.recordDuration(event.durationMs);
        if (isObservedCommand) {
          const unscorable: Record<string, unknown> = {
            protocol: "plyth/event/1",
            sessionId,
            callId: event.toolCallId,
            unscorableReason: "host_did_not_return_tool_result",
          };
          finish(sessionId, event.toolCallId, unscorable);
          pending.delete(key);
        }
      });

      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\nPLYTH observe-only prediction guidance: ${GUIDANCE}`,
      }));
    },
  };
}

export function classifyCommand(command: string): CommandClass {
  if (
    /^[ \t]*(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?test(?::[\w:-]+)?[ \t]*$/.test(
      command,
    )
  )
    return "test";
  if (
    /^[ \t]*(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?build[ \t]*$/.test(command)
  )
    return "build";
  if (
    /^[ \t]*(?:(?:npx|pnpm exec|yarn exec|bunx)[ \t]+)?(?:tsc|eslint|prettier|vitest|jest|pytest|cargo check|go vet)(?:[ \t]+--(?:run|noEmit|check))?[ \t]*$/.test(
      command,
    )
  )
    return "diagnostic";
  return "other";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function predictionFromInput(value: unknown) {
  const input = record(value);
  if (
    input?.outcome !== "pass" &&
    input?.outcome !== "fail" &&
    input?.outcome !== "error"
  )
    return undefined;
  if (
    input.evidence !== undefined &&
    (typeof input.evidence !== "string" || input.evidence.length > 200)
  )
    return undefined;
  return {
    outcome: input.outcome,
    ...(typeof input.evidence === "string" ? { evidence: input.evidence } : {}),
  } as const;
}
