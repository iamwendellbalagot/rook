import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Effect = "allow" | "ask" | "deny";
export interface PermissionRule {
  action: string;
  resource: string;
  effect: Effect;
}
export interface PolicyRule extends Omit<PermissionRule, "effect"> {
  effect: "allow" | "deny";
}
export interface PermissionConfiguration {
  permissions?: PermissionRule[];
  policies?: PolicyRule[];
}
export interface SavedApproval extends PermissionRule {
  id: string;
  effect: "allow";
}
export interface PermissionResource {
  action: string;
  resource: string;
}

const DEFAULTS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "ask" },
  ...[
    "read",
    "edit",
    "glob",
    "grep",
    "rook_inspect",
    "rook_map",
    "rook_code",
    "rook_impact",
    "tool_search",
    "codemode",
    "rook_todo",
    "rook_task",
    "rook_job",
  ].map((action) => ({ action, resource: "*", effect: "allow" as const })),
  { action: "read", resource: "*.env*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  ...[
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.ssh/*",
    "*.aws/*",
    "*credentials*",
    "*id_rsa*",
    "*id_ed25519*",
  ].map((resource) => ({ action: "read", resource, effect: "ask" as const })),
];

/** Whole-value wildcards, not regular expressions or shell globs. */
export function matches(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const options = process.platform === "win32" ? "is" : "s";
  return (
    new RegExp(`^${source}$`, options).test(value.replaceAll("\\", "/")) ||
    (pattern.endsWith(" *") && matches(pattern.slice(0, -2), value))
  );
}

export function rookHome(): string {
  return resolve(process.env.ROOK_HOME ?? join(homedir(), ".rook"));
}

export function systemPermissionPath(): string {
  return process.platform === "darwin"
    ? "/Library/Application Support/rook/permissions.json"
    : process.platform === "win32"
      ? join(
          process.env.ProgramData ?? "C:\\ProgramData",
          "rook",
          "permissions.json",
        )
      : "/etc/rook/permissions.json";
}

/** Configuration is validated fail-closed. Only explicit permission files grant host access. */
export class Permissions {
  private approvals: SavedApproval[] = [];
  private session: PermissionResource[] = [];
  private constructor(
    readonly workspace: string,
    private readonly layers: PermissionConfiguration[],
    private readonly approvalPath?: string,
  ) {}

  static async load(cwd: string): Promise<Permissions> {
    const root = await realpath(cwd);
    const home = rookHome();
    const result = new Permissions(
      root,
      await Promise.all([
        loadConfiguration(join(root, ".rook", "permissions.json"), true),
        loadConfiguration(join(home, "permissions.json")),
        loadConfiguration(systemPermissionPath()),
      ]),
      join(
        home,
        "approvals",
        `${createHash("sha256").update(root).digest("hex")}.json`,
      ),
    );
    try {
      const data: unknown = JSON.parse(
        await readFile(result.approvalPath!, "utf8"),
      );
      if (!Array.isArray(data) || data.length > 1000)
        throw new Error("Invalid saved approvals");
      result.approvals = data.map((item) => {
        validateRule(item, false);
        if (item.effect !== "allow" || typeof item.id !== "string")
          throw new Error("Invalid saved approval");
        return item as SavedApproval;
      });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return result;
  }

  static configured(
    workspace: string,
    layers: PermissionConfiguration[] = [],
  ): Permissions {
    layers.forEach(validateConfiguration);
    return new Permissions(workspace, layers);
  }

  evaluate(action: string, resource: string): Effect {
    let effect: Effect = "ask";
    for (const rule of [
      ...DEFAULTS,
      ...this.layers.flatMap((layer) => layer.permissions ?? []),
    ]) {
      if (matches(rule.action, action) && matches(rule.resource, resource))
        effect = rule.effect;
    }
    if (
      effect !== "deny" &&
      [...this.approvals, ...this.session].some(
        (rule) => rule.action === action && rule.resource === resource,
      )
    )
      effect = "allow";
    let denied = false;
    // Broader authority is later. Policy allow only lifts policy deny.
    for (const layer of this.layers) {
      for (const rule of layer.policies ?? []) {
        if (
          matches(rule.action, "tool.use") &&
          matches(rule.resource, `${action}:${resource}`)
        )
          denied = rule.effect === "deny";
      }
    }
    return denied ? "deny" : effect;
  }

  hasShellDenials(): boolean {
    return this.layers.some(
      (layer) =>
        layer.permissions?.some(
          (rule) => rule.effect === "deny" && matches(rule.action, "shell"),
        ) ||
        layer.policies?.some(
          (rule) =>
            rule.effect === "deny" &&
            matches(rule.action, "tool.use") &&
            (rule.resource.startsWith("shell:") ||
              matches(rule.resource, "shell:anything")),
        ),
    );
  }

  hasReadRestrictions(): boolean {
    return this.layers.some(
      (layer) =>
        layer.permissions?.some(
          (rule) => rule.effect !== "allow" && matches(rule.action, "read"),
        ) ||
        layer.policies?.some(
          (rule) =>
            rule.effect === "deny" &&
            (rule.resource.startsWith("read:") ||
              matches(rule.resource, "read:anything")),
        ),
    );
  }

  async grant(
    resources: PermissionResource[],
    persist: boolean,
  ): Promise<void> {
    if (!persist) {
      this.session.push(...resources);
      return;
    }
    if (!this.approvalPath)
      throw new Error("Persistent approvals are unavailable");
    const previous = this.approvals;
    this.approvals = [
      ...previous,
      ...resources
        .filter(
          (resource) =>
            !previous.some(
              (item) =>
                item.action === resource.action &&
                item.resource === resource.resource,
            ),
        )
        .map((resource) => ({
          ...resource,
          id: randomUUID(),
          effect: "allow" as const,
        })),
    ];
    if (this.approvals.length > 1000) {
      this.approvals = previous;
      throw new Error("Saved approval limit reached");
    }
    try {
      await this.save();
    } catch (error) {
      this.approvals = previous;
      throw error;
    }
  }

  listApprovals(): SavedApproval[] {
    return this.approvals.map((item) => ({ ...item }));
  }
  clearSession(): void {
    this.session = [];
  }
  async revoke(id: string): Promise<boolean> {
    const previous = this.approvals;
    this.approvals = previous.filter((item) => item.id !== id);
    if (previous.length === this.approvals.length) return false;
    try {
      await this.save();
    } catch (error) {
      this.approvals = previous;
      throw error;
    }
    return true;
  }
  private async save(): Promise<void> {
    await mkdir(dirname(this.approvalPath!), { recursive: true, mode: 0o700 });
    const temporary = `${this.approvalPath!}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.approvals, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.approvalPath!);
  }
}

async function loadConfiguration(
  path: string,
  project = false,
): Promise<PermissionConfiguration> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.size > 128 * 1024 ||
      (project && (await realpath(path)) !== resolve(path))
    )
      throw new Error(
        "Permission configuration must be a bounded regular file without symbolic-link traversal",
      );
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 128 * 1024)
      throw new Error("Permission configuration exceeds 128 KiB");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON permission configuration");
    }
    validateConfiguration(value);
    return value;
  } catch (error) {
    if (missing(error)) return {};
    throw new Error(
      `Could not load permissions ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function validateConfiguration(
  value: unknown,
): asserts value is PermissionConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Permission configuration must be an object");
  for (const [name, rules] of Object.entries(value)) {
    if (!["permissions", "policies", "$schema"].includes(name))
      throw new Error(`Unknown permission configuration key: ${name}`);
    if (name === "$schema") continue;
    if (!Array.isArray(rules) || rules.length > 1000)
      throw new Error(`${name} must be a bounded array`);
    rules.forEach((rule) => validateRule(rule, name === "policies"));
  }
}
function validateRule(value: any, policy: boolean): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.action !== "string" ||
    typeof value.resource !== "string" ||
    !value.action.length ||
    value.action.length > 200 ||
    value.resource.length > 8192 ||
    !(policy ? ["allow", "deny"] : ["allow", "ask", "deny"]).includes(
      value.effect,
    )
  )
    throw new Error("Invalid permission/policy rule");
  if (policy && value.action !== "tool.use")
    throw new Error("Only tool.use policies are supported");
}
function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
