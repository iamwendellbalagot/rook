import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../evals/simplicity-finish/cases.mjs";
import {
  createPiAgentGateway,
  runGenericSimplicityReview,
} from "../src/pi/pi-agent-gateway.js";

const expectedModel = { provider: "openai", id: "gpt-6.1-sol" };
const resultDirectory = join(process.cwd(), "evals/simplicity-finish/runs");
const resultPath = join(resultDirectory, "RESULTS.jsonl");
const workspaceRoot = await mkdtemp(join(tmpdir(), "plyth-finish-eval-"));
const preflight = process.argv.includes("--preflight");

console.log(`Disposable fixtures preserved at ${workspaceRoot}`);

const preparedCases = [];
for (const item of cases) {
  const workspaces: Record<string, string> = {};
  const tests: { condition: string; passed: boolean; output: string }[] = [];
  for (const condition of ["plyth", "generic"]) {
    const cwd = join(workspaceRoot, item.id, condition);
    workspaces[condition] = cwd;
    await prepareFixture(cwd, item.source, item.test);
    try {
      const testOutput = execFileSync(
        "node",
        ["--test", "tests/main.test.js"],
        { cwd, encoding: "utf8", timeout: 30_000 },
      );
      tests.push({ condition, passed: true, output: testOutput });
    } catch (error) {
      tests.push({
        condition,
        passed: false,
        output: String(error),
      });
      throw new Error(`Trusted test failed for ${item.id}/${condition}`);
    }
  }
  if (item.candidate) {
    const cwd = join(workspaceRoot, item.id, "candidate");
    await prepareFixture(cwd, item.candidate, item.test);
    try {
      const testOutput = execFileSync(
        "node",
        ["--test", "tests/main.test.js"],
        { cwd, encoding: "utf8", timeout: 30_000 },
      );
      tests.push({ condition: "candidate", passed: true, output: testOutput });
    } catch (error) {
      tests.push({
        condition: "candidate",
        passed: false,
        output: String(error),
      });
      throw new Error(`Candidate simplification failed for ${item.id}`);
    }
  }
  preparedCases.push({ item, workspaces, tests });
}

console.log("All fixture and candidate checks passed before inference.");
if (preflight) {
  console.log("Preflight only; no provider inference requested.");
  process.exit(0);
}
await mkdir(resultDirectory, { recursive: true });
try {
  await writeFile(resultPath, "", { flag: "wx" });
} catch {
  throw new Error(`Refusing to overwrite existing results: ${resultPath}`);
}
console.log(`Incremental results: ${resultPath}`);
for (const [index, prepared] of preparedCases.entries()) {
  const { item, workspaces, tests } = prepared;
  const order = index % 2 === 0 ? ["plyth", "generic"] : ["generic", "plyth"];
  for (const condition of order) {
    const cwd = workspaces[condition]!;
    const gateway = await createPiAgentGateway(cwd, {
      sessionDir: join(cwd, ".sessions"),
    });
    try {
      const model = gateway.currentModel();
      if (
        model?.provider !== expectedModel.provider ||
        model.id !== expectedModel.id
      )
        throw new Error(
          "Frozen model is not selected; no substitution allowed.",
        );
      const startedAt = Date.now();
      let result: Record<string, unknown>;
      if (condition === "plyth") {
        let metrics:
          | Parameters<
              NonNullable<
                Parameters<typeof gateway.reviewGitChanges>[0]
              >["onMetrics"]
            >[0]
          | undefined;
        const report = await gateway.reviewGitChanges({
          focus: "simplicity",
          taskContext: item.task,
          paths: ["src/main.js", "tests/main.test.js"],
          isolatedEvaluation: true,
          onMetrics: (value) => {
            metrics = value;
          },
        });
        result = {
          report,
          providerRequests: metrics?.providerRequests,
          usage: metrics?.usage,
          diagnostics: metrics?.diagnostics,
        };
      } else {
        const review = await runGenericSimplicityReview(
          cwd,
          model,
          item.task,
          undefined,
          "high",
        );
        result = review;
      }
      const record = {
        caseId: item.id,
        class: item.class,
        condition,
        orderIndex: index,
        model,
        task: item.task,
        paths: ["src/main.js", "tests/main.test.js"],
        fixtureTests: tests,
        elapsedMs: Date.now() - startedAt,
        ...result,
      };
      await appendFile(resultPath, `${JSON.stringify(record)}\n`);
      console.log(
        JSON.stringify({
          caseId: item.id,
          condition,
          providerRequests: record.providerRequests,
          elapsedMs: record.elapsedMs,
          report:
            "report" in result
              ? String(result.report).slice(0, 1400)
              : undefined,
        }),
      );
    } finally {
      await gateway.dispose();
    }
  }
}

console.log("All preregistered reviews attempted once; no retries performed.");

async function prepareFixture(
  cwd: string,
  source: string,
  test: string,
): Promise<void> {
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "tests"), { recursive: true });
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify(
      { type: "module", scripts: { test: "node --test" } },
      null,
      2,
    ),
  );
  await writeFile(join(cwd, "README.md"), "# Isolated review fixture\n");
  await writeFile(join(cwd, "src/main.js"), "export {};\n");
  await writeFile(
    join(cwd, "tests/main.test.js"),
    'import test from "node:test"; test("fixture baseline", () => {});\n',
  );
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "PLYTH Fixture"]);
  execFileSync("git", [
    "-C",
    cwd,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture baseline"]);
  await writeFile(join(cwd, "src/main.js"), source);
  await writeFile(join(cwd, "tests/main.test.js"), test);
}
