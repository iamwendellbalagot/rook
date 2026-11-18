import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  loadWorkspaceModelProviders,
  WorkspaceModelConfiguration,
} from "../../src/pi/workspace-models.js";

describe("workspace model providers", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("registers workspace models alongside the Pi catalog and refreshes changes", async () => {
    directory = await mkdtemp(join(tmpdir(), "rook-workspace-models-"));
    const configPath = join(directory, "models.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          RONE_Models: {
            name: "RONE Models",
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            apiKey: "$ROOK_TEST_API_KEY",
            models: [
              {
                id: "gpt-6-luna",
                name: "GPT-6 Luna AWS",
                contextWindow: 128000,
              },
            ],
          },
        },
      }),
    );
    const previousKey = process.env.ROOK_TEST_API_KEY;
    process.env.ROOK_TEST_API_KEY = "test-token";
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    const configuration = new WorkspaceModelConfiguration(runtime);
    try {
      await configuration.refresh(directory);
      expect(runtime.getModel("RONE_Models", "gpt-6-luna")).toMatchObject({
        id: "gpt-6-luna",
        name: "GPT-6 Luna AWS",
        contextWindow: 128000,
      });
      expect(runtime.getRegisteredProviderIds()).toContain("RONE_Models");
      expect(runtime.getModels().length).toBeGreaterThan(1);

      await writeFile(
        configPath,
        JSON.stringify({
          providers: {
            RONE_Models: {
              baseUrl: "https://api.example.com/v1",
              api: "openai-completions",
              apiKey: "$ROOK_TEST_API_KEY",
              models: [{ id: "gpt-6-sol" }],
            },
          },
        }),
      );
      await configuration.refresh(directory);
      expect(runtime.getModel("RONE_Models", "gpt-6-luna")).toBeUndefined();
      expect(runtime.getModel("RONE_Models", "gpt-6-sol")).toBeDefined();
    } finally {
      await runtime.settleCredentialWrites();
      if (previousKey === undefined) delete process.env.ROOK_TEST_API_KEY;
      else process.env.ROOK_TEST_API_KEY = previousKey;
    }
  });

  it("rejects literal API keys and non-HTTP endpoints", async () => {
    directory = await mkdtemp(join(tmpdir(), "rook-invalid-models-"));
    const configPath = join(directory, "models.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            apiKey: "do-not-store-this",
            models: [{ id: "model" }],
          },
        },
      }),
    );
    await expect(loadWorkspaceModelProviders(directory)).rejects.toThrow(
      "must reference an environment variable",
    );

    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "file:///tmp/endpoint",
            api: "openai-completions",
            apiKey: "$TEST_KEY",
            models: [{ id: "model" }],
          },
        },
      }),
    );
    await expect(loadWorkspaceModelProviders(directory)).rejects.toThrow(
      "must be an HTTP(S) URL",
    );
  });

  it("returns no workspace providers when models.json is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "rook-no-models-"));
    await expect(loadWorkspaceModelProviders(directory)).resolves.toEqual({});
  });

  it("loads the example catalog with a placeholder endpoint and AWS models", async () => {
    directory = await mkdtemp(join(tmpdir(), "rook-example-models-"));
    await writeFile(
      join(directory, "models.json"),
      await readFile(join(process.cwd(), "models.example.json"), "utf8"),
    );
    const providers = await loadWorkspaceModelProviders(directory);
    expect(providers.RONE_Models).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "$RDSEC_API_KEY",
      models: [
        { id: "gpt-5.6-luna-aws" },
        { id: "gpt-6-luna" },
        { id: "gpt-6-sol" },
      ],
    });
  });
});
