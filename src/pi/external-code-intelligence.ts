import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatAgentError } from "./errors.js";
import {
  queryLanguageServer,
  type SemanticAction,
} from "./language-protocol.js";

const SERVER_ROOT = "/workspace";
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const MAX_FILE_BYTES = 128 * 1024;
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_SCAN = 3000;
const DEADLINE_MS = 20_000;
const SKIP = new Set([
  "node_modules",
  "vendor",
  "venv",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
  "credentials",
  "secrets",
]);
const BACKENDS = {
  python: {
    name: "Pyright",
    env: "ROOK_PYRIGHT_LANGUAGE_SERVER",
    args: ["--stdio"],
    source: /\.pyi?$/,
  },
  go: { name: "gopls", env: "ROOK_GOPLS", args: ["serve"], source: /\.go$/ },
};

export type ExternalLanguage = keyof typeof BACKENDS;

export async function inspectExternalCode(
  language: ExternalLanguage,
  root: string,
  file: string,
  input: {
    action: SemanticAction;
    line?: number;
    column?: number;
    limit?: number;
  },
  allowed: boolean,
  signal?: AbortSignal,
) {
  const backend = BACKENDS[language];
  const unavailable = (reason: string) =>
    result(
      input.action,
      0,
      false,
      `${backend.name} semantic support unavailable: ${reason} Use rook_map or rook_search for fallback exploration.`,
      "unavailable",
    );
  if (!allowed)
    return unavailable(
      "external language tools require Build mode with sandboxing enabled.",
    );
  if (process.platform !== "linux")
    return unavailable(
      "a Linux Bubblewrap sandbox is required; no host fallback is allowed.",
    );
  if (
    SYSTEM_DIRS.some(
      (directory) => within(directory, root) || within(root, directory),
    )
  ) {
    return unavailable("workspace overlaps system mounts.");
  }
  const configured = process.env[backend.env];
  if (!configured || !isAbsolute(configured)) {
    return unavailable(
      `set ${backend.env} to an absolute path to a trusted installation under /usr.`,
    );
  }
  const command = await trustedExecutable(configured);
  if (!command)
    return unavailable(
      `${backend.env} does not resolve to an executable under /usr.`,
    );
  const sandbox =
    (await trustedExecutable("/usr/bin/bwrap")) ??
    (await trustedExecutable("/usr/local/bin/bwrap"));
  if (!sandbox)
    return unavailable(
      "Bubblewrap is not installed in /usr/bin or /usr/local/bin.",
    );

  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let projection: string | undefined;
  try {
    requestSignal.throwIfAborted();
    const goModule =
      language === "go" ? await findGoModule(root, file) : undefined;
    if (language === "go" && !goModule)
      return unavailable(
        "a safe, enclosing go.mod within the workspace is required.",
      );
    const directory = goModule?.directory ?? root;
    const path = portableRelative(directory, file);
    const targetText = await readSource(directory, file, requestSignal);
    if (targetText === undefined || !safeRelative(path))
      return unavailable(
        "the source file is linked, unsafe, binary, or too large.",
      );
    let position: { line: number; character: number } | undefined;
    if (input.action !== "diagnostics") {
      const line = (input.line ?? 0) - 1;
      const character = (input.column ?? 0) - 1;
      const lines = targetText.split(/\r?\n/);
      if (
        !Number.isInteger(line) ||
        !Number.isInteger(character) ||
        line < 0 ||
        character < 0 ||
        line >= lines.length ||
        character > lines[line]!.length
      ) {
        return unavailable(
          "definition and reference queries require a valid one-based line and column.",
        );
      }
      position = { line, character };
    }
    projection = await mkdtemp(join(tmpdir(), "rook-semantic-"));
    const { files, capped } = await projectSources(
      directory,
      projection,
      backend.source,
      { path, text: targetText },
      requestSignal,
    );
    if (goModule)
      await writeFile(
        join(projection, "go.mod"),
        `module ${goModule.name}\n\ngo ${goModule.version}\n`,
      );
    const uri = pathToFileURL(`${SERVER_ROOT}/${path}`).href;
    const query = {
      action: input.action,
      uri,
      rootUri: pathToFileURL(SERVER_ROOT).href,
      languageId: language,
      text: targetText,
      signal: requestSignal,
      ...(position ? { position } : {}),
    };
    requestSignal.throwIfAborted();
    const response = await runLanguageServer(
      sandbox,
      command,
      backend.args,
      projection,
      query,
    );
    const formatted = formatResponse(
      input.action,
      response,
      path,
      directory,
      root,
      files,
      input.limit ?? 40,
    );
    const limits = `Partial ${backend.name} analysis: only bounded workspace sources were supplied; project settings and external dependencies are omitted.${capped ? " Source scan limit reached." : ""}`;
    return result(
      input.action,
      formatted.lines.length,
      formatted.truncated || capped,
      [
        limits,
        ...formatted.lines,
        ...(!formatted.lines.length
          ? ["No in-scope results reported (not a clean bill of health)."]
          : []),
        ...(formatted.truncated ? ["[Results limited.]"] : []),
      ].join("\n"),
      "partial",
    );
  } catch (error) {
    if (signal?.aborted) throw new Error("Language server request cancelled.");
    return unavailable(
      deadline.aborted
        ? "the analysis timed out."
        : error instanceof LanguageServerError
          ? error.message
          : "the sandbox or source projection could not be prepared.",
    );
  } finally {
    if (projection)
      await rm(projection, { recursive: true, force: true }).catch(() => {});
  }
}

