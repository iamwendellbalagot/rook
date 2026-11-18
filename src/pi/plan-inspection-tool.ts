import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { isAbsolute } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT = 50 * 1024;
const inspectionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("summary"),
      Type.Literal("diff"),
      Type.Literal("log"),
      Type.Literal("branches"),
      Type.Literal("show"),
    ]),
    revision: Type.Optional(Type.String({ maxLength: 64 })),
    path: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);

export function createPlanInspectionTool(cwd: string) {
  return defineTool({
    name: "rook_inspect",
    label: "Inspect repository (read-only)",
    description:
      "Read-only Git inspection in plan or build mode. action: summary (status + recent commits in one call), status, diff, log, branches, or show. show without path returns commit metadata; show with a safe repository-relative path returns the file contents at revision (default HEAD). Revisions: HEAD, HEAD~N, HEAD^N, or commit hash. No shell is executed.",
    promptSnippet: "Inspect Git state without changing the repository.",
    parameters: inspectionSchema,
    execute: async (_id, input) => {
      const action = input.action;
      let args: string[];
      if (action === "status" || action === "summary") {
        const status = runGit(cwd, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        const entries = status
          .split("\0")
          .filter(Boolean)
          .filter((entry) => isSafeRepoPath(entry.slice(3)));
        const text = entries.length
          ? entries
              .map(
                (entry) =>
                  `${entry.slice(0, 2)} ${JSON.stringify(entry.slice(3))}`,
              )
              .join("\n")
          : "Working tree clean (or only sensitive paths are changed).";
        return result(
          limitOutput(
            action === "summary"
              ? `${text}\n\nRecent commits:\n${runGit(cwd, ["log", "-8", "--oneline", "--decorate=short"])}`
              : text,
          ),
        );
      } else if (action === "diff") {
        const paths = changedRepoFiles(cwd);
        const safe = paths.filter(isSafeRepoPath);
        if (!safe.length) return result("No inspectable tracked changes.");
        args = [
          "--literal-pathspecs",
          "diff",
          "HEAD",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          ...safe,
        ];
      } else if (action === "log") {
        args = ["log", "-8", "--oneline", "--decorate=short"];
      } else if (action === "branches") {
        args = ["branch", "--list", "--no-color"];
      } else {
        const revision = input.revision ?? "HEAD";
        const path = input.path ?? "";
        if (
          !/^(?:HEAD(?:~[0-9]+|\^[0-9]*)?|[a-fA-F0-9]{7,40})$/.test(revision)
        ) {
          throw new Error(
            "Revision must be HEAD, a bounded HEAD ancestor, or a commit hash.",
          );
        }
        if (!path) {
          return result(
            limitOutput(
              runGit(cwd, ["show", "--no-patch", "--format=fuller", revision]),
            ),
          );
        }
        if (!isSafeRepoPath(path))
          throw new Error("A safe repository-relative path is required.");
        if (
          runGit(cwd, ["cat-file", "-t", `${revision}:${path}`]).trim() !==
          "blob"
        ) {
          throw new Error(
            "Git inspection can show files only, not directories or trees.",
          );
        }
        args = ["cat-file", "blob", `${revision}:${path}`];
      }

      const output = runGit(cwd, args);
      return result(limitOutput(output));
    },
  });
}

export function inspectGitWorkspace(cwd: string): string {
  const status = runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = status
    .split("\0")
    .filter(Boolean)
    .filter((entry) => isSafeRepoPath(entry.slice(3)));
  const summary = entries.length
    ? entries
        .map(
          (entry) => `${entry.slice(0, 2)} ${JSON.stringify(entry.slice(3))}`,
        )
        .join("\n")
    : "Working tree clean (or only sensitive paths are changed).";
  const files = changedRepoFiles(cwd).filter(isSafeRepoPath);
  const diff = files.length
    ? runGit(cwd, [
        "--literal-pathspecs",
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        ...files,
      ])
    : "No inspectable tracked changes.";
  return limitOutput(
    `Git status (XY: staged, unstaged):\n${summary}\n\nDiff vs HEAD:\n${diff}`,
  );
}

export function changedRepoFiles(cwd: string): string[] {
  let output = "";
  try {
    output = runGit(cwd, ["diff", "HEAD", "--name-only", "-z"]);
  } catch {
    output = [
      safeGit(cwd, ["diff", "--name-only", "-z"]),
      safeGit(cwd, ["diff", "--cached", "--name-only", "-z"]),
    ].join("\0");
  }
  const status = safeGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const statusPaths = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  return [...new Set([...output.split("\0").filter(Boolean), ...statusPaths])];
}

export function isSafeRepoPath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some(
      (part) =>
        part.toLowerCase() === ".." ||
        part.toLowerCase() === ".git" ||
        part.toLowerCase() === "node_modules" ||
        part.toLowerCase() === ".ssh" ||
        part.toLowerCase() === ".aws" ||
        part.toLowerCase() === ".azure" ||
        part.toLowerCase() === ".gnupg" ||
        part.toLowerCase() === ".config" ||
        part.toLowerCase() === ".pi" ||
        part.toLowerCase().startsWith(".env") ||
        part.toLowerCase() === "credentials",
    )
  )
    return false;
  return !/\.(?:pem|key|p12|pfx)$/i.test(segments.at(-1) ?? "");
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.pager=cat",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: MAX_OUTPUT + 1,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error((result.stderr || "Git inspection failed.").trim());
  return result.stdout;
}

function safeGit(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args);
  } catch {
    return "";
  }
}

function limitOutput(output: string): string {
  if (Buffer.byteLength(output) <= MAX_OUTPUT) return output || "No output.";
  let result = output;
  while (Buffer.byteLength(result) > MAX_OUTPUT - 32)
    result = result.slice(0, Math.floor(result.length * 0.9));
  return `${result}\n[Git output truncated at 50 KiB]`;
}

function result(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
