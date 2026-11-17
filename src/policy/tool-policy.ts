import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
  PermissionDecision,
  PermissionMode,
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

  async check(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<PermissionDecision> {
    let reason: string;
    let allowed = false;

    if (READ_TOOLS.has(toolName)) {
      const path = typeof input.path === "string" ? input.path : ".";
      reason = await this.checkWorkspacePath(path, false);
      allowed = reason === "Allowed within the workspace.";
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
          ? await this.checkWorkspacePath(path, true)
          : "A valid workspace path is required.";
        allowed = reason === "Allowed within the workspace.";
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

  private async checkWorkspacePath(
    inputPath: string,
    mutation: boolean,
  ): Promise<string> {
    try {
      const root = await (this.workspaceRoot ??= realpath(this.cwd));
      if (inputPath.includes("\0"))
        return "Paths containing null bytes are denied.";
      const segments = inputPath.split(/[\\/]+/).filter(Boolean);
      if (segments.includes(".."))
        return "Parent-directory traversal is denied.";
      if (
        segments.some((segment) => isSensitiveSegment(segment)) ||
        isSensitiveFile(segments.at(-1) ?? "")
      ) {
        return "Sensitive and dependency paths are denied.";
      }

      const target = isAbsolute(inputPath)
        ? resolve(inputPath)
        : resolve(root, inputPath || ".");
      if (!isWithin(root, target))
        return "Path is outside the authorized workspace.";

      const relativePath = relative(root, target);
      let current = root;
      if (relativePath) {
        for (const segment of relativePath.split(sep)) {
          current = resolve(current, segment);
          try {
            const entry = await lstat(current);
            if (entry.isSymbolicLink())
              return "Symbolic links are denied by policy.";
            if (entry.isFile() && entry.nlink > 1)
              return "Hard-linked paths are denied by policy.";
          } catch (error) {
            if (isMissing(error)) {
              if (mutation && current !== target) {
                return "Parent directories must already exist for a write.";
              }
              if (mutation) break;
              return "Read paths must exist within the workspace.";
            }
            throw error;
          }
        }
      }

      if (mutation) {
        const parent = await realpath(resolve(target, ".."));
        if (!isWithin(root, parent)) {
          return "Resolved parent directory is outside the authorized workspace.";
        }
      } else {
        const resolved = await realpath(target);
        if (!isWithin(root, resolved)) {
          return "Resolved path is outside the authorized workspace.";
        }
      }
      return "Allowed within the workspace.";
    } catch {
      return "Workspace path could not be verified; access is denied.";
    }
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