class LanguageServerError extends Error {}

async function runLanguageServer(
  sandbox: string,
  command: string,
  args: readonly string[],
  projection: string,
  query: Parameters<typeof queryLanguageServer>[1],
) {
  const child = spawn(
    sandbox,
    [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/home",
      ...SYSTEM_DIRS.flatMap((path) => ["--ro-bind-try", path, path]),
      "--ro-bind",
      projection,
      SERVER_ROOT,
      "--chdir",
      SERVER_ROOT,
      "--setenv",
      "HOME",
      "/tmp/home",
      "--setenv",
      "PATH",
      "/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
      "--setenv",
      "GOENV",
      "off",
      "--setenv",
      "GOTOOLCHAIN",
      "local",
      "--setenv",
      "GOWORK",
      "off",
      "--setenv",
      "GOPROXY",
      "off",
      "--setenv",
      "GOSUMDB",
      "off",
      "--setenv",
      "CGO_ENABLED",
      "0",
      "--setenv",
      "XDG_CACHE_HOME",
      "/tmp",
      "--setenv",
      "GOTELEMETRY",
      "off",
      "--",
      command,
      ...args,
    ],
    { cwd: "/", env: {}, stdio: ["pipe", "pipe", "ignore"] },
  );
  // Killing Bubblewrap tears down its private PID namespace. Wait for close before removing the source projection.
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  const failure = new AbortController();
  child.on("error", () => failure.abort());
  child.stdin.on("error", () => failure.abort());
  child.stdout.on("error", () => failure.abort());
  try {
    return await queryLanguageServer(
      { input: child.stdout, output: child.stdin },
      {
        ...query,
        signal: AbortSignal.any([query.signal, failure.signal]),
      },
    );
  } catch {
    throw new LanguageServerError(
      "the sandboxed server could not answer this request; check the installation and Bubblewrap user namespace support.",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  }
}

async function trustedExecutable(path: string): Promise<string | undefined> {
  try {
    const target = await realpath(path);
    if (!target.startsWith("/usr/") || !(await lstat(target)).isFile()) return;
    await access(target, constants.X_OK);
    return target;
  } catch {
    return;
  }
}

async function findGoModule(root: string, file: string) {
  for (
    let directory = dirname(file);
    within(root, directory);
    directory = dirname(directory)
  ) {
    const path = join(directory, "go.mod");
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      if (directory === root) return;
      continue;
    }
    const original = await readSource(root, path);
    const module = original?.match(
      /^module[ \t]+(?:"([\w./~+-]+)"|([\w./~+-]+))[ \t]*(?:\/\/[^\r\n]*)?\r?$/m,
    );
    const name = module?.[1] ?? module?.[2];
    if (name && name.length <= 200 && safeRelative(name)) {
      const version =
        original?.match(
          /^go[ \t]+(\d{1,2}\.\d{1,3}(?:\.\d{1,3})?)[ \t]*(?:\/\/[^\r\n]*)?\r?$/m,
        )?.[1] ?? "1.20";
      return { directory, name, version };
    }
    return;
  }
}

