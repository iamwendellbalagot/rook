import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlythIntegratedExtension } from "../../src/pi/plyth-integrated.js";

describe("PLYTH integration through the pinned Pi inference loop", () => {
  it("places the task checkpoint in the next model-bound context after an edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-plyth-pi-loop-"));
    const agentDir = join(root, ".agent");
    await mkdir(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "value.mjs"),
      "export const value = 0;\n",
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("scripted", {
      name: "Scripted provider (no network)",
      api: "openai-completions",
      apiKey: "test-only",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [
        {
          id: "scripted-model",
          name: "Scripted model",
          api: "openai-completions",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 16_000,
          maxTokens: 2_000,
        },
      ],
    });
    const model = modelRuntime.getModel("scripted", "scripted-model");
    if (!model) throw new Error("Scripted model was not registered.");

    const boundContexts: Array<{
      hasCheckpoint: boolean;
      customTypes: string[];
    }> = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        createPlythIntegratedExtension(root),
        {
          name: "plyth-inference-context-test-trace",
          factory(pi) {
            pi.on("context_with_system", (event) => {
              const custom = event.messages.filter(
                (message) => message.role === "custom",
              );
              const text = custom
                .map((message) =>
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n"),
                )
                .join("\n");
              boundContexts.push({
                hasCheckpoint: text.includes("task-local change checkpoint"),
                customTypes: custom.map((message) => message.customType),
              });
            });
          },
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime,
      model,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: loader,
      tools: ["edit"],
    });
    const scriptedCalls: boolean[] = [];
    session.agent.streamFunction = ((requestModel, context) => {
      const messages = JSON.stringify(context.messages);
      scriptedCalls.push(messages.includes("task-local change checkpoint"));
      const stopReason = scriptedCalls.length === 1 ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant",
        content:
          scriptedCalls.length === 1
            ? [
                {
                  type: "toolCall",
                  id: "scripted-edit-1",
                  name: "edit",
                  arguments: {
                    path: "src/value.mjs",
                    oldText: "export const value = 0;",
                    newText: "export const value = 1;",
                  },
                },
              ]
            : [{ type: "text", text: "The requested change is complete." }],
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      };
      const stream: AssistantMessageEventStream =
        createAssistantMessageEventStream();
      stream.push({
        type: "start",
        partial: { ...message, content: [], stopReason: "stop" },
      });
      stream.push({
        type: "done",
        reason: stopReason,
        message,
      });
      return stream;
    }) as typeof session.agent.streamFunction;

    try {
      await session.prompt("Change src/value.mjs so value is 1.");
      expect(scriptedCalls).toEqual([false, true]);
      expect(boundContexts).toHaveLength(2);
      expect(boundContexts.at(0)?.hasCheckpoint).toBe(false);
      expect(boundContexts[1]).toMatchObject({
        hasCheckpoint: true,
        customTypes: expect.arrayContaining(["plyth-integrated-context"]),
      });
      expect(
        await (
          await import("node:fs/promises")
        ).readFile(join(root, "src/value.mjs"), "utf8"),
      ).toContain("value = 1");
    } finally {
      session.dispose();
      await modelRuntime.settleCredentialWrites();
      await rm(root, { recursive: true, force: true });
    }
  });
});
