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

export interface SessionInfo {
  id: string;
  path: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export interface CurrentSessionInfo {
  id: string;
  path?: string;
  name?: string;
}

export interface PermissionDecision {
  toolName: string;
  allowed: boolean;
  reason: string;
  timestamp: Date;
}

export interface ExternalAccessRequest {
  toolName: string;
  path: string;
  folderPath: string;
  access: "read" | "write";
}

export type ExternalAccessChoice = "once" | "session" | "deny";

export interface ExternalAccessGrant {
  id: string;
  path: string;
  requestedPath: string;
  access: "read" | "write";
}

export type PermissionMode = "plan" | "build";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
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
  listSessions(): Promise<SessionInfo[]>;
  currentSession(): CurrentSessionInfo;
  sessionHistory(): SessionMessage[];
  newSession(): Promise<void>;
  resumeSession(path: string): Promise<void>;
  setMode(mode: PermissionMode): void;
  getPermissionDecisions(): PermissionDecision[];
  setExternalAccessPrompt(
    handler:
      | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
      | undefined,
  ): void;
  getExternalAccessGrants(): ExternalAccessGrant[];
  revokeExternalAccessGrant(id: string): boolean;
  getActiveTools(): string[];
  subscribe(handler: (event: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}
