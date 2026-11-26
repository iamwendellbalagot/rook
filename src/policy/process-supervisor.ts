import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { rookHome } from "./permissions.js";

export interface ProcessResult {
  exitCode: number;
  cancelled: boolean;
  timedOut: boolean;
  outputLimited: boolean;
  artifact: string;
}

/** Host execution. Output limits never terminate an otherwise healthy process. */
export async function runHostCommand(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onData: (data: Buffer) => void;
    artifactDirectory?: string;
    presentationLimit?: number;
    artifactLimit?: number;
  },
): Promise<ProcessResult> {
  const directory = options.artifactDirectory ?? join(rookHome(), "output");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifact = join(directory, `${randomUUID()}.log`);
  const log = await open(artifact, "wx", 0o600);
  try {
    if (options.signal?.aborted)
      return {
        exitCode: 130,
        cancelled: true,
        timedOut: false,
        outputLimited: false,
        artifact,
      };
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let presented = 0;
      let retained = 0;
      let cancelled = false;
      let timedOut = false;
      let outputLimited = false;
      let killing = false;
      let closed = false;
      let escalated = false;
      let settled = false;
      let exitCode = 1;
      let failure: Error | undefined;
      let writes = Promise.resolve();
      let escalation: NodeJS.Timeout | undefined;
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, signal);
        } catch {
          child.kill(signal);
        }
      };
      const finish = () => {
        if (settled || !closed || (killing && !escalated)) return;
        settled = true;
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", abort);
        void writes.then(() => {
          if (failure) reject(failure);
          else
            resolve({ exitCode, cancelled, timedOut, outputLimited, artifact });
        }, reject);
      };
      const terminate = () => {
        if (killing || settled) return;
        killing = true;
        signalGroup("SIGTERM");
        escalation = setTimeout(() => {
          // Always escalate even if the leader closed its pipes before its children.
          signalGroup("SIGKILL");
          escalated = true;
          finish();
        }, 1000);
      };
      const abort = () => {
        cancelled = true;
        terminate();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeout);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const data = (chunk: Buffer) => {
        const visible = chunk.subarray(
          0,
          Math.max(0, (options.presentationLimit ?? 50 * 1024) - presented),
        );
        const saved = chunk.subarray(
          0,
          Math.max(0, (options.artifactLimit ?? 2 * 1024 * 1024) - retained),
        );
        if (visible.length) {
          presented += visible.length;
          options.onData(visible);
        }
        if (saved.length) {
          retained += saved.length;
          writes = writes.then(async () => {
            await log.write(saved);
          });
          // Apply bounded backpressure to disk rather than queuing arbitrary output.
          child.stdout.pause();
          child.stderr.pause();
          void writes.then(
            () => {
              child.stdout.resume();
              child.stderr.resume();
            },
            (error: Error) => {
              failure = error;
              terminate();
            },
          );
        }
        outputLimited ||= visible.length < chunk.length;
      };
      child.stdout.on("data", data);
      child.stderr.on("data", data);
      child.once("error", (error) => {
        failure = error;
        closed = true;
        finish();
      });
      child.once("close", (code) => {
        closed = true;
        exitCode = timedOut ? 124 : cancelled ? 130 : (code ?? 1);
        finish();
      });
    });
  } finally {
    await log.close();
  }
}
