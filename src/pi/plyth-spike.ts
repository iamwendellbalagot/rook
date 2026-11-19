import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

type ExpectedOutcome = "pass" | "fail" | "error";

interface Expectation {
  outcome: ExpectedOutcome;
  evidence?: string;
}

/** Proves Pi can append deterministic prediction feedback to a tool result. */
export function createPlythSpikeExtension(
  options: { feedback?: boolean } = {},
): InlineExtension {
  return {
    name: "rook-plyth-spike",
    factory(pi: ExtensionAPI) {
      pi.on("tool_result", (event) => {
        if (!options.feedback || event.toolName !== "bash") return;
        const input = record(event.input);
        const prediction = parseExpectation(input?.expect);
        if (!prediction) return;

        const structured = record(event.structuredContent);
        const exitCode = structured?.exit_code;
        const observed: ExpectedOutcome | undefined =
          typeof exitCode === "number" && Number.isInteger(exitCode)
            ? exitCode === 0
              ? "pass"
              : "fail"
            : undefined;
        if (!observed || observed === prediction.outcome) return;

        const text = `PLYTH: expected ${prediction.outcome}; observed ${observed}. Recheck the assumption before the next step.`;
        return {
          content: [...event.content, { type: "text", text }],
          ...(event.structuredContent === undefined
            ? {}
            : { structuredContent: event.structuredContent }),
        };
      });
    },
  };
}

function parseExpectation(value: unknown): Expectation | undefined {
  const object = record(value);
  if (
    !object ||
    (object.outcome !== "pass" &&
      object.outcome !== "fail" &&
      object.outcome !== "error") ||
    (object.evidence !== undefined &&
      (typeof object.evidence !== "string" || object.evidence.length > 200))
  ) {
    return undefined;
  }
  return {
    outcome: object.outcome,
    ...(typeof object.evidence === "string"
      ? { evidence: object.evidence }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
