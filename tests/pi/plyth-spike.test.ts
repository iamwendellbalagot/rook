import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPlythSpikeExtension } from "../../src/pi/plyth-spike.js";

function toolResultHandler(feedback: boolean) {
  let handler: ((event: Record<string, unknown>) => unknown) | undefined;
  const extension = createPlythSpikeExtension({ feedback });
  if (typeof extension === "function")
    throw new Error("Expected a named extension.");
  extension.factory({
    on: (_event: string, callback: unknown) => {
      handler = callback as typeof handler;
      return () => {};
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error("Expected tool_result handler.");
  return handler;
}

const resultEvent = (overrides: Record<string, unknown> = {}) => ({
  toolName: "bash",
  input: { command: "npm test", expect: { outcome: "fail" } },
  content: [{ type: "text", text: "tests passed" }],
  structuredContent: { exit_code: 0, output: "tests passed", truncated: false },
  isError: false,
  ...overrides,
});

describe("PLYTH Rook feasibility spike", () => {
  it("adds feedback to the existing tool result on an outcome miss", () => {
    const result = toolResultHandler(true)(resultEvent()) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: unknown;
    };

    expect(result.content.at(-1)).toEqual({
      type: "text",
      text: "PLYTH: expected fail; observed pass. Recheck the assumption before the next step.",
    });
    expect(result.structuredContent).toEqual({
      exit_code: 0,
      output: "tests passed",
      truncated: false,
    });
  });

  it("does nothing when feedback is disabled or the outcome matches", () => {
    expect(toolResultHandler(false)(resultEvent())).toBeUndefined();
    expect(
      toolResultHandler(true)(
        resultEvent({
          input: { command: "npm test", expect: { outcome: "pass" } },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores malformed or absent predictions and non-bash results", () => {
    const handler = toolResultHandler(true);
    expect(
      handler(resultEvent({ input: { command: "npm test", expect: "fail" } })),
    ).toBeUndefined();
    expect(
      handler(resultEvent({ input: { command: "npm test" } })),
    ).toBeUndefined();
    expect(handler(resultEvent({ toolName: "write" }))).toBeUndefined();
  });

  it("does not guess an outcome when the result lacks an exit code", () => {
    expect(
      toolResultHandler(true)(
        resultEvent({
          isError: true,
          structuredContent: undefined,
        }),
      ),
    ).toBeUndefined();
  });
});
