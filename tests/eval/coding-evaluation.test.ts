import { describe, expect, it } from "vitest";
import {
  CODING_EVAL_TASKS,
  createCodingEvalTemplate,
  formatCodingEvalReport,
  scoreCodingEvalRun,
  validateCodingEvalRun,
} from "../../src/eval/coding-evaluation.js";

describe("coding evaluation scoring", () => {
  it("provides a complete, scoreable template for every fixed task", () => {
    const template = createCodingEvalTemplate("provider", "model");
    const validated = validateCodingEvalRun(template);
    expect(validated.tasks).toHaveLength(CODING_EVAL_TASKS.length);
    expect(scoreCodingEvalRun(validated).totalToolCalls).toBe(0);
  });

  it("scores success only when rubric, checks, and changed-file scope pass", () => {
    const scored = scoreCodingEvalRun(validateCodingEvalRun(successfulRun()));
    expect(scored.passedTasks).toBe(CODING_EVAL_TASKS.length);
    expect(scored.successRate).toBe(1);
    expect(scored.score).toBe(100);
    expect(scored.totalToolCalls).toBe(4);
  });

  it("penalizes failed checks and unexpected changed files", () => {
    const run = successfulRun();
    run.tasks[1]!.checks["retry-tests"] = "failed";
    run.tasks[1]!.changedFiles.push("src/unrelated.mjs");
    const scored = scoreCodingEvalRun(validateCodingEvalRun(run));
    expect(scored.tasks[1]).toMatchObject({
      passed: false,
      score: 25,
      scopeViolations: ["src/unrelated.mjs"],
      failedChecks: ["retry-tests"],
    });
  });

  it("rejects incomplete tasks, invalid rubric values, and missing check results", () => {
    const missingTask = successfulRun();
    missingTask.tasks.pop();
    expect(() => validateCodingEvalRun(missingTask)).toThrow("missing tasks");

    const missingCheck = successfulRun();
    delete missingCheck.tasks[1]!.checks["retry-tests"];
    expect(() => validateCodingEvalRun(missingCheck)).toThrow("missing check");

    const invalidRubric = successfulRun();
    invalidRubric.tasks[0]!.rubric.path = 3;
    expect(() => validateCodingEvalRun(invalidRubric)).toThrow(
      "integers from 0 to 2",
    );
  });

  it("reports metrics as unavailable when they are not recorded", () => {
    const run = successfulRun();
    run.tasks[0]!.response = "<answer & notes>";
    const report = formatCodingEvalReport(
      scoreCodingEvalRun(validateCodingEvalRun(run)),
    );
    expect(report).toContain("Average elapsed time: not recorded");
    expect(report).toContain("Input/output tokens: not recorded");
    expect(report).toContain("not statistical evidence");
    expect(report).toContain("&lt;answer &amp; notes&gt;");
  });
});

function successfulRun() {
  const run = createCodingEvalTemplate("fixture", "node");
  for (const task of run.tasks) {
    task.rubric = Object.fromEntries(
      Object.keys(task.rubric).map((criterion) => [criterion, 2]),
    );
    task.checks = Object.fromEntries(
      Object.keys(task.checks).map((check) => [check, "passed"]),
    ) as typeof task.checks;
    task.toolCalls = 1;
  }
  run.tasks.find((task) => task.taskId === "retry-boundary")!.changedFiles = [
    "src/retry.mjs",
  ];
  run.tasks.find(
    (task) => task.taskId === "feature-normalize-labels",
  )!.changedFiles = ["src/labels.mjs"];
  return run;
}
