import { describe, expect, it } from "vitest";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createPiAgentGateway } from "../../src/pi/pi-agent-gateway.js";

describe("Pi SDK compatibility", () => {
  it("creates and disposes an in-memory session without credentials", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd() });
    expect(session).toBeDefined();
    session.dispose();
  });

  it("exposes Pi's model, provider, and thinking catalogs through the gateway", async () => {
    const gateway = await createPiAgentGateway(process.cwd(), { tools: [] });
    try {
      expect(await gateway.listModels()).toEqual(expect.any(Array));
      expect(gateway.listProviders()).toEqual(expect.any(Array));
      expect(gateway.getThinkingInfo()).toMatchObject({
        current: expect.any(String),
        available: expect.any(Array),
      });
    } finally {
      await gateway.dispose();
    }
  });
});
