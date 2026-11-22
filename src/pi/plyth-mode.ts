export type PlythMode = "off" | "observe" | "feedback";

export function resolvePlythMode(env: NodeJS.ProcessEnv): PlythMode {
  if (env.ROOK_PLYTH_MODE !== undefined) {
    return env.ROOK_PLYTH_MODE === "off" || env.ROOK_PLYTH_MODE === "feedback"
      ? env.ROOK_PLYTH_MODE
      : "observe";
  }
  return env.ROOK_PLYTH_FEEDBACK === "1" ? "feedback" : "off";
}
