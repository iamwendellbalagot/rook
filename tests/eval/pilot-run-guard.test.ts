import { describe, expect, it, vi } from "vitest";
import { PilotRunGuard } from "../../src/eval/pilot-run-guard.js";

describe("synthetic pilot run guard", () => {
  it("denies writes outside the exact relative allowlist", () => {
    const onViolation = vi.fn();
    const guard = new PilotRunGuard(
      "/synthetic/run",
      ["read", "edit", "write"],
      ["src/path.mjs"],
      12,
      8,
      onViolation,
    );

    expect(guard.admitToolCall("edit", { path: "src/path.mjs" })).toBe(true);
    expect(guard.admitToolCall("write", { path: "status.md" })).toBe(false);
    expect(guard.admitToolCall("write", { path: "../status.md" })).toBe(false);
    expect(
      guard.admitToolCall("write", { path: "/synthetic/run/src/path.mjs" }),
    ).toBe(false);
    expect(guard.admitToolCall("bash", { command: "anything" })).toBe(false);
    expect(onViolation).toHaveBeenCalledTimes(4);
  });

  it("stops admitting tool calls after the exact call ceiling", () => {
    const guard = new PilotRunGuard("/synthetic/run", ["read"], [], 2, 8);
    expect(guard.admitToolCall("read", {})).toBe(true);
    expect(guard.admitToolCall("read", {})).toBe(true);
    expect(guard.admitToolCall("read", {})).toBe(false);
    expect(guard.violations).toEqual([{ kind: "tool_call_limit", limit: 2 }]);
  });

  it("admits exactly the provider request budget, then fails closed", () => {
    const onViolation = vi.fn();
    const guard = new PilotRunGuard(
      "/synthetic/run",
      ["read"],
      [],
      12,
      2,
      onViolation,
    );
    expect(guard.admitProviderRequest()).toBe(true);
    expect(guard.admitProviderRequest()).toBe(true);
    expect(guard.admitProviderRequest()).toBe(false);
    expect(guard.requestCount()).toBe(2);
    expect(guard.violations).toEqual([
      { kind: "provider_request_limit", limit: 2 },
    ]);
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it("allows bash only for the exact frozen test command", () => {
    const guard = new PilotRunGuard(
      "/synthetic/run",
      ["bash"],
      [],
      4,
      8,
      undefined,
      ["node --test tests/path.test.mjs"],
    );
    expect(
      guard.admitToolCall("bash", {
        command: "node --test tests/path.test.mjs",
      }),
    ).toBe(true);
    expect(
      guard.admitToolCall("bash", { command: "node -e 'writeFile()'" }),
    ).toBe(false);
  });
});
