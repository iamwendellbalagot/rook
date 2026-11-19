import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "coding-eval.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("coding evaluation CLI", () => {
  it("prepares disposable fixtures and runs the fixed check on task code", async () => {
    const directory = await tempDirectory();
    const output = join(directory, "prepared");
    run("prepare", output);

    const manifest = await readFile(join(output, "TASKS.md"), "utf8");
    expect(manifest).toContain("retry-boundary");
    expect(manifest).toContain("feature-normalize-labels");

    await writeFile(
      join(output, "retry-boundary", "src", "retry.mjs"),
      "export function shouldRetry(completedAttempts, maxAttempts) { return completedAttempts < maxAttempts; }\n",
    );
    expect(
      run("check", "retry-boundary", join(output, "retry-boundary")),
    ).toContain('"retry-tests": "passed"');
  });

  it("refuses to execute altered evaluation tests", async () => {
    const directory = await tempDirectory();
    const output = join(directory, "prepared");
    run("prepare", output);
    const testPath = join(output, "retry-boundary", "tests", "retry.test.mjs");
    await writeFile(testPath, "process.exit(0);\n");

    const result = runResult(
      "check",
      "retry-boundary",
      join(output, "retry-boundary"),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/modified|changed or removed/);
  });

  it("writes a scorer report from a complete results template", async () => {
    const directory = await tempDirectory();
    const input = join(directory, "results.json");
    const report = join(directory, "report.md");
    run("template", input, "fixture", "node");
    const output = run("score", input, report);

    expect(output).toContain("Rook coding evaluation:");
    expect(output).toContain("Task success: 0/4");
    expect(await readFile(report, "utf8")).toContain("Checks");
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rook-eval-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    },
  });
}

function runResult(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    },
  });
}
