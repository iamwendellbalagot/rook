import { randomUUID } from "node:crypto";

export interface CodingEvalCheck {
  id: string;
}

export interface CodingEvalCriterion {
  id: string;
  description: string;
}

export interface CodingEvalTask {
  id: string;
  category: "exploration" | "bugfix" | "feature" | "review";
  prompt: string;
  fixture: string;
  allowedChangedFiles: string[];
  checks: CodingEvalCheck[];
  rubric: CodingEvalCriterion[];
}

export const CODING_EVAL_TASKS: CodingEvalTask[] = [
  {
    id: "trace-agent-lifecycle",
    category: "exploration",
    fixture: "agent-lifecycle",
    prompt:
      "Trace how a user prompt reaches the agent and how tool permission mode is selected. Give a concise explanation with file and line references. Do not edit files or run commands.",
    allowedChangedFiles: [],
    checks: [],
    rubric: [
      {
        id: "path",
        description: "Correctly traces prompt dispatch and session send.",
      },
      {
        id: "policy",
        description: "Correctly explains where tool mode is selected.",
      },
      {
        id: "citations",
        description: "Provides precise, relevant file and line references.",
      },
    ],
  },
  {
    id: "retry-boundary",
    category: "bugfix",
    fixture: "retry-boundary",
    prompt:
      "Fix the retry-limit bug: the configured maximum is the total number of attempts, so the helper must not allow an additional retry at the limit. Preserve the existing API and make the focused test pass.",
    allowedChangedFiles: ["src/retry.mjs"],
    checks: [{ id: "retry-tests" }],
    rubric: [
      { id: "boundary", description: "Corrects the off-by-one boundary." },
      {
        id: "regression",
        description: "Preserves valid retries below the limit.",
      },
      {
        id: "scope",
        description: "Keeps the change focused and API-compatible.",
      },
    ],
  },
  {
    id: "feature-normalize-labels",
    category: "feature",
    fixture: "normalize-labels",
    prompt:
      "Implement normalizeLabels(labels). Return labels with duplicates removed case-insensitively, preserving the first spelling and original order. Ignore non-string and blank entries, trim surrounding whitespace, and do not mutate the input. Make the focused tests pass.",
    allowedChangedFiles: ["src/labels.mjs"],
    checks: [{ id: "label-tests" }],
    rubric: [
      {
        id: "behavior",
        description:
          "Implements the requested normalization and deduplication.",
      },
      {
        id: "edge-cases",
        description: "Handles blanks, non-strings, casing, and whitespace.",
      },
      {
        id: "quality",
        description:
          "Preserves order and input immutability with a simple implementation.",
      },
    ],
  },
  {
    id: "review-retry-delay",
    category: "review",
    fixture: "review-retry-delay",
    prompt:
      "Review the retry implementation for concrete correctness issues. In particular, consider invalid delay inputs. Return only actionable findings, ordered by severity, with file and line references. Do not edit files.",
    allowedChangedFiles: [],
    checks: [],
    rubric: [
      {
        id: "finding",
        description:
          "Identifies that a negative requested delay can produce a negative retry delay.",
      },
      {
        id: "evidence",
        description:
          "Supports the finding with an accurate code location and behavior.",
      },
      {
        id: "signal",
        description: "Avoids speculative or non-actionable findings.",
      },
    ],
  },
];

export type CheckResult = "passed" | "failed" | "not_run";

export interface CodingEvalTaskResult {
  taskId: string;
  response: string;
  changedFiles: string[];
  checks: Record<string, CheckResult>;
  rubric: Record<string, number>;
  toolCalls: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CodingEvalRun {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  provider: string;
  model: string;
  tasks: CodingEvalTaskResult[];
}

export function createCodingEvalTemplate(
  provider = "unknown",
  model = "unknown",
): CodingEvalRun {
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    provider,
    model,
    tasks: CODING_EVAL_TASKS.map((task) => ({
      taskId: task.id,
      response: "",
      changedFiles: [],
      checks: Object.fromEntries(
        task.checks.map((check) => [check.id, "not_run"]),
      ),
      rubric: Object.fromEntries(
        task.rubric.map((criterion) => [criterion.id, 0]),
      ),
      toolCalls: 0,
    })),
  };
}

export interface ScoredTask {
  task: CodingEvalTask;
  result: CodingEvalTaskResult;
  score: number;
  passed: boolean;
  rubricScore: number;
  scopeViolations: string[];
  failedChecks: string[];
}

