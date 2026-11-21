import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PlythIntegratedMode = "off" | "prompt" | "integrated";

export async function resolvePlythIntegratedMode(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<PlythIntegratedMode> {
  if (env.ROOK_PLYTH_INTEGRATED !== undefined) {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(cwd, ".rook", "plyth.json"), "utf8"),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return "off";
    throw new Error(
      `Could not load .rook/plyth.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(".rook/plyth.json must contain a JSON object.");
  const config = parsed as Record<string, unknown>;
  if (config.schemaVersion !== 1)
    throw new Error(".rook/plyth.json has an unsupported schema version.");
  const mode = config.mode;
  if (mode === "off" || mode === "prompt" || mode === "integrated") return mode;
  throw new Error(
    '.rook/plyth.json must set mode to "off", "prompt", or "integrated".',
  );
}
