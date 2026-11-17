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

const READ_TOOLS = new Set(["read", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
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
  private workspaceRoot?: Promise<string>;
  private readonly decisions: PermissionDecision[] = [];
  private readonly activeMutations = new Set<string>();
  private readonly externalGrants: ExternalAccessGrant[] = [];
  private externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined = undefined;

  constructor(private readonly cwd: string) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
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
          "Another file mutation is active; concurrent mutations are denied.";
      } else {
        const path = typeof input.path === "string" ? input.path : "";
        this.activeMutations.add(toolCallId);
        reason = path
          ? await this.checkPath(path, true, toolName)
          : "A valid workspace path is required.";
        allowed = reason.startsWith("Allowed ");
        if (!allowed) this.activeMutations.delete(toolCallId);
      }
    } else if (toolName === "bash" || toolName === "powershell") {
      reason =
        "Shell execution is disabled in Rook's current permission policy.";
    } else {
      reason = "This tool is not classified by Rook and is denied by default.";
    }

    const decision = { toolName, allowed, reason, timestamp: new Date() };
    this.decisions.push(decision);
    if (this.decisions.length > 20) this.decisions.shift();
    return { ...decision };
  }

  finish(toolCallId: string): void {
    this.activeMutations.delete(toolCallId);
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

export function createToolPolicyExtension(policy: ToolPolicy): InlineExtension {
  return {
    name: "rook-tool-policy",
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", async (event) => {
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
        policy.finish(event.toolCallId);
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
