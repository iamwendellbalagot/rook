import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { ReviewBudget } from "../../src/pi/review-budget.js";

describe("review-only inspection budget", () => {
  it("allows at most two read/search calls and blocks all other tools", () => {
    const budget = new ReviewBudget("short prompt");
    expect(budget.admit("bash")).toBe(false);
    expect(budget.admit("mcp__test__read")).toBe(false);
    expect(budget.admit("read")).toBe(true);
    expect(budget.admit("rook_search")).toBe(true);
    expect(budget.admit("read")).toBe(false);
    expect(budget.limitations.size).toBeGreaterThan(0);
  });

  it("omits oversized results and guards blocked-call transcript results", () => {
    const budget = new ReviewBudget("p".repeat(5_800));
    expect(budget.bound("界".repeat(200))).toContain("budget exhausted");
    const handlers = new Map<string, (event: any) => any>();
    const extension = budget.extension() as ExtensionFactory;
    extension({
      on: (name: string, handler: (event: any) => any) =>
        handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    expect(handlers.get("tool_call")!({ toolName: "edit" }).block).toBe(true);
    const context = handlers.get("context")!({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "x".repeat(1_000) }],
        },
      ],
    });
    expect(context.messages[0].content).toEqual([]);
    expect(budget.limitations.size).toBeGreaterThan(0);
    expect(() => new ReviewBudget("x".repeat(6_001))).toThrow("budget");
  });
});
