import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Reject fixture or ancestor instructions before starting an isolated run. */
export async function assertNoInheritedInstructions(
  workspace: string,
): Promise<void> {
  await rejectFixtureInstructions(workspace);
  let directory = dirname(workspace);
  while (true) {
    const candidate = join(directory, "AGENTS.md");
    try {
      await readFile(candidate);
      throw new Error(
        `Synthetic workspace inherits host instructions: ${candidate}`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Synthetic workspace inherits")
      )
        throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

async function rejectFixtureInstructions(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rejectFixtureInstructions(path);
    else if (entry.isFile() && basename(path).toLowerCase() === "agents.md") {
      throw new Error(
        `Synthetic fixture contains inherited instructions: ${path}`,
      );
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported symlink/special entry in fixture: ${path}`);
    }
  }
}
