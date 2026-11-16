export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "message_complete"; text: string }
  | { type: "tool_started"; id: string; name: string; summary: string }
  | { type: "tool_finished"; id: string; status: "ok" | "error" }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "run_settled"; aborted: boolean }
  | { type: "error"; message: string };

export interface AgentGateway {
  send(prompt: string): Promise<void>;
  cancel(): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}
