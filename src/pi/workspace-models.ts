import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
type ProviderConfiguration = Parameters<ModelRuntime["registerProvider"]>[1];

interface WorkspaceModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

interface WorkspaceProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  authHeader?: boolean;
  models?: WorkspaceModel[];
}

export class WorkspaceModelConfiguration {
  private readonly registeredProviders = new Map<string, string>();

  constructor(private readonly runtime: ModelRuntime) {}

  async refresh(cwd: string): Promise<void> {
    const root = await realpath(cwd);
    const providers = await loadWorkspaceModelProviders(root);
    for (const providerId of this.registeredProviders.keys()) {
      if (!(providerId in providers)) {
        this.runtime.unregisterProvider(providerId);
        this.registeredProviders.delete(providerId);
      }
    }
    for (const [providerId, config] of Object.entries(providers)) {
      const serialized = JSON.stringify(config);
      if (this.registeredProviders.get(providerId) === serialized) continue;
      if (this.registeredProviders.has(providerId)) {
        this.runtime.unregisterProvider(providerId);
      }
      this.runtime.registerProvider(
        providerId,
        config as ProviderConfiguration,
      );
      this.registeredProviders.set(providerId, serialized);
    }
  }
}

export async function loadWorkspaceModelProviders(
  cwd: string,
): Promise<Record<string, WorkspaceProvider>> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "models.json"), "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Workspace models.json must contain valid JSON.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error("Workspace models.json must define a providers object.");
  }

  const providers: Record<string, WorkspaceProvider> = {};
  for (const [providerId, value] of Object.entries(parsed.providers)) {
    if (!providerId.trim() || !isRecord(value)) {
      throw new Error("Workspace models.json contains an invalid provider.");
    }
    providers[providerId] = validateProvider(providerId, value);
  }
  return providers;
}

function validateProvider(
  providerId: string,
  value: Record<string, unknown>,
): WorkspaceProvider {
  const provider: WorkspaceProvider = {};
  if (value.name !== undefined)
    provider.name = requireString(value.name, "name");
  if (value.baseUrl !== undefined) {
    provider.baseUrl = requireHttpUrl(value.baseUrl, "baseUrl");
  }
  if (value.api !== undefined) provider.api = requireString(value.api, "api");
  if (value.apiKey !== undefined) {
    const apiKey = requireString(value.apiKey, "apiKey");
    if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey)) {
      throw new Error(
        `Provider '${providerId}' apiKey must reference an environment variable, such as $RDSEC_API_KEY.`,
      );
    }
    provider.apiKey = apiKey;
  }
  if (value.authHeader !== undefined) {
    if (typeof value.authHeader !== "boolean") {
      throw new Error(`Provider '${providerId}' authHeader must be a boolean.`);
    }
    provider.authHeader = value.authHeader;
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) {
      throw new Error(`Provider '${providerId}' models must be an array.`);
    }
    provider.models = value.models.map((model, index) =>
      validateModel(providerId, model, index),
    );
  }
  if (!provider.baseUrl && !provider.models?.length) {
    throw new Error(
      `Provider '${providerId}' must define a baseUrl or at least one model.`,
    );
  }
  return provider;
}

function validateModel(
  providerId: string,
  value: unknown,
  index: number,
): WorkspaceModel {
  if (!isRecord(value)) {
    throw new Error(`Provider '${providerId}' model ${index + 1} is invalid.`);
  }
  const model: WorkspaceModel = { id: requireString(value.id, "model id") };
  if (value.name !== undefined)
    model.name = requireString(value.name, "model name");
  if (value.api !== undefined)
    model.api = requireString(value.api, "model api");
  if (value.baseUrl !== undefined) {
    model.baseUrl = requireHttpUrl(value.baseUrl, "model baseUrl");
  }
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "boolean") {
      throw new Error(`Model '${model.id}' reasoning must be a boolean.`);
    }
    model.reasoning = value.reasoning;
  }
  if (value.input !== undefined) {
    if (
      !Array.isArray(value.input) ||
      !value.input.every((item) => item === "text" || item === "image")
    ) {
      throw new Error(
        `Model '${model.id}' input must contain text and/or image.`,
      );
    }
    model.input = value.input;
  }
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const number = value[field];
    if (number !== undefined) {
      if (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number <= 0
      ) {
        throw new Error(
          `Model '${model.id}' ${field} must be a positive number.`,
        );
      }
      model[field] = number;
    }
  }
  return model;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Workspace models.json ${field} must be a nonempty string.`,
    );
  }
  return value.trim();
}

function requireHttpUrl(value: unknown, field: string): string {
  const url = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Workspace models.json ${field} must be an HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `Workspace models.json ${field} must be an HTTP(S) URL without embedded credentials.`,
    );
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
