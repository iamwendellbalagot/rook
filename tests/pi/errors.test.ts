import { describe, expect, it } from "vitest";
import { formatAgentError } from "../../src/pi/errors.js";

describe("provider errors", () => {
  it("summarizes gateway timeouts and HTML instead of rendering markup", () => {
    expect(
      formatAgentError(
        new Error("504 <html><body>504 Gateway Time-out</body></html>"),
      ),
    ).toContain("Provider timed out (504)");
    expect(
      formatAgentError("502 <html>private upstream details</html>"),
    ).not.toContain("private upstream");
    expect(
      formatAgentError("502 <html>private upstream details</html>"),
    ).not.toContain("<html>");
  });

  it("bounds errors and removes terminal controls", () => {
    expect(formatAgentError("a\x1b[31mb\n")).not.toContain("\x1b");
    expect(formatAgentError("a".repeat(2000))).toHaveLength(500);
    expect(formatAgentError(new Error("No model selected"))).toBe(
      "No model selected",
    );
  });

  it("redacts credential-shaped values from provider errors", () => {
    const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdWRpdCJ9.signature0123456789012345";
    const formatted = formatAgentError(
      `api_key=${key}; Authorization: Bearer ${jwt}; upstream token ${jwt}`,
    );

    expect(formatted).not.toContain(key);
    expect(formatted).not.toContain(jwt);
    expect(formatted).toContain("[redacted]");
    expect(formatted).toContain("[redacted token]");
  });
});
