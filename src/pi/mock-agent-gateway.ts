import type {
  AgentEvent,
  AgentGateway,
  AgentResource,
  ExternalAccessGrant,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  SessionInfo,
  SessionMessage,
  ThinkingInfo,
} from "./agent-gateway.js";

export class MockAgentGateway implements AgentGateway {
  private running = false;
  isRunning(): boolean {
    return this.running;
  }
  private readonly handlers = new Set<(event: AgentEvent) => void>();

  async send(prompt: string): Promise<void> {
    this.running = true;
    try {
      const response = `Mock response to: ${prompt}`;
      for (let offset = 0; offset < response.length; offset += 8) {
        const text = response.slice(offset, offset + 8);
        for (const handler of this.handlers)
          handler({ type: "text_delta", text });
      }
      for (const handler of this.handlers)
        handler({ type: "message_complete", text: response });
    } finally {
      this.running = false;
    }
    for (const handler of this.handlers)
      handler({ type: "run_settled", aborted: false });
  }

  async cancel(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  currentModel(): undefined {
    return undefined;
  }

  async selectModel(): Promise<void> {
    throw new Error("The mock gateway has no model catalog.");
  }

  listProviders(): [] {
    return [];
  }

  async logout(): Promise<void> {
    throw new Error("The mock gateway has no provider credentials.");
  }

  getThinkingInfo(): ThinkingInfo {
    return { current: "medium", available: ["medium"] };
  }

  setThinkingLevel(): void {}

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  currentSession() {
    return { id: "mock" };
  }

  sessionHistory(): SessionMessage[] {
    return [];
  }

  listSkills(): AgentResource[] {
    return [];
  }

  listPromptTemplates(): AgentResource[] {
    return [];
  }

  isResourceCommand(): boolean {
    return false;
  }

  listForkPoints(): [] {
    return [];
  }

  async fork(): Promise<void> {
    throw new Error("The mock gateway has no saved session branches.");
  }

  async compact(): Promise<void> {
    throw new Error("The mock gateway has no persistent session to compact.");
  }

  async newSession(): Promise<void> {}

  async resumeSession(): Promise<void> {
    throw new Error("The mock gateway has no saved sessions.");
  }

  setMode(_mode: PermissionMode): void {}

  getPermissionDecisions(): PermissionDecision[] {
    return [];
  }

  setExternalAccessPrompt(): void {}

  getExternalAccessGrants(): ExternalAccessGrant[] {
    return [];
  }

  revokeExternalAccessGrant(): boolean {
    return false;
  }

  getActiveTools(): string[] {
    return [];
  }

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
  }
}
