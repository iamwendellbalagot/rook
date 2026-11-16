import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentGateway,
  ModelInfo,
  ProviderInfo,
  ThinkingInfo,
} from "./agent-gateway.js";
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
    async listModels(): Promise<ModelInfo[]> {
      return session.modelRuntime.getModels().map(({ provider, id, name }) => ({
        provider,
        id,
        name,
      }));
    },
    currentModel(): ModelInfo | undefined {
      const model = session.model;
      return model
        ? { provider: model.provider, id: model.id, name: model.name }
        : undefined;
    },
    async selectModel(model) {
      const candidate = session.modelRuntime.getModel(model.provider, model.id);
      if (!candidate)
        throw new Error("That model is not in Pi's model catalog.");
      await session.setModel(candidate, { persist: true });
    },
    listProviders(): ProviderInfo[] {
      const runtime = session.modelRuntime;
      return runtime.getRegisteredProviderIds().map((id) => {
        const provider = runtime.getProvider(id);
        const auth = provider?.auth;
        return {
          id,
          name: provider?.name ?? id,
          configured: runtime.getProviderAuthStatus(id).configured,
          authMethods: [
            ...(auth?.apiKey ? [auth.apiKey.name] : []),
            ...(auth?.oauth ? [auth.oauth.name] : []),
          ],
        };
      });
    },
    async logout(providerId) {
      await session.modelRuntime.logout(providerId);
    },
    getThinkingInfo(): ThinkingInfo {
      return {
        current: session.thinkingLevel,
        available: session.getAvailableThinkingLevels(),
      };
    },
    setThinkingLevel(level) {
      const available = session.getAvailableThinkingLevels();
      if (!available.includes(level as (typeof available)[number])) {
        throw new Error("Unsupported thinking level for the selected model.");
      }
      session.setThinkingLevel(level as (typeof available)[number], {
        persist: true,
      });
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
