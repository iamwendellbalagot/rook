import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
  PermissionDecision,
  PermissionMode,
  ExternalAccessChoice,
  ExternalAccessGrant,
  ExternalAccessRequest,
  SessionPermissionGrant,
} from "../pi/agent-gateway.js";
import type { TaskReceipt } from "../pi/task-receipt.js";
import { MAX_SHELL_COMMAND_LENGTH, shellTimeout } from "./shell-limits.js";
import { FileChangeRecovery } from "./file-change-recovery.js";
import {
  Permissions,
  rookHome,
  systemPermissionPath,
  type PermissionResource,
} from "./permissions.js";
import { scanShell } from "./shell-scanner.js";

const READ_TOOLS = new Set(["read", "find", "ls"]);
const INSPECT_TOOLS = new Set([
  "rook_inspect",
  "rook_search",
  "rook_map",
  "rook_code",
  "rook_impact",
]);

export class ToolPolicy {
  private readonly fileRecovery: FileChangeRecovery;
  private mode: PermissionMode = "plan";
  private readonly decisions: PermissionDecision[] = [];
  private readonly active = new Set<string>();
  private readonly grants: SessionPermissionGrant[] = [];
  private generation = 0;
  private permissions?: Promise<Permissions>;
  private externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined;

  constructor(
    private readonly cwd: string,
    permissions?: Permissions,
  ) {
    this.fileRecovery = new FileChangeRecovery(cwd);
    if (permissions) this.permissions = Promise.resolve(permissions);
  }
  async initialize(): Promise<void> {
    await this.rules();
  }
  async bindSession(session: string): Promise<void> {
    await this.fileRecovery.bindSession(session);
  }
  private rules(): Promise<Permissions> {
    return (this.permissions ??= Permissions.load(this.cwd));
  }
  async beginToolExecution(
    id: string,
    name: string,
    input: unknown,
  ): Promise<void> {
    await this.fileRecovery.begin(id, name, input);
  }
  async finishToolExecution(
    id: string,
    name: string,
    error: boolean,
  ): Promise<void> {
    if (name === "edit" || name === "write")
      await this.fileRecovery.finish(id, error);
    this.finish(id);
  }
  finish(id: string, _name?: string, _error = false): void {
    this.active.delete(id);
  }
  getUndoPreview(): string {
    return this.fileRecovery.preview();
  }
  async undoLastFileChange(): Promise<string> {
    if (this.mode !== "build" || this.active.size)
      return "Undo requires idle Build mode.";
    // Recovery performs its own conflict/path validation. It must also respect edit policy.
    return this.fileRecovery
      .undo(
        async (path) => (await this.check("edit", { path }, "undo")).allowed,
      )
      .finally(() => this.finish("undo"));
  }
  setMode(mode: PermissionMode): void {
    if (this.mode !== mode) this.generation++;
    this.mode = mode;
  }
  getMode(): PermissionMode {
    return this.mode;
  }
  // Kept as compatibility methods for old callers; sandbox grants are never migrated.
  setSandboxShell(_enabled: boolean): void {}
  isSandboxShellEnabled(): boolean {
    return false;
  }
  setSandboxRuntimeAvailable(_available: boolean): void {}
  getDecisions(): PermissionDecision[] {
    return this.decisions.map((item) => ({ ...item }));
  }
  setExternalAccessPrompt(handler: typeof this.externalAccessPrompt): void {
    this.generation++;
    this.externalAccessPrompt = handler;
  }
  getExternalAccessGrants(): ExternalAccessGrant[] {
    return [];
  }
  getSessionPermissionGrants(): SessionPermissionGrant[] {
    return this.grants.map((item) => ({ ...item }));
  }
  async getSavedPermissionGrants(): Promise<SessionPermissionGrant[]> {
    return (await this.rules()).listApprovals().map((item) => ({
      id: item.id,
      type: "tool",
      description: `${item.action}: ${item.resource}`,
      identity: item.resource,
      sourceName: item.action,
      workspace: this.cwd,
    }));
  }
  async revokeExternalAccessGrant(id: string): Promise<boolean> {
    this.generation++;
    const index = this.grants.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.grants.splice(index, 1);
      const rules = await this.rules();
      rules.clearSession();
      // Revoking any session grant conservatively revokes all session approvals.
      this.grants.length = 0;
      return true;
    }
    return (await this.rules()).revoke(id);
  }
  setMcpUserAuthorization(_prompt: string): void {
    this.generation++;
  }
  clearMcpUserAuthorization(): void {
    this.generation++;
  }
  clearSessionPermissionGrants(): void {
    this.generation++;
    this.grants.length = 0;
    void this.rules().then((rules) => rules.clearSession());
  }
  async canRead(path: string): Promise<boolean> {
    const rules = await this.rules();
    const target = await canonicalPath(resolve(this.cwd, path));
    return (
      rules.evaluate("read", resourcePath(rules.workspace, target)) === "allow"
    );
  }

  async check(
    name: string,
    input: Record<string, unknown>,
    id: string,
  ): Promise<PermissionDecision> {
    let reason: string;
    try {
      reason = await this.checkOperation(name, input, id);
    } catch (error) {
      this.active.delete(id);
      reason = `Permission check failed; access denied: ${error instanceof Error ? error.message : String(error)}`;
    }
    const decision = {
      toolName: name,
      allowed: reason.startsWith("Allowed "),
      reason,
      timestamp: new Date(),
    };
    if (!decision.allowed) this.active.delete(id);
    this.decisions.push(decision);
    if (this.decisions.length > 100) this.decisions.shift();
    return { ...decision };
  }

  private async checkOperation(
    name: string,
    input: Record<string, unknown>,
    id: string,
  ): Promise<string> {
    if (name === "rook_job" && input.action === "start")
      return this.checkOperation("bash", input, id);
    const rules = await this.rules();
    const mutation = name === "edit" || name === "write";
    const shell = name === "bash";
    const mcp = name.startsWith("mcp__");
    const knownRead =
      READ_TOOLS.has(name) ||
      INSPECT_TOOLS.has(name) ||
      [
        "codemode",
        "tool_search",
        "rook_todo",
        "rook_task",
        "rook_agent",
      ].includes(name);
    if (this.mode !== "build" && (mutation || shell || mcp || !knownRead))
      return "Plan mode blocks mutations, shell, MCP, and tools with unknown effects; switch to Build mode.";
    if ((mutation || shell || INSPECT_TOOLS.has(name)) && this.active.size)
      return "Another file mutation or shell command is active; concurrent execution is denied.";
    if (mutation || shell || INSPECT_TOOLS.has(name)) this.active.add(id);
    if (name === "powershell")
      return "PowerShell is not enabled; use the bash tool.";
    if (
      INSPECT_TOOLS.has(name) &&
      name !== "rook_search" &&
      rules.hasReadRestrictions()
    )
      return "Aggregate inspection is disabled by scoped read restrictions; use individually permission-checked reads or rook_search.";
    if (mcp && !/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+$/.test(name))
      return "Malformed MCP tool name.";
    const resources: PermissionResource[] = [];
    let request: ExternalAccessRequest;
    let remember = true;
    if (shell) {
      const command = input.command;
      if (
        typeof command !== "string" ||
        !command.trim() ||
        command.length > MAX_SHELL_COMMAND_LENGTH ||
        /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(command)
      )
        return "A bounded shell command without control codes is required.";
      const timeoutSeconds = shellTimeout(input.timeout);
      const scan = scanShell(command);
      if (!scan.complete && rules.hasShellDenials())
        return "Shell syntax cannot be reliably checked against configured denials; execution is denied.";
      resources.push(
        ...[...new Set([command, ...scan.commands])].map((resource) => ({
          action: "shell",
          resource,
        })),
      );
      for (const path of scan.paths) {
        const target = await canonicalPath(expandPath(this.cwd, path));
        if (!isWithin(rules.workspace, target))
          resources.push({
            action: "external_directory",
            resource: `${await directoryBoundary(target)}/*`,
          });
      }
      if (!scan.complete) {
        remember = false;
        resources.push({ action: "external_directory", resource: "*" });
      }
      request = {
        toolName: "bash",
        path: rules.workspace,
        folderPath: rules.workspace,
        access: "execute",
        command,
        timeoutSeconds,
        sandboxed: false,
        reason: scan.complete
          ? "Host execution: command inspection is best effort, not isolation."
          : "Dynamic or unsupported shell syntax: explicit one-time approval required; nested effects cannot be inferred.",
      };
    } else if (READ_TOOLS.has(name) || mutation) {
      const path =
        typeof input.path === "string" ? input.path : mutation ? "" : ".";
      if (!path || path.includes("\0")) return "A valid path is required.";
      const target = await canonicalPath(expandPath(this.cwd, path));
      const folderPath = await directoryBoundary(target);
      if (
        mutation &&
        (isWithin(rookHome(), target) ||
          target === systemPermissionPath() ||
          target === resolve(rules.workspace, ".rook/permissions.json"))
      )
        return "Agent file tools cannot modify permission configuration or saved approvals; edit these settings yourself.";
      resources.push({
        action: mutation ? "edit" : "read",
        resource: resourcePath(rules.workspace, target),
      });
      if (name === "find")
        resources.push({
          action: "glob",
          resource: typeof input.pattern === "string" ? input.pattern : "*",
        });
      if (!isWithin(rules.workspace, target))
        resources.push({
          action: "external_directory",
          resource: `${folderPath}/*`,
        });
      request = {
        toolName: name,
        path: target,
        folderPath,
        access: mutation ? "write" : "read",
      };
    } else {
      const action =
        name === "rook_search"
          ? "grep"
          : name === "rook_agent"
            ? "subagent"
            : name;
      resources.push({
        action,
        resource:
          name === "rook_agent" && typeof input.name === "string"
            ? input.name
            : typeof input.query === "string"
              ? input.query
              : "*",
      });
      request = mcp
        ? {
            toolName: name,
            serverName: name.split("__")[1]!,
            access: "mcp",
            inputSummary: summarizeInput(input),
          }
        : {
            toolName: name,
            sourceName: `registered:${name}`,
            access: "tool",
            inputSummary: summarizeInput(input),
            reason: "Tool permission requires approval.",
          };
    }
    const effects = resources.map((item) =>
      rules.evaluate(item.action, item.resource),
    );
    if (effects.includes("deny"))
      return "Blocked by configured permission or policy.";
    const pending = resources.filter(
      (_item, index) => effects[index] === "ask",
    );
    if (!remember && !pending.length) pending.push(...resources);
    const reserved = mutation || shell || INSPECT_TOOLS.has(name);
    if (reserved) this.active.add(id);
    let allowed = false;
    try {
      if (pending.length) {
        const handler = this.externalAccessPrompt;
        if (!handler)
          return "Permission requires user approval; no interactive approval handler is available.";
        const generation = this.generation;
        const choice = await handler({
          ...request,
          permissionResources: pending,
          rememberAllowed: remember,
        });
        if (
          generation !== this.generation ||
          handler !== this.externalAccessPrompt
        )
          return "Approval expired after a mode, session, or authorization change.";
        if (
          !["once", "session", "always"].includes(choice) ||
          (!remember && choice !== "once")
        )
          return "Permission denied; this operation requires one-time approval.";
        if (choice === "always" || choice === "session") {
          await rules.grant(pending, choice === "always");
          if (choice === "session")
            this.grants.push({
              id: randomUUID(),
              type: shell ? "shell" : "tool",
              description: pending
                .map((item) => `${item.action}: ${item.resource}`)
                .join(", "),
              identity: JSON.stringify(pending),
              sourceName: name,
              workspace: rules.workspace,
              sandboxed: false,
            });
        }
      }
      allowed = true;
      return "Allowed by Rook permissions; shell and integrations run with host authority, not OS isolation.";
    } finally {
      if (!allowed && reserved) this.active.delete(id);
    }
  }
}

