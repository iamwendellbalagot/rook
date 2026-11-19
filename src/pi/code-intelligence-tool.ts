import { lstat, readdir, realpath } from "node:fs/promises";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import ts from "typescript-legacy";

const MAX_FILES = 1000;
const MAX_OUTPUT = 12_000;
const MAX_RESULTS = 40;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const EXCLUDED = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".pi",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".rook-worktrees",
]);

export function createCodeIntelligenceTool(cwd: string) {
  return defineTool({
    name: "rook_code",
    label: "Navigate code and inspect TypeScript diagnostics (read-only)",
    description:
      "Use the TypeScript language service for symbol definitions/references and focused syntactic/semantic diagnostics. Requires an in-workspace TypeScript or JavaScript file; output and project file count are bounded.",
    promptSnippet:
      "Use rook_code to find symbol definitions/references or inspect focused TypeScript diagnostics when text search is insufficient.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("definition"),
          Type.Literal("references"),
          Type.Literal("diagnostics"),
        ]),
        path: Type.String({ minLength: 1, maxLength: 1024 }),
        line: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
        column: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      const root = await realpath(cwd);
      const file = await resolveSourceFile(root, input.path);
      const project = createLanguageService(root, file);
      try {
        const limit = input.limit ?? MAX_RESULTS;
        let lines: string[];
        let resultTruncated = false;
        if (input.action === "diagnostics") {
          const diagnostics = [
            ...project.service.getSyntacticDiagnostics(file),
            ...project.service.getSemanticDiagnostics(file),
          ].filter(
            (diagnostic) =>
              !diagnostic.file || isWithin(root, diagnostic.file.fileName),
          );
          lines = diagnostics.slice(0, limit).map((diagnostic) => {
            const location = diagnosticLocation(diagnostic, root);
            const code = `TS${diagnostic.code}`;
            const category =
              ts.DiagnosticCategory[diagnostic.category]?.toLowerCase();
            return `${location}${location ? ": " : ""}${category} ${code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
          });
          resultTruncated = diagnostics.length > limit;
          if (diagnostics.length === 0)
            lines = ["No syntactic or semantic diagnostics in this file."];
        } else {
          if (input.line === undefined || input.column === undefined) {
            throw new Error(
              "Definition and reference queries require line and column.",
            );
          }
          const source = project.service.getProgram()?.getSourceFile(file);
          if (!source)
            throw new Error(
              "The requested source file is not in the TypeScript project.",
            );
          const sourceLines = source.text.split(/\r?\n/);
          if (
            input.line > sourceLines.length ||
            input.column > (sourceLines[input.line - 1]?.length ?? 0) + 1
          ) {
            throw new Error(
              "The requested line and column are outside the source file.",
            );
          }
          const position = source.getPositionOfLineAndCharacter(
            input.line - 1,
            input.column - 1,
          );
          const entries =
            input.action === "definition"
              ? (project.service.getDefinitionAtPosition(file, position) ?? [])
              : (project.service
                  .findReferences(file, position)
                  ?.flatMap((group) => group.references) ?? []);
          const localEntries = entries.filter((entry) =>
            isWithin(root, entry.fileName),
          );
          resultTruncated = localEntries.length > limit;
          lines = localEntries.slice(0, limit).map((entry) => {
            const sourceFile = project.service
              .getProgram()
              ?.getSourceFile(entry.fileName);
            if (!sourceFile) return "(location unavailable)";
            const { line, character } =
              sourceFile.getLineAndCharacterOfPosition(entry.textSpan.start);
            const label =
              "isDefinition" in entry && entry.isDefinition
                ? "definition"
                : "reference";
            return `${label}: ${relative(root, entry.fileName).split(sep).join("/")}:${line + 1}:${character + 1}`;
          });
          if (localEntries.length === 0)
            lines = [
              `No ${input.action} found at ${input.path}:${input.line}:${input.column}.`,
            ];
        }
        const truncated =
          resultTruncated || lines.join("\n").length > MAX_OUTPUT;
        const fullText = lines.slice(0, limit).join("\n");
        const text = fullText.slice(0, MAX_OUTPUT);
        return {
          content: [
            {
              type: "text" as const,
              text:
                truncated || fullText.length > MAX_OUTPUT
                  ? `${text}\n[Results limited.]`
                  : text,
            },
          ],
          details: {
            action: input.action,
            resultCount: lines.length,
            truncated,
          },
        };
      } finally {
        project.service.dispose();
      }
    },
  });
}

async function resolveSourceFile(
  root: string,
  requested: string,
): Promise<string> {
  if (isAbsolute(requested) || requested.split(/[\\/]+/).includes("..")) {
    throw new Error("Code navigation paths must stay within the workspace.");
  }
  const file = resolve(root, requested);
  const rel = relative(root, file);
  if (!isWithin(root, file) || isSensitivePath(rel) || !SOURCE.test(file)) {
    throw new Error(
      "Code navigation requires a safe in-workspace source file.",
    );
  }
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(file)) !== file
  ) {
    throw new Error("Code navigation does not follow links or non-file paths.");
  }
  return file;
}

function createLanguageService(root: string, requestedFile: string) {
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  let configured = false;
  try {
    const configPath = join(root, "tsconfig.json");
    if (realpathSync(configPath) !== configPath) throw new Error();
    const configInfo = lstatSync(configPath);
    if (
      !configInfo.isFile() ||
      configInfo.isSymbolicLink() ||
      configInfo.size > 256 * 1024
    )
      throw new Error();
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as { compilerOptions?: unknown };
    if (config.compilerOptions && typeof config.compilerOptions === "object") {
      const allowedOptions = Object.fromEntries(
        Object.entries(
          config.compilerOptions as Record<string, unknown>,
        ).filter(([key]) =>
          [
            "allowJs",
            "checkJs",
            "target",
            "module",
            "moduleResolution",
            "jsx",
            "baseUrl",
            "paths",
            "strict",
            "skipLibCheck",
            "types",
            "typeRoots",
            "resolveJsonModule",
          ].includes(key),
        ),
      );
      const converted = ts.convertCompilerOptionsFromJson(allowedOptions, root);
      if (converted.errors.length === 0) {
        options = {
          ...converted.options,
          noEmit: true,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.Node10,
        };
        configured = true;
      }
    }
  } catch {
    // No safe project config is available; use conservative inferred defaults.
  }
  if (!configured) {
    options = {
      ...options,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    };
  }
  options = {
    ...options,
    types: [],
    typeRoots: [join(root, "node_modules", "@types")],
  };
  const fileNames = listProjectFiles(root);
  if (!fileNames.includes(requestedFile)) fileNames.push(requestedFile);
  const versions = new Map(fileNames.map((file) => [file, "0"]));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (file) => versions.get(file) ?? "0",
    getScriptSnapshot(file) {
      const content = safeRead(file, root, options);
      return content === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => safeRead(file, root, options) !== undefined,
    readFile: (file) => safeRead(file, root, options),
    readDirectory: (_path, extensions) =>
      fileNames.filter(
        (file) =>
          isWithin(root, file) &&
          !isSensitivePath(relative(root, file)) &&
          (!extensions?.length ||
            extensions.some((extension) => file.endsWith(extension))),
      ),
  };
  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
  };
}

function listProjectFiles(root: string): string[] {
  const files: string[] = [];
  let bytes = 0;
  let directories = 0;
  const visit = (directory: string, depth: number): void => {
    if (files.length >= MAX_FILES || directories >= 5000 || depth > 64) return;
    directories++;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const file = resolve(directory, entry.name);
      const relativePath = relative(root, file);
      if (isSensitivePath(relativePath)) continue;
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && SOURCE.test(file)) {
        try {
          const size = statSync(file).size;
          if (size > 1024 * 1024 || bytes + size > MAX_TOTAL_SOURCE_BYTES)
            continue;
          bytes += size;
          files.push(file);
        } catch {
          continue;
        }
      }
    }
  };
  visit(root, 0);
  return files;
}

function safeRead(
  path: string,
  root: string,
  options: ts.CompilerOptions,
): string | undefined {
  const absolute = resolve(path);
  const relativePath = relative(root, absolute);
  const inRoot = isWithin(root, absolute);
  const isDefaultLib = absolute.startsWith(
    dirname(ts.getDefaultLibFilePath(options)) + sep,
  );
  const dependencyMetadata =
    inRoot &&
    relativePath.split(sep).includes("node_modules") &&
    (absolute.endsWith(".d.ts") || absolute.endsWith("package.json"));
  if (
    (!inRoot && !isDefaultLib) ||
    (inRoot && isSensitivePath(relativePath) && !dependencyMetadata)
  ) {
    return undefined;
  }
  try {
    const metadata = statSync(absolute);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return undefined;
    if (realpathSync(absolute) !== absolute) return undefined;
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

function diagnosticLocation(diagnostic: ts.Diagnostic, root: string): string {
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    return `${relative(root, diagnostic.file.fileName).split(sep).join("/")}:${line + 1}:${character + 1}`;
  }
  return "";
}

function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => {
    const lower = segment.toLowerCase();
    return (
      EXCLUDED.has(lower) ||
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
