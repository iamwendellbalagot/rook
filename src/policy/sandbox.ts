import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type SandboxRuntime = "bwrap";

export interface SandboxCommand {
  executable: string;
  args: string[];
  runtime: SandboxRuntime;
}

export function sandboxRuntimeCandidates(
  platform = process.platform,
): SandboxRuntime[] {
  return platform === "linux" ? ["bwrap"] : [];
}

export async function detectSandboxRuntime(
  env = process.env,
  platform = process.platform,
): Promise<SandboxRuntime | undefined> {
  for (const runtime of sandboxRuntimeCandidates(platform)) {
    const executable = await findExecutable(runtime, env.PATH);
    if (executable && probeBubblewrap(executable)) return runtime;
  }
  return undefined;
}

export async function createSandboxCommand(
  command: string,
  cwdArgument: string,
  runtime: SandboxRuntime,
  env = process.env,
): Promise<SandboxCommand> {
  const cwd = await realpath(resolve(cwdArgument));
  if (isForbiddenWorkspaceRoot(cwd)) {
    throw new Error(
      "This workspace location cannot be sandbox-mounted safely.",
    );
  }
  if (runtime === "bwrap") {
    return {
      executable: (await findExecutable("bwrap", env.PATH)) ?? "bwrap",
      runtime,
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/root",
        "--tmpfs",
        "/home",
        "--tmpfs",
        "/media",
        "--tmpfs",
        "/mnt",
        "--tmpfs",
        "/run",
        ...workspaceMountParents(cwd),
        ...pathMountArguments(env.PATH ?? "/usr/bin:/bin"),
        "--bind",
        cwd,
        cwd,
        "--chdir",
        cwd,
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--",
        "/bin/sh",
        "-lc",
        command,
      ],
    };
  }
  throw new Error(`Unsupported sandbox runtime '${runtime}'.`);
}

function probeBubblewrap(executable: string): boolean {
  const result = spawnSync(
    executable,
    [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
      "/bin/true",
    ],
    { encoding: "utf8", timeout: 2_000, windowsHide: true },
  );
  return result.status === 0;
}

function isForbiddenWorkspaceRoot(path: string): boolean {
  const supported = ["/tmp", "/home", "/root"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
  if (!supported) return true;
  return [
    "/",
    "/proc",
    "/sys",
    "/dev",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/run",
  ].includes(path);
}

function workspaceMountParents(cwd: string): string[] {
  const mountRoot = ["/tmp", "/home", "/root"].find(
    (root) => cwd === root || cwd.startsWith(`${root}/`),
  );
  if (!mountRoot || cwd === mountRoot) return [];
  const components = cwd.slice(mountRoot.length).split("/").filter(Boolean);
  let path = mountRoot;
  const args: string[] = [];
  for (const component of components.slice(0, -1)) {
    path = `${path}/${component}`;
    args.push("--dir", path);
  }
  return args;
}

function pathMountArguments(pathValue: string): string[] {
  const paths = new Set<string>();
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    paths.add(resolve(entry));
    for (const name of ["node", "npm", "npx"]) {
      try {
        paths.add(dirname(resolve(entry, name)));
      } catch {
        // Ignore optional executable candidates.
      }
    }
  }
  const args: string[] = [];
  for (const path of paths) {
    if (["/usr/bin", "/bin", "/usr/local/bin"].includes(path)) continue;
    const mountRoot = ["/tmp", "/home", "/root"].find((root) =>
      path.startsWith(`${root}/`),
    );
    if (!mountRoot) continue;
    let parent = mountRoot;
    const components = relative(mountRoot, path).split(sep).filter(Boolean);
    for (const component of components.slice(0, -1)) {
      parent = join(parent, component);
      args.push("--dir", parent);
    }
    args.push("--ro-bind", path, path);
  }
  return args;
}

export function runSandboxCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
  },
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const maxOutputBytes = options.maxOutputBytes ?? 50 * 1024;
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    const finish = (error?: Error, exitCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (forceKillTimerActive && forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimerActive = false;
      }
      if (error) reject(error);
      else
        resolvePromise({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          cancelled,
          timedOut,
          truncated,
        });
    };
    let forceKillTimer: NodeJS.Timeout | undefined;
    let forceKillTimerActive = false;
    const kill = (reason: "cancelled" | "timeout" | "output") => {
      cancelled ||= reason === "cancelled";
      timedOut ||= reason === "timeout";
      truncated ||= reason === "output";
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        forceKillTimerActive = false;
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      }, 1_000);
      forceKillTimerActive = true;
      if (!settled) {
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        if (reason === "timeout" || reason === "output") {
          const outputResult = {
            exitCode: reason === "timeout" ? 124 : 125,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            cancelled,
            timedOut,
            truncated,
          };
          resolvePromise(outputResult);
          return;
        }
        if (forceKillTimerActive && forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimerActive = false;
        }
        reject(new Error("aborted"));
      }
    };
    const abort = () => kill("cancelled");
    const timer = setTimeout(() => kill("timeout"), options.timeout);
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes;
      if (remaining <= 0) {
        kill("output");
        return;
      }
      const kept = chunk.subarray(0, remaining);
      stdout.push(kept);
      stdoutBytes += kept.length;
      if (kept.length < chunk.length) {
        truncated = true;
        kill("output");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes - stderrBytes;
      if (remaining <= 0) {
        kill("output");
        return;
      }
      const kept = chunk.subarray(0, remaining);
      stderr.push(kept);
      stderrBytes += kept.length;
      if (kept.length < chunk.length) {
        truncated = true;
        kill("output");
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (forceKillTimerActive && forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimerActive = false;
      }
      finish(undefined, code ?? 1);
    });
  });
}

async function findExecutable(
  name: string,
  pathValue = "",
): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return resolve(path);
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}
