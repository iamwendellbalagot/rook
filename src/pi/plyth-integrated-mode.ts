export type PlythIntegratedMode = "off" | "prompt" | "integrated";

export function resolvePlythIntegratedMode(
  env: NodeJS.ProcessEnv,
): PlythIntegratedMode {
  switch (env.ROOK_PLYTH_INTEGRATED) {
    case "1":
    case "integrated":
      return "integrated";
    case "prompt":
      return "prompt";
    default:
      return "off";
  }
}
