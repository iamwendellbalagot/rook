import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 12 * 1024;
const MAX_RESULTS = 40;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".cs",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".pi",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
]);

interface MappedFile {
  path: string;
  symbols: string[];
  importedBy: number;
  score: number;
}

export function createWorkspaceMapTool(cwd: string) {
  return defineTool({
    name: "rook_map",
    label: "Map workspace symbols (read-only)",
    description:
      "Build a bounded, on-demand map of source files and top-level symbols to orient repository work. An optional query ranks relevant paths and symbols. It skips credentials, dependencies, generated output, links, binaries, and oversized files; it does not emit source contents.",
    promptSnippet:
      "Use rook_map for a compact repository structure/symbol overview when relevant context is not obvious.",
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String({ maxLength: 200 })),
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
        throw new Error("Map paths must stay within the workspace.");
      }
      const target = resolve(root, requested);
      if (!isWithin(root, target) || isSensitivePath(relative(root, target))) {
        throw new Error("Map path is outside the safe workspace scope.");
      }
      const targetInfo = await lstat(target);
      if (targetInfo.isSymbolicLink() || (await realpath(target)) !== target) {
        throw new Error("Symbolic links are not mapped.");
      }

      const candidates = await listCandidateFiles(root, target);
      const mapped = await mapFiles(root, candidates);
      const queryTerms = (input.query ?? "")
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_$]+/u)
        .filter((term) => term.length > 1)
        .slice(0, 12);
      for (const file of mapped) {
        const path = file.path.toLocaleLowerCase();
        const symbols = file.symbols.join(" ").toLocaleLowerCase();
        file.score =
          queryTerms.reduce(
            (score, term) =>
              score +
              (path.includes(term) ? 5 : 0) +
              (symbols.includes(term) ? 4 : 0),
            0,
          ) + file.importedBy;
      }
      mapped.sort(
        (a, b) =>
          b.score - a.score ||
          b.importedBy - a.importedBy ||
          a.path.localeCompare(b.path),
      );
      const limit = input.limit ?? 30;
      const lines = mapped.slice(0, limit).map((file) => {
        const declarations = file.symbols.length
          ? file.symbols.slice(0, 8).join(", ")
          : "(no top-level symbols detected)";
        return `- ${file.path}${file.importedBy ? ` · ${file.importedBy} internal importers` : ""}\n  ${declarations}`;
      });
      const text = lines.length
        ? `Workspace map${input.query ? ` for “${safeText(input.query)}”` : ""} (${lines.length} of ${mapped.length} source files):\n${lines.join("\n")}`
        : "No safe source files were found to map.";
      return {
        content: [
          { type: "text" as const, text: text.slice(0, MAX_OUTPUT_CHARS) },
        ],
        details: {
          mappedFiles: mapped.length,
          listedFiles: lines.length,
          truncated: candidates.length >= MAX_FILES || mapped.length > limit,
        },
      };
    },
  });
}

async function listCandidateFiles(
  root: string,
  target: string,
): Promise<string[]> {
  if (target !== root && !(await lstat(target)).isDirectory()) {
    return [relative(root, target)];
  }
  const gitFiles = gitCandidateFiles(root, target);
  if (gitFiles) return gitFiles.slice(0, MAX_FILES);

  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (found.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= MAX_FILES) break;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink() || isSensitivePath(relative(root, path)))
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && isSourceFile(path))
        found.push(relative(root, path));
    }
  };
  await visit(target);
  return found;
}

function gitCandidateFiles(root: string, target: string): string[] | undefined {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: target,
        encoding: "buffer",
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const prefix = target === root ? "" : `${relative(root, target)}${sep}`;
    return output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => (prefix ? resolve(target, path) : resolve(root, path)))
      .filter((path) => isWithin(root, path) && isSourceFile(path))
      .map((path) => relative(root, path));
  } catch {
    return undefined;
  }
}

async function mapFiles(root: string, paths: string[]): Promise<MappedFile[]> {
  const importedBy = new Map<string, number>();
  const sources: { path: string; content: string; symbols: string[] }[] = [];
  let bytesRead = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    if (isSensitivePath(path)) continue;
    const absolute = resolve(root, path);
    try {
      const info = await lstat(absolute);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size > MAX_FILE_BYTES ||
        bytesRead + info.size > MAX_TOTAL_BYTES ||
        (await realpath(absolute)) !== absolute
      ) {
        continue;
      }
      const content = await readFile(absolute, "utf8");
      if (content.includes("\0")) continue;
      bytesRead += info.size;
      const symbols = extractSymbols(content, absolute);
      sources.push({ path, content, symbols });
    } catch {
      // A file may disappear or become unreadable during the bounded scan.
    }
  }
  const knownPaths = new Set(sources.map((source) => source.path));
  for (const source of sources) {
    for (const match of source.content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const imported = normalizeImportPath(
        root,
        source.path,
        match[1] ?? "",
        knownPaths,
      );
      if (imported && knownPaths.has(imported)) {
        importedBy.set(imported, (importedBy.get(imported) ?? 0) + 1);
      }
    }
  }
  return sources.map((source) => ({
    path: source.path.split(sep).join("/"),
    symbols: source.symbols,
    importedBy: importedBy.get(source.path) ?? 0,
    score: 0,
  }));
}

function extractSymbols(content: string, filePath: string): string[] {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const patterns =
    extension === ".py"
      ? [/^\s*(?:async\s+)?(?:def|class)\s+([\w$]+)/gm]
      : extension === ".go"
        ? [/^\s*func(?:\s+\([^)]*\))?\s+([\w$]+)/gm]
        : extension === ".rs"
          ? [
              /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([\w$]+)/gm,
            ]
          : [
              /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|const|let|var)\s+([\w$]+)/gm,
            ];
  const symbols = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
      if (symbols.size >= 24) return [...symbols];
    }
  }
  return [...symbols];
}

function normalizeImportPath(
  root: string,
  from: string,
  imported: string,
  knownPaths: Set<string>,
): string | undefined {
  const absolute = resolve(root, dirname(from), imported);
  const relativePath = relative(root, absolute);
  if (!isWithin(root, absolute) || isSensitivePath(relativePath))
    return undefined;
  const candidates = [relativePath];
  if (!/\.[^/\\]+$/.test(imported)) {
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(
        `${relativePath}${extension}`,
        join(relativePath, `index${extension}`),
      );
    }
  }
  return candidates.find((candidate) => knownPaths.has(candidate));
}

function isSourceFile(path: string): boolean {
  const basename = path.split(/[\\/]/).at(-1) ?? "";
  return SOURCE_EXTENSIONS.has(
    basename.slice(basename.lastIndexOf(".")).toLowerCase(),
  );
}

function isSensitivePath(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase();
      return (
        EXCLUDED_SEGMENTS.has(lower) ||
        lower.startsWith(".env") ||
        lower === "credentials" ||
        /\.(?:pem|key|p12|pfx)$/i.test(lower)
      );
    });
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
