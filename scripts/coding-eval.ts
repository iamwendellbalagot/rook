import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import {
  CODING_EVAL_TASKS,
  createCodingEvalTemplate,
  formatCodingEvalReport,
  scoreCodingEvalRun,
  validateCodingEvalRun,
} from "../src/eval/coding-evaluation.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "evals", "coding", "fixtures");

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "prepare") {
    await prepare(rest[0] ?? join(tmpdir(), `rook-coding-${Date.now()}`));
    return;
  }
  if (command === "check") {
    const [taskId, workspace] = rest;
    if (!taskId || !workspace) usage();
    await check(taskId, workspace);
    return;
  }
  if (command === "verify-fixtures") {
    await verifyFixtures();
    return;
  }
  if (command === "score") {
    const [inputPath, reportPath] = rest;
    if (!inputPath) usage();
    await score(inputPath, reportPath);
    return;
  }
  if (command === "template") {
    const [outputPath, provider, model] = rest;
    if (!outputPath) usage();
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `${JSON.stringify(createCodingEvalTemplate(provider, model), null, 2)}\n`,
    );
    process.stdout.write(`Wrote scoring template to ${target}\n`);
    return;
  }
  usage();
}

async function prepare(outputArgument: string): Promise<void> {
  const output = resolve(outputArgument);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const task of CODING_EVAL_TASKS) {
    await cp(join(fixtureRoot, task.fixture), join(output, task.id), {
      recursive: true,
      errorOnExist: true,
    });
  }
  const manifest = CODING_EVAL_TASKS.map((task) =>
    [
      `## ${task.id} (${task.category})`,
      "",
      task.prompt,
      "",
      `Workspace: \`${task.id}/\``,
      `Allowed changed files: ${task.allowedChangedFiles.length ? task.allowedChangedFiles.map((path) => `\`${path}\``).join(", ") : "none"}.`,
      task.checks.length
        ? `Fixed checks: ${task.checks.map((check) => `\`npm run eval:coding -- check ${task.id} <workspace>\` (${check.id})`).join(", ")}.`
        : "Fixed checks: none.",
      "Rubric:",
      ...task.rubric.map(
        (criterion) => `- ${criterion.id}: ${criterion.description}`,
      ),
      "",
      "Score each rubric criterion from 0 (incorrect/missing) to 2 (correct). Record the model response, changed files, check results, rubric scores, and any available run metrics in the results JSON.",
      "",
    ].join("\n"),
  ).join("\n");
  await writeFile(
    join(output, "TASKS.md"),
    `# Rook coding evaluation tasks\n\n${manifest}`,
  );
  process.stdout.write(
    `Prepared ${CODING_EVAL_TASKS.length} task workspaces under ${output}\n`,
  );
}

async function check(
  taskId: string,
  workspaceArgument: string,
  quiet = false,
): Promise<Record<string, "passed" | "failed">> {
  const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task '${taskId}'.`);
  const workspace = await realpath(resolve(workspaceArgument));
  const results: Record<string, "passed" | "failed"> = {};
  for (const checkSpec of task.checks) {
    const fixtureTest = join(fixtureRoot, task.fixture, "tests");
    const workspaceTest = join(workspace, "tests");
    const testInfo = await lstat(workspaceTest);
    if (!testInfo.isDirectory() || testInfo.isSymbolicLink()) {
      throw new Error("Evaluation tests must be a regular directory.");
    }
    await assertTrustedTests(fixtureTest, workspaceTest);
    const testFiles = await listFiles(workspaceTest);
    const testArgs = testFiles.map((path) => relative(workspace, path));
    try {
      execFileSync(process.execPath, ["--test", ...testArgs], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        },
        stdio: quiet ? "ignore" : "inherit",
        timeout: 30_000,
        windowsHide: true,
      });
      results[checkSpec.id] = "passed";
    } catch (error) {
      results[checkSpec.id] = "failed";
      if (!quiet) {
        process.stderr.write(
          `Check ${checkSpec.id} failed: ${formatExecutionError(error)}\n`,
        );
      }
    }
  }
  if (!quiet) {
    process.stdout.write(
      `${JSON.stringify({ taskId, checks: results }, null, 2)}\n`,
    );
  }
  if (Object.values(results).some((result) => result !== "passed")) {
    if (!quiet) throw new Error(`Task '${taskId}' has failing fixed checks.`);
  }
  return results;
}

async function verifyFixtures(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rook-coding-fixtures-"));
  try {
    for (const task of CODING_EVAL_TASKS.filter(
      (candidate) => candidate.checks.length > 0,
    )) {
      const workspace = join(directory, task.id);
      await cp(join(fixtureRoot, task.fixture), workspace, { recursive: true });
      const results = await check(task.id, workspace, true);
      if (Object.values(results).every((result) => result === "passed")) {
        throw new Error(
          `Fixture '${task.id}' unexpectedly passed before a solution.`,
        );
      }
      process.stdout.write(
        `Verified ${task.id}: starter fixture fails its task checks.\n`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertTrustedTests(
  trustedDirectory: string,
  submittedDirectory: string,
): Promise<void> {
  const expectedFiles = await listFiles(trustedDirectory);
  const actualFiles = await listFiles(submittedDirectory);
  const expected = new Set(
    expectedFiles.map((path) => relative(trustedDirectory, path)),
  );
  const actual = new Set(
    actualFiles.map((path) => relative(submittedDirectory, path)),
  );
  if (
    expected.size !== actual.size ||
    [...expected].some((path) => !actual.has(path))
  ) {
    throw new Error(
      "Evaluation tests were changed or removed; restore fixture tests before running checks.",
    );
  }
  for (const path of expected) {
    const [trusted, submitted] = await Promise.all([
      readFile(join(trustedDirectory, path)),
      readFile(join(submittedDirectory, path)),
    ]);
    if (!trusted.equals(submitted)) {
      throw new Error(
        `Evaluation test '${path}' was modified; restore fixture tests before running checks.`,
      );
    }
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(
        "Symlinks are not allowed in evaluation test directories.",
      );
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs"))
      files.push(path);
    else throw new Error(`Unexpected evaluation test entry '${entry.name}'.`);
  }
  return files.sort();
}

async function score(
  inputArgument: string,
  reportArgument?: string,
): Promise<void> {
  const inputPath = resolve(inputArgument);
  const input: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  const run = validateCodingEvalRun(input);
  const scored = scoreCodingEvalRun(run);
  const markdown = `${formatCodingEvalReport(scored)}\n`;
  const formatted = await format(markdown, {
    filepath: "docs/CODING_EVALUATION.md",
  });
  if (reportArgument) {
    const reportPath = resolve(reportArgument);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, formatted);
  }
  process.stdout.write(formatted);
}

function formatExecutionError(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    return `exit ${String(error.status)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run eval:coding -- prepare [output-directory]",
      "  npm run eval:coding -- check <task-id> <workspace>",
      "  npm run eval:coding -- verify-fixtures",
      "  npm run eval:coding -- template <results.json> [provider] [model]",
      "  npm run eval:coding -- score <results.json> [report.md]",
    ].join("\n"),
  );
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `coding-eval: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
