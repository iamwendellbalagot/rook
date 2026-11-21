import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChangeReviewRequest } from "plyth";
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

export function inspectGitWorkspace(
  cwd: string,
  selectedPaths?: readonly string[],
): string {
  const status = runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  let entries = parseGitStatus(status).filter((entry) =>
    isSafeRepoPath(entry.slice(3)),
  );
  let files = changedRepoFiles(cwd).filter(isSafeRepoPath);
  if (selectedPaths) {
    const selected = [...new Set(selectedPaths)];
    if (
      selected.length === 0 ||
      selected.some((path) => !isSafeRepoPath(path) || path.trim() !== path)
    )
      throw new Error(
        "Review scope must contain safe repository-relative paths.",
      );
    const changed = new Set(files);
    const notChanged = selected.filter((path) => !changed.has(path));
    if (notChanged.length)
      throw new Error(
        `Review paths must be changed files: ${notChanged.join(", ")}`,
      );
    const selectedSet = new Set(selected);
    entries = entries.filter((entry) => selectedSet.has(entry.slice(3)));
    files = selected;
  }
  const summary = entries.length
    ? entries
        .map(
          (entry) => `${entry.slice(0, 2)} ${JSON.stringify(entry.slice(3))}`,
        )
        .join("\n")
    : "Working tree clean (or only sensitive paths are changed).";
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
  const statusPaths = parseGitStatus(status).map((entry) => entry.slice(3));
  return [...new Set([...output.split("\0").filter(Boolean), ...statusPaths])];
}

export function isSafeRepoPath(path: string): boolean {
  if (
    !path ||
    path.length > 512 ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    /[\x00-\x1f\\]/.test(path)
  )
    return false;
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

/** Porcelain -z rename entries have an extra source-path record, not a status. */
function parseGitStatus(status: string): string[] {
  const records = status.split("\0");
  const entries: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    if (!entry) continue;
    entries.push(entry);
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return entries;
}

export interface ReviewBoundary {
  head: string;
  files: Set<string>;
}

export function reviewWorkspaceRoot(cwd: string): string {
  return realpathSync(runGit(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

/** Bounded changed-file snapshots only; never crawl the repository or persist source. */
export function captureReviewBoundary(cwd: string): ReviewBoundary {
  const root = reviewWorkspaceRoot(cwd);
  const paths = changedRepoFiles(root).filter(isSafeRepoPath);
  if (paths.length > 100)
    throw new Error(
      "Review scope exceeds 100 changed files; select a smaller workspace.",
    );
  return {
    head: runGit(root, ["rev-parse", "--verify", "HEAD"]).trim(),
    files: new Set(paths),
  };
}

export function captureChangeReview(
  cwd: string,
  taskContext: string,
  boundary?: ReviewBoundary,
  selectedPaths?: readonly string[],
): ChangeReviewRequest {
  const root = reviewWorkspaceRoot(cwd);
  const changed = changedRepoFiles(root).filter(isSafeRepoPath);
  const workspace = realpathSync(cwd);
  const withinWorkspace = (path: string) => {
    const local = relative(workspace, resolve(root, path));
    return (
      local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    );
  };
  const head = runGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const knownBoundary = boundary?.head === head ? boundary : undefined;
  const paths = selectedPaths
    ? [...new Set(selectedPaths)]
    : changed.filter(
        (path) =>
          withinWorkspace(path) &&
          !knownBoundary?.files.has(path) &&
          !/(?:^|\/)(?:dist|build|vendor|coverage|generated)(?:\/|$)/.test(
            path,
          ),
      );
  if (
    paths.length > 20 ||
    paths.some(
      (path) =>
        !isSafeRepoPath(path) ||
        !changed.includes(path) ||
        !withinWorkspace(path),
    )
  )
    throw new Error(
      "Review requires at most 20 safe changed repository-relative files.",
    );
  const mixed =
    !knownBoundary || paths.some((path) => knownBoundary.files.has(path));
  const limitations: string[] = [];
  if (mixed)
    limitations.push(
      "Task attribution is unknown: selected files may include pre-existing or mixed user changes.",
    );
  if (
    !selectedPaths &&
    knownBoundary &&
    changed.some((path) => knownBoundary.files.has(path))
  )
    limitations.push(
      "Pre-existing changed files were excluded; use explicit --file scope to review mixed files without claiming task attribution.",
    );
  if (!taskContext.trim()) limitations.push("Task intent is unavailable.");
  const view = paths.length ? inspectGitWorkspace(root, paths) : "";
  if (view.includes("[Git output truncated"))
    throw new Error("Review diff is too large; select fewer files.");
  let changes = paths.length
    ? view
    : "No task-window changes are available for review.";
  const hashes: [string, string][] = [];
  const contents = new Map<string, string | null>();
  for (const path of paths) {
    const content = safeReviewFile(root, path);
    hashes.push([path, fingerprint(content)]);
    contents.set(path, content);
  }
  // Git diff omits new untracked contents; include them through the same safe file boundary.
  const untracked = new Set(
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split(
      "\0",
    ),
  );
  for (const path of paths) {
    if (untracked.has(path))
      changes += `\nUntracked file ${JSON.stringify(path)}:\n${contents.get(path) ?? "[deleted]"}`;
  }
  return {
    version: 1,
    taskContext,
    changes,
    scope: {
      paths,
      revision: createHash("sha256")
        .update(JSON.stringify([head, changes, hashes]))
        .digest("hex"),
      attribution: mixed ? "unknown" : "task-window",
      limitations,
    },
  };
}

function fingerprint(content: string | null): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Reject links in every component, special files, binary and oversized content. */
function safeReviewFile(root: string, path: string): string | null {
  if (!isSafeRepoPath(path)) throw new Error("Unsafe review path.");
  root = realpathSync(root);
  const target = resolve(root, path);
  const rel = relative(realpathSync(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Review path escapes workspace.");
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    try {
      if (lstatSync(parent).isSymbolicLink())
        throw new Error("Linked review path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
    throw new Error("Review file is linked, special, or exceeds 128 KiB.");
  const fd = openSync(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(fd);
    if (
      before.ino !== info.ino ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 128 * 1024
    )
      throw new Error("Review file changed during capture.");
    const buffer = Buffer.alloc(before.size + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Review file changed during capture.");
    if (buffer.subarray(0, count).includes(0))
      throw new Error("Binary review files are unsupported.");
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    closeSync(fd);
  }
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
