import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentGateway } from "./agent-gateway.js";

export async function createPiAgentGateway(
  cwd = process.cwd(),
): Promise<AgentGateway> {
  const { session } = await createAgentSession({ cwd });
  const handlers = new Set<(event: AgentEvent) => void>();
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      emit({ type: "text_delta", text: event.assistantMessageEvent.delta });
    } else if (event.type === "agent_settled") {
      emit({ type: "run_settled" });
    }
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
