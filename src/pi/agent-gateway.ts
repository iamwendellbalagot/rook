import type { TaskChecklistItem } from "./task-checklist.js";

export type AgentEvent =
  | { type: "model_request_started" }
  | { type: "text_delta"; text: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_started"; id: string; name: string; summary: string }
  | {
      type: "tool_finished";
      id: string;
      status: "ok" | "error";
      error?: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "todo_updated"; tasks: TaskChecklistItem[] }
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

export type ExternalAccessRequest =
  | {
      toolName: string;
      path: string;
      folderPath: string;
      access: "read" | "write";
    }
  | {
      toolName: "bash";
      path: string;
      folderPath: string;
      access: "execute";
      command: string;
      timeoutSeconds: number;
    };

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

export type PromptDisposition = "normal" | "steer" | "follow_up";

export interface AgentResource {
  name: string;
  description: string;
}

export interface ForkPoint {
  entryId: string;
  text: string;
}

export interface AgentGateway {
  isRunning(): boolean;
  send(prompt: string, disposition?: PromptDisposition): Promise<void>;
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
  listSkills(): AgentResource[];
  listPromptTemplates(): AgentResource[];
  isResourceCommand(prompt: string): boolean;
  listForkPoints(): ForkPoint[];
  fork(entryId: string): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  newSession(): Promise<void>;
  resumeSession(path: string): Promise<void>;
  setMode(mode: PermissionMode): void;
  inspectGitChanges(): Promise<string>;
  reviewGitChanges(): Promise<string>;
  exploreReadOnly(task: string): Promise<string>;
  architectReadOnly(task: string): Promise<string>;
  getUndoPreview(): string;
  undoLastFileChange(): Promise<string>;
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
