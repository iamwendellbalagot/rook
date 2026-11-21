import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiAgentGateway } from "../src/pi/pi-agent-gateway.js";
import { PilotRunGuard } from "../src/eval/pilot-run-guard.js";

type Mode = "off" | "prompt" | "integrated";
interface EvalCase {
  id: string;
  category: string;
  prompt: string;
  writablePaths: string[];
  testCommand: string;
  testFile: string;
  rubric: string[];
}
interface CaseFile {
  schemaVersion: number;
  cases: EvalCase[];
  conditionOrder: Record<string, Mode[]>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = join(root, "evals/plyth-integrated-comparison");
const fixtureDir = join(evalDir, "fixtures");
const resultsPath = join(evalDir, "runs.jsonl");
const inspectCommand =
  "pwd; git status --short; ls -a; find . -name AGENTS.md -print";
const MAX_PROVIDER_REQUESTS = 24;
const MAX_TOOL_CALLS = 48;
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_CELL_MS = 10 * 60 * 1_000;

async function main(): Promise<void> {
  const cases = JSON.parse(
    await readFile(join(evalDir, "cases.json"), "utf8"),
  ) as CaseFile;
  if (process.argv.includes("--preflight")) {
    await preflight(cases);
    return;
  }
  await verifyFreeze(cases);
  await runRemaining(cases);
}

async function preflight(cases: CaseFile): Promise<void> {
  const results = await readExistingResults();
  const started = new Set(
    results.filter((item) => item.event === "start").map((item) => item.cellId),
  );
  const finished = new Set(
    results
      .filter((item) => item.event === "finish")
      .map((item) => item.cellId),
  );
  const pending = [...started].filter((id) => !finished.has(id));
  if (pending.length)
    throw new Error(
      `Refusing to replace interrupted cells: ${pending.join(", ")}`,
    );

  for (const item of cases.cases) {
    const workspace = join(fixtureDir, item.id);
    const files = await sourceAndTestFiles(workspace);
    if (!item.writablePaths.length || !files.includes(item.testFile))
      throw new Error(
        `Fixture '${item.id}' is missing required source/test files.`,
      );
    for (const path of item.writablePaths) {
      if (!files.includes(path))
        throw new Error(
          `Writable source '${path}' is missing in '${item.id}'.`,
        );
    }
    if (item.testCommand !== `node --test ${item.testFile}`)
      throw new Error(`Fixture '${item.id}' has an unexpected test command.`);
    const output = runCheck(workspace, item.testCommand);
    if (output.status === "passed")
      throw new Error(`Starter fixture '${item.id}' unexpectedly passes.`);
    if (
      !output.output.includes("ERR_ASSERTION") ||
      output.output.includes("Could not find")
    )
      throw new Error(
        `Starter fixture '${item.id}' did not fail through an assertion.\n${output.output}`,
      );
    process.stdout.write(`Verified failing starter: ${item.id}\n`);
  }
  process.stdout.write(
    `Preflight passed for ${cases.cases.length} cases and ${cases.cases.length * 3} planned cells. No provider was called.\n`,
  );
}

async function runRemaining(cases: CaseFile): Promise<void> {
  for (const item of cases.cases) {
    const order = cases.conditionOrder[item.id];
    if (!order || order.length !== 3 || new Set(order).size !== 3)
      throw new Error(`Invalid frozen arm order for '${item.id}'.`);
    for (const mode of order) {
      const cellId = `${item.id}/${mode}`;
      const records = await readExistingResults();
      if (
        records.some(
          (record) => record.event === "start" && record.cellId === cellId,
        )
      ) {
        if (
          !records.some(
            (record) => record.event === "finish" && record.cellId === cellId,
          )
        )
          throw new Error(
            `Cell '${cellId}' has a retained start without a finish; refusing replacement.`,
          );
        continue;
      }
      await appendRecord({
        event: "start",
        cellId,
        caseId: item.id,
        mode,
        startedAt: new Date().toISOString(),
      });
      let result;
      try {
        result = await runCell(item, mode, cellId);
      } catch (error) {
        result = {
          cellId,
          caseId: item.id,
          mode,
          primarySuccess: false,
          providerRequests: 0,
          toolCalls: 0,
          guardViolations: [],
          timedOut: false,
          runError:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          elapsedMs: 0,
        };
        await appendRecord({ event: "finish", ...result });
        throw new Error(
          `Cell '${cellId}' failed during setup; failure retained.`,
          { cause: error },
        );
      }
      await appendRecord({ event: "finish", ...result });
      process.stdout.write(
        `${cellId}: ${result.primarySuccess ? "PASS" : "FAIL"} · ${result.providerRequests} requests · ${result.toolCalls} tools · ${result.elapsedMs}ms\n`,
      );
      if (
        result.timedOut ||
        result.providerRequests >= MAX_PROVIDER_REQUESTS ||
        result.guardViolations.length
      )
        throw new Error(
          `Stop rule triggered in '${cellId}'; the cell is retained and no replacement will run.`,
        );
    }
  }
}

async function runCell(item: EvalCase, mode: Mode, cellId: string) {
  const workspace = await mkdtemp(
    join(tmpdir(), `rook-plyth-eval-${item.id}-`),
  );
  const sessionDir = await mkdtemp(join(tmpdir(), "rook-plyth-eval-sessions-"));
  const canonicalWorkspace = await realpath(workspace);
  const sessionStorage = join(sessionDir, "sessions");
  const timeline: Record<string, unknown>[] = [];
  const modelContexts: Record<string, unknown>[] = [];
  const finalMessages: string[] = [];
  const approvals: Record<string, unknown>[] = [];
  const guardViolations: unknown[] = [];
  let providerRequests = 0;
  let timedOut = false;
  let gateway: Awaited<ReturnType<typeof createPiAgentGateway>> | undefined;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  try {
    await cp(join(fixtureDir, item.id), workspace, { recursive: true });
    await mkdir(join(workspace, ".rook"), { recursive: true });
    await writeFile(
      join(workspace, ".rook/policy.json"),
      JSON.stringify({ execution: { sandbox_shell: false } }),
    );
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync(
      "git",
      ["config", "user.email", "plyth-eval@example.invalid"],
      { cwd: workspace },
    );
    execFileSync("git", ["config", "user.name", "PLYTH Evaluation"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "frozen fixture"], {
      cwd: workspace,
    });

    const trustedTestPath = join(workspace, item.testFile);
    const testHashBefore = await sha256(await readFile(trustedTestPath));
    const baseline = runCheck(workspace, item.testCommand);
    const guard = new PilotRunGuard(
      workspace,
      ["read", "edit", "bash"],
      item.writablePaths,
      MAX_TOOL_CALLS,
      MAX_PROVIDER_REQUESTS,
      (violation) => {
        guardViolations.push(violation);
        timeline.push({ kind: "guard_violation", violation });
        void gateway?.cancel();
      },
      [inspectCommand, item.testCommand],
    );

    const instrumentation = {
      name: "plyth-integrated-eval-instrumentation",
      factory(pi: ExtensionAPI) {
        pi.on("before_agent_start", (event) => {
          if (event.messageType !== "user") return;
          return {
            systemPrompt: `${event.systemPrompt}\n\nFrozen evaluation constraints: use only the named fixture files and tools. Do not modify test files or other paths. The exact focused test command is in the user task. Shell inspection is limited to the approved in-workspace listing command.`,
          };
        });
        pi.on("context_with_system", (event) => {
          const custom = event.messages.filter(
            (message) => message.role === "custom",
          );
          const plyth = custom.filter(
            (message) => message.customType === "plyth-integrated-context",
          );
          const contents = plyth
            .flatMap((message) =>
              typeof message.content === "string"
                ? [message.content]
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text),
            )
            .join("\n");
          const record = {
            kind: "model_context",
            index: modelContexts.length + 1,
            hasPlythCheckpoint: contents.includes(
              "task-local change checkpoint",
            ),
            hasStaleVerification: contents.includes("verification freshness"),
          };
          modelContexts.push(record);
          timeline.push(record);
        });
      },
    };

    process.env.ROOK_PLYTH_INTEGRATED = mode;
    process.env.ROOK_PLYTH_MODE = "off";
    delete process.env.ROOK_PLYTH_TRACE;
    gateway = await createPiAgentGateway(workspace, {
      sessionDir: sessionStorage,
      pilotRunGuard: guard,
      maxOutputTokensPerResponse: MAX_OUTPUT_TOKENS,
      repositoryInstructionsExtension: instrumentation,
      onProviderRequest: (count) => {
        providerRequests = count;
        timeline.push({ kind: "provider_request", count });
      },
    });
    const model = gateway.currentModel();
    const configuredProviders = gateway
      .listProviders()
      .filter((provider) => provider.configured)
      .map((provider) => provider.id);
    if (!model || !configuredProviders.includes(model.provider))
      throw new Error(
        `Configured model/auth unavailable: ${JSON.stringify(model)}.`,
      );
    gateway.setThinkingLevel("high");
    gateway.setMode("build");
    gateway.setExternalAccessPrompt(async (request) => {
      const allowed =
        request.toolName === "bash" &&
        request.access === "execute" &&
        (request.path === canonicalWorkspace ||
          request.folderPath === canonicalWorkspace) &&
        [inspectCommand, item.testCommand].includes(request.command ?? "");
      approvals.push({
        toolName: request.toolName,
        command: request.toolName === "bash" ? request.command : undefined,
        allowed,
      });
      return allowed ? "once" : "deny";
    });
    gateway.subscribe((event) => {
      if (event.type === "tool_started")
        timeline.push({ kind: "tool_started", name: event.name });
      if (event.type === "tool_finished")
        timeline.push({ kind: "tool_finished", status: event.status });
      if (event.type === "message_complete") finalMessages.push(event.text);
      if (event.type === "error")
        timeline.push({
          kind: "agent_error",
          message: event.message.slice(0, 400),
        });
    });

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolveTimeout) => {
      timeout = setTimeout(() => {
        timedOut = true;
        void gateway?.cancel().finally(resolveTimeout);
      }, MAX_CELL_MS);
    });
    let runError: string | undefined;
    try {
      await Promise.race([
        gateway.send(
          `${item.prompt}\nDo not modify tests. Run exactly \`${item.testCommand}\` for verification.`,
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const finalCheck = runCheck(workspace, item.testCommand);
    const testHashAfter = await sha256(await readFile(trustedTestPath));
    const changedFiles = execFileSync("git", ["status", "--short"], {
      cwd: workspace,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const patch = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--", ...item.writablePaths],
      { cwd: workspace, encoding: "utf8" },
    );
    const usage = gateway.getUsageStats?.();
    const passed =
      baseline.status === "failed" &&
      finalCheck.status === "passed" &&
      testHashBefore === testHashAfter &&
      changedFiles.every((line) => {
        const path = line.slice(3);
        return item.writablePaths.includes(path);
      });
    return {
      cellId,
      caseId: item.id,
      category: item.category,
      mode,
      startedAt,
      model,
      thinking: "high",
      baselineStatus: baseline.status,
      finalStatus: finalCheck.status,
      testHashBefore,
      testHashAfter,
      testsUnchanged: testHashBefore === testHashAfter,
      changedFiles,
      patch,
      rubric: item.rubric,
      timeline,
      modelContexts,
      approvals,
      guardViolations,
      providerRequests,
      toolCalls: guard.toolCallCount(),
      usage,
      elapsedMs: Date.now() - startedMs,
      timedOut,
      runError,
      finalMessages: finalMessages.slice(-2),
      primarySuccess: passed,
      workspace,
    };
  } finally {
    await gateway?.dispose();
    await rm(sessionDir, { recursive: true, force: true });
  }
}

function runCheck(workspace: string, command: string) {
  try {
    const output = execFileSync(
      process.execPath,
      ["--test", command.split(" ").at(-1)!],
      {
        cwd: workspace,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        },
      },
    );
    return { status: "passed", output };
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String(error.stdout ?? "")
        : "";
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    return { status: "failed", output: `${stdout}${stderr}` };
  }
}

async function sourceAndTestFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      output.push(
        ...(await sourceAndTestFiles(path)).map(
          (child) => `${entry.name}/${child}`,
        ),
      );
    else if (entry.isFile()) output.push(entry.name);
    else throw new Error(`Unexpected fixture entry: ${path}`);
  }
  return output;
}

async function readExistingResults(): Promise<any[]> {
  try {
    const text = await readFile(resultsPath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function appendRecord(record: unknown): Promise<void> {
  await appendFile(resultsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function sha256(data: Buffer): Promise<string> {
  return createHash("sha256").update(data).digest("hex");
}

async function verifyFreeze(cases: CaseFile): Promise<void> {
  const freeze = JSON.parse(
    await readFile(join(evalDir, "freeze.json"), "utf8"),
  ) as {
    hashes: Record<string, string>;
    rookSourceCommit: string;
    plythSourceCommit: string;
  };
  const plythRoot = join(root, "../plyth");
  const rookHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const plythHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: plythRoot,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", freeze.rookSourceCommit, rookHead],
    { cwd: root },
  );
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", freeze.plythSourceCommit, plythHead],
    { cwd: plythRoot },
  );
  for (const [relativePath, expected] of Object.entries(freeze.hashes)) {
    const path = join(root, relativePath);
    const actual = await sha256(await readFile(path));
    if (actual !== expected)
      throw new Error(`Frozen input changed: ${relativePath}`);
  }
  if (cases.schemaVersion !== 1) throw new Error("Unknown case schema.");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
