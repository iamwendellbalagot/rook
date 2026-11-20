import {
  judgeEvents,
  parseCommandStarted,
  parseCommandFinished,
  SessionFeedbackGate,
  SessionCounter,
  CommandHistoryBaseline,
  createTraceRecord,
  type HistoryForecast,
  type TraceRecord,
  type CommandClass,
  type CommandStarted,
} from "plyth";
import {
  isBashToolResult,
  isToolCallEventType,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

const GUIDANCE =
  "For eligible test, build, and diagnostic bash commands, include expect.outcome (pass, fail, or error) when reasonably predictable. Use expect.evidence as a short exact substring from a known test name or stable error label, not a prose summary or guessed aggregate count. Omit expect only when the result is genuinely uncertain; it never changes the command.";

export function createPlythObserveExtension(
  counter: SessionCounter,
  options: {
    feedback?: boolean;
    baseline?: CommandHistoryBaseline;
    workspaceRevision?: () => string | undefined;
    trace?: { append(record: TraceRecord): void };
  } = {},
): InlineExtension {
  return {
    name: "rook-plyth-observe",
    factory(pi: ExtensionAPI) {
      const pending = new Map<string, unknown>();
      const tracked = new Set<string>();
      const feedbackGate = new SessionFeedbackGate();
      const baseline = options.baseline ?? new CommandHistoryBaseline();
      const forecasts = new Map<string, HistoryForecast>();
      const traces = new Map<string, Parameters<typeof createTraceRecord>[0]>();
      let sessionKey = randomBytes(16).toString("hex");
      const revision = () => {
        try {
          return options.workspaceRevision?.();
        } catch {
          return undefined;
        }
      };
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
        const parsedStart = parseCommandStarted(start);
        const parsedFinish = parseCommandFinished(event);
        const forecast = forecasts.get(key);
        forecasts.delete(key);
        const comparison = forecast
          ? baseline.complete(
              forecast,
              revision(),
              parsedFinish.ok ? parsedFinish.value.outcome : undefined,
              parsedStart.ok
                ? parsedStart.value.prediction?.outcome
                : undefined,
            )
          : { comparable: false };
        traces.set(key, {
          sessionKey,
          nowMs: Date.now(),
          commandClass: (record(start)?.commandClass ??
            "other") as CommandClass,
          verdict: judgment.verdict,
          mode: options.feedback ? "feedback" : "observe",
          ...(parsedStart.ok && parsedStart.value.prediction
            ? { predictionOutcome: parsedStart.value.prediction.outcome }
            : {}),
          ...(parsedFinish.ok && parsedFinish.value.outcome
            ? { observedOutcome: parsedFinish.value.outcome }
            : {}),
          baseline: comparison,
        });
      };

      pi.on("session_start", () => {
        pending.clear();
        tracked.clear();
        feedbackGate.reset();
        counter.reset();
        baseline.reset();
        forecasts.clear();
        traces.clear();
        sessionKey = randomBytes(16).toString("hex");
      });

      pi.on("tool_call", (event, ctx) => {
        if (!isToolCallEventType("bash", event)) {
          if (
            ![
              "read",
              "find",
              "ls",
              "rook_inspect",
              "rook_search",
              "rook_map",
              "rook_code",
              "rook_impact",
              "rook_todo",
              "tool_search",
            ].includes(event.toolName)
          )
            baseline.invalidate();
          return;
        }
        const input = record(event.input);
        if (typeof input?.command !== "string") return;
        const commandClass = classifyCommand(input.command);
        if (commandClass === "other") {
          baseline.invalidate();
          return;
        }
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
        forecasts.set(
          key,
          baseline.begin(
            input.command.trim().replace(/[ \t]+/g, " "),
            revision(),
          ),
        );
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
        const evidence =
          !truncated && typeof output === "string"
            ? evidenceLabelsFromOutput(
                output,
                startEvent?.commandClass,
                normalized,
              )
            : undefined;
        const evidenceLabels = evidence?.labels;
        const finishEvent: Record<string, unknown> = {
          protocol: "plyth/event/1",
          sessionId,
          callId: event.toolCallId,
          ...(normalized ? { outcome: normalized } : {}),
          ...(evidenceLabels ? { evidenceLabels } : {}),
          ...(truncated ||
          evidence?.limited ||
          (prediction?.evidence && !evidenceLabels?.length)
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
        const traceInput = traces.get(key);
        if (traceInput) traceInput.feedbackAppended = true;
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
          const traceInput = traces.get(key);
          traces.delete(key);
          if (traceInput && options.trace) {
            const trace = createTraceRecord({
              ...traceInput,
              ...(typeof event.durationMs === "number"
                ? { durationMs: event.durationMs }
                : {}),
            });
            if (trace) {
              try {
                options.trace.append(trace);
              } catch {
                /* Persistence is advisory too. */
              }
            }
          }
        }
      });

      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\nPLYTH prediction guidance: ${GUIDANCE}`,
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
): { labels: string[]; limited: boolean } | undefined {
  if (output.length > 65536) return { labels: [], limited: true };
  const lines = output.split(/\r?\n/).map((line) =>
    line
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, " "),
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
      ];
      return matchingLabels.length > 0
        ? {
            labels: matchingLabels
              .slice(0, 16)
              .map((label) => label.slice(0, 160)),
            limited:
              matchingLabels.length > 16 ||
              matchingLabels.some((label) => label.length > 160),
          }
        : undefined;
    }
  }

  const labels = lines.filter(Boolean);
  return labels.length > 0
    ? {
        labels: labels.slice(0, 16).map((label) => label.slice(0, 160)),
        limited:
          labels.length > 16 || labels.some((label) => label.length > 160),
      }
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
