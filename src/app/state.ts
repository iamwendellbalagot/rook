export type RookMode = "plan" | "build";
export type RunState = "idle" | "running" | "settled" | "failed";
export type ToolStatus = "running" | "ok" | "error" | "blocked";

export interface ToolActivity {
  id: string;
  name: string;
  summary: string;
  status: ToolStatus;
}

export interface AppState {
  phase: "startup" | "ready" | "auth_required" | "disposed";
  runState: RunState;
  mode: RookMode;
  response: string;
  error: string | null;
  tools: ToolActivity[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  } | null;
}

export type AppEvent =
  | { type: "startup_complete" }
  | { type: "auth_required" }
  | { type: "auth_complete" }
  | { type: "prompt_submitted" }
  | { type: "text_delta"; text: string }
  | { type: "message_complete"; text: string }
  | { type: "run_state"; state: RunState }
  | { type: "mode_changed"; mode: RookMode }
  | { type: "tool_started"; tool: Omit<ToolActivity, "status"> }
  | {
      type: "tool_finished";
      id: string;
      status: Exclude<ToolStatus, "running">;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }
  | { type: "error"; message: string }
  | { type: "shutdown" };

export function initialAppState(): AppState {
  return {
    phase: "startup",
    runState: "idle",
    mode: "build",
    response: "",
    error: null,
    tools: [],
    usage: null,
  };
}

export function reduceAppState(state: AppState, event: AppEvent): AppState {
  if (state.phase === "disposed") return state;

  switch (event.type) {
    case "startup_complete":
      return state.phase === "startup" ? { ...state, phase: "ready" } : state;
    case "auth_required":
      return state.phase === "startup"
        ? { ...state, phase: "auth_required" }
        : state;
    case "auth_complete":
      return state.phase === "auth_required"
        ? { ...state, phase: "ready" }
        : state;
    case "prompt_submitted":
      return state.phase === "ready" && state.runState !== "running"
        ? {
            ...state,
            runState: "running",
            response: "",
            error: null,
            tools: [],
            usage: null,
          }
        : state;
    case "text_delta":
      return state.runState === "running"
        ? { ...state, response: state.response + event.text }
        : state;
    case "message_complete":
      return state.runState === "running"
        ? { ...state, response: event.text }
        : state;
    case "run_state":
      return state.phase === "ready"
        ? { ...state, runState: event.state }
        : state;
    case "mode_changed":
      return state.phase === "ready" && state.runState !== "running"
        ? { ...state, mode: event.mode }
        : state;
    case "tool_started":
      return state.runState === "running"
        ? {
            ...state,
            tools: [
              ...state.tools.filter((tool) => tool.id !== event.tool.id),
              { ...event.tool, status: "running" },
            ],
          }
        : state;
    case "tool_finished":
      return state.runState === "running"
        ? {
            ...state,
            tools: state.tools.map((tool) =>
              tool.id === event.id ? { ...tool, status: event.status } : tool,
            ),
          }
        : state;
    case "usage":
      return state.runState === "running"
        ? {
            ...state,
            usage: {
              ...(event.inputTokens === undefined
                ? {}
                : { inputTokens: event.inputTokens }),
              ...(event.outputTokens === undefined
                ? {}
                : { outputTokens: event.outputTokens }),
              ...(event.costUsd === undefined
                ? {}
                : { costUsd: event.costUsd }),
            },
          }
        : state;
    case "error":
      return {
        ...state,
        runState: "failed",
        error: event.message,
      };
    case "shutdown":
      return { ...state, phase: "disposed", runState: "idle" };
  }
}
