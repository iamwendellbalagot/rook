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
import { TASK_CHECKLIST_TOOL_NAME } from "../pi/task-checklist.js";
import { MAX_SHELL_COMMAND_LENGTH, shellTimeout } from "./shell-limits.js";
import { FileChangeRecovery } from "./file-change-recovery.js";

const READ_TOOLS = new Set(["read", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PLAN_INSPECTION_TOOL = "rook_inspect";
const WORKSPACE_SEARCH_TOOL = "rook_search";
const WORKSPACE_MAP_TOOL = "rook_map";
const CODE_INTELLIGENCE_TOOL = "rook_code";
const CHANGE_IMPACT_TOOL = "rook_impact";
const SENSITIVE_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".config",
  ".pi",
  "node_modules",
]);

export class ToolPolicy {
  private readonly fileRecovery: FileChangeRecovery;
  private mode: PermissionMode = "plan";
  private changeVersion = 0;
  private workspaceRoot?: Promise<string>;
  private readonly decisions: PermissionDecision[] = [];
  private readonly activeMutations = new Set<string>();
  private readonly shellCommands = new Map<string, string>();
  private readonly successfulChecks = new Map<string, number>();
  private readonly externalGrants: ExternalAccessGrant[] = [];
  private readonly sessionPermissionGrants: SessionPermissionGrant[] = [];
  private permissionGrantGeneration = 0;
  private mcpAuthorizationGeneration = 0;
  private explicitMcpAuthorization: Set<string> | "all" | undefined;
  private mcpUserDenied = false;
  private sandboxShell = true;
  private sandboxRuntimeAvailable = true;
  private externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined = undefined;

  constructor(private readonly cwd: string) {
    this.fileRecovery = new FileChangeRecovery(cwd);
  }

