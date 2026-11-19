import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
      const providers = gateway.listProviders();
      expect(providers).toEqual(expect.any(Array));
      for (const provider of providers) {
        expect(provider.authMethods).toEqual(expect.any(Array));
        for (const method of provider.authMethods) {
          expect(method.type).toMatch(/^(api_key|oauth)$/);
          expect(method.name).toEqual(expect.any(String));
        }
      }
      expect(
        providers.find((provider) => provider.id === "anthropic")?.authMethods,
      ).toContainEqual(
        expect.objectContaining({
          type: "oauth",
          name: "Anthropic (Claude Pro/Max)",
          isSubscription: true,
        }),
      );
      expect(
        providers.find((provider) => provider.id === "openai")?.authMethods,
      ).toContainEqual(
        expect.objectContaining({
          type: "oauth",
          name: "OpenAI (ChatGPT subscription)",
          isSubscription: true,
        }),
      );
      expect(gateway.getThinkingInfo()).toMatchObject({
        current: expect.any(String),
        available: expect.any(Array),
      });
      expect(gateway.getActiveTools()).toEqual(
        expect.arrayContaining([
          "read",
          "find",
          "ls",
          "rook_inspect",
          "rook_search",
          "rook_map",
          "rook_todo",
        ]),
      );
      expect(gateway.getActiveTools()).not.toContain("rook_impact");
      expect(gateway.getActiveTools()).not.toContain("bash");
      expect(gateway.getActiveTools()).not.toContain("grep");
      expect(gateway.getActiveTools()).not.toContain("write");
      expect(gateway.listSkills()).toEqual(expect.any(Array));
      expect(gateway.listPromptTemplates()).toEqual(expect.any(Array));
      gateway.setMode("build");
      expect(gateway.getActiveTools()).toContain("write");
      expect(gateway.getActiveTools()).toContain("rook_todo");
      expect(gateway.getActiveTools()).toContain("bash");
      expect(gateway.getActiveTools()).toContain("rook_impact");
      gateway.setMode("plan");
      expect(gateway.getActiveTools()).not.toContain("write");
      expect(gateway.getActiveTools()).not.toContain("bash");
      expect(gateway.getActiveTools()).not.toContain("rook_impact");
      expect(gateway.getActiveTools()).toContain("rook_todo");
    } finally {
      await gateway.dispose();
    }
  });

  it("loads ignored workspace providers into Pi's model runtime on picker refresh", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rook-workspace-model-runtime-"));
    const previousKey = process.env.ROOK_TEST_API_KEY;
    process.env.ROOK_TEST_API_KEY = "test-token";
    await writeFile(
      join(cwd, "models.json"),
      JSON.stringify({
        providers: {
          RONE_Models: {
            name: "RONE Models",
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            apiKey: "$ROOK_TEST_API_KEY",
            models: [{ id: "gpt-6-luna", name: "GPT-6 Luna AWS" }],
          },
        },
      }),
    );
    const gateway = await createPiAgentGateway(cwd);
    try {
      expect(await gateway.listModels()).toContainEqual({
        provider: "RONE_Models",
        id: "gpt-6-luna",
        name: "GPT-6 Luna AWS",
      });
      expect(gateway.listProviders()).toContainEqual(
        expect.objectContaining({ id: "RONE_Models", name: "RONE Models" }),
      );
      await gateway.selectModel({
        provider: "RONE_Models",
        id: "gpt-6-luna",
        name: "GPT-6 Luna AWS",
      });
      expect(gateway.currentModel()).toMatchObject({
        provider: "RONE_Models",
        id: "gpt-6-luna",
      });

      await writeFile(
        join(cwd, "models.json"),
        JSON.stringify({
          providers: {
            RONE_Models: {
              baseUrl: "https://api.example.com/v1",
              api: "openai-completions",
              apiKey: "$ROOK_TEST_API_KEY",
              models: [{ id: "gpt-6-sol", name: "GPT-6 Sol AWS" }],
            },
          },
        }),
      );
      expect(await gateway.listModels()).toContainEqual({
        provider: "RONE_Models",
        id: "gpt-6-sol",
        name: "GPT-6 Sol AWS",
      });
      expect(
        (await gateway.listModels()).some(
          (model) =>
            model.provider === "RONE_Models" && model.id === "gpt-6-luna",
        ),
      ).toBe(false);
    } finally {
      await gateway.dispose();
      if (previousKey === undefined) delete process.env.ROOK_TEST_API_KEY;
      else process.env.ROOK_TEST_API_KEY = previousKey;
      await rm(cwd, { recursive: true, force: true });
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
      repositoryInstructions: () => ({
        content: "",
        files: [],
      }),
      listRepositoryInstructions: () => ["AGENTS.md"],
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
        expect.arrayContaining([
          "read",
          "find",
          "ls",
          "rook_inspect",
          "rook_search",
        ]),
      );
      expect(gateway.getActiveTools()).not.toContain("bash");
      await expect(gateway.listRepositoryInstructions?.()).resolves.toEqual([
        "AGENTS.md",
      ]);
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

      const forkPoint = gateway.listForkPoints()[0];
      expect(forkPoint?.text).toBe("saved test prompt");
      const previousSessionId = gateway.currentSession().id;
      await gateway.fork(forkPoint!.entryId);
      // Pi forks before the selected user message so it can be edited/retried.
      expect(gateway.sessionHistory()).toEqual([]);
      expect(gateway.currentSession().id).not.toBe(previousSessionId);

      const previousId = gateway.currentSession().id;
      gateway.setMode("build");
      await gateway.newSession();
      expect(gateway.getActiveTools()).toContain("bash");
      expect(gateway.currentSession().id).not.toBe(previousId);
      expect(gateway.sessionHistory()).toEqual([]);
    } finally {
      await gateway.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads Rook-managed skills and only selected Pi built-in extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-pi-resources-"));
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const previousRookHome = process.env.ROOK_HOME;
    process.env.ROOK_HOME = join(root, "rook-home");
    let gateway: Awaited<ReturnType<typeof createPiAgentGateway>> | undefined;
    try {
      await mkdir(join(cwd, ".rook", "skills", "safe-review"), {
        recursive: true,
      });
      await mkdir(join(cwd, ".pi", "skills", "ambient-review"), {
        recursive: true,
      });
      await mkdir(join(cwd, ".agents", "skills", "shared-review"), {
        recursive: true,
      });
      await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
      await writeFile(
        join(cwd, ".rook", "skills", "safe-review", "SKILL.md"),
        "---\nname: safe-review\ndescription: Review code without executing commands.\n---\nRead and review code only.\n",
      );
      await writeFile(
        join(cwd, ".pi", "skills", "ambient-review", "SKILL.md"),
        "---\nname: ambient-review\ndescription: Must not leak into Rook.\n---\nAmbient skill.\n",
      );
      await writeFile(
        join(cwd, ".agents", "skills", "shared-review", "SKILL.md"),
        "---\nname: shared-review\ndescription: Must not leak into Rook.\n---\nShared skill.\n",
      );
      await writeFile(
        join(cwd, ".pi", "prompts", "review.md"),
        "---\nname: review\ndescription: Review the current change.\n---\nReview this change: $ARGUMENTS\n",
      );
      gateway = await createPiAgentGateway(cwd, { sessionDir });
      expect(gateway.listSkills()).toContainEqual({
        name: "safe-review",
        description: "Review code without executing commands.",
      });
      expect(gateway.listSkills()).not.toContainEqual(
        expect.objectContaining({ name: "ambient-review" }),
      );
      expect(gateway.listSkills()).not.toContainEqual(
        expect.objectContaining({ name: "shared-review" }),
      );
      expect(gateway.listPromptTemplates()).toContainEqual({
        name: "review",
        description: "Review the current change.",
      });
      expect(gateway.isResourceCommand("/skill:safe-review")).toBe(true);
      expect(gateway.isResourceCommand("/review this diff")).toBe(true);
      expect(gateway.getActiveTools()).not.toContain("bash");
      expect(gateway.getActiveTools()).not.toContain("codemode");
      expect(gateway.isResourceCommand("/mcp")).toBe(true);
    } finally {
      await gateway?.dispose();
      if (previousRookHome === undefined) delete process.env.ROOK_HOME;
      else process.env.ROOK_HOME = previousRookHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits temporary subagent sessions to profile-selected read-only tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-subagent-session-"));
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    await mkdir(join(cwd, ".rook"), { recursive: true });
    await writeFile(
      join(cwd, ".rook", "agents.json"),
      JSON.stringify({
        agents: [
          {
            name: "reader",
            description: "Read selected files",
            instructions: "Answer with file references.",
            tools: ["read", "rook_search"],
          },
        ],
      }),
    );
    const previousRookHome = process.env.ROOK_HOME;
    process.env.ROOK_HOME = join(root, "rook-home");
    const gateway = await createPiAgentGateway(cwd, {
      sessionDir,
      readOnlyTools: ["read", "rook_search", "write", "bash"],
    });
    try {
      expect(gateway.listSubagents().map(({ name }) => name)).toEqual([
        "reader",
      ]);
      expect(gateway.getActiveTools()).toEqual(["read", "rook_search"]);
    } finally {
      await gateway.dispose();
      if (previousRookHome === undefined) delete process.env.ROOK_HOME;
      else process.env.ROOK_HOME = previousRookHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
