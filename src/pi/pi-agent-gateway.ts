import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentGateway,
  CurrentSessionInfo,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  ProviderInfo,
  SessionInfo,
  SessionMessage,
  ThinkingInfo,
} from "./agent-gateway.js";
import { adaptPiEvent } from "./event-adapter.js";
import {
  createToolPolicyExtension,
  ToolPolicy,
} from "../policy/tool-policy.js";

const AVAILABLE_TOOLS = ["read", "find", "ls", "edit", "write"];

function activeToolsFor(mode: PermissionMode): string[] {
  return mode === "build"
    ? AVAILABLE_TOOLS
    : AVAILABLE_TOOLS.filter((name) => name !== "edit" && name !== "write");
}

export async function createPiAgentGateway(
  cwd = process.cwd(),
  options: { sessionDir?: string } = {},
): Promise<AgentGateway> {
  const handlers = new Set<(event: AgentEvent) => void>();
  const policy = new ToolPolicy(cwd);
  let unsubscribe: (() => void) | undefined;
  const runtime = await createAgentSessionRuntime(
    async ({
      cwd: sessionCwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd: sessionCwd,
        agentDir,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          extensionFactories: [createToolPolicyExtension(policy)],
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
          tools: AVAILABLE_TOOLS,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd, options.sessionDir),
    },
  );

  const bindSession = async (session: AgentSession): Promise<void> => {
    unsubscribe?.();
    session.setActiveToolsByName(activeToolsFor(policy.getMode()));
    await session.bindExtensions({});
    unsubscribe = session.subscribe((event) => {
      for (const mapped of adaptPiEvent(event)) emit(mapped);
    });
  };
  runtime.setBeforeSessionInvalidate(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });
  runtime.setRebindSession(bindSession);
  await bindSession(runtime.session);

  function emit(event: AgentEvent): void {
    for (const handler of handlers) handler(event);
  }

  return {
    async send(prompt) {
      try {
        await runtime.session.prompt(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", message });
        throw error;
      }
    },
    async cancel() {
      await runtime.session.abort();
    },
    async listModels(): Promise<ModelInfo[]> {
      return runtime.session.modelRuntime
        .getModels()
        .map(({ provider, id, name }) => ({
          provider,
          id,
          name,
        }));
    },
    currentModel(): ModelInfo | undefined {
      const model = runtime.session.model;
      return model
        ? { provider: model.provider, id: model.id, name: model.name }
        : undefined;
    },
    async selectModel(model) {
      const candidate = runtime.session.modelRuntime.getModel(
        model.provider,
        model.id,
      );
      if (!candidate)
        throw new Error("That model is not in Pi's model catalog.");
      await runtime.session.setModel(candidate, { persist: true });
    },
    listProviders(): ProviderInfo[] {
      const modelRuntime = runtime.session.modelRuntime;
      return modelRuntime.getRegisteredProviderIds().map((id) => {
        const provider = modelRuntime.getProvider(id);
        const auth = provider?.auth;
        return {
          id,
          name: provider?.name ?? id,
          configured: modelRuntime.getProviderAuthStatus(id).configured,
          authMethods: [
            ...(auth?.apiKey ? [auth.apiKey.name] : []),
            ...(auth?.oauth ? [auth.oauth.name] : []),
          ],
        };
      });
    },
    async logout(providerId) {
      await runtime.session.modelRuntime.logout(providerId);
    },
    getThinkingInfo(): ThinkingInfo {
      return {
        current: runtime.session.thinkingLevel,
        available: runtime.session.getAvailableThinkingLevels(),
      };
    },
    setThinkingLevel(level) {
      const available = runtime.session.getAvailableThinkingLevels();
      if (!available.includes(level as (typeof available)[number])) {
        throw new Error("Unsupported thinking level for the selected model.");
      }
      runtime.session.setThinkingLevel(level as (typeof available)[number], {
        persist: true,
      });
    },
    setMode(mode) {
      policy.setMode(mode);
      runtime.session.setActiveToolsByName(activeToolsFor(mode));
    },
    getPermissionDecisions(): PermissionDecision[] {
      return policy.getDecisions();
    },
    getActiveTools(): string[] {
      return runtime.session.getActiveToolNames();
    },
    async listSessions(): Promise<SessionInfo[]> {
      return (await SessionManager.list(runtime.cwd, options.sessionDir)).map(
        (session) => ({
          id: session.id,
          path: session.path,
          ...(session.name ? { name: session.name } : {}),
          created: session.created,
          modified: session.modified,
          messageCount: session.messageCount,
          firstMessage: session.firstMessage,
        }),
      );
    },
    currentSession(): CurrentSessionInfo {
      const session = runtime.session;
      return {
        id: session.sessionId,
        ...(session.sessionFile ? { path: session.sessionFile } : {}),
        ...(session.sessionName ? { name: session.sessionName } : {}),
      };
    },
    sessionHistory(): SessionMessage[] {
      return runtime.session.messages.flatMap((message) => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        return text ? [{ role: message.role, text }] : [];
      });
    },
    async newSession() {
      await runtime.newSession();
    },
    async resumeSession(path) {
      const result = await runtime.switchSession(path);
      if (result.cancelled)
        throw new Error("The session switch was cancelled.");
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      handlers.clear();
      await runtime.dispose();
    },
  };
}
