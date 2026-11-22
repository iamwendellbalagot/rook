import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type PlythIntegratedMode = "off" | "prompt" | "integrated";

export async function resolvePlythIntegratedMode(
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
  defaultMode: PlythIntegratedMode = "off",
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
      return defaultMode;
    throw new Error(
      `Could not load .rook/plyth.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(".rook/plyth.json must contain a JSON object.");
  const config = parsed as Record<string, unknown>;
  if (config.schemaVersion !== 1 || config.integrationVersion !== 1)
    throw new Error(".rook/plyth.json has an unsupported schema version.");
  const mode = config.mode;
  if (mode === "off" || mode === "prompt" || mode === "integrated") return mode;
  throw new Error(
    '.rook/plyth.json must set mode to "off", "prompt", or "integrated".',
  );
}

export async function writePlythIntegratedMode(
  cwd: string,
  mode: PlythIntegratedMode,
): Promise<void> {
  const directory = join(cwd, ".rook");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Refusing to write through a non-directory .rook path.");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(directory, { mode: 0o700 });
  }

  const path = join(directory, "plyth.json");
  const temporary = join(directory, `.plyth-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify({ schemaVersion: 1, integrationVersion: 1, mode }, null, 2)}\n`,
      "utf8",
    );
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
