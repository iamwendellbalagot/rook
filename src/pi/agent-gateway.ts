export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_started"; id: string; name: string; summary: string }
  | { type: "tool_finished"; id: string; status: "ok" | "error" }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "run_settled"; aborted: boolean }
  | { type: "error"; message: string };

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  authMethods: string[];
}

export interface ThinkingInfo {
  current: string;
  available: string[];
}

export interface AgentGateway {
  send(prompt: string): Promise<void>;
  cancel(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  currentModel(): ModelInfo | undefined;
  selectModel(model: ModelInfo): Promise<void>;
  listProviders(): ProviderInfo[];
  logout(providerId: string): Promise<void>;
  getThinkingInfo(): ThinkingInfo;
  setThinkingLevel(level: string): void;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}
