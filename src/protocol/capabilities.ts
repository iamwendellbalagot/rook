import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  getRookSkillDirectories,
  isWithinRookSkillDirectories,
  listInstalledSkills,
  type SkillScope,
} from "../skills/manager.js";
import {
  loadWorkspaceModelProviders,
  workspaceEndpointFingerprint,
} from "../pi/workspace-models.js";

const MAX_SKILL_INSPECT_BYTES = 64 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CapabilitySkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
  precedence: "active" | "shadowed";
  baseDir: string;
  skillFilePath: string;
  digest: string;
}

export interface CapabilityMcpServerSummary {
  name: string;
  scope: "global" | "project";
  sourcePath: string;
  overridePath: string | null;
  transport: "stdio" | "http" | "invalid";
  target: string;
  configured: "valid" | "invalid";
  configEnabled: boolean;
  enabled: boolean;
  connected: boolean;
  connectionStatus:
    | "blocked_by_stdio_policy"
    | "disabled"
    | "untrusted_project"
    | "invalid_config";
  connectionNote: string;
  authorizationPolicy: "approval_required";
  authorizationNote: string;
  exposure: string;
  redactedHeaders: string[];
  errors: string[];
}

export interface CapabilityWorkspaceProviderSummary {
  id: string;
  endpoint: string | null;
  endpointFingerprint: string;
  missingEnvironmentVariables: string[];
  source: "workspace";
}

export interface RookParityItem {
  id: string;
  feature: string;
  status: "native" | "terminal_handoff" | "blocked_protocol";
  detail: string;
  terminalCommand?: string;
}

export interface CapabilitiesSnapshot {
  runtimeSource: "rook_stdio";
  arbitraryMcpEnabled: false;
  projectTrusted: boolean;
  skillDirectories: { project: string; global: string };
  mcpConfigPaths: { project: string; global: string };
  skills: CapabilitySkillSummary[];
  mcpServers: CapabilityMcpServerSummary[];
  mcpErrors: string[];
  workspaceProviders: CapabilityWorkspaceProviderSummary[];
  parityInventory: RookParityItem[];
}

export interface SkillInspectResult {
  name: string;
  scope: SkillScope;
  skillFilePath: string;
  digest: string;
  content: string;
  truncated: boolean;
}

export interface McpUpdateParams {
  action: "toggle" | "add" | "remove";
  scope: "global" | "project";
  name: string;
  enabled?: boolean;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  projectTrusted?: boolean;
}

const ROOK_PARITY_INVENTORY: RookParityItem[] = [
  {
    id: "provider-auth",
    feature: "Provider sign-in / sign-out",
    status: "native",
    detail:
      "Managed natively in Rook picker via stdio provider/login and provider/logout.",
  },
  {
    id: "model-selection",
    feature: "Model catalog & selection",
    status: "native",
    detail:
      "Rook-owned catalog and active model selection via model/list and model/select.",
  },
  {
    id: "ask-build-sessions",
    feature: "Ask & Build sessions with OS sandbox",
    status: "native",
    detail:
      "Process-pinned Ask (read-only) and Build (Seatbelt/bwrap sandbox) sessions.",
  },
  {
    id: "skills-inspect",
    feature: "Skills discovery & read-only SKILL.md inspection",
    status: "native",
    detail:
      "Inspects .rook/skills and ~/.rook/skills with precedence and digest provenance without executing skills.",
  },
  {
    id: "skills-manage",
    feature: "Install / remove skills from Git or local path",
    status: "terminal_handoff",
    detail: "Use Rook CLI in Terminal to install or remove skill directories.",
    terminalCommand: "rook skills list",
  },
  {
    id: "mcp-config",
    feature: "MCP server configuration (mcp.json)",
    status: "native",
    detail:
      "Reads and edits Pi/Rook global and trusted project mcp.json files with secret redaction.",
  },
  {
    id: "mcp-runtime",
    feature: "Live MCP tool execution",
    status: "terminal_handoff",
    detail:
      "Blocked in Laplace stdio sessions (arbitraryMcp: false). Open Rook Terminal to connect and authorize MCP calls.",
    terminalCommand: "rook",
  },
  {
    id: "project-memory",
    feature: "Repository memory & context compaction",
    status: "terminal_handoff",
    detail: "Interactive /memory and /compact workflows run in Rook Terminal.",
    terminalCommand: "rook",
  },
  {
    id: "worktrees",
    feature: "Rook CLI worktree commands",
    status: "terminal_handoff",
    detail:
      "Laplace edits directly in the open repository; use Rook Terminal for manual worktrees.",
    terminalCommand: "rook worktree list",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sanitizeUrl(raw: string): {
  valid: boolean;
  display: string;
  error?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      valid: false,
      display: "[invalid URL]",
      error: "Invalid HTTP(S) URL.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      display: `${parsed.protocol}//${parsed.host}`,
      error: "MCP HTTP transport requires an http:// or https:// URL.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      display: `${parsed.protocol}//[redacted]@${parsed.host}${parsed.pathname}`,
      error: "Embedded URL credentials are not allowed in mcp.json.",
    };
  }
  return {
    valid: true,
    display: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
  };
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const prev = index > 0 ? args[index - 1]!.toLowerCase() : "";
    if (
      /(?:token|key|secret|password|auth)/i.test(prev) ||
      /(?:--?(?:token|api-key|secret|password)=|Bearer\s+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,})/i.test(
        arg,
      )
    ) {
      const eq = arg.indexOf("=");
      return eq > 0 ? `${arg.slice(0, eq + 1)}[redacted]` : "[redacted]";
    }
    return arg;
  });
}

