import { spawn, spawnSync } from "node:child_process";
import { constants, statSync } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export type SandboxRuntime = "bwrap" | "seatbelt";

export interface SandboxCommand {
  executable: string;
  args: string[];
  runtime: SandboxRuntime;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
}

export function sandboxRuntimeCandidates(
  platform = process.platform,
): SandboxRuntime[] {
  if (platform === "linux") return ["bwrap"];
  if (platform === "darwin") return ["seatbelt"];
  return [];
}

export async function detectSandboxRuntime(
  env = process.env,
  platform = process.platform,
): Promise<SandboxRuntime | undefined> {
  // Keep the parameter for API compatibility; sandbox binaries must not come from project PATH.
  void env;
  for (const runtime of sandboxRuntimeCandidates(platform)) {
    const executable = await runtimeExecutable(runtime);
    if (
      executable &&
      (runtime === "bwrap"
        ? probeBubblewrap(executable)
        : probeSeatbelt(executable))
    )
      return runtime;
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
  if (isForbiddenWorkspaceRoot(cwd, runtime)) {
    throw new Error(
      "This workspace location cannot be sandbox-mounted safely.",
    );
  }
  if (runtime === "bwrap") {
    const executable = await runtimeExecutable(runtime);
    if (!executable || !probeBubblewrap(executable)) {
      throw new Error(
        "Bubblewrap is unavailable or failed its isolation probe.",
      );
    }
    return {
      executable,
      runtime,
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--tmpfs",
        "/",
        ...systemMountArguments(),
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
        "--tmpfs",
        "/var",
        "--tmpfs",
        "/Users",
        ...workspaceMountParents(cwd),
        "--bind",
        cwd,
        cwd,
        ...(await workspaceGitMountArguments(cwd)),
        "--chdir",
        cwd,
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--",
        "/bin/sh",
        "-lc",
        command,
      ],
    };
  }
  if (runtime === "seatbelt") {
    const executable = await runtimeExecutable(runtime);
    if (!executable || !probeSeatbelt(executable)) {
      throw new Error(
        "macOS Seatbelt is unavailable or failed its isolation probe.",
      );
    }
    const privateTemp = await mkdtemp(join(tmpdir(), "rook-sandbox-"));
    try {
      const canonicalPrivateTemp = await realpath(privateTemp);
      return {
        executable,
        runtime,
        args: [
          "-p",
          seatbeltProfile(),
          `-DWORKSPACE=${cwd}`,
          `-DWORKSPACE_GIT_DIR=${join(cwd, ".git")}`,
          `-DPRIVATE_TMP=${canonicalPrivateTemp}`,
          "--",
          "/bin/sh",
          "-c",
          command,
        ],
        env: {
          PATH: seatbeltPath(env.PATH),
          HOME: canonicalPrivateTemp,
          TMPDIR: canonicalPrivateTemp,
        },
        cleanup: () => rm(privateTemp, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(privateTemp, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`Unsupported sandbox runtime '${runtime}'.`);
}

async function workspaceGitMountArguments(cwd: string): Promise<string[]> {
  const gitPath = join(cwd, ".git");
  try {
    const metadata = await lstat(gitPath);
    if (metadata.isSymbolicLink()) {
      throw new Error("A symlinked .git boundary cannot be sandboxed safely.");
    }
    return ["--ro-bind", gitPath, gitPath];
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function systemMountArguments(): string[] {
  const args: string[] = [];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    try {
      if (!statSync(path).isDirectory()) continue;
      args.push("--ro-bind", path, path);
    } catch {
      // Optional system paths vary by distribution.
    }
  }
  for (const path of ["/etc/ssl"]) {
    try {
      statSync(path);
      args.push("--dir", "/etc", "--ro-bind", path, path);
    } catch {
      // Optional system paths vary by distribution.
    }
  }
  return args;
}

function seatbeltProfile(): string {
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/usr/local") (subpath "/opt/homebrew") (subpath "/Library/Apple") (subpath "/private/var/db/dyld") (literal "/") (literal "/private/var/select/sh") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (subpath (param "WORKSPACE")))
(allow file-read* (subpath (param "PRIVATE_TMP")))
(allow file-write* (subpath (param "WORKSPACE")) (subpath (param "PRIVATE_TMP")))
(deny file-write* (literal (param "WORKSPACE_GIT_DIR")))
(deny file-write* (subpath (param "WORKSPACE_GIT_DIR")))
(deny file-write-unlink (require-all (literal (param "WORKSPACE")) (vnode-type DIRECTORY)))
(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))
(deny system-socket)
`;
}

function probeSeatbelt(executable: string): boolean {
  const result = spawnSync(
    executable,
    [
      "-p",
      '(version 1) (deny default) (allow process-exec) (allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/private/var/db/dyld") (literal "/"))',
      "/usr/bin/true",
    ],
    { encoding: "utf8", timeout: 2_000, windowsHide: true },
  );
  return result.status === 0;
}

function seatbeltPath(pathValue = ""): string {
  const allowedRoots = [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  return pathValue
    .split(delimiter)
    .filter((path) => allowedRoots.includes(resolve(path)))
    .join(delimiter);
}

function probeBubblewrap(executable: string): boolean {
  const result = spawnSync(
    executable,
    [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--tmpfs",
      "/",
      "--ro-bind",
      "/usr",
      "/usr",
      ...(existsDirectory("/bin") ? ["--ro-bind", "/bin", "/bin"] : []),
      ...(existsDirectory("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
      ...(existsDirectory("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
      "--dev",
      "/dev",
      "--",
      "/usr/bin/test",
      "!",
      "-e",
      "/etc/shadow",
    ],
    { encoding: "utf8", timeout: 2_000, windowsHide: true },
  );
  return result.status === 0;
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function runtimeExecutable(
  runtime: SandboxRuntime,
): Promise<string | undefined> {
  if (runtime === "seatbelt") {
    const executable = "/usr/bin/sandbox-exec";
    try {
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      return undefined;
    }
  }
  const executable = await findExecutable(
    "bwrap",
    ["/usr/bin", "/usr/local/bin"].join(delimiter),
  );
  if (!executable) return undefined;
  try {
    const canonicalExecutable = await realpath(executable);
    return canonicalExecutable.startsWith("/usr/")
      ? canonicalExecutable
      : undefined;
  } catch {
    return undefined;
  }
}

function isForbiddenWorkspaceRoot(
  path: string,
  runtime: SandboxRuntime,
): boolean {
  if (runtime === "seatbelt") {
    const forbiddenSubtrees = [
      "/",
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/etc",
      "/private/etc",
      "/dev",
      "/proc",
      "/private/var/db",
    ];
    return (
      forbiddenSubtrees.some(
        (root) => path === root || path.startsWith(`${root}/`),
      ) || ["/private", "/private/var", "/private/tmp"].includes(path)
    );
  }
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
    let killReason: "cancelled" | "timeout" | "output" | undefined;
    const finish = (error?: Error, exitCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
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
    const kill = (reason: "cancelled" | "timeout" | "output") => {
      if (killReason || settled) return;
      killReason = reason;
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
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      }, 1_000);
      clearTimeout(timer);
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
      if (killReason === "cancelled") {
        finish(new Error("aborted"));
      } else {
        finish(
          undefined,
          killReason === "timeout"
            ? 124
            : killReason === "output"
              ? 125
              : (code ?? 1),
        );
      }
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