async function projectSources(
  root: string,
  projection: string,
  extension: RegExp,
  target: { path: string; text: string },
  signal: AbortSignal,
) {
  const files = new Set([target.path]);
  let bytes = Buffer.byteLength(target.text);
  let scanned = 0;
  let capped = false;
  const put = async (path: string, text: string) => {
    const destination = join(projection, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text, { mode: 0o600 });
  };
  await put(target.path, target.text);
  const directories = [root];
  while (directories.length && !capped) {
    signal.throwIfAborted();
    const directory = directories.pop()!;
    if ((await realpath(directory).catch(() => "")) !== directory) continue;
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) continue;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (
        ++scanned > MAX_SCAN ||
        files.size >= MAX_FILES ||
        bytes >= MAX_PROJECT_BYTES
      ) {
        capped = true;
        break;
      }
      const source = join(directory, entry.name);
      const path = portableRelative(root, source);
      if (!safeRelative(path)) continue;
      if (entry.isDirectory()) directories.push(source);
      else if (entry.isFile() && extension.test(path) && !files.has(path)) {
        const text = await readSource(root, source, signal);
        if (text === undefined) continue;
        const size = Buffer.byteLength(text);
        if (bytes + size > MAX_PROJECT_BYTES) {
          capped = true;
          break;
        }
        await put(path, text);
        files.add(path);
        bytes += size;
      }
    }
  }
  return { files, capped };
}

async function readSource(
  root: string,
  source: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    if (!within(root, source) || (await realpath(source)) !== source) return;
    const before = await lstat(source);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
      return;
    const handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        return;
      const buffer = Buffer.alloc(opened.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (
        bytesRead !== opened.size ||
        opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs ||
        (await realpath(source)) !== source
      )
        return;
      const content = buffer.subarray(0, bytesRead);
      if (!content.includes(0))
        return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

function formatResponse(
  action: SemanticAction,
  response: unknown,
  target: string,
  project: string,
  root: string,
  files: ReadonlySet<string>,
  limit: number,
) {
  const entries = Array.isArray(response)
    ? response
    : response
      ? [response]
      : [];
  const lines: string[] = [];
  let truncated = false;
  let size = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const path =
      action === "diagnostics"
        ? target
        : locationPath(entry.targetUri ?? entry.uri, files);
    const start = (entry.targetSelectionRange ?? entry.range)?.start;
    if (
      !path ||
      !Number.isInteger(start?.line) ||
      !Number.isInteger(start?.character) ||
      start.line < 0 ||
      start.character < 0 ||
      start.line > 1_000_000 ||
      start.character > 1_000_000
    )
      continue;
    const location = `${portableRelative(root, resolve(project, path))}:${start.line + 1}:${start.character + 1}`;
    const line =
      action === "diagnostics"
        ? typeof entry.message === "string"
          ? `${location}: ${formatAgentError(entry.message).replace(/[\u202a-\u202e\u2066-\u2069]/g, " ")}`
          : undefined
        : `${action === "references" ? "reference" : "definition"}: ${location}`;
    if (!line || lines.includes(line)) continue;
    if (lines.length >= limit || size + line.length > 11_000) {
      truncated = true;
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return { lines, truncated };
}

function locationPath(
  uri: unknown,
  files: ReadonlySet<string>,
): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return;
  try {
    const path = portableRelative(SERVER_ROOT, fileURLToPath(uri));
    if (files.has(path)) return path;
  } catch {
    return;
  }
}

function result(
  action: SemanticAction,
  resultCount: number,
  truncated: boolean,
  text: string,
  coverage: "partial" | "unavailable",
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { action, resultCount, truncated, coverage },
  };
}

function portableRelative(root: string, path: string) {
  return relative(root, path).split(sep).join("/");
}
function within(root: string, path: string) {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}
function safeRelative(path: string) {
  return Boolean(
    path &&
      path.length <= 512 &&
      !isAbsolute(path) &&
      !/[\\\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(path) &&
      path
        .split("/")
        .every(
          (part) =>
            part && !part.startsWith(".") && !SKIP.has(part.toLowerCase()),
        ),
  );
}
