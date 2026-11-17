import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_RESULTS = 100;
const EXCLUDED = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".pi",
  "node_modules",
]);

export function createWorkspaceSearchTool(cwd: string) {
  return defineTool({
    name: "rook_search",
    label: "Search workspace files (read-only)",
    description:
      "Search literal text in bounded, ordinary workspace files without shell. Skips credentials, dependency directories, symlinks, binary files, and oversized files.",
    promptSnippet:
      "Search source and configuration text safely in the workspace.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200 }),
        path: Type.Optional(Type.String({ maxLength: 1024 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      const root = await realpath(cwd);
      const requested = input.path ?? ".";
      if (isAbsolute(requested) || requested.split(/[\\/]+/).includes("..")) {
        throw new Error("Search paths must stay within the workspace.");
      }
      const target = resolve(root, requested);
      if (!isWithin(root, target) || isSensitivePath(relative(root, target))) {
        throw new Error("Search path is outside the safe workspace scope.");
      }
      const info = await lstat(target);
      if (info.isSymbolicLink())
        throw new Error("Symbolic links are not searched.");
      if ((await realpath(target)) !== target)
        throw new Error("Search paths cannot traverse symbolic links.");

      const query = input.query.toLocaleLowerCase();
      const limit = input.limit ?? 40;
      const results: string[] = [];
      let bytesRead = 0;
      let visitedFiles = 0;
      let visitedEntries = 0;
      let truncated = false;

      const visit = async (path: string): Promise<void> => {
        if (
          results.length >= limit ||
          bytesRead >= MAX_TOTAL_BYTES ||
          visitedFiles >= 5000 ||
          visitedEntries >= 10000
        ) {
          truncated = true;
          return;
        }
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) return;
        if (metadata.isDirectory()) {
          const entries = await readdir(path, { withFileTypes: true });
          for (const entry of entries) {
            visitedEntries++;
            if (visitedEntries >= 10000) {
              truncated = true;
              break;
            }
            if (entry.isSymbolicLink()) continue;
            const child = resolve(path, entry.name);
            if (isSensitivePath(relative(root, child))) continue;
            if (entry.isDirectory() || entry.isFile()) await visit(child);
            if (results.length >= limit || bytesRead >= MAX_TOTAL_BYTES) break;
          }
          return;
        }
        if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return;
        visitedFiles++;
        bytesRead += metadata.size;
        const content = await readFile(path);
        if (content.includes(0)) return;
        const lines = content.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? "";
          if (line.toLocaleLowerCase().includes(query)) {
            const location = relative(root, path).split(sep).join("/");
            const safeLine = line
              .trim()
              .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
              .slice(0, 300);
            results.push(`${location}:${index + 1}: ${safeLine}`);
            if (results.length >= limit) break;
          }
        }
      };

      await visit(target);
      const text = results.length
        ? results.join("\n")
        : "No matches found in the inspected files.";
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}${truncated ? "\n[Search output limited.]" : ""}`,
          },
        ],
        details: { matchCount: results.length, bytesRead, truncated },
      };
    },
  });
}

function isSensitivePath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return (
      EXCLUDED.has(lower) ||
      lower.startsWith(".env") ||
      lower === "credentials" ||
      /\.(?:pem|key|p12|pfx)$/.test(lower)
    );
  });
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}
