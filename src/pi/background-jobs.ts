import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  runHostCommand,
  type ProcessResult,
} from "../policy/process-supervisor.js";

interface Job {
  id: string;
  controller: AbortController;
  output: string;
  result?: ProcessResult;
  error?: string;
  settled: boolean;
  promise: Promise<void>;
}
/** Session-owned jobs: no PID reattachment and no automatic replay after restart. */
export class BackgroundJobs {
  private readonly jobs = new Map<string, Job>();
  constructor(
    private readonly cwd: string,
    private readonly lifecycle?: {
      started(id: string, tool: string): Promise<void>;
      finished(id: string, failed: boolean): Promise<void>;
    },
  ) {}
  start(command: string, timeoutSeconds = 120): string {
    if ([...this.jobs.values()].filter((job) => !job.settled).length >= 4)
      throw new Error("At most four background jobs may run");
    if (this.jobs.size >= 20) {
      const oldest = [...this.jobs.values()].find((job) => job.settled);
      if (oldest) this.jobs.delete(oldest.id);
    }
    const id = randomUUID();
    const job: Job = {
      id,
      controller: new AbortController(),
      output: "",
      settled: false,
      promise: Promise.resolve(),
    };
    this.jobs.set(id, job);
    job.promise = (async () => {
      await this.lifecycle?.started(id, "background_command");
      const result = await runHostCommand(command, {
        cwd: this.cwd,
        timeout: timeoutSeconds * 1000,
        signal: job.controller.signal,
        onData: (data) => {
          job.output = (job.output + data.toString("utf8")).slice(-50 * 1024);
        },
      });
      job.result = result;
      await this.lifecycle?.finished(id, result.exitCode !== 0);
    })()
      .catch((error: unknown) => {
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        job.settled = true;
      });
    return id;
  }
  async inspect(
    id: string,
    action: "status" | "output" | "wait" | "cancel",
    signal?: AbortSignal,
  ): Promise<string> {
    const job = this.jobs.get(id);
    if (!job)
      throw new Error(
        "Unknown job: jobs belong to the current session and are not resumed after restart",
      );
    if (action === "cancel") job.controller.abort();
    if (action === "wait" || action === "cancel") {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 30_000);
        signal?.addEventListener("abort", done, { once: true });
        void job.promise.then(done);
        if (signal?.aborted) done();
      });
    }
    return JSON.stringify({
      id,
      status: job.settled ? "settled" : "running",
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(action === "output" ? { output: job.output } : {}),
    });
  }
  async cancelAll(): Promise<void> {
    for (const job of this.jobs.values())
      if (!job.settled) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.promise));
  }
  clear(): void {
    if ([...this.jobs.values()].some((job) => !job.settled))
      throw new Error("Cancel running jobs before changing sessions");
    this.jobs.clear();
  }
}
export function createBackgroundJobTool(jobs: BackgroundJobs) {
  return defineTool({
    name: "rook_job",
    label: "Manage session background commands",
    description:
      "Start, inspect, await (up to 30s per call), or cancel a session-owned host command. Start uses the SAME shell permissions and approval rules as bash. At most four jobs; timeout 120s by default, maximum 300s. Session changes, task cancellation, and shutdown cancel owned jobs. Unknown jobs after restart must be investigated, never automatically replayed.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("status"),
          Type.Literal("output"),
          Type.Literal("wait"),
          Type.Literal("cancel"),
        ]),
        command: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
        timeout: Type.Optional(
          Type.Number({ exclusiveMinimum: 0, maximum: 300 }),
        ),
        id: Type.Optional(Type.String({ maxLength: 100 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input, signal) => {
      if (input.action === "start") {
        if (!input.command) throw new Error("Start requires a command");
        return {
          content: [
            {
              type: "text" as const,
              text: `Started job ${jobs.start(input.command, input.timeout)}`,
            },
          ],
          details: {},
        };
      }
      if (!input.id) throw new Error("A job ID is required");
      return {
        content: [
          {
            type: "text" as const,
            text: await jobs.inspect(input.id, input.action, signal),
          },
        ],
        details: {},
      };
    },
  });
}
