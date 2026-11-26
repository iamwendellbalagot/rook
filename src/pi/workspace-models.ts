import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
type ProviderConfiguration = Parameters<ModelRuntime["registerProvider"]>[1];

export interface WorkspaceModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

export interface WorkspaceProvider {
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

type EndpointConfiguration = {
  baseUrl?: string;
  models?: { id: string; baseUrl?: string }[];
};

export function workspaceModelEndpoint(
  provider: EndpointConfiguration,
  modelId: string,
): string | undefined {
  return (
    provider.models?.find((model) => model.id === modelId)?.baseUrl ??
    provider.baseUrl
  );
}

export function workspaceEndpointFingerprint(
  provider: EndpointConfiguration,
): string {
  const endpointConfig = [provider.baseUrl ?? ""];
  for (const model of provider.models ?? [])
    endpointConfig.push(
      "\0",
      model.id,
      "\0",
      model.baseUrl ?? provider.baseUrl ?? "",
    );
  return createHash("sha256").update(endpointConfig.join("")).digest("hex");
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
      validateModel(providerId, model, index, provider),
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
  provider: WorkspaceProvider,
): WorkspaceModel {
  if (!isRecord(value)) {
    throw new Error(`Provider '${providerId}' model ${index + 1} is invalid.`);
  }
  const id = requireString(value.id, "model id");
  const name =
    value.name === undefined ? id : requireString(value.name, "model name");
  const api =
    value.api === undefined
      ? provider.api
      : requireString(value.api, "model api");
  const baseUrl =
    value.baseUrl === undefined
      ? provider.baseUrl
      : requireHttpUrl(value.baseUrl, "model baseUrl");
  if (!api) throw new Error(`Model '${id}' must define an API.`);
  if (!baseUrl) throw new Error(`Model '${id}' must define a baseUrl.`);

  let reasoning = false;
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "boolean") {
      throw new Error(`Model '${id}' reasoning must be a boolean.`);
    }
    reasoning = value.reasoning;
  }
  let input: ("text" | "image")[] = ["text"];
  if (value.input !== undefined) {
    if (
      !Array.isArray(value.input) ||
      !value.input.every((item) => item === "text" || item === "image")
    ) {
      throw new Error(`Model '${id}' input must contain text and/or image.`);
    }
    input = value.input;
  }
  let contextWindow = 128000;
  let maxTokens = 16384;
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const number = value[field];
    if (number !== undefined) {
      if (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number <= 0
      ) {
        throw new Error(`Model '${id}' ${field} must be a positive number.`);
      }
      if (field === "contextWindow") contextWindow = number;
      else maxTokens = number;
    }
  }
  return {
    id,
    name,
    api,
    baseUrl,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
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
