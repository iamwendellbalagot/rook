import { describe, expect, it } from "vitest";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

describe("Pi SDK compatibility", () => {
  it("creates and disposes an in-memory session without credentials", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd() });
    expect(session).toBeDefined();
    session.dispose();
  });
});