export function createToolPolicyExtension(
  policy: ToolPolicy,
  activeReceipt?: () => TaskReceipt | undefined,
): InlineExtension {
  return {
    name: "rook-tool-policy",
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", async (event) => {
        const decision = await policy.check(
          event.toolName,
          event.input,
          event.toolCallId,
        );
        if (decision.allowed) return;
        activeReceipt?.()?.blocked(
          event.toolName,
          event.toolCallId,
          event.input,
          decision.reason,
        );
        return { block: true, reason: decision.reason };
      });
      pi.on("tool_execution_start", (event) => {
        activeReceipt?.()?.started(
          event.toolName,
          event.toolCallId,
          event.args,
        );
        return policy.beginToolExecution(
          event.toolCallId,
          event.toolName,
          event.args,
        );
      });
      pi.on("tool_execution_end", async (event) => {
        activeReceipt?.()?.finished(event.toolCallId, event.isError);
        await policy.finishToolExecution(
          event.toolCallId,
          event.toolName,
          event.isError,
        );
      });
    },
  };
}

function expandPath(cwd: string, path: string): string {
  return resolve(
    cwd,
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : path,
  );
}
async function directoryBoundary(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isDirectory()) return path;
  } catch {
    /* missing mutation target: authorize its parent */
  }
  return dirname(path);
}
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    // Existing dangling symlinks must not become apparently safe missing paths.
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Dangling symbolic link");
    } catch (failure) {
      if (
        !(
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          failure.code === "ENOENT"
        )
      )
        throw failure;
    }
    return resolve(await canonicalPath(dirname(path)), path.split(sep).at(-1)!);
  }
}
function resourcePath(root: string, path: string): string {
  return (isWithin(root, path) ? relative(root, path) || "." : path)
    .split(sep)
    .join("/");
}
function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
function summarizeInput(input: Record<string, unknown>): string {
  let budget = 100;
  const visit = (value: unknown, key = "", depth = 0): unknown => {
    if (/secret|token|password|authorization|api.?key|credential/i.test(key))
      return "[redacted]";
    if (typeof value === "string")
      return value
        .replace(
          /\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[\w-]{16,}/gi,
          "[redacted]",
        )
        .slice(0, 200);
    if (!value || typeof value !== "object") return value;
    if (depth >= 5 || budget-- <= 0) return "[truncated]";
    if (Array.isArray(value))
      return value.slice(0, 20).map((item) => visit(item, "", depth + 1));
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([name, item]) => [name, visit(item, name, depth + 1)]),
    );
  };
  try {
    return JSON.stringify(visit(input)).slice(0, 800);
  } catch {
    return "<unavailable>";
  }
}
