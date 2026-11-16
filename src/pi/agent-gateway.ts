export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "run_settled" }
  | { type: "error"; message: string };

export interface AgentGateway {
  send(prompt: string): Promise<void>;
  cancel(): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}
