import {
  judgeEvents,
  parseCommandStarted,
  parseCommandFinished,
  SessionFeedbackGate,
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
  "For eligible test, build, and diagnostic bash commands, include expect.outcome (pass, fail, or error) when reasonably predictable. Use expect.evidence as a short exact substring from a known test name or stable error label, not a prose summary or guessed aggregate count. Omit expect only when the result is genuinely uncertain; it never changes the command.";

export function createPlythObserveExtension(
  counter: SessionCounter,
  options: { feedback?: boolean } = {},
): InlineExtension {
  return {
    name: "rook-plyth-observe",
    factory(pi: ExtensionAPI) {
      const pending = new Map<string, unknown>();
      const tracked = new Set<string>();
      const feedbackGate = new SessionFeedbackGate();
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
        feedbackGate.reset();
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
        const startEvent = record(
          pending.get(`${sessionId}\0${event.toolCallId}`),
        );
        const prediction = record(startEvent?.prediction);
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
            ? evidenceLabelsFromOutput(
                output,
                startEvent?.commandClass,
                normalized,
              )
            : undefined;
        const finishEvent: Record<string, unknown> = {
          protocol: "plyth/event/1",
          sessionId,
          callId: event.toolCallId,
          ...(normalized ? { outcome: normalized } : {}),
          ...(evidenceLabels ? { evidenceLabels } : {}),
          ...(truncated || (prediction?.evidence && !evidenceLabels?.length)
            ? { evidenceUnavailable: true }
            : {}),
          ...(!normalized
            ? { unscorableReason: "host_did_not_return_exit_code" }
            : {}),
        };
        const key = `${sessionId}\0${event.toolCallId}`;
        const start = pending.get(key);
        finish(sessionId, event.toolCallId, finishEvent);
        if (!options.feedback || !start) return;
        const feedback = feedbackGate.offer(start, finishEvent);
        if (!feedback) return;
        return {
          content: [
            ...event.content,
            { type: "text", text: `PLYTH: ${feedback}` },
          ],
          ...(event.structuredContent === undefined
            ? {}
            : { structuredContent: event.structuredContent }),
        };
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
  if (/^[ \t]*node[ \t]+--test(?:[ \t]+[A-Za-z0-9_./-]+)*[ \t]*$/.test(command))
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

function evidenceLabelsFromOutput(
  output: string,
  commandClass: unknown,
  outcome: string | undefined,
): string[] | undefined {
  const lines = output.split(/\r?\n/).map((line) =>
    line
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 160),
  );

  if (commandClass === "test" && (outcome === "pass" || outcome === "fail")) {
    const nodeTestLabels = lines.flatMap((line) => {
      const match = /^([✔✖])\s+(.+)$/u.exec(line);
      const status = match?.[1];
      const testLabel = match?.[2];
      if (!status || !testLabel) return [];
      const label = testLabel
        .replace(/\s+\(\d+(?:\.\d+)?(?:ns|us|μs|µs|ms|s)\)$/u, "")
        .trim();
      return label ? [{ status, label }] : [];
    });

    if (nodeTestLabels.length > 0) {
      const expectedStatus = outcome === "pass" ? "✔" : "✖";
      const matchingLabels = [
        ...new Set(
          nodeTestLabels
            .filter(
              ({ status, label }) =>
                status === expectedStatus &&
                label.toLowerCase() !== "failing tests:",
            )
            .map(({ label }) => label),
        ),
      ].slice(0, 16);
      return matchingLabels.length > 0 ? matchingLabels : undefined;
    }
  }

  const labels = lines.filter(Boolean).slice(0, 16);
  return labels.length > 0 ? labels : undefined;
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
