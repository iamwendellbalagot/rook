import { isAbsolute, relative, resolve } from "node:path";

export type PilotGuardViolation =
  | { kind: "tool_not_allowed"; toolName: string }
  | { kind: "write_path_not_allowed"; toolName: string; path: string }
  | { kind: "tool_call_limit"; limit: number }
  | { kind: "provider_request_limit"; limit: number };

/** Fail-closed budgets for one disposable pilot session. */
export class PilotRunGuard {
  private toolCalls = 0;
  private providerRequests = 0;
  readonly violations: PilotGuardViolation[] = [];
  readonly allowedTools: ReadonlySet<string>;
  readonly writablePaths: ReadonlySet<string>;
  readonly workspace: string;

  constructor(
    workspace: string,
    allowedTools: readonly string[],
    writablePaths: readonly string[],
    readonly maxToolCalls: number,
    readonly maxProviderRequests: number,
    private readonly onViolation?: (violation: PilotGuardViolation) => void,
    private readonly allowedBashCommands: readonly string[] = [],
  ) {
    this.workspace = resolve(workspace);
    this.allowedTools = new Set(allowedTools);
    this.writablePaths = new Set(writablePaths);
  }

  admitToolCall(toolName: string, input: unknown): boolean {
    if (!this.allowedTools.has(toolName)) {
      return this.deny({ kind: "tool_not_allowed", toolName });
    }
    if (toolName === "bash") {
      const command =
        input && typeof input === "object"
          ? (input as { command?: unknown }).command
          : undefined;
      if (
        typeof command !== "string" ||
        !this.allowedBashCommands.includes(command)
      ) {
        return this.deny({
          kind: "tool_not_allowed",
          toolName: `bash:${typeof command === "string" ? command : "[missing]"}`,
        });
      }
    }
    if (this.toolCalls >= this.maxToolCalls) {
      return this.deny({ kind: "tool_call_limit", limit: this.maxToolCalls });
    }
    if (toolName === "edit" || toolName === "write") {
      const requested =
        input && typeof input === "object"
          ? (input as { path?: unknown }).path
          : undefined;
      if (typeof requested !== "string" || !this.isWritablePath(requested)) {
        return this.deny({
          kind: "write_path_not_allowed",
          toolName,
          path: typeof requested === "string" ? requested : "[missing]",
        });
      }
    }
    this.toolCalls++;
    return true;
  }

  admitProviderRequest(): boolean {
    if (this.providerRequests >= this.maxProviderRequests) {
      return this.deny({
        kind: "provider_request_limit",
        limit: this.maxProviderRequests,
      });
    }
    this.providerRequests++;
    return true;
  }

  requestCount(): number {
    return this.providerRequests;
  }

  toolCallCount(): number {
    return this.toolCalls;
  }

  private isWritablePath(path: string): boolean {
    if (!path || isAbsolute(path) || /[\x00-\x1f\\]/.test(path)) return false;
    const relativePath = relative(
      this.workspace,
      resolve(this.workspace, path),
    );
    return (
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      this.writablePaths.has(relativePath)
    );
  }

  private deny(violation: PilotGuardViolation): false {
    this.violations.push(violation);
    this.onViolation?.(violation);
    return false;
  }
}
