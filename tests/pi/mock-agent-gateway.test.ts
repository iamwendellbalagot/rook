import { describe, expect, it } from "vitest";
import { MockAgentGateway } from "../../src/pi/mock-agent-gateway.js";

describe("MockAgentGateway", () => {
  it("streams 100 chunks exactly once and settles without provider credentials", async () => {
    const gateway = new MockAgentGateway();
    const chunks: string[] = [];
    let settled = 0;
    const unsubscribe = gateway.subscribe((event) => {
      if (event.type === "text_delta") chunks.push(event.text);
      if (event.type === "run_settled") settled += 1;
    });

    const prompt = "x".repeat(780);
    await gateway.send(prompt);
    expect(chunks).toHaveLength(100);
    expect(chunks.join("")).toBe(`Mock response to: ${prompt}`);
    expect(settled).toBe(1);
    unsubscribe();
    await gateway.dispose();
  });
});