  async beginToolExecution(
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> {
    await this.fileRecovery.begin(toolCallId, toolName, input);
  }

  async finishToolExecution(
    toolCallId: string,
    toolName: string,
    isError: boolean,
  ): Promise<void> {
    if (toolName === "edit" || toolName === "write") {
      await this.fileRecovery.finish(toolCallId, isError);
    }
    this.finish(toolCallId, toolName, isError);
  }

  getUndoPreview(): string {
    return this.fileRecovery.preview();
  }

  undoLastFileChange(): Promise<string> {
    return this.fileRecovery.undo();
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setSandboxShell(enabled: boolean): void {
    this.sandboxShell = enabled;
  }

  isSandboxShellEnabled(): boolean {
    return this.sandboxShell;
  }

  setSandboxRuntimeAvailable(available: boolean): void {
    this.sandboxRuntimeAvailable = available;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  getDecisions(): PermissionDecision[] {
    return this.decisions.map((decision) => ({ ...decision }));
  }

  setExternalAccessPrompt(
    handler:
      | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
      | undefined,
  ): void {
    this.externalAccessPrompt = handler;
  }

  getExternalAccessGrants(): ExternalAccessGrant[] {
    return this.externalGrants.map((grant) => ({ ...grant }));
  }

  revokeExternalAccessGrant(id: string): boolean {
    const index = this.externalGrants.findIndex((grant) => grant.id === id);
    if (index >= 0) {
      this.externalGrants.splice(index, 1);
      this.permissionGrantGeneration++;
      return true;
    }
    const sessionIndex = this.sessionPermissionGrants.findIndex(
      (grant) => grant.id === id,
    );
    if (sessionIndex < 0) return false;
    this.sessionPermissionGrants.splice(sessionIndex, 1);
    this.permissionGrantGeneration++;
    return true;
  }

  getSessionPermissionGrants(): SessionPermissionGrant[] {
    return this.sessionPermissionGrants.map((grant) => ({ ...grant }));
  }

  setMcpUserAuthorization(prompt: string): void {
    this.explicitMcpAuthorization = explicitMcpTools(prompt);
    this.mcpUserDenied = explicitlyDeniesMcp(prompt);
    this.mcpAuthorizationGeneration++;
  }

  clearMcpUserAuthorization(): void {
    this.explicitMcpAuthorization = undefined;
    this.mcpUserDenied = false;
    this.mcpAuthorizationGeneration++;
  }

  clearSessionPermissionGrants(): void {
    this.sessionPermissionGrants.splice(0);
    this.externalGrants.splice(0);
    this.permissionGrantGeneration++;
  }

  async check(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<PermissionDecision> {
    let reason: string;
    let allowed = false;

    if (READ_TOOLS.has(toolName)) {
      const path = typeof input.path === "string" ? input.path : ".";
      reason = await this.checkPath(path, false, toolName);
      allowed = reason.startsWith("Allowed ");
    } else if (MUTATING_TOOLS.has(toolName)) {
      if (this.mode !== "build") {
        reason =
          "Plan mode blocks file mutations; switch to build mode to edit workspace files.";
      } else if (this.activeMutations.size > 0) {
        reason =
          "Another file mutation or shell command is active; concurrent mutations are denied.";
      } else {
        const path = typeof input.path === "string" ? input.path : "";
        this.activeMutations.add(toolCallId);
        reason = path
          ? await this.checkPath(path, true, toolName)
          : "A valid workspace path is required.";
        allowed = reason.startsWith("Allowed ");
        if (!allowed) this.activeMutations.delete(toolCallId);
        else this.invalidateChecks();
      }
    } else if (toolName === "bash") {
      const command = input.command;
      if (this.mode !== "build") {
        reason = await this.checkShell(input, toolCallId);
      } else if (
        isVerificationCommand(command) &&
        this.successfulChecks.get(command) === this.changeVersion
      ) {
        reason =
          "This exact verification command already succeeded since the last Rook-observed change; do not repeat it.";
      } else {
        reason = await this.checkShell(input, toolCallId);
      }
      allowed = reason.startsWith("Allowed ");
    } else if (
      toolName === PLAN_INSPECTION_TOOL ||
      toolName === WORKSPACE_SEARCH_TOOL ||
      toolName === WORKSPACE_MAP_TOOL ||
      toolName === CODE_INTELLIGENCE_TOOL
    ) {
      if (this.activeMutations.size) {
        reason =
          "Repository inspection is unavailable while another Rook operation is active.";
      } else if (
        toolName === PLAN_INSPECTION_TOOL &&
        !["summary", "status", "diff", "log", "branches", "show"].includes(
          String(input.action),
        )
      ) {
        reason = "Unsupported repository inspection operation.";
      } else if (
        toolName === CODE_INTELLIGENCE_TOOL &&
        (!(["definition", "references", "diagnostics"] as unknown[]).includes(
          input.action,
        ) ||
          typeof input.path !== "string" ||
          !input.path.trim() ||
          input.path.length > 1024 ||
          isAbsolute(input.path) ||
          input.path.split(/[\\/]+/).includes("..") ||
          ((input.action === "definition" || input.action === "references") &&
            ![input.line, input.column].every(
              (value) =>
                typeof value === "number" &&
                Number.isInteger(value) &&
                value > 0 &&
                value <= 1_000_000,
            )))
      ) {
        reason = "Code navigation parameters are outside the supported bounds.";
      } else if (
        toolName === WORKSPACE_SEARCH_TOOL &&
        (typeof input.query !== "string" ||
          !input.query.trim() ||
          input.query.length > 200)
      ) {
        reason =
          "A nonempty literal search query of at most 200 characters is required.";
      } else if (
        toolName === WORKSPACE_MAP_TOOL &&
        ((input.query !== undefined &&
          (typeof input.query !== "string" || input.query.length > 200)) ||
          (input.path !== undefined &&
            (typeof input.path !== "string" ||
              input.path.length > 1024 ||
              isAbsolute(input.path) ||
              input.path.split(/[\\/]+/).includes(".."))) ||
          (input.limit !== undefined &&
            (typeof input.limit !== "number" ||
              !Number.isInteger(input.limit) ||
              input.limit < 1 ||
              input.limit > 40)))
      ) {
        reason = "Workspace map parameters are outside the supported bounds.";
      } else {
        this.activeMutations.add(toolCallId);
        reason =
          toolName === WORKSPACE_MAP_TOOL
            ? "Allowed bounded read-only workspace mapping."
            : "Allowed read-only repository inspection.";
      }
      allowed = reason.startsWith("Allowed ");
    } else if (toolName === CHANGE_IMPACT_TOOL) {
      if (this.mode !== "build") {
        reason = "Change impact analysis is available in build mode only.";
      } else if (this.activeMutations.size) {
        reason =
          "Change impact analysis must wait until the active mutation or command finishes.";
      } else {
        this.activeMutations.add(toolCallId);
        reason = "Allowed change impact analysis.";
      }
      allowed = reason.startsWith("Allowed ");
    } else if (toolName === "powershell") {
      reason =
        "PowerShell is not enabled; use the approved bash tool in /build mode.";
    } else if (toolName === "codemode") {
      reason =
        "Allowed Pi code-mode wrapper; nested tool calls remain policy checked.";
      allowed = true;
    } else if (toolName === "tool_search") {
      reason =
        "Allowed MCP tool discovery; invoking a discovered server tool still requires authorization.";
      allowed = true;
    } else if (toolName.startsWith("mcp__")) {
      const match = /^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_.-]+)$/.exec(toolName);
      if (!match) {
        reason = "Malformed MCP tool name; MCP call is denied.";
      } else if (this.mcpUserDenied) {
        reason = "MCP use denied by the user's prompt.";
      } else if (
        this.explicitMcpAuthorization === "all" ||
        this.explicitMcpAuthorization?.has(toolName) ||
        this.hasMcpToolGrant(toolName, match[1]!)
      ) {
        reason = "Allowed MCP call by explicit user request or session grant.";
        allowed = true;
      } else {
        const prompt = this.externalAccessPrompt;
        if (!prompt) {
          reason =
            "MCP use requires user approval; no interactive approval handler is available.";
        } else {
          try {
            const authorization = this.explicitMcpAuthorization;
            const authorizationGeneration = this.mcpAuthorizationGeneration;
            const mode = this.mode;
            const grantGeneration = this.permissionGrantGeneration;
            const choice = await prompt({
              toolName,
              serverName: match[1]!,
              access: "mcp",
              inputSummary: summarizeMcpInput(input),
              reason:
                "Rook initiated this MCP call without an explicit user request.",
            });
            if (
              this.mode !== mode ||
              this.permissionGrantGeneration !== grantGeneration ||
              this.externalAccessPrompt !== prompt ||
              this.explicitMcpAuthorization !== authorization ||
              this.mcpAuthorizationGeneration !== authorizationGeneration
            ) {
              reason =
                "MCP approval expired after a session or authorization change.";
            } else if (
              authorization === undefined &&
              (this.mcpUserDenied ||
                this.explicitMcpAuthorization !== undefined)
            ) {
              reason = "MCP approval expired after a new user authorization.";
            } else if (choice === "once") {
              reason = "Allowed this MCP call once with user approval.";
              allowed = true;
            } else if (choice === "session") {
              this.addToolGrant(toolName, match[1]!);
              reason = `Allowed MCP tool ${toolName} from ${match[1]} for this session.`;
              allowed = true;
            } else {
              reason = "MCP call denied by the user.";
            }
          } catch (error) {
            reason =
              error instanceof Error
                ? `MCP call denied: ${error.message}`
                : "MCP approval failed; call denied.";
          }
        }
      }
    } else {
      const sourceName = toolSourceName(toolName);
      if (this.hasToolGrant(toolName, sourceName)) {
        reason = `Allowed unclassified tool ${toolName} from ${sourceName} by this session's grant.`;
        allowed = true;
      } else if (!this.externalAccessPrompt) {
        reason =
          "This tool is not classified by Rook; no interactive approval handler is available.";
      } else {
        const prompt = this.externalAccessPrompt;
        const mode = this.mode;
        const grantGeneration = this.permissionGrantGeneration;
        const authorizationGeneration = this.mcpAuthorizationGeneration;
        try {
          const choice = await prompt({
            toolName,
            sourceName,
            access: "tool",
            inputSummary: summarizeMcpInput(input),
            reason:
              "Rook has no registered policy classification for this tool.",
          });
          if (
            this.mode !== mode ||
            this.permissionGrantGeneration !== grantGeneration ||
            this.mcpAuthorizationGeneration !== authorizationGeneration ||
            this.externalAccessPrompt !== prompt
          ) {
            reason =
              "Tool approval expired after a mode, session, or approval-handler change.";
          } else if (choice === "once") {
            reason = `Allowed unclassified tool ${toolName} from ${sourceName} once with user approval.`;
            allowed = true;
          } else if (choice === "session") {
            this.addToolGrant(toolName, sourceName);
            reason = `Allowed unclassified tool ${toolName} from ${sourceName} for this session.`;
            allowed = true;
          } else {
            reason = `Unclassified tool ${toolName} denied by the user.`;
          }
        } catch (error) {
          reason =
            error instanceof Error
              ? `Unclassified tool approval failed: ${error.message}`
              : "Unclassified tool approval failed; call denied.";
        }
      }
    }

    const decision = { toolName, allowed, reason, timestamp: new Date() };
    this.decisions.push(decision);
    if (this.decisions.length > 20) this.decisions.shift();
    return { ...decision };
  }

  finish(toolCallId: string, toolName?: string, isError = false): void {
    this.activeMutations.delete(toolCallId);
    const command = this.shellCommands.get(toolCallId);
    this.shellCommands.delete(toolCallId);
    if (toolName === "bash" && command && isVerificationCommand(command)) {
      if (!isError) this.successfulChecks.set(command, this.changeVersion);
    } else if (toolName === "bash" && command) {
      this.invalidateChecks();
    }
  }

  private async checkShell(
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<string> {
    if (this.mode !== "build")
      return "Plan mode blocks shell execution; switch to /build to run terminal commands.";
    if (this.sandboxShell && !this.sandboxRuntimeAvailable)
      return "Shell execution is disabled because the required Bubblewrap sandbox runtime is unavailable; Rook will not fall back to host execution.";
    if (this.activeMutations.size > 0)
      return "Another file mutation or shell command is active; concurrent execution is denied.";
    const command = input.command;
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > MAX_SHELL_COMMAND_LENGTH ||
      /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(command)
    ) {
      return `A nonempty shell command of at most ${MAX_SHELL_COMMAND_LENGTH} characters without control codes is required.`;
    }
    let timeoutSeconds: number;
    try {
      timeoutSeconds = shellTimeout(input.timeout);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid shell timeout.";
    }
    const classification = classifyShellCommand(command);
    if (classification.kind === "routine" && this.sandboxShell) {
      this.activeMutations.add(toolCallId);
      this.shellCommands.set(toolCallId, command);
      return "Allowed routine command inside the OS sandbox; network access is disabled.";
    }
    const root = await (this.workspaceRoot ??= realpath(this.cwd));
    const grantIdentity = shellGrantIdentity(command, root, this.sandboxShell);
    if (this.hasShellGrant(grantIdentity)) {
      this.activeMutations.add(toolCallId);
      this.shellCommands.set(toolCallId, command);
      return "Allowed by this session's exact-command shell grant.";
    }
    const prompt = this.externalAccessPrompt;
    if (!prompt)
      return "Shell execution requires approval for a destructive or unclassified command; no interactive approval handler is available.";
    const mode = this.mode;
    const grantGeneration = this.permissionGrantGeneration;
    this.activeMutations.add(toolCallId);
    let allowed = false;
    try {
      const choice = await prompt({
        toolName: "bash",
        path: root,
        folderPath: root,
        access: "execute",
        command,
        timeoutSeconds,
        sandboxed: this.sandboxShell,
        reason: classification.reason,
      });
      if (choice === "deny")
        return "Shell command execution was denied by the user.";
      if (
        this.mode !== mode ||
        mode !== "build" ||
        this.permissionGrantGeneration !== grantGeneration ||
        this.externalAccessPrompt !== prompt
      )
        return "Shell approval expired after a mode or approval-handler change.";
      if (choice === "session") this.addShellGrant(grantIdentity, root);
      allowed = true;
      this.shellCommands.set(toolCallId, command);
      return this.sandboxShell
        ? choice === "session"
          ? "Allowed for this exact command and workspace for this session; execution is sandboxed."
          : "Allowed once for this command; execution is sandboxed."
        : choice === "session"
          ? "Allowed for this exact host command and workspace for this session by explicit policy opt-out; execution is not sandboxed."
          : "Allowed once for this host shell command by explicit policy opt-out; execution is not sandboxed.";
    } catch (error) {
      return error instanceof Error
        ? `Shell execution denied: ${error.message}`
        : "Shell command approval failed; execution is denied.";
    } finally {
      if (!allowed) this.activeMutations.delete(toolCallId);
    }
  }

  private async checkPath(
    inputPath: string,
    mutation: boolean,
    toolName: string,
  ): Promise<string> {
    try {
      const root = await (this.workspaceRoot ??= realpath(this.cwd));
      if (inputPath.includes("\0"))
        return "Paths containing null bytes are denied.";
      const expandedPath = inputPath.startsWith("~/")
        ? resolve(homedir(), inputPath.slice(2))
        : inputPath;
      const segments = expandedPath.split(/[\\/]+/).filter(Boolean);
      if (segments.includes(".."))
        return "Parent-directory traversal is denied.";
      if (
        segments.some((segment) => isSensitiveSegment(segment)) ||
        isSensitiveFile(segments.at(-1) ?? "")
      ) {
        return "Sensitive and dependency paths are denied.";
      }

      const target = isAbsolute(expandedPath)
        ? resolve(expandedPath)
        : resolve(root, expandedPath || ".");
      const access = mutation ? "write" : "read";
      if (isWithin(root, target)) {
        const checked = await this.inspectPath(target, mutation);
        if ("error" in checked) return checked.error;
        if (!isWithin(root, checked.path))
          return "Resolved path is outside the authorized workspace.";
        if (checked.path !== target)
          return "Symbolic links are denied by policy.";
        if (hasSensitivePath(checked.path))
          return "Sensitive and dependency paths are denied.";
        return "Allowed within the workspace.";
      }

      const requestedFolder =
        toolName === "ls" || toolName === "find" ? target : dirname(target);
      const existingGrant = this.externalGrants.find(
        (grant) =>
          grant.access === access &&
          (isWithin(grant.requestedPath, target) ||
            isWithin(grant.path, target)),
      );
      if (existingGrant) {
        const checked = await this.inspectPath(target, mutation);
        if ("error" in checked) return checked.error;
        if (hasSensitivePath(checked.path))
          return "Sensitive and dependency paths are denied.";
        if (isWithin(existingGrant.path, checked.path)) {
          return `Allowed by this session's ${access} grant for ${existingGrant.path}.`;
        }
      }
      if (!this.externalAccessPrompt) {
        return "Path is outside the authorized workspace; no interactive approval is available.";
      }

      const request: ExternalAccessRequest = {
        toolName,
        path: target,
        folderPath: requestedFolder,
        access,
      };
      const choice = await this.externalAccessPrompt(request);
      if (choice === "deny")
        return `External ${access} access was denied for ${target}.`;
      const checked = await this.inspectPath(target, mutation);
      if ("error" in checked) return checked.error;
      if (hasSensitivePath(checked.path))
        return "Sensitive and dependency paths are denied.";
      if (choice === "once") {
        return `Allowed once for ${access} access to ${checked.path}.`;
      }
      if (choice === "session") {
        this.externalGrants.push({
          id: randomUUID(),
          path: checked.folderPath,
          requestedPath: requestedFolder,
          access,
        });
        return `Allowed by this session's ${access} grant for ${checked.folderPath}.`;
      }
      return `External ${access} access was denied for ${checked.path}.`;
    } catch {
      return "Path could not be verified; access is denied.";
    }
  }

  private async inspectPath(
    target: string,
    mutation: boolean,
  ): Promise<{ path: string; folderPath: string } | { error: string }> {
    let targetInfo;
    try {
      targetInfo = await lstat(target);
    } catch (error) {
      if (!mutation && isMissing(error)) {
        return { error: "Read paths must exist." };
      }
      if (!mutation || !isMissing(error)) throw error;
    }
    if (targetInfo?.isSymbolicLink()) {
      return { error: "Symbolic links are denied by policy." };
    }
    if (targetInfo?.isFile() && targetInfo.nlink > 1) {
      return { error: "Hard-linked paths are denied by policy." };
    }

    const parent = await realpath(
      targetInfo?.isDirectory() ? target : dirname(target),
    );
    const canonicalPath = targetInfo
      ? await realpath(target)
      : resolve(parent, target.split(sep).at(-1) ?? "");
    return {
      path: canonicalPath,
      folderPath: targetInfo?.isDirectory() ? canonicalPath : parent,
    };
  }

  private invalidateChecks(): void {
    this.changeVersion++;
    this.successfulChecks.clear();
  }

  private hasToolGrant(toolName: string, sourceName: string): boolean {
    return this.sessionPermissionGrants.some(
      (grant) =>
        grant.type === "tool" &&
        grant.identity === toolName &&
        grant.sourceName === sourceName,
    );
  }

  private hasMcpToolGrant(toolName: string, serverName: string): boolean {
    return this.sessionPermissionGrants.some(
      (grant) =>
        grant.type === "tool" &&
        grant.identity === toolName &&
        grant.sourceName === serverName,
    );
  }

  private addToolGrant(toolName: string, sourceName: string): void {
    if (this.hasToolGrant(toolName, sourceName)) return;
    this.sessionPermissionGrants.push({
      id: randomUUID(),
      type: "tool",
      description: toolName,
      identity: toolName,
      sourceName,
    });
  }

  private hasShellGrant(identity: string): boolean {
    return this.sessionPermissionGrants.some(
      (grant) => grant.type === "shell" && grant.identity === identity,
    );
  }

  private addShellGrant(identity: string, workspace: string): void {
    this.sessionPermissionGrants.push({
      id: randomUUID(),
      type: "shell",
      description: commandFromGrantIdentity(identity),
      identity,
      sourceName: "bash",
      workspace,
      sandboxed: identity.split("\0")[1] === "sandboxed",
    });
  }
}

function explicitMcpTools(prompt: string): Set<string> | "all" | undefined {
  if (
    /\b(?:not sure|unsure|uncertain|whether|maybe|might|consider)\b[\s\S]{0,50}\b(?:use|call|invoke|query|ask|run)\b[\s\S]{0,40}\bmcp\b/i.test(
      prompt,
    )
  )
    return undefined;
  const action = /\b(?:use|call|invoke|query|ask|run)\b/i.exec(prompt);
  const names = [...prompt.matchAll(/\bmcp__[a-z0-9_-]+__[a-z0-9_.-]+\b/gi)];
  const requestedNames = names
    .filter((match) => action && match.index! >= action.index)
    .map(([name]) => name!);
  if (action && requestedNames.length > 0) {
    return new Set(requestedNames);
  }
  if (/\b(?:use|call|invoke|query|ask|run)\b[\s\S]{0,40}\bmcp\b/i.test(prompt))
    return "all";
  return undefined;
}

function explicitlyDeniesMcp(prompt: string): boolean {
  return (
    /\b(?:don't|do not|never|avoid)\s+(?:use|call|invoke|query|run)\b[\s\S]{0,40}\b(?:mcp\b|mcp__[a-z0-9_-]+__[a-z0-9_.-]+\b)/i.test(
      prompt,
    ) || /\bavoid\s+mcp\b/i.test(prompt)
  );
}

function summarizeMcpInput(input: Record<string, unknown>): string {
  try {
    let remaining = 100;
    const sanitize = (value: unknown, depth = 0, key = ""): unknown => {
      if (
        /(?:secret|token|password|authorization|api.?key|credential)/i.test(key)
      )
        return "[redacted]";
      if (typeof value === "string") return redactSummaryString(value);
      if (!value || typeof value !== "object") return value;
      if (depth >= 5 || remaining <= 0) return "[truncated]";
      remaining--;
      if (Array.isArray(value))
        return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 20)
          .map(([childKey, childValue]) => [
            childKey,
            sanitize(childValue, depth + 1, childKey),
          ]),
      );
    };
    const serialized = JSON.stringify(sanitize(input));
    return (serialized ?? "{}").slice(0, 800);
  } catch {
    return "<unavailable>";
  }
}

