export interface SessionPredictionStats {
  eligibleCommands: number;
  predictedCommands: number;
  invalidPredictions: number;
  specificPredictions: number;
  durationMs: number;
  durationSamples: number;
  verdicts: Record<"hit" | "miss" | "vague" | "none" | "unscorable", number>;
  baseline?: {
    comparisons: number;
    baselineCorrect: number;
    agentCorrect: number;
    unavailable: number;
    invalidations: number;
  };
}

export interface ChangeReviewRequest {
  version: 1;
  taskContext: string;
  changes: string;
  scope: {
    paths: string[];
    revision: string;
    attribution: "task-window" | "unknown";
    limitations: string[];
  };
}

export interface TraceRecord {
  protocol: "plyth/trace/1";
  adapter: "rook-pi/1";
  sessionKey: string;
  minute: number;
  commandClass: "test" | "build" | "diagnostic" | "other";
  verdict: "hit" | "miss" | "vague" | "none" | "unscorable";
  mode: "observe" | "feedback";
  feedbackAppended: boolean;
  predictionOutcome?: "pass" | "fail" | "error";
  observedOutcome?: "pass" | "fail" | "error";
  durationBucket?: "lt100ms" | "lt1s" | "lt10s" | "gte10s";
  baselineComparable: boolean;
  baselineOutcome?: "pass" | "fail" | "error";
  baselineCorrect?: boolean;
  agentCorrect?: boolean;
}

export type PlythRuntime = Record<string, any>;
