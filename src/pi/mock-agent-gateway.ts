import type { AgentEvent, AgentGateway } from "./agent-gateway.js";

export class MockAgentGateway implements AgentGateway {
  private readonly handlers = new Set<(event: AgentEvent) => void>();

  async send(prompt: string): Promise<void> {
    const response = `Mock response to: ${prompt}`;
    for (let offset = 0; offset < response.length; offset += 8) {
      const text = response.slice(offset, offset + 8);
      for (const handler of this.handlers)
        handler({ type: "text_delta", text });
    }
    for (const handler of this.handlers) handler({ type: "run_settled" });
  }

  async cancel(): Promise<void> {}

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
  }
}
