import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlythRuntime } from "./plyth-contracts.js";

const PLYTH_PACKAGE_NAME = "plyth-core";

/** Resolve PLYTH from the target workspace, not from Rook's installation. */
export async function loadPlythRuntime(
  cwd: string,
): Promise<PlythRuntime | undefined> {
  const require = createRequire(join(cwd, "__rook_plyth_resolver__.cjs"));
  const entry = await findPlythEntry(
    require.resolve.paths(PLYTH_PACKAGE_NAME) ?? [],
  );
  if (!entry) return undefined;
  const loaded = (await import(pathToFileURL(entry).href)) as PlythRuntime;
  const requiredFunctions = [
    "SessionCounter",
    "CommandHistoryBaseline",
    "IntegratedPlythFlow",
    "parseTraceRecord",
    "createTraceRecord",
    "parseCommandStarted",
    "parseCommandFinished",
    "judgeEvents",
    "SessionFeedbackGate",
    "buildChangeReviewPrompt",
    "buildScopedChangeReviewPrompt",
    "bindChangeReviewResult",
    "parseChangeReviewReport",
    "formatChangeReviewReport",
    "reviewContextUnits",
  ];
  const missing = requiredFunctions.filter(
    (name) => typeof loaded[name] !== "function",
  );
  if (typeof loaded.CHANGE_REVIEW_CONTEXT_BUDGET !== "number")
    missing.push("CHANGE_REVIEW_CONTEXT_BUDGET");
  if (missing.length)
    throw new Error(
      `The installed PLYTH package is incompatible; missing exports: ${missing.join(", ")}.`,
    );
  return loaded;
}

async function findPlythEntry(
  searchPaths: string[],
): Promise<string | undefined> {
  for (const nodeModules of searchPaths) {
    const packageRoot = join(nodeModules, ...PLYTH_PACKAGE_NAME.split("/"));
    const manifestPath = join(packageRoot, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        exports?: Record<string, unknown> | string;
        module?: string;
        main?: string;
      };
      const packageExport =
        typeof manifest.exports === "string"
          ? manifest.exports
          : manifest.exports?.["."];
      const entry =
        typeof packageExport === "string"
          ? packageExport
          : packageExport && typeof packageExport === "object"
            ? ((packageExport as Record<string, unknown>).import ??
              (packageExport as Record<string, unknown>).default)
            : (manifest.module ?? manifest.main);
      if (typeof entry !== "string")
        throw new Error("The installed PLYTH package has no import entry.");
      const absoluteEntry = resolve(packageRoot, entry);
      await access(absoluteEntry);
      return absoluteEntry;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        continue;
      throw error;
    }
  }
  return undefined;
}