export interface ScoredRun {
  run: CodingEvalRun;
  tasks: ScoredTask[];
  score: number;
  successRate: number;
  passedTasks: number;
  totalTasks: number;
  totalToolCalls: number;
  averageElapsedMs: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
}

export function validateCodingEvalRun(value: unknown): CodingEvalRun {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Evaluation input must have schemaVersion: 1.");
  }
  if (
    !nonEmptyString(value.runId) ||
    !nonEmptyString(value.startedAt) ||
    !nonEmptyString(value.provider) ||
    !nonEmptyString(value.model) ||
    !Array.isArray(value.tasks)
  ) {
    throw new Error("Evaluation run metadata or tasks are missing.");
  }

  const seenTasks = new Set<string>();
  const tasks = value.tasks.map((item, index) => {
    if (!isRecord(item))
      throw new Error(`Task result ${index + 1} is invalid.`);
    const task = CODING_EVAL_TASKS.find(
      (candidate) => candidate.id === item.taskId,
    );
    if (!task) throw new Error(`Unknown task ID '${String(item.taskId)}'.`);
    if (seenTasks.has(task.id))
      throw new Error(`Duplicate task result '${task.id}'.`);
    seenTasks.add(task.id);
    if (
      !Array.isArray(item.changedFiles) ||
      !item.changedFiles.every(nonEmptyString)
    ) {
      throw new Error(
        `Task '${task.id}' must include changedFiles as strings.`,
      );
    }
    if (typeof item.response !== "string") {
      throw new Error(
        `Task '${task.id}' must include the model response as a string.`,
      );
    }
    if (!isRecord(item.checks) || !isRecord(item.rubric)) {
      throw new Error(
        `Task '${task.id}' must include checks and rubric objects.`,
      );
    }
    const checkIds = new Set(task.checks.map((check) => check.id));
    for (const [id, result] of Object.entries(item.checks)) {
      if (!checkIds.has(id))
        throw new Error(`Task '${task.id}' has unknown check '${id}'.`);
      if (result !== "passed" && result !== "failed" && result !== "not_run") {
        throw new Error(
          `Task '${task.id}' check '${id}' has an invalid result.`,
        );
      }
    }
    for (const check of task.checks) {
      if (!Object.hasOwn(item.checks, check.id)) {
        throw new Error(`Task '${task.id}' is missing check '${check.id}'.`);
      }
    }
    const rubricIds = new Set(task.rubric.map((criterion) => criterion.id));
    for (const [id, score] of Object.entries(item.rubric)) {
      if (!rubricIds.has(id))
        throw new Error(
          `Task '${task.id}' has unknown rubric criterion '${id}'.`,
        );
      if (
        !Number.isInteger(score) ||
        (score as number) < 0 ||
        (score as number) > 2
      ) {
        throw new Error(
          `Task '${task.id}' rubric scores must be integers from 0 to 2.`,
        );
      }
    }
    for (const criterion of task.rubric) {
      if (!Object.hasOwn(item.rubric, criterion.id)) {
        throw new Error(
          `Task '${task.id}' is missing rubric criterion '${criterion.id}'.`,
        );
      }
    }
    assertNonNegativeInteger(item.toolCalls, `Task '${task.id}' toolCalls`);
    for (const metric of [
      "elapsedMs",
      "inputTokens",
      "outputTokens",
    ] as const) {
      if (item[metric] !== undefined) {
        if (metric === "elapsedMs") {
          assertNonNegativeNumber(item[metric], `Task '${task.id}' ${metric}`);
        } else {
          assertNonNegativeInteger(item[metric], `Task '${task.id}' ${metric}`);
        }
      }
    }
    return item as unknown as CodingEvalTaskResult;
  });
  const missingTasks = CODING_EVAL_TASKS.filter(
    (task) => !seenTasks.has(task.id),
  );
  if (missingTasks.length) {
    throw new Error(
      `Evaluation run is missing tasks: ${missingTasks.map((task) => task.id).join(", ")}.`,
    );
  }
  return { ...value, tasks } as unknown as CodingEvalRun;
}

