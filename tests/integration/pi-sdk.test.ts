import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentGateway } from "../../src/pi/pi-agent-gateway.js";
import { RookStore } from "../../src/db/store.js";
import { MemoryCaptureManager } from "../../src/memory/capture.js";
import type { RepositoryIdentity } from "../../src/repo/workspace.js";

describe("Pi SDK compatibility", () => {
  it("creates and disposes an in-memory session without credentials", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd() });
    expect(session).toBeDefined();
    session.dispose();
  });

  it("exposes Pi's model, provider, and thinking catalogs through the gateway", async () => {
    const gateway = await createPiAgentGateway(process.cwd());
    try {
      expect(await gateway.listModels()).toEqual(expect.any(Array));
      expect(gateway.listProviders()).toEqual(expect.any(Array));
      expect(gateway.getThinkingInfo()).toMatchObject({
        current: expect.any(String),
        available: expect.any(Array),
      });
      expect(gateway.getActiveTools()).toEqual(
        expect.arrayContaining(["read", "find", "ls"]),
      );
      expect(gateway.getActiveTools()).not.toContain("bash");
      expect(gateway.getActiveTools()).not.toContain("grep");
      expect(gateway.getActiveTools()).not.toContain("write");
      gateway.setMode("build");
      expect(gateway.getActiveTools()).toContain("write");
      expect(gateway.getActiveTools()).not.toContain("bash");
      gateway.setMode("plan");
      expect(gateway.getActiveTools()).not.toContain("write");
    } finally {
      await gateway.dispose();
    }
  });

  it("loads the optional memory context extension alongside the tool policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rook-memory-extension-"));
    const store = await RookStore.open(join(directory, "state.sqlite"));
    const repository: RepositoryIdentity = {
      id: "extension-repo",
      logicalId: "extension-repo",
      kind: "directory",
      root: process.cwd(),
      displayName: "integration",
      remoteFingerprint: null,
    };
    store.saveWorkspace(repository, null);
    const memoryCapture = new MemoryCaptureManager(store, repository, null);
    const gateway = await createPiAgentGateway(process.cwd(), {
      memoryContext: () => ({
        content: "",
        memoryIds: [],
        estimatedTokens: 0,
        tokenBudget: 1000,
      }),
      memoryCapture,
    });
    try {
      expect(gateway.getActiveTools()).toEqual(
        expect.arrayContaining(["read", "find", "ls"]),
      );
      expect(gateway.getActiveTools()).not.toContain("bash");
    } finally {
      await gateway.dispose();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces the active persistent session through Pi's runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-session-runtime-"));
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd);
    const fixture = SessionManager.create(cwd, sessionDir);
    fixture.appendMessage({
      role: "user",
      content: "saved test prompt",
      timestamp: Date.now(),
    });
    const gateway = await createPiAgentGateway(cwd, { sessionDir });
    try {
      const savedSessions = await gateway.listSessions();
      expect(savedSessions).toHaveLength(1);
      expect(savedSessions[0]?.firstMessage).toBe("saved test prompt");
      await gateway.resumeSession(savedSessions[0]!.path);
      expect(gateway.sessionHistory()).toEqual([
        { role: "user", text: "saved test prompt" },
      ]);

      const previousId = gateway.currentSession().id;
      await gateway.newSession();
      expect(gateway.currentSession().id).not.toBe(previousId);
      expect(gateway.sessionHistory()).toEqual([]);
    } finally {
      await gateway.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