function resolveMcpPaths(
  cwd: string,
  agentDir = getAgentDir(),
): {
  global: string;
  project: string;
} {
  return {
    global: join(agentDir, "mcp.json"),
    project: join(cwd, CONFIG_DIR_NAME, "mcp.json"),
  };
}

interface RawServerEntry {
  name: string;
  scope: "global" | "project";
  sourcePath: string;
  overridePath: string | null;
  raw: Record<string, unknown>;
}

function parseMcpFile(
  filePath: string,
  scope: "global" | "project",
  entries: Map<string, RawServerEntry>,
  errors: string[],
): void {
  if (!existsSync(filePath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  } catch (error) {
    errors.push(
      `${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  if (
    !isRecord(parsed) ||
    (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
  ) {
    errors.push(`${filePath}: expected an object with an "mcpServers" object.`);
    return;
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      errors.push(`${filePath}: server "${name}" must be an object.`);
      continue;
    }
    const isOverride =
      scope === "project" &&
      value.command === undefined &&
      value.url === undefined &&
      value.type === undefined;
    if (isOverride) {
      const existing = entries.get(name);
      if (!existing) {
        errors.push(
          `${filePath}: project override "${name}" requires a global server or a command/url.`,
        );
        continue;
      }
      entries.set(name, {
        ...existing,
        overridePath: filePath,
        raw: { ...existing.raw, ...value },
      });
      continue;
    }
    entries.set(name, {
      name,
      scope,
      sourcePath: filePath,
      overridePath: null,
      raw: value,
    });
  }
}

function summarizeMcpEntry(
  entry: RawServerEntry,
  projectTrusted: boolean,
): CapabilityMcpServerSummary {
  const errors: string[] = [];
  const raw = entry.raw;
  const configEnabled = raw.enabled !== false;
  const exposure = typeof raw.exposure === "string" ? raw.exposure : "codemode";
  const redactedHeaders: string[] = [];
  if (isRecord(raw.headers)) {
    for (const key of Object.keys(raw.headers)) {
      redactedHeaders.push(`${key} (redacted)`);
    }
  }
  if (isRecord(raw.env)) {
    for (const key of Object.keys(raw.env)) {
      redactedHeaders.push(`env:${key} (redacted)`);
    }
  }

  let transport: "stdio" | "http" | "invalid" = "invalid";
  let target = "(unconfigured)";
  if (typeof raw.command === "string" && raw.command.trim()) {
    transport = "stdio";
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : [];
    target = [raw.command.trim(), ...redactArgs(args)].join(" ");
  } else if (typeof raw.url === "string" && raw.url.trim()) {
    const checked = sanitizeUrl(raw.url.trim());
    target = checked.display;
    if (checked.valid) {
      transport = "http";
    } else if (checked.error) {
      errors.push(checked.error);
    }
    if (entry.scope === "project" && raw.auth !== undefined) {
      errors.push(
        'Project mcp.json cannot set "auth"; define auth only in global mcp.json.',
      );
    }
  } else {
    errors.push(
      'Server entry must define either a non-empty "command" (stdio) or "url" (http).',
    );
  }

  const configured = errors.length === 0 ? "valid" : "invalid";
  const effectiveEnabled =
    configured === "valid" &&
    configEnabled &&
    (entry.scope === "global" || projectTrusted);

  let connectionStatus: CapabilityMcpServerSummary["connectionStatus"] =
    "blocked_by_stdio_policy";
  let connectionNote =
    "Not connected: Laplace stdio sessions pin arbitraryMcp=false. Use Rook Terminal to connect and invoke MCP tools.";
  if (configured === "invalid") {
    connectionStatus = "invalid_config";
    connectionNote = errors[0] ?? "Configuration is invalid.";
  } else if (entry.scope === "project" && !projectTrusted) {
    connectionStatus = "untrusted_project";
    connectionNote =
      "Project MCP configuration is inactive until this workspace is trusted.";
  } else if (!configEnabled) {
    connectionStatus = "disabled";
    connectionNote = "Disabled in mcp.json.";
  }

  return {
    name: entry.name,
    scope: entry.scope,
    sourcePath: entry.sourcePath,
    overridePath: entry.overridePath,
    transport,
    target,
    configured,
    configEnabled,
    enabled: effectiveEnabled,
    connected: false,
    connectionStatus,
    connectionNote,
    authorizationPolicy: "approval_required",
    authorizationNote:
      "Enabled is not authorized: Rook enforces per-call or session approval before invoking any MCP tool.",
    exposure,
    redactedHeaders,
    errors,
  };
}

export async function collectCapabilitiesSnapshot(
  cwd: string,
  options: { projectTrusted?: boolean; agentDir?: string } = {},
): Promise<CapabilitiesSnapshot> {
  const projectTrusted = Boolean(options.projectTrusted);
  const skillDirectories = getRookSkillDirectories(cwd);
  const mcpConfigPaths = resolveMcpPaths(cwd, options.agentDir);
  const installed = await listInstalledSkills(cwd);
  const seenNames = new Set<string>();
  const skills: CapabilitySkillSummary[] = [];

  for (const skill of installed) {
    const skillFilePath = join(skill.path, "SKILL.md");
    let digest = "";
    try {
      const content = await readFile(skillFilePath, "utf8");
      digest = sha256Hex(content);
    } catch {
      digest = "";
    }
    const precedence: "active" | "shadowed" = seenNames.has(skill.name)
      ? "shadowed"
      : "active";
    seenNames.add(skill.name);
    skills.push({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      precedence,
      baseDir: skill.path,
      skillFilePath,
      digest,
    });
  }

  const entries = new Map<string, RawServerEntry>();
  const mcpErrors: string[] = [];
  parseMcpFile(mcpConfigPaths.global, "global", entries, mcpErrors);
  parseMcpFile(mcpConfigPaths.project, "project", entries, mcpErrors);

  const mcpServers = [...entries.values()]
    .map((entry) => summarizeMcpEntry(entry, projectTrusted))
    .sort((a, b) => a.name.localeCompare(b.name));

  const workspaceProvidersRaw = await loadWorkspaceModelProviders(cwd).catch(
    () => ({}) as Awaited<ReturnType<typeof loadWorkspaceModelProviders>>,
  );
  const workspaceProviders: CapabilityWorkspaceProviderSummary[] =
    Object.entries(workspaceProvidersRaw).map(([id, provider]) => {
      const requiredVars = [
        provider.apiKey,
        ...((provider.models ?? []) as Array<{ apiKey?: string }>).map(
          (m) => m.apiKey,
        ),
      ]
        .filter((key): key is string => Boolean(key?.startsWith("$")))
        .map((key) => key.slice(1));
      const missingEnvironmentVariables = [...new Set(requiredVars)].filter(
        (name) => !process.env[name],
      );
      return {
        id,
        endpoint: provider.baseUrl ?? null,
        endpointFingerprint: workspaceEndpointFingerprint(provider),
        missingEnvironmentVariables,
        source: "workspace",
      };
    });

  return {
    runtimeSource: "rook_stdio",
    arbitraryMcpEnabled: false,
    projectTrusted,
    skillDirectories,
    mcpConfigPaths,
    skills,
    mcpServers,
    mcpErrors,
    workspaceProviders,
    parityInventory: ROOK_PARITY_INVENTORY,
  };
}

export async function inspectInstalledSkill(
  cwd: string,
  name: string,
  scope: SkillScope,
): Promise<SkillInspectResult> {
  const directories = Object.values(getRookSkillDirectories(cwd));
  const installed = await listInstalledSkills(cwd);
  const match = installed.find(
    (skill) => skill.name === name && skill.scope === scope,
  );
  if (!match) {
    throw new Error(`No ${scope} skill named "${name}" was found.`);
  }
  const skillFilePath = join(match.path, "SKILL.md");
  if (!isWithinRookSkillDirectories(skillFilePath, directories)) {
    throw new Error(
      "Refusing to read skill instructions outside Rook's managed skill directories.",
    );
  }
  const raw = await readFile(skillFilePath);
  const truncated = raw.byteLength > MAX_SKILL_INSPECT_BYTES;
  const content = (
    truncated ? raw.subarray(0, MAX_SKILL_INSPECT_BYTES) : raw
  ).toString("utf8");
  return {
    name: match.name,
    scope: match.scope,
    skillFilePath,
    digest: sha256Hex(raw.toString("utf8")),
    content,
    truncated,
  };
}

function editMcpFile(
  filePath: string,
  mutate: (servers: Record<string, Record<string, unknown>>) => void,
): void {
  const existingText = existsSync(filePath)
    ? stripBom(readFileSync(filePath, "utf8"))
    : undefined;
  let parsed: Record<string, unknown> = {};
  if (existingText !== undefined) {
    const raw = JSON.parse(existingText) as unknown;
    if (
      !isRecord(raw) ||
      (raw.mcpServers !== undefined && !isRecord(raw.mcpServers))
    ) {
      throw new Error(
        `${filePath}: expected an object with an "mcpServers" object.`,
      );
    }
    parsed = raw;
  }
  const servers: Record<string, Record<string, unknown>> = {};
  if (isRecord(parsed.mcpServers)) {
    for (const [k, v] of Object.entries(parsed.mcpServers)) {
      if (isRecord(v)) servers[k] = { ...v };
    }
  }
  mutate(servers);
  parsed.mcpServers = servers;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function applyMcpConfigUpdate(
  cwd: string,
  params: McpUpdateParams,
  options: { agentDir?: string } = {},
): Promise<CapabilitiesSnapshot> {
  if (!SERVER_NAME_PATTERN.test(params.name)) {
    throw new Error(
      "MCP server name must start with a letter/digit and contain only letters, digits, dots, underscores, or hyphens.",
    );
  }
  if (params.scope === "project" && !params.projectTrusted) {
    throw new Error(
      "Trust this workspace before modifying project MCP configuration.",
    );
  }
  const paths = resolveMcpPaths(cwd, options.agentDir);
  const targetPath = params.scope === "project" ? paths.project : paths.global;

  if (params.action === "toggle") {
    if (typeof params.enabled !== "boolean") {
      throw new Error("enabled boolean is required for toggle.");
    }
    editMcpFile(targetPath, (servers) => {
      const current = servers[params.name];
      if (!current) {
        if (params.scope === "project") {
          servers[params.name] = { enabled: params.enabled };
          return;
        }
        throw new Error(
          `MCP server "${params.name}" was not found in ${targetPath}.`,
        );
      }
      if (params.enabled) {
        delete current.enabled;
      } else {
        current.enabled = false;
      }
    });
  } else if (params.action === "add") {
    if (params.transport === "stdio") {
      const command = params.command?.trim();
      if (!command)
        throw new Error("Command is required for stdio MCP servers.");
      const args = (params.args ?? []).map((a) => a.trim()).filter(Boolean);
      editMcpFile(targetPath, (servers) => {
        servers[params.name] = {
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(params.enabled === false ? { enabled: false } : {}),
        };
      });
    } else if (params.transport === "http") {
      const url = params.url?.trim();
      if (!url) throw new Error("URL is required for HTTP MCP servers.");
      const checked = sanitizeUrl(url);
      if (!checked.valid) {
        throw new Error(checked.error ?? "Invalid MCP server URL.");
      }
      editMcpFile(targetPath, (servers) => {
        servers[params.name] = {
          url,
          ...(params.enabled === false ? { enabled: false } : {}),
        };
      });
    } else {
      throw new Error('transport must be "stdio" or "http".');
    }
  } else if (params.action === "remove") {
    if (!existsSync(targetPath)) {
      throw new Error(`No MCP config file exists at ${targetPath}.`);
    }
    editMcpFile(targetPath, (servers) => {
      if (!(params.name in servers)) {
        throw new Error(
          `MCP server "${params.name}" was not found in ${targetPath}.`,
        );
      }
      delete servers[params.name];
    });
  } else {
    throw new Error("Unsupported MCP update action.");
  }

  return collectCapabilitiesSnapshot(cwd, {
    projectTrusted: Boolean(params.projectTrusted),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  });
}
