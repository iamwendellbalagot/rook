import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentGateway } from "./agent-gateway.js";
import { adaptPiEvent } from "./event-adapter.js";

export async function createPiAgentGateway(
  cwd = process.cwd(),
  options: { tools?: string[] } = {},
): Promise<AgentGateway> {
  const { session } = await createAgentSession({ cwd, ...options });
  const handlers = new Set<(event: AgentEvent) => void>();
  const unsubscribe = session.subscribe((event) => {
    for (const mapped of adaptPiEvent(event)) emit(mapped);
  });

  function emit(event: AgentEvent): void {
    for (const handler of handlers) handler(event);
  }

  return {
    async send(prompt) {
      try {
        await session.prompt(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", message });
        throw error;
      }
    },
    async cancel() {
      await session.abort();
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispose() {
      unsubscribe();
      handlers.clear();
      session.dispose();
    },
  };
}
