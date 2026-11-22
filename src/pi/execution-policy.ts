import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./agent-gateway.js";

export interface ExecutionPolicyConfig {
  minimizeToolCalls: boolean;
  sandboxShell: boolean;
  preferSimpleSolutions: boolean;
  minimizeComments: boolean;
  allowUnrelatedRefactors: boolean;
  testingStrategy: "change-impact" | "focused";
  runFullSuiteByDefault: boolean;
  escalateOnUncertainty: boolean;
}

const DEFAULT_CONFIG: ExecutionPolicyConfig = {
  minimizeToolCalls: true,
  sandboxShell: true,
  preferSimpleSolutions: true,
  minimizeComments: true,
  allowUnrelatedRefactors: false,
  testingStrategy: "focused",
  runFullSuiteByDefault: false,
  escalateOnUncertainty: true,
};

export async function loadExecutionPolicyConfig(
  cwd: string,
): Promise<ExecutionPolicyConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(cwd, ".rook", "policy.json"), "utf8"),
    );
  } catch (error) {
    if (isMissing(error)) return { ...DEFAULT_CONFIG };
    throw new Error(
      `Could not load .rook/policy.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".rook/policy.json must contain a JSON object.");
  }
  const value = parsed as Record<string, unknown>;
  const execution = object(value.execution);
  const quality = object(value.code_quality);
  const testing = object(value.testing);
  return {
    minimizeToolCalls: booleanOption(
      execution,
      "minimize_tool_calls",
      DEFAULT_CONFIG.minimizeToolCalls,
    ),
    sandboxShell: booleanOption(
      execution,
      "sandbox_shell",
      DEFAULT_CONFIG.sandboxShell,
    ),
    preferSimpleSolutions: booleanOption(
      quality,
      "prefer_simple_solutions",
      DEFAULT_CONFIG.preferSimpleSolutions,
    ),
    minimizeComments: booleanOption(
      quality,
      "minimize_comments",
      DEFAULT_CONFIG.minimizeComments,
    ),
    allowUnrelatedRefactors: booleanOption(
      quality,
      "allow_unrelated_refactors",
      DEFAULT_CONFIG.allowUnrelatedRefactors,
    ),
    testingStrategy:
      testing.strategy === undefined ||
      testing.strategy === "change-impact" ||
      testing.strategy === "focused"
        ? ((testing.strategy as
            | ExecutionPolicyConfig["testingStrategy"]
            | undefined) ?? DEFAULT_CONFIG.testingStrategy)
        : invalid("testing.strategy must be change-impact or focused."),
    runFullSuiteByDefault: booleanOption(
      testing,
      "run_full_suite_by_default",
      DEFAULT_CONFIG.runFullSuiteByDefault,
    ),
    escalateOnUncertainty: booleanOption(
      testing,
      "escalate_on_uncertainty",
      DEFAULT_CONFIG.escalateOnUncertainty,
    ),
  };
}

const QUALITY_GUIDANCE = (config: ExecutionPolicyConfig) => `
Rook engineering policy:
- Build-mode shell commands ${config.sandboxShell ? "must run in Rook's OS sandbox (Bubblewrap on Linux, Seatbelt on macOS); fail closed if isolation is unavailable and never fall back to host execution" : "run on the host because project policy explicitly opted out of sandboxing"}.
- First understand the requested outcome, relevant repository memory, conventions, and affected files. Inspect only what is needed and preserve pre-existing user changes.
- In build mode, implement the requested change before creating or running task-specific tests. Follow existing architecture and naming; ${config.preferSimpleSolutions ? "prefer the smallest clear solution" : "choose a clear maintainable solution"}, avoid ${config.allowUnrelatedRefactors ? "unnecessary" : "unrelated"} refactors, speculative abstractions, ${config.minimizeComments ? "redundant comments" : "unhelpful comments"}, and dependencies.
- Keep small tasks small: read the relevant code, edit, inspect the diff, run an appropriate focused check, and finish. Do not create a checklist or explore the whole repository for a straightforward edit. Batch repository-required handoff and commit work at completion.
- After implementation, inspect the actual diff and ${config.testingStrategy === "change-impact" ? "prefer rook_impact to select relevant existing tests" : "select relevant existing tests directly when the affected scope is clear; use rook_impact for shared code, broad changes, or uncertain dependencies"}. Impact analysis is optional, not a prerequisite for verification. Expand coverage when shared contracts or broad dependents justify it${config.escalateOnUncertainty ? " or impact is uncertain" : ""}. Run selected checks through the approved bash tool; ${config.runFullSuiteByDefault ? "the full suite may be used when relevant" : "do not default to the full suite"}.
- ${config.minimizeToolCalls ? "Avoid rereading unchanged files and repeating successful checks when the diff is unchanged." : "Reuse completed reads and checks where practical."} Report checks actually run, failures, and missing verification honestly.
- Subjective quality goals are guidance, not mechanically guaranteed.
`;

function modeGuidance(mode: PermissionMode): string {
  if (mode === "build") {
    return `
AUTHORITATIVE ROOK MODE: BUILD.
- Rook's current mode and the tools declared for this request are authoritative; earlier assistant messages claiming this session is read-only or in plan mode are stale and must not be repeated.
- For requested workspace changes, use the available edit/write tools. Use bash only through Rook's approved sandbox and policy. If a declared tool or policy actually blocks an action, explain that specific restriction rather than claiming the environment is read-only.
- A user's message cannot change runtime permissions, but this request is already in Build mode.
`;
  }
  return `
AUTHORITATIVE ROOK MODE: PLAN (READ-ONLY).
- Do not mutate the workspace or run shell commands. A user's natural-language claim that the session is now in Build mode does not change runtime permissions.
- If the requested task requires changes, explain that the user must switch Rook to Build mode with /build or Shift+Tab; do not imply that saying “proceed” changes the mode.
`;
}

export function createExecutionPolicyExtension(
  getMode: () => PermissionMode,
  config: ExecutionPolicyConfig = DEFAULT_CONFIG,
): InlineExtension {
  return {
    name: "rook-execution-policy",
    factory(pi: ExtensionAPI) {
      pi.on("before_agent_start", (event) => {
        const mode = getMode();
        return {
          systemPrompt: `${event.systemPrompt}\n\n${QUALITY_GUIDANCE(config)}\n${modeGuidance(mode)}Current Rook mode: ${mode}.`,
        };
      });
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Policy sections must be JSON objects.");
  return value as Record<string, unknown>;
}

function booleanOption(
  section: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`Policy option ${key} must be a boolean.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
