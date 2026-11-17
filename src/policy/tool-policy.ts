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
} from "../pi/agent-gateway.js";
import { TASK_CHECKLIST_TOOL_NAME } from "../pi/task-checklist.js";
import { MAX_SHELL_COMMAND_LENGTH, shellTimeout } from "./shell-limits.js";

const READ_TOOLS = new Set(["read", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PLAN_INSPECTION_TOOL = "rook_inspect";
const WORKSPACE_SEARCH_TOOL = "rook_search";
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
  private mode: PermissionMode = "plan";
  private impactReviewed = false;
  private workspaceRoot?: Promise<string>;
  private readonly decisions: PermissionDecision[] = [];
  private readonly activeMutations = new Set<string>();
  private readonly shellCommands = new Map<string, string>();
  private readonly externalGrants: ExternalAccessGrant[] = [];
  private externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined = undefined;

  constructor(private readonly cwd: string) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    if (mode === "plan") this.impactReviewed = false;
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
    if (index < 0) return false;
    this.externalGrants.splice(index, 1);
    return true;
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
        this.impactReviewed = false;
        reason = path
          ? await this.checkPath(path, true, toolName)
          : "A valid workspace path is required.";
        allowed = reason.startsWith("Allowed ");
        if (!allowed) this.activeMutations.delete(toolCallId);
      }
    } else if (toolName === "bash") {
      reason = isVerificationCommand(input.command)
        ? this.impactReviewed
          ? await this.checkShell(input, toolCallId)
          : "Run rook_impact after implementation and before test/build/type-check commands so verification is selected from the actual diff."
        : await this.checkShell(input, toolCallId);
      allowed = reason.startsWith("Allowed ");
    } else if (
      toolName === PLAN_INSPECTION_TOOL ||
      toolName === WORKSPACE_SEARCH_TOOL
    ) {
      if (this.activeMutations.size) {
        reason =
          "Repository inspection is unavailable while another Rook operation is active.";
      } else if (
        toolName === PLAN_INSPECTION_TOOL &&
        !["status", "diff", "log", "branches", "show"].includes(
          String(input.action),
        )
      ) {
        reason = "Unsupported repository inspection operation.";
      } else if (
        toolName === WORKSPACE_SEARCH_TOOL &&
        (typeof input.query !== "string" ||
          !input.query.trim() ||
          input.query.length > 200)
      ) {
        reason =
          "A nonempty literal search query of at most 200 characters is required.";
      } else {
        this.activeMutations.add(toolCallId);
        reason = "Allowed read-only Git inspection.";
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
    } else {
      reason = "This tool is not classified by Rook and is denied by default.";
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
    if (toolName === CHANGE_IMPACT_TOOL && !isError) this.impactReviewed = true;
    if (toolName === "edit" || toolName === "write")
      this.impactReviewed = false;
    if (toolName === "bash" && command && !isVerificationCommand(command))
      this.impactReviewed = false;
  }

  private async checkShell(
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<string> {
    if (this.mode !== "build")
      return "Plan mode blocks shell execution; switch to /build to run terminal commands.";
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
    const prompt = this.externalAccessPrompt;
    if (!prompt)
      return "Shell execution requires interactive command approval; no approval handler is available.";
    this.activeMutations.add(toolCallId);
    let allowed = false;
    try {
      const timeoutSeconds = shellTimeout(input.timeout);
      const root = await (this.workspaceRoot ??= realpath(this.cwd));
      const choice = await prompt({
        toolName: "bash",
        path: root,
        folderPath: root,
        access: "execute",
        command,
        timeoutSeconds,
      });
      if (choice !== "once")
        return "Shell command execution was denied; each command requires one-time approval.";
      if (this.mode !== "build" || this.externalAccessPrompt !== prompt)
        return "Shell approval expired after a mode or approval-handler change.";
      allowed = true;
      this.shellCommands.set(toolCallId, command);
      return "Allowed once for this host shell command; execution is not sandboxed.";
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
      pi.on("tool_execution_end", (event) => {
        policy.finish(event.toolCallId, event.toolName, event.isError);
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
