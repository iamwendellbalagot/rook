import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { changedRepoFiles, isSafeRepoPath } from "./plan-inspection-tool.js";
import type { ExecutionPolicyConfig } from "./execution-policy.js";

export function createChangeImpactTool(
  cwd: string,
  config: ExecutionPolicyConfig,
) {
  return defineTool({
    name: "rook_impact",
    label: "Analyze change impact",
    description:
      "Analyze the current Git diff, likely direct dependents, related existing tests, and minimal verification commands. Use after implementing changes and before running task-specific tests.",
    promptSnippet: "Select focused tests from the actual implementation diff.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const files = changedRepoFiles(cwd).filter(isSafeRepoPath);
      const sourceFiles = files.filter(
        (path) => path.startsWith("src/") && path.endsWith(".ts"),
      );
      const dependents = await findDirectDependents(cwd, sourceFiles);
      const tests = await findRelatedTests(cwd, [...files, ...dependents]);
      const uncertain = sourceFiles.length > 0 && tests.length === 0;
      const broad =
        config.runFullSuiteByDefault ||
        (config.testingStrategy === "change-impact" &&
          (sourceFiles.length > 5 ||
            sourceFiles.some(isSharedBoundary) ||
            dependents.length > 8)) ||
        (config.escalateOnUncertainty && uncertain);
      const commands =
        tests.length && !broad
          ? [`npx vitest run ${tests.map(quoteShell).join(" ")}`]
          : broad
            ? ["npm test", ...(sourceFiles.length ? ["npm run typecheck"] : [])]
            : sourceFiles.length
              ? ["npm run typecheck"]
              : [];
      const lines = [
        `Changed files (${files.length}): ${files.length ? JSON.stringify(files) : "none detected"}`,
        `Direct source dependents (${dependents.length}): ${dependents.length ? dependents.join(", ") : "none detected"}`,
        `Related tests (${tests.length}): ${tests.length ? tests.join(", ") : "none detected"}`,
        `Impact: ${broad ? "broad/shared; escalate verification" : "focused"}`,
        `Recommended checks: ${commands.length ? commands.join("; ") : "none inferred; inspect package scripts and report verification gap"}`,
        "Execute only the selected checks through the approved bash tool. Reassess if tests fail or the diff changes.",
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { files, dependents, tests, commands, broad },
      };
    },
  });
}

async function findDirectDependents(
  cwd: string,
  changed: string[],
): Promise<string[]> {
  if (!changed.length) return [];
  const changedSet = new Set(changed.map((path) => resolve(cwd, path)));
  const files = await listTypeScript(join(cwd, "src"));
  const dependents: string[] = [];
  for (const file of files) {
    if (changedSet.has(file)) continue;
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(
      /(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g,
    );
    for (const [, specifier] of imports) {
      if (!specifier) continue;
      const target = resolve(dirname(file), specifier);
      const normalizedTarget = target.replace(/\.js$/, ".ts");
      if (
        [
          target,
          normalizedTarget,
          `${target}.ts`,
          join(target, "index.ts"),
        ].some((candidate) => changedSet.has(candidate))
      ) {
        dependents.push(relative(cwd, file).split("\\").join("/"));
        break;
      }
    }
  }
  return dependents.sort();
}

async function findRelatedTests(
  cwd: string,
  affected: string[],
): Promise<string[]> {
  const testRoot = join(cwd, "tests");
  const existing = await listFiles(testRoot).catch(() => []);
  const candidates = new Set<string>();
  const stems = new Set(
    affected.map((path) =>
      basename(path, extname(path)).replace(/\.test$/, ""),
    ),
  );
  for (const testPath of existing.filter((path) =>
    /\.test\.[cm]?[jt]sx?$/.test(path),
  )) {
    const name = basename(testPath);
    if ([...stems].some((stem) => stem && name.startsWith(`${stem}.`)))
      candidates.add(testPath);
    for (const path of affected) {
      if (path.startsWith("src/policy/") && testPath.includes("/policy/"))
        candidates.add(testPath);
      if (path.startsWith("src/tui/") && testPath.includes("/pty/"))
        candidates.add(testPath);
      if (
        ["src/pi/agent-gateway.ts", "src/pi/pi-agent-gateway.ts"].includes(
          path,
        ) &&
        testPath.includes("/integration/")
      )
        candidates.add(testPath);
    }
  }
  return [...candidates]
    .sort()
    .map((path) => relative(cwd, path).split("\\").join("/"));
}

async function listTypeScript(root: string): Promise<string[]> {
  const files = await listFiles(root).catch(() => []);
  return files.filter(
    (path) => path.endsWith(".ts") && !path.endsWith(".d.ts"),
  );
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

function isSharedBoundary(path: string): boolean {
  return /^(?:src\/index\.ts|src\/app\/|src\/policy\/|src\/pi\/agent-gateway\.ts)/.test(
    path,
  );
}

function quoteShell(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
