import { execFile } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXCLUDED = new Set([
  ".git",
  ".rook",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".pi",
  "node_modules",
]);
export function createWorkspaceSearchTool(
  cwd: string,
  canRead: (path: string) => Promise<boolean> = async () => true,
) {
  return defineTool({
    name: "rook_search",
    label: "Search workspace files (read-only)",
    description:
      "Git-ignore-aware ripgrep search. Literal by default; optional regex, file glob, and case control. Permission-restricted, sensitive, binary, linked, and oversized files are skipped. Partial results are explicitly reported. Requires ripgrep installed in a standard system location.",
    promptSnippet:
      "Search relevant source with literal or regex patterns and file-glob filters.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200 }),
        path: Type.Optional(Type.String({ maxLength: 1024 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        regex: Type.Optional(Type.Boolean()),
        caseSensitive: Type.Optional(Type.Boolean()),
        glob: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input, signal) => {
      const root = await realpath(cwd);
      const requested = input.path ?? ".";
      if (isAbsolute(requested) || requested.split(/[\\/]+/).includes(".."))
        throw new Error("Search paths must stay within the workspace.");
      const target = resolve(root, requested);
      if (
        (await realpath(target)) !== target ||
        sensitive(relative(root, target))
      )
        throw new Error(
          "Search paths cannot traverse symbolic links or sensitive directories.",
        );
      let rg: string | undefined;
      for (const candidate of [
        "/usr/bin/rg",
        "/usr/local/bin/rg",
        "/opt/homebrew/bin/rg",
        resolve(
          getAgentDir(),
          "bin",
          process.platform === "win32" ? "rg.exe" : "rg",
        ),
      ]) {
        try {
          await access(candidate);
          rg = candidate;
          break;
        } catch {
          /* next trusted location */
        }
      }
      if (!rg)
        throw new Error(
          "ripgrep is unavailable; install rg in a standard system location.",
        );
      const listing = await run(
        rg,
        [
          "--files",
          "--null",
          "--hidden",
          ...(input.glob ? [`--glob=${input.glob}`] : []),
          "--",
          requested,
        ],
        root,
        signal,
      );
      let truncated = listing.limited;
      let omitted = 0;
      const paths: string[] = [];
      let argumentBytes = 0;
      for (const path of listing.stdout.split("\0").filter(Boolean)) {
        if (paths.length >= 2000 || argumentBytes > 100_000) {
          truncated = true;
          break;
        }
        if (sensitive(path)) {
          omitted++;
          continue;
        }
        try {
          const absolute = resolve(root, path);
          const info = await lstat(absolute);
          if (
            !info.isFile() ||
            info.size > 1024 * 1024 ||
            (await realpath(absolute)) !== absolute ||
            !(await canRead(path))
          ) {
            omitted++;
            continue;
          }
          paths.push(path);
          argumentBytes += Buffer.byteLength(path) + 1;
        } catch {
          omitted++;
        }
      }
      const result = paths.length
        ? await run(
            rg,
            [
              "--json",
              "--line-number",
              "--max-filesize=1M",
              ...(input.regex ? [] : ["--fixed-strings"]),
              ...(input.caseSensitive === false
                ? ["--ignore-case"]
                : ["--case-sensitive"]),
              `--regexp=${input.query}`,
              "--",
              ...paths,
            ],
            root,
            signal,
          )
        : { stdout: "", limited: false };
      truncated ||= result.limited;
      const matches: string[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          truncated = true;
          continue;
        }
        if (entry.type !== "match") continue;
        if (matches.length >= (input.limit ?? 40)) {
          truncated = true;
          break;
        }
        if (
          typeof entry.data?.path?.text !== "string" ||
          typeof entry.data?.lines?.text !== "string"
        ) {
          omitted++;
          continue;
        }
        matches.push(
          `${entry.data.path.text}:${entry.data.line_number}: ${entry.data.lines.text
            .trim()
            .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
            .slice(0, 300)}`,
        );
      }
      const text = matches.length
        ? matches.join("\n")
        : "No matches found in the inspected files.";
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}${truncated || omitted ? `\n[Partial search: ${omitted} files omitted; ${truncated ? "scan/output limit reached" : "permissions/safety exclusions apply"}.]` : ""}`,
          },
        ],
        details: {
          matchCount: matches.length,
          truncated,
          omitted,
          inspectedFiles: paths.length,
        },
      };
    },
  });
}
function sensitive(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some(
      (segment) =>
        EXCLUDED.has(segment.toLowerCase()) ||
        /^\.env|^(?:credentials|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(
          segment,
        ),
    );
}
function run(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; limited: boolean }> {
  return new Promise((resolveResult, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("Search cancelled"));
          return;
        }
        if (error && "code" in error && error.code !== 1) {
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            resolveResult({ stdout, limited: true });
          else
            reject(
              new Error(
                `Search failed: ${stderr.slice(0, 1000) || error.message}`,
              ),
            );
        } else resolveResult({ stdout, limited: false });
      },
    );
  });
}