export function scoreCodingEvalRun(run: CodingEvalRun): ScoredRun {
  const tasks = run.tasks.map((result) => {
    const task = CODING_EVAL_TASKS.find(
      (candidate) => candidate.id === result.taskId,
    )!;
    const maximum = task.rubric.length * 2;
    const rawRubricScore = Object.values(result.rubric).reduce(
      (sum, score) => sum + score,
      0,
    );
    const rubricScore = maximum === 0 ? 0 : rawRubricScore / maximum;
    const scopeViolations = result.changedFiles.filter(
      (path) => !task.allowedChangedFiles.includes(path),
    );
    const failedChecks = task.checks
      .filter((check) => result.checks[check.id] !== "passed")
      .map((check) => check.id);
    const passed =
      rubricScore >= 0.7 &&
      scopeViolations.length === 0 &&
      failedChecks.length === 0;
    const score = Math.round(
      rubricScore *
        100 *
        (scopeViolations.length === 0 ? 1 : 0.5) *
        (failedChecks.length === 0 ? 1 : 0.5),
    );
    return {
      task,
      result,
      score,
      passed,
      rubricScore,
      scopeViolations,
      failedChecks,
    };
  });
  const passedTasks = tasks.filter((task) => task.passed).length;
  const metrics = (key: "elapsedMs" | "inputTokens" | "outputTokens") =>
    tasks.map(({ result }) => result[key]);
  const elapsed = metrics("elapsedMs");
  const inputTokens = metrics("inputTokens");
  const outputTokens = metrics("outputTokens");
  return {
    run,
    tasks,
    score: tasks.length
      ? Math.round(
          tasks.reduce((sum, task) => sum + task.score, 0) / tasks.length,
        )
      : 0,
    successRate: tasks.length ? passedTasks / tasks.length : 0,
    passedTasks,
    totalTasks: tasks.length,
    totalToolCalls: tasks.reduce((sum, task) => sum + task.result.toolCalls, 0),
    averageElapsedMs:
      elapsed.length && elapsed.every(isNumber)
        ? elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length
        : null,
    totalInputTokens:
      inputTokens.length && inputTokens.every(isNumber)
        ? inputTokens.reduce((sum, value) => sum + value, 0)
        : null,
    totalOutputTokens:
      outputTokens.length && outputTokens.every(isNumber)
        ? outputTokens.reduce((sum, value) => sum + value, 0)
        : null,
  };
}

export function formatCodingEvalReport(scored: ScoredRun): string {
  const { run } = scored;
  const lines = [
    `# Rook coding evaluation: ${run.runId}`,
    "",
    `- Started: ${run.startedAt}`,
    `- Provider/model: ${run.provider}/${run.model}`,
    `- Overall score: ${scored.score}%`,
    `- Task success: ${scored.passedTasks}/${scored.totalTasks} (${percent(scored.successRate)})`,
    `- Tool calls: ${scored.totalToolCalls}`,
    `- Average elapsed time: ${scored.averageElapsedMs === null ? "not recorded" : `${Math.round(scored.averageElapsedMs)} ms`}`,
    `- Input/output tokens: ${scored.totalInputTokens === null || scored.totalOutputTokens === null ? "not recorded" : `${scored.totalInputTokens}/${scored.totalOutputTokens}`}`,
    "",
    "| Task | Category | Score | Checks | Scope | Rubric | Result |",
    "|---|---|---:|---|---|---:|---|",
    ...scored.tasks.map((item) => {
      const checks = item.task.checks.length
        ? item.failedChecks.length
          ? `failed: ${item.failedChecks.join(", ")}`
          : "all passed"
        : "n/a";
      const scope = item.scopeViolations.length
        ? `violations: ${item.scopeViolations.join(", ")}`
        : "within scope";
      return `| ${item.task.id} | ${item.task.category} | ${item.score}% | ${checks} | ${scope} | ${percent(item.rubricScore)} | ${item.passed ? "PASS" : "FAIL"} |`;
    }),
    "",
    ...scored.tasks.flatMap((item) => [
      `<details><summary>${item.task.id} response</summary>`,
      "",
      `<pre>${escapeHtml(item.result.response)}</pre>`,
      "",
      "</details>",
      "",
    ]),
    "Rubric scores are human-assessed (0 = incorrect/missing, 1 = partial, 2 = correct). Checks are reported from the submitted run record and are not executed by this scorer. Scores are descriptive for this run, not statistical evidence or a cross-model comparison.",
    "",
  ];
  return lines.join("\n");
}

function assertNonNegativeNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (!isNumber(value) || value < 0)
    throw new Error(`${label} must be a non-negative number.`);
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
