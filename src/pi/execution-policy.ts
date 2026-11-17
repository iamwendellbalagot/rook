import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./agent-gateway.js";

export interface ExecutionPolicyConfig {
  minimizeToolCalls: boolean;
  preferSimpleSolutions: boolean;
  minimizeComments: boolean;
  allowUnrelatedRefactors: boolean;
  testingStrategy: "change-impact" | "focused";
  runFullSuiteByDefault: boolean;
  escalateOnUncertainty: boolean;
}

const DEFAULT_CONFIG: ExecutionPolicyConfig = {
  minimizeToolCalls: true,
  preferSimpleSolutions: true,
  minimizeComments: true,
  allowUnrelatedRefactors: false,
  testingStrategy: "change-impact",
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
- First understand the requested outcome, relevant repository memory, conventions, and affected files. Inspect only what is needed and preserve pre-existing user changes.
- In build mode, implement the requested change before creating or running task-specific tests. Follow existing architecture and naming; ${config.preferSimpleSolutions ? "prefer the smallest clear solution" : "choose a clear maintainable solution"}, avoid ${config.allowUnrelatedRefactors ? "unnecessary" : "unrelated"} refactors, speculative abstractions, ${config.minimizeComments ? "redundant comments" : "unhelpful comments"}, and dependencies.
- After implementation, inspect the actual diff and use rook_impact to select relevant existing tests. Expand coverage when shared contracts or broad dependents justify it${config.escalateOnUncertainty ? " or impact is uncertain" : ""}. Run selected checks through the approved bash tool; ${config.runFullSuiteByDefault ? "the full suite may be used when relevant" : "do not default to the full suite"}.
- ${config.minimizeToolCalls ? "Avoid rereading unchanged files and repeating successful checks when the diff is unchanged." : "Reuse completed reads and checks where practical."} Report checks actually run, failures, and missing verification honestly.
- Subjective quality goals are guidance, not mechanically guaranteed. Plan mode is read-only: use bounded workspace read/search tools and rook_inspect for structured Git inspection; never attempt shell execution or mutation in plan mode.
`;

export function createExecutionPolicyExtension(
  getMode: () => PermissionMode,
  config: ExecutionPolicyConfig = DEFAULT_CONFIG,
): InlineExtension {
  return {
    name: "rook-execution-policy",
    factory(pi: ExtensionAPI) {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${QUALITY_GUIDANCE(config)}\nCurrent Rook mode: ${getMode()}.`,
      }));
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