function redactSummaryString(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(
      /\b(?:Authorization|Token|API[_-]?Key|Access[_-]?Token|Password|Secret)\s*[:=]?\s+(?:Bearer\s+)?\S+/gi,
      "[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-|AIza)[A-Za-z0-9_-]{16,}/g,
      "[redacted token]",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted AWS key]")
    .replace(
      /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted credential]",
    )
    .slice(0, 200);
}

function toolSourceName(toolName: string): string {
  const mcp = /^mcp__([a-zA-Z0-9_-]+)__/.exec(toolName);
  if (mcp) return mcp[1]!;
  const namespace = /^([a-zA-Z0-9_-]+)[.:]/.exec(toolName);
  return namespace?.[1] ?? `registered:${toolName}`;
}

function shellGrantIdentity(
  command: string,
  workspace: string,
  sandboxed: boolean,
): string {
  return `${workspace}\0${sandboxed ? "sandboxed" : "host"}\0${command}`;
}

function commandFromGrantIdentity(identity: string): string {
  return identity.split("\0").at(-1) ?? identity;
}

function classifyShellCommand(command: string): {
  kind: "routine" | "review";
  reason: string;
} {
  const trimmed = command.trim();
  const safePath = String.raw`(?:\.|[\w./-]+)`;
  const routineCommands = [
    /^pwd$/,
    new RegExp(`^ls(?:\\s+-[A-Za-z]+)?(?:\\s+${safePath})?$`),
    /^git status(?: --short)?$/,
    /^git diff(?: --check| --stat| --name-only)?$/,
    /^git diff --stat -- [\w./-]+$/,
    /^git log(?: -[0-9]{1,2})?$/,
    /^git branch --show-current$/,
    /^(?:npm|pnpm|yarn|bun) (?:test|run (?:test(?::[\w:-]+)?|typecheck|check|lint|build))$/,
    /^(?:npx|pnpm exec|yarn exec|bunx) (?:vitest|jest|mocha|pytest|tsc|eslint)(?:\s+--(?:run|noEmit|check))?$/,
    /^go test(?:\s+\.\/[-\w./]+)?$/,
    /^cargo test(?:\s+[-\w./]+)?$/,
    /^python(?:3)? -m pytest(?:\s+[-\w./]+)?$/,
  ];
  if (
    !/[;&|`$<>\n\r]/.test(trimmed) &&
    !/(?:^|[\s/])(?:\/|~|\.\.?\/|\.\.?$)/.test(trimmed) &&
    !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed) &&
    !/(?:^|\s)(?:\.env(?:\.[\w-]+)?|\.ssh|\.aws|credentials|id_rsa|id_ed25519)(?:\/|\s|$)/i.test(
      trimmed,
    ) &&
    routineCommands.some((pattern) => pattern.test(trimmed))
  ) {
    return {
      kind: "routine",
      reason: "Recognized routine development command.",
    };
  }
  const destructive =
    /\b(?:rm|rmdir|dd|mkfs|shutdown|reboot|kill|pkill|chmod|chown|curl|wget|sudo|su|docker|podman|kubectl|terraform|tofu|aws|az|gcloud)\b|\bgit\s+(?:reset|clean|checkout|restore|push|rebase|commit|merge|tag)\b|\b(?:--force|--hard|--delete|--force-with-lease)\b/i.test(
      trimmed,
    );
  return {
    kind: "review",
    reason: destructive
      ? "Command may modify or delete files, rewrite history, or cross the workspace boundary."
      : "Command is outside the conservative routine-command allowlist and needs review.",
  };
}

function isVerificationCommand(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test(?::[\w:-]+)?|check|typecheck|lint|build)(?:\s|$)|(?:^|[\s;&|])(?:npx\s+)?(?:vitest|jest|mocha|pytest|tsc|eslint)(?:\s|$)|(?:^|[\s;&|])(?:go\s+test|cargo\s+test|python\s+-m\s+pytest)(?:\s|$)/.test(
    value,
  );
}

export function createToolPolicyExtension(policy: ToolPolicy): InlineExtension {
  return {
    name: "rook-tool-policy",
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", async (event) => {
        if (event.toolName === TASK_CHECKLIST_TOOL_NAME) return;
        const decision = await policy.check(
          event.toolName,
          event.input,
          event.toolCallId,
        );
        return decision.allowed
          ? undefined
          : { block: true, reason: decision.reason };
      });
      pi.on("tool_execution_start", (event) =>
        policy.beginToolExecution(event.toolCallId, event.toolName, event.args),
      );
      pi.on("tool_execution_end", async (event) => {
        await policy.finishToolExecution(
          event.toolCallId,
          event.toolName,
          event.isError,
        );
      });
    },
  };
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function isSensitiveSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return (
    SENSITIVE_SEGMENTS.has(normalized) ||
    normalized.startsWith(".env") ||
    normalized === "credentials"
  );
}

function isSensitiveFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return (
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx") ||
    normalized === "id_rsa" ||
    normalized === "id_ed25519"
  );
}

function hasSensitivePath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return (
    segments.some((segment) => isSensitiveSegment(segment)) ||
    isSensitiveFile(segments.at(-1) ?? "")
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
