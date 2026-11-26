import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripTerminalSequences,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import type {
  AgentEvent,
  AgentGateway,
  AgentResource,
  ExternalAccessChoice,
  ExternalAccessGrant,
  ExternalAccessRequest,
  ForkPoint,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  SessionPermissionGrant,
  ProviderAuthInteraction,
  ProviderAuthType,
  ProviderInfo,
  SessionInfo,
  SessionMessage,
  SessionContextUsage,
  ThinkingInfo,
} from "../../src/pi/agent-gateway.js";
import type { SubagentProfile } from "../../src/pi/subagents.js";
import type {
  GitSnapshot,
  RepositoryIdentity,
} from "../../src/repo/workspace.js";
import { RookStore } from "../../src/db/store.js";
import { MemoryCaptureManager } from "../../src/memory/capture.js";
import { createRookTui } from "../../src/tui/rook-tui.js";

class EventGateway implements AgentGateway {
  isRunning(): boolean {
    return this.finishPendingRun !== undefined;
  }
  private handlers = new Set<(event: AgentEvent) => void>();
  private sessionId = "session-12345678";
  private mode: PermissionMode = "plan";
  externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined = undefined;
  externalGrants: ExternalAccessGrant[] = [];
  sessionPermissionGrants: SessionPermissionGrant[] = [];
  queuedMessages: { text: string; disposition: string }[] = [];
  sentPrompts: string[] = [];
  reviewCalls = 0;
  reviewOptions: Parameters<AgentGateway["reviewGitChanges"]>[0][] = [];
  exploreCalls: string[] = [];
  architectCalls: string[] = [];
  subagentCalls: { name: string; task: string }[] = [];
  subagents: SubagentProfile[] = [
    {
      name: "api-reviewer",
      description: "Review API changes",
      instructions: "Check compatibility.",
      tools: ["read"],
    },
  ];
  models: ModelInfo[] = [
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    {
      provider: "anthropic",
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
    },
  ];
  selectedModel: ModelInfo | undefined;
  selectedThinkingLevel: string | undefined;
  providers: ProviderInfo[] = [];
  receivedLoginSecret: string | undefined;
  failLoginWithCredential = false;
  verificationUri = "https://login.example.test/device";
  loggedOutProviders: string[] = [];
  modeHistory: PermissionMode[] = [];
  plythModeChanges: ("off" | "integrated")[] = [];
  forkedEntry?: string;
  compactedInstructions: string | undefined = undefined;
  contextUsage: SessionContextUsage | undefined = {
    tokens: 1_024,
    contextWindow: 128_000,
    percent: 0.8,
  };
  private finishPendingRun: (() => void) | undefined = undefined;

  async send(
    prompt: string,
    disposition: "normal" | "steer" | "follow_up" = "normal",
  ): Promise<void> {
    if (disposition !== "normal") {
      this.queuedMessages.push({ text: prompt, disposition });
      return;
    }
    this.sentPrompts.push(prompt);
    if (prompt === "long running prompt") {
      await new Promise<void>((resolve) => {
        this.finishPendingRun = resolve;
      });
      this.emit({ type: "text_delta", text: "working" });
      this.emit({ type: "message_complete", text: "finished" });
      this.emit({ type: "run_settled", aborted: false });
      return;
    }
    this.emit({ type: "text_delta", text: "draft answer" });
    this.emit({
      type: "tool_started",
      id: "read-1",
      name: "read",
      summary: "package.json",
    });
    this.emit({ type: "tool_finished", id: "read-1", status: "ok" });
    this.emit({ type: "message_complete", text: "final answer" });
    this.emit({ type: "usage", inputTokens: 8, outputTokens: 3 });
    this.emit({ type: "run_settled", aborted: false });
  }

  async cancel(): Promise<void> {}

  async inspectGitChanges(): Promise<string> {
    return "Git status\n M src/example.ts\n\nDiff vs HEAD\n+change";
  }

  async reviewGitChanges(
    options?: Parameters<AgentGateway["reviewGitChanges"]>[0],
  ): Promise<string> {
    this.reviewCalls += 1;
    this.reviewOptions.push(options);
    return "No actionable findings.";
  }

  async exploreReadOnly(task: string): Promise<string> {
    this.exploreCalls.push(task);
    return "The entry point is src/index.ts.";
  }

  async architectReadOnly(task: string): Promise<string> {
    this.architectCalls.push(task);
    return "Proposal: update src/index.ts, then run focused tests.";
  }

  listSubagents(): SubagentProfile[] {
    return this.subagents;
  }

  async runSubagent(name: string, task: string): Promise<string> {
    this.subagentCalls.push({ name, task });
    return "API contract remains compatible.";
  }

  async listRepositoryInstructions(): Promise<string[]> {
    return ["AGENTS.md", "src/AGENTS.md"];
  }

  getUndoPreview(): string {
    return "Rook can restore its last file edit: src/example.ts. Use /undo confirm.";
  }

  async undoLastFileChange(): Promise<string> {
    return "Restored Rook's last edit to src/example.ts.";
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  currentModel(): ModelInfo | undefined {
    return this.selectedModel;
  }

  async selectModel(model: ModelInfo): Promise<void> {
    this.selectedModel = model;
  }

  listProviders(): ProviderInfo[] {
    return this.providers;
  }

  async login(
    providerId: string,
    authType: ProviderAuthType,
    interaction: ProviderAuthInteraction,
  ): Promise<void> {
    if (!this.providers.some((provider) => provider.id === providerId))
      throw new Error("Unknown fake provider.");
    if (authType === "oauth") {
      interaction.notify({
        type: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: this.verificationUri,
      });
    }
    this.receivedLoginSecret = await interaction.prompt({
      type: "secret",
      message: "Provider credential",
      signal: interaction.signal,
    });
    if (this.failLoginWithCredential)
      throw new Error(
        `Provider rejected credential ${this.receivedLoginSecret}`,
      );
  }

  async logout(providerId: string): Promise<void> {
    this.loggedOutProviders.push(providerId);
  }

  getThinkingInfo(): ThinkingInfo {
    return { current: "medium", available: ["low", "medium", "high"] };
  }

  setThinkingLevel(level: string): void {
    this.selectedThinkingLevel = level;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  currentSession() {
    return { id: this.sessionId };
  }

  sessionHistory(): SessionMessage[] {
    return [];
  }

  listSkills(): AgentResource[] {
    return [{ name: "review", description: "Review source changes" }];
  }

  listPromptTemplates(): AgentResource[] {
    return [{ name: "explain", description: "Explain a design" }];
  }

  isResourceCommand(prompt: string): boolean {
    return prompt.startsWith("/skill:review") || prompt.startsWith("/explain");
  }

  listForkPoints(): ForkPoint[] {
    return [{ entryId: "entry-user-1", text: "start from here" }];
  }

  async fork(entryId: string): Promise<void> {
    this.forkedEntry = entryId;
  }

  async compact(
    customInstructions?: string,
  ): Promise<{ tokensBefore: number; estimatedTokensAfter: number }> {
    this.compactedInstructions = customInstructions;
    this.contextUsage = { tokens: 512, contextWindow: 128_000, percent: 0.4 };
    return { tokensBefore: 1_024, estimatedTokensAfter: 512 };
  }

  getContextUsage(): SessionContextUsage | undefined {
    return this.contextUsage;
  }

  completePendingRun(): void {
    this.finishPendingRun?.();
    this.finishPendingRun = undefined;
  }

  updateChecklist(
    tasks: Extract<AgentEvent, { type: "todo_updated" }>["tasks"],
  ): void {
    this.emit({ type: "todo_updated", tasks });
  }

  async newSession(): Promise<void> {
    this.sessionId = "session-87654321";
    this.contextUsage = { tokens: 0, contextWindow: 128_000, percent: 0 };
  }

  async resumeSession(): Promise<void> {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.modeHistory.push(mode);
  }

  controlPlythTrace(
    _action: "status" | "on" | "off" | "export" | "clear",
  ): string {
    return "PLYTH traces off";
  }

  async setPlythIntegratedMode(mode: "off" | "integrated"): Promise<string> {
    this.plythModeChanges.push(mode);
    return `PLYTH ${mode} saved; restart Rook to apply.`;
  }

  getPlythStats(): ReturnType<AgentGateway["getPlythStats"]> {
    return {
      eligibleCommands: 0,
      predictedCommands: 0,
      invalidPredictions: 0,
      specificPredictions: 0,
      durationMs: 0,
      durationSamples: 0,
      verdicts: { hit: 0, miss: 0, vague: 0, none: 0, unscorable: 0 },
    };
  }

  getPermissionDecisions(): PermissionDecision[] {
    return [];
  }

  setExternalAccessPrompt(
    handler:
      | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
      | undefined,
  ): void {
    this.externalAccessPrompt = handler;
  }

  getExternalAccessGrants(): ExternalAccessGrant[] {
    return this.externalGrants;
  }

  getSessionPermissionGrants(): SessionPermissionGrant[] {
    return this.sessionPermissionGrants;
  }

  revokeExternalAccessGrant(id: string): boolean {
    const previous = this.externalGrants.length;
    this.externalGrants = this.externalGrants.filter(
      (grant) => grant.id !== id,
    );
    if (previous !== this.externalGrants.length) return true;
    const sessionPrevious = this.sessionPermissionGrants.length;
    this.sessionPermissionGrants = this.sessionPermissionGrants.filter(
      (grant) => grant.id !== id,
    );
    return sessionPrevious !== this.sessionPermissionGrants.length;
  }

  getActiveTools(): string[] {
    return this.mode === "build" ? ["read", "edit", "write", "bash"] : ["read"];
  }

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 36;
  kittyProtocolActive = false;
  started = 0;
  stopped = 0;
  writes: string[] = [];
  private onInput?: (data: string) => void;
  private onResize?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started += 1;
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop(): void {
    this.stopped += 1;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgramStatus(): void {}
  setProgress(): void {}

  input(data: string): void {
    this.onInput?.(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
}

describe("Rook TUI shell", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows exact host permission scopes and only offers remembered approval when allowed", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    await app.submit("/build");
    const request: ExternalAccessRequest = {
      toolName: "bash",
      path: "/workspace/sample-project",
      folderPath: "/workspace/sample-project",
      access: "execute",
      command: "npm test",
      timeoutSeconds: 120,
      sandboxed: false,
      permissionResources: [{ action: "shell", resource: "npm test" }],
      rememberAllowed: true,
    };
    const pending = gateway.externalAccessPrompt!(request);
    app.tui.renderNow(true);
    app.tui.renderNow(true);
    const screen = app.tui.render(120).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("NOT sandboxed");
    expect(screen).toContain('Approval scope: shell "npm test"');
    expect(screen).toContain("Remember these exact resources for this project");
    terminal.input("4");
    expect(await pending).toBe("always");
    const dynamic = gateway.externalAccessPrompt!({
      ...request,
      rememberAllowed: false,
    });
    app.tui.renderNow(true);
    const dynamicScreen = app.tui
      .render(120)
      .map(stripTerminalSequences)
      .join("\n");
    expect(dynamicScreen).not.toContain("Remember these exact resources");
    terminal.input("2");
    expect(await dynamic).toBe("once");
    app.stop();
    await finished;
  });

  it("shows shell review details, defaults to deny, and offers exact-command session approval", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    await app.submit("/build");
    const request: ExternalAccessRequest = {
      toolName: "bash",
      path: "/workspace/sample-project",
      folderPath: "/workspace/sample-project",
      access: "execute",
      command: "node --version",
      timeoutSeconds: 120,
      sandboxed: true,
      reason: "Command needs review.",
    };
    const denied = gateway.externalAccessPrompt!(request);
    app.tui.renderNow(true);
    app.tui.renderNow(true);
    const screen = app.tui.render(120).map(stripTerminalSequences).join("\n");
    expect(screen).toContain('Command: "node --version"');
    expect(screen).toContain("Why approval: Command needs review.");
    expect(screen).toContain("workspace and temporary directory");
    expect(screen).toContain("Timeout: 120s");
    expect(screen).toContain("[Deny]");
    expect(screen).toContain("Allow this command for this session");
    terminal.input("\r");
    expect(await denied).toBe("deny");
    const approved = gateway.externalAccessPrompt!(request);
    terminal.input("\x1b[B");
    terminal.input("\r");
    expect(await approved).toBe("once");
    const oversized = gateway.externalAccessPrompt!({
      ...request,
      command: "echo " + "x".repeat(4000),
    });
    app.tui.renderNow(true);
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).toContain("cannot be fully reviewed");
    terminal.input("2");
    terminal.input("\x1b");
    expect(await oversized).toBe("deny");
    const cancelled = gateway.externalAccessPrompt!(request);
    terminal.input("\u0003");
    expect(await cancelled).toBe("deny");
    app.stop();
    await finished;
  });

  it("lists and revokes exact-command and per-tool session grants", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.sessionPermissionGrants = [
      {
        id: "shell-grant",
        type: "shell",
        description: "node custom-script",
        identity: "/workspace/sample-project\0sandboxed\0node custom-script",
        sourceName: "bash",
        workspace: "/workspace/sample-project",
      },
      {
        id: "tool-grant",
        type: "tool",
        description: "mcp__docs__search",
        identity: "mcp__docs__search",
        sourceName: "docs",
      },
    ];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    await app.submit("/build");
    await app.submit("/permissions");
    app.tui.renderNow(true);
    const screen = app.tui.render(120).map(stripTerminalSequences).join("\n");
    expect(screen).toContain('SHELL "node custom-script"');
    expect(screen).toContain("TOOL mcp__docs__search from docs");
    expect(screen).toContain("/permissions revoke shell-grant");
    expect(screen).toContain("/permissions revoke tool-grant");
    await app.submit("/permissions revoke shell-grant");
    expect(gateway.sessionPermissionGrants.map((grant) => grant.id)).toEqual([
      "tool-grant",
    ]);
    app.stop();
    await finished;
  });

  it("shows bounded unclassified-tool details and defaults to deny", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const request = gateway.externalAccessPrompt!({
      toolName: "plugin__publish",
      sourceName: "plugin",
      access: "tool",
      inputSummary: '{"destination":"preview"}',
      reason: "Unclassified tool requires review.",
    });
    app.tui.renderNow(true);
    const screen = app.tui.render(120).join("\n");
    expect(screen).toContain("Unclassified tool call · plugin");
    expect(screen).toContain("plugin__publish");
    expect(screen).toContain('Arguments: {"destination":"preview"}');
    expect(screen).toContain(
      "Why approval: Unclassified tool requires review.",
    );
    expect(screen).toContain("[Deny tool call]");
    terminal.input("\r");
    await expect(request).resolves.toBe("deny");
    app.stop();
    await finished;
  });

  it("signs in from the TUI without echoing credentials into the transcript", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        authMethods: [
          { type: "oauth", name: "Claude Pro/Max", isSubscription: true },
        ],
      },
    ];
    const openedUrls: string[] = [];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
      openBrowser: async (url) => {
        openedUrls.push(url);
      },
    });
    const finished = app.start();
    await app.submit("/login");
    terminal.input("\r");
    app.tui.renderNow(true);
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).toContain("WXYZ-1234");
    expect(openedUrls).toEqual(["https://login.example.test/device"]);

    const credential = "sk-test-credential-not-for-display";
    for (const character of credential) terminal.input(character);
    app.tui.renderNow(true);
    const screenWhileTyping = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screenWhileTyping).not.toContain(credential);
    expect(screenWhileTyping).toContain("•");

    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    expect(gateway.receivedLoginSecret).toBe(credential);
    const screenAfterLogin = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screenAfterLogin).toContain("Choose a model · Anthropic");
    expect(screenAfterLogin).toContain("Claude Sonnet 4");
    expect(screenAfterLogin).not.toContain("GPT-4.1");
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.selectedModel).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
    });
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).not.toContain(credential);
    expect(terminal.writes.join("")).not.toContain(credential);
    expect(terminal.writes.join("")).toContain("Signed in to Anthropic.");

    gateway.failLoginWithCredential = true;
    await app.submit("/login");
    terminal.input("\r");
    for (const character of credential) terminal.input(character);
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).not.toContain(credential);
    expect(terminal.writes.join("")).not.toContain(credential);
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).toContain("[redacted]");

    gateway.failLoginWithCredential = false;
    gateway.receivedLoginSecret = undefined;
    await app.submit("/login");
    terminal.input("\r");
    terminal.input("\u0003");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    expect(gateway.receivedLoginSecret).toBeUndefined();
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).toContain("cancelled");
    app.stop();
    await finished;
  });

  it("preserves the active model when dismissing post-login model selection", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.selectedModel = {
      provider: "openai",
      id: "gpt-4.1",
      name: "GPT-4.1",
    };
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        authMethods: [{ type: "oauth", name: "Claude login" }],
      },
    ];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
      openBrowser: async () => {},
    });
    const finished = app.start();
    await app.submit("/login");
    terminal.input("\r");
    for (const character of "temporary credential") terminal.input(character);
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    const screen = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screen).toContain("Choose a model · Anthropic");
    expect(screen).toContain("Claude Sonnet 4");
    expect(screen).not.toContain("openai/");
    terminal.input("\u001b");
    expect(gateway.selectedModel).toEqual({
      provider: "openai",
      id: "gpt-4.1",
      name: "GPT-4.1",
    });
    app.stop();
    await finished;
  });

  it("reports when a successful login has no selectable models for that provider", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.models = [];
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        authMethods: [{ type: "oauth", name: "Claude login" }],
      },
    ];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
      openBrowser: async () => {},
    });
    const finished = app.start();
    await app.submit("/login");
    terminal.input("\r");
    for (const character of "temporary credential") terminal.input(character);
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    const screen = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screen).toContain(
      "Signed in, but Pi has no available models for Anthropic",
    );
    expect(screen).not.toContain("Choose a model · Anthropic");
    app.stop();
    await finished;
  });

  it("filters provider login methods and logout choices by searchable text", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: true,
        authMethods: [
          { type: "oauth", name: "Claude Pro/Max", isSubscription: true },
          { type: "api_key", name: "Anthropic API key" },
        ],
      },
      {
        id: "openai",
        name: "OpenAI",
        configured: true,
        authMethods: [
          { type: "oauth", name: "ChatGPT subscription", isSubscription: true },
        ],
      },
    ];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const screen = (): string => {
      app.tui.renderNow(true);
      return app.tui.getScreenLines().map(stripTerminalSequences).join("\n");
    };

    await app.submit("/login");
    expect(screen()).toContain("Search by provider or sign-in method");
    for (const character of "claude") terminal.input(character);
    expect(screen()).toContain("Anthropic · Claude Pro/Max");
    expect(screen()).not.toContain("OpenAI · ChatGPT subscription");
    terminal.input("\u001b");

    await app.submit("/logout");
    expect(screen()).toContain("Search by provider name or ID");
    for (const character of "openai") terminal.input(character);
    expect(screen()).toContain("OpenAI");
    expect(screen()).not.toContain("Anthropic · configured in Pi");
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.loggedOutProviders).toEqual(["openai"]);

    app.stop();
    await finished;
  });

  it("does not open unsafe OAuth URLs and keeps a manual fallback", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.verificationUri = "javascript:alert(1)";
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        authMethods: [{ type: "oauth", name: "Claude login" }],
      },
    ];
    const openedUrls: string[] = [];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
      openBrowser: async (url) => {
        openedUrls.push(url);
      },
    });
    const finished = app.start();
    await app.submit("/login");
    terminal.input("\r");
    app.tui.renderNow(true);
    const screen = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(openedUrls).toEqual([]);
    expect(screen).toContain("javascript:alert(1)");
    expect(screen).toContain("Browser not opened");
    terminal.input("\u0003");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.stop();
    await finished;
  });

  it("keeps the OAuth link visible when the system browser cannot launch", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: false,
        authMethods: [{ type: "oauth", name: "Claude login" }],
      },
    ];
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
      openBrowser: async () => {
        throw new Error("launcher unavailable");
      },
    });
    const finished = app.start();
    await app.submit("/login");
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.tui.renderNow(true);
    const screen = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screen).toContain("https://login.example.test/device");
    expect(screen).toContain("Could not open a browser");
    terminal.input("\u0003");
    await new Promise<void>((resolve) => setImmediate(resolve));
    app.stop();
    await finished;
  });

  it("places per-prompt token totals, rate, and elapsed time below the final result", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    vi.spyOn(gateway, "send").mockImplementation(async (prompt) => {
      if (prompt === "first") {
        gateway.emit({
          type: "message_complete",
          text: "Checking the project.",
        });
        gateway.emit({ type: "usage", inputTokens: 100, outputTokens: 20 });
        gateway.emit({
          type: "tool_started",
          id: "read-stats",
          name: "read",
          summary: "package.json",
        });
        now = 6000;
        gateway.emit({ type: "tool_finished", id: "read-stats", status: "ok" });
        gateway.emit({ type: "message_complete", text: "First result." });
        gateway.emit({ type: "usage", inputTokens: 300, outputTokens: 80 });
        now = 11000;
      } else {
        gateway.emit({ type: "message_complete", text: "Second result." });
        gateway.emit({ type: "usage", inputTokens: 10, outputTokens: 0 });
        now += 5000;
      }
      gateway.emit({ type: "run_settled", aborted: false });
      now += 10000; // Promise cleanup must not extend the measured inference time.
    });
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    await app.submit("first");
    let lines = app.tui.render(100).map(stripTerminalSequences);
    const resultRow = lines.findIndex((line) => line.includes("First result."));
    const statsRow = lines.findIndex((line) =>
      line.includes("in 400 · out 100 · 10.0 tok/s · 10.0s elapsed"),
    );
    expect(statsRow).toBeGreaterThan(resultRow);
    expect(resultRow).toBeGreaterThanOrEqual(0);
    expect(
      lines.slice(resultRow + 1, statsRow).every((line) => !line.trim()),
    ).toBe(true);
    expect(lines.filter((line) => line.includes("s elapsed"))).toHaveLength(1);
    await app.submit("second");
    lines = app.tui.render(100).map(stripTerminalSequences);
    expect(lines.filter((line) => line.includes("s elapsed"))).toHaveLength(2);
    expect(lines.join("\n")).toContain(
      "in 10 · out 0 · 0.0 tok/s · 5.0s elapsed",
    );
    app.stop();
    await finished;
  });

  it("waits until the whole run finishes instead of showing stats after an intermediate turn", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const pending = app.submit("long running prompt");
    gateway.emit({ type: "message_complete", text: "An intermediate turn." });
    gateway.emit({ type: "usage", inputTokens: 30, outputTokens: 10 });
    expect(app.tui.render(100).join("\n")).not.toContain("s elapsed");
    now = 3500;
    gateway.completePendingRun();
    await pending;
    const lines = app.tui.render(100).map(stripTerminalSequences);
    expect(lines.join("\n")).toContain(
      "in 30 · out 10 · 4.0 tok/s · 2.5s elapsed",
    );
    expect(lines.filter((line) => line.includes("s elapsed"))).toHaveLength(1);
    const next = app.submit("long running prompt");
    now = 6000;
    gateway.completePendingRun();
    await next;
    expect(
      app.tui.render(100).map(stripTerminalSequences).join("\n"),
    ).toContain("in — · out — · — tok/s · 2.5s elapsed");
    app.stop();
    await finished;
  });

  it.each(["settled", "returned", "failed", "cancelled"])(
    "adds one stats line without stale usage when a run is %s",
    async (outcome) => {
      let now = 1000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const terminal = new FakeTerminal();
      const gateway = new EventGateway();
      vi.spyOn(gateway, "send").mockImplementation(async () => {
        now += 2000;
        if (outcome === "failed") {
          gateway.emit({ type: "error", message: "Request failed." });
          throw new Error("Request failed.");
        }
        gateway.emit({
          type: "message_complete",
          text: "An inference result.",
        });
        if (outcome !== "returned") {
          gateway.emit({
            type: "run_settled",
            aborted: outcome === "cancelled",
          });
        }
      });
      const app = createRookTui({
        cwd: "/workspace/sample-project",
        gateway,
        terminal,
      });
      const finished = app.start();
      await app.submit("/help");
      expect(app.tui.render(100).join("\n")).not.toContain("s elapsed");
      await app.submit("hello");
      const lines = app.tui.render(100).map(stripTerminalSequences);
      expect(lines.filter((line) => line.includes("s elapsed"))).toHaveLength(
        1,
      );
      expect(lines.join("\n")).toContain(
        "in — · out — · — tok/s · 2.0s elapsed",
      );
      expect(lines.join("\n")).not.toMatch(/NaN|Infinity/);
      app.stop();
      await finished;
    },
  );

  it("shows PLYTH observe-only counts without running an inference", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    vi.spyOn(gateway, "getPlythStats").mockReturnValue({
      eligibleCommands: 4,
      predictedCommands: 3,
      invalidPredictions: 1,
      specificPredictions: 2,
      durationMs: 1500,
      durationSamples: 2,
      verdicts: { hit: 1, miss: 1, vague: 1, none: 1, unscorable: 0 },
    });
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const sentBefore = gateway.sentPrompts.length;
    await app.submit("/plyth");
    const screen = app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain(
      "PLYTH observe-only · eligible 4 · predicted 3 · invalid 1",
    );
    expect(screen).toContain(
      "hit 1 · miss 1 · vague 1 · none 1 · unscorable 0",
    );
    expect(screen).toContain("command time 1500ms across 2 commands");
    expect(gateway.sentPrompts).toHaveLength(sentBefore);
    app.stop();
    await finished;
  });

  it("shows PLYTH status, routes enable/disable and trace controls without inference", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const stats = gateway.getPlythStats();
    vi.spyOn(gateway, "getPlythStats").mockReturnValue({
      ...stats,
      baseline: {
        comparisons: 2,
        agentCorrect: 1,
        baselineCorrect: 2,
        unavailable: 3,
        invalidations: 1,
      },
    });
    const trace = vi
      .spyOn(gateway, "controlPlythTrace")
      .mockReturnValue("PLYTH traces on");
    const setPlythMode = vi.spyOn(gateway, "setPlythIntegratedMode");
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const before = gateway.sentPrompts.length;
    await app.submit("/plyth");
    let screen = app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("agent 1/2 · history 2/2");
    await app.submit("/plyth enable");
    expect(setPlythMode).toHaveBeenLastCalledWith("integrated");
    await app.submit("/plyth disable");
    expect(setPlythMode).toHaveBeenLastCalledWith("off");
    await app.submit("/plyth enable prompt");
    screen = app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("Usage: /plyth");
    for (const action of ["status", "on", "off", "export", "clear"]) {
      await app.submit(`/plyth trace ${action}`);
      expect(trace).toHaveBeenLastCalledWith(action);
    }
    await app.submit("/plyth trace typo");
    screen = app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("Usage: /plyth");
    expect(trace).toHaveBeenCalledTimes(5);
    expect(setPlythMode).toHaveBeenCalledTimes(2);
    expect(gateway.sentPrompts).toHaveLength(before);
    app.stop();
    await finished;
  });

  it("shows repository status and diff through /diff without prompting the model", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/diff");

    const screen = app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("Git status");
    expect(screen).toContain("src/example.ts");
    expect(screen).toContain("Diff vs HEAD");
    expect(gateway.sentPrompts).toEqual([]);

    terminal.input("\u0003");
    await finished;
  });

  it("runs /ask as a read-only one-turn question and restores build mode", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/build");
    await app.submit("/ask Where is the main entry point?");

    expect(gateway.sentPrompts).toEqual(["Where is the main entry point?"]);
    expect(gateway.modeHistory.slice(-2)).toEqual(["plan", "build"]);

    terminal.input("\u0003");
    await finished;
  });

  it("runs /review through the separate read-only review path", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/build");
    await app.submit("/review");

    const screen = app.tui
      .render(100)
      .map(stripTerminalSequences)
      .join(" ")
      .replace(/\s+/g, " ");
    expect(gateway.reviewCalls).toBe(1);
    expect(gateway.sentPrompts).toEqual([]);
    expect(gateway.modeHistory.at(-1)).toBe("build");
    expect(screen).toContain("No actionable findings.");

    terminal.input("\u0003");
    await finished;
  });

  it("offers the opt-in PLYTH simplicity review without changing modes", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/build");
    await app.submit("/review simplicity");

    expect(gateway.reviewOptions).toEqual([{ focus: "simplicity" }]);
    expect(gateway.modeHistory.at(-1)).toBe("build");

    terminal.input("\u0003");
    await finished;
  });

  it("runs /explore in fresh read-only context without submitting to the main session", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/explore Find the request entry point");

    expect(gateway.exploreCalls).toEqual(["Find the request entry point"]);
    expect(gateway.sentPrompts).toEqual([]);
    expect(gateway.modeHistory).toEqual([]);

    terminal.input("\u0003");
    await finished;
  });

  it("lists applicable project instruction files", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/instructions");
    app.tui.renderNow(true);

    const screen = app.tui
      .getScreenLines()
      .map(stripTerminalSequences)
      .join("\n");
    expect(screen).toContain("AGENTS.md");
    expect(screen).toContain("src/AGENTS.md");

    terminal.input("\u0003");
    await finished;
  });

  it("runs /architect as an explicit read-only proposal without editing or submitting", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/architect Add request validation");

    expect(gateway.architectCalls).toEqual(["Add request validation"]);
    expect(gateway.sentPrompts).toEqual([]);
    expect(gateway.modeHistory).toEqual([]);

    terminal.input("\u0003");
    await finished;
  });

  it("lists and runs configured read-only subagents", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/agents");
    expect(app.tui.render(100).map(stripTerminalSequences).join(" ")).toContain(
      "api-reviewer",
    );
    await app.submit("/agents api-reviewer Check the contract");

    expect(gateway.subagentCalls).toEqual([
      { name: "api-reviewer", task: "Check the contract" },
    ]);
    expect(gateway.sentPrompts).toEqual([]);

    terminal.input("\u0003");
    await finished;
  });

  it("requires the explicit /undo confirm command to recover a Rook edit", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/undo");
    expect(
      app.tui
        .render(100)
        .map(stripTerminalSequences)
        .join(" ")
        .replace(/\s+/g, " "),
    ).toContain("Use /undo confirm");
    await app.submit("/undo confirm");
    expect(
      app.tui
        .render(100)
        .map(stripTerminalSequences)
        .join(" ")
        .replace(/\s+/g, " "),
    ).toContain("Restored Rook's last edit");
    expect(gateway.sentPrompts).toEqual([]);

    terminal.input("\u0003");
    await finished;
  });

  it("shares screen gutters across the header, home, transcript, prompt, and footer", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const screen = (): string[] => {
      app.tui.renderNow(true);
      return app.tui.getScreenLines().map(stripTerminalSequences);
    };
    const expectGutters = (lines: string[]): void => {
      expect(
        lines.every(
          (line) =>
            !line.trim() || (line.startsWith("  ") && line.endsWith("  ")),
        ),
      ).toBe(true);
      expect(
        lines.every((line) => visibleWidth(line) <= terminal.columns),
      ).toBe(true);
    };
    let lines = screen();
    expectGutters(lines);
    expect(lines[0]).toMatch(/^  rook/);
    expect(lines.find((line) => line.includes("╭─"))).toMatch(/^  ╭─+╮  $/);
    expect(lines.some((line) => line.includes("Rook v0.1.0"))).toBe(true);
    expect(lines.some((line) => line.includes("/ Commands"))).toBe(true);
    expect(lines.some((line) => line.includes("@ Files"))).toBe(true);
    expect(lines.some((line) => line.includes("# Context"))).toBe(true);
    await app.submit("hello");
    for (const width of [100, 70, 30, 8]) {
      terminal.resize(width, 36);
      lines = screen();
      expectGutters(lines);
    }
    for (const width of [4, 1]) {
      terminal.resize(width, 36);
      expect(screen().every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    terminal.input("\u0003");
    await finished;
  });

  it("keeps prompt mouse placement correct inside shared screen gutters", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    for (const character of "hello") terminal.input(character);
    app.tui.renderNow(true);
    const lines = app.tui.getScreenLines().map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes("rook > hello"));
    const x = lines[y]!.indexOf("hello") + 2;
    terminal.input(`\x1b[<0;${x + 1};${y + 1}M`);
    terminal.input(`\x1b[<0;${x + 1};${y + 1}m`);
    terminal.input("!");
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.sentPrompts).toEqual(["he!llo"]);
    terminal.input("\u0003");
    await finished;
  });

  it("renders the framed left-hand prompt and submits only editable text", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    for (const character of "hello") terminal.input(character);
    let lines = app.tui.render(100);
    const row = lines.findIndex((line) => line.includes("\u001b_pi:c"));
    expect(stripTerminalSequences(lines[row - 1]!)).toMatch(/^  ╭─+╮  $/);
    expect(stripTerminalSequences(lines[row]!)).toMatch(
      /^  │ rook > hello +│  $/,
    );
    expect(stripTerminalSequences(lines[row + 1]!)).toMatch(/^  ╰─+╯  $/);
    terminal.resize(40, 36);
    lines = app.tui.render(40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.map(stripTerminalSequences).join("\n")).toContain(
      "rook > hello",
    );
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.sentPrompts).toEqual(["hello"]);
    terminal.input("\u0003");
    await finished;
  });

  it("renders the home view, handles resize, and restores the terminal on exit", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      branch: "feature/ui",
      repository: {
        id: "repo-12345678",
        logicalId: "logical-12345678",
        kind: "git",
        root: "/workspace/sample-project",
        displayName: "sample-project",
        remoteFingerprint: null,
      } satisfies RepositoryIdentity,
      snapshot: {
        repoId: "repo-12345678",
        branch: "feature/ui",
        headCommit: "0123456789abcdef",
        dirtyFingerprint: null,
        capturedAt: new Date(0).toISOString(),
      } satisfies GitSnapshot,
      gateway,
      terminal,
    });
    const finished = app.start();
    app.tui.renderNow(true);

    expect(terminal.started).toBe(1);
    expect(gateway.externalAccessPrompt).toBeDefined();
    expect(terminal.writes.join("")).toContain("rook");
    expect(terminal.writes.join("")).toContain(
      "A coding agent that grows with your codebase.",
    );
    expect(terminal.writes.join("")).toContain("/plan");
    expect(terminal.writes.join("")).toContain("/build");
    expect(terminal.writes.join("")).toContain("feature/ui");
    const homeScreen = app.tui.getScreenLines().map(stripTerminalSequences);
    expect(homeScreen.join("\n")).toContain("/plan");
    expect(homeScreen.join("\n")).toContain("/build");
    expect(homeScreen.join("\n")).toContain("feature/ui");
    expect(homeScreen.join("\n")).toContain("sample-project");
    expect(homeScreen.join("\n")).toContain("/workspace/sample-project");
    expect(homeScreen.join("\n")).toContain("Ctx ~1.0k/128.0k 1%");

    await app.submit("/build");
    expect(app.tui.render(100).join("\n")).toContain("/build");
    expect(app.tui.render(100).join("\n")).not.toContain("Build mode enabled");
    await app.submit("/plan");
    expect(app.tui.render(100).join("\n")).toContain("/plan");

    await app.submit("hello");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("final answer");
    expect(terminal.writes.join("")).toContain("package.json");

    await app.submit("/login");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("No providers are registered");

    await app.submit("/sessions");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("No saved sessions were found");

    await app.submit("/new");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain(
      "Started a new persistent session",
    );
    expect(app.tui.render(100).join("\n")).toContain("Rook v0.1.0");

    const pendingRun = app.submit("long running prompt");
    await app.submit("/new");
    expect(gateway.currentSession().id).toBe("session-87654321");
    app.tui.renderNow(true);
    expect(
      app.tui.getScreenLines().map(stripTerminalSequences).join("\n"),
    ).toContain("A response is still running. Use /cancel");
    gateway.emit({ type: "error", message: "Provider timed out (504)." });
    await app.submit("Use the smaller change");
    await app.submit("/build");
    terminal.input("\x1b[Z");
    expect(gateway.getActiveTools()).not.toContain("write");
    expect(app.tui.render(180).join("\n")).toContain(
      "Queued follow-up: Use the smaller change",
    );
    await app.submit("/steer Continue with the simpler approach");
    await app.submit("/follow-up Add tests after that");
    expect(gateway.queuedMessages).toEqual([
      { text: "Use the smaller change", disposition: "follow_up" },
      {
        text: "Continue with the simpler approach",
        disposition: "steer",
      },
      { text: "Add tests after that", disposition: "follow_up" },
    ]);
    gateway.completePendingRun();
    await pendingRun;

    await app.submit("/compact Keep the final decision");
    expect(gateway.compactedInstructions).toBe("Keep the final decision");
    app.tui.renderNow(true);
    expect(app.tui.render(180).join("\n")).toContain(
      "Compacted session context: 1.0k → ~512 tokens",
    );
    expect(app.tui.render(180).join("\n")).toContain("Ctx ~512/128.0k");
    await app.submit("/skills");
    await app.submit("/prompts");
    await app.submit("/skill:review");
    await app.submit("/explain this module");
    await app.submit("/fork");
    terminal.input("\r");
    expect(gateway.forkedEntry).toBe("entry-user-1");

    await app.submit("/build");
    app.tui.renderNow(true);
    expect(app.tui.render(100).join("\n")).toContain("BUILD");
    await app.submit("/plan");
    app.tui.renderNow(true);
    expect(app.tui.render(100).join("\n")).toContain("PLAN");

    const accessRequest = gateway.externalAccessPrompt?.({
      toolName: "read",
      path: "/Users/test/Downloads/notes.txt",
      folderPath: "/Users/test/Downloads",
      access: "read",
    });
    expect(accessRequest).toBeDefined();
    app.tui.renderNow(true);
    expect(terminal.writes.join(" ")).toContain("External read access · read");
    const accessScreen = app.tui.render(100).join("\n");
    expect(
      accessScreen.indexOf("/Users/test/Downloads/notes.txt"),
    ).toBeLessThan(accessScreen.indexOf("Rook v0.1.0"));
    terminal.input("\u001b[B");
    expect(app.tui.render(100).join("\n")).toContain("2. [Allow read once]");
    terminal.input("\r");
    await expect(accessRequest).resolves.toBe("once");

    const deniedRequest = gateway.externalAccessPrompt?.({
      toolName: "read",
      path: "/Users/test/Downloads/private.txt",
      folderPath: "/Users/test/Downloads",
      access: "read",
    });
    expect(deniedRequest).toBeDefined();
    terminal.input("\r");
    await expect(deniedRequest).resolves.toBe("deny");

    const mcpRequest = gateway.externalAccessPrompt?.({
      toolName: "mcp__docs__search",
      serverName: "docs",
      access: "mcp",
      inputSummary: '{"query":"Rook MCP"}',
      reason: "Rook recommends this call.",
    });
    expect(mcpRequest).toBeDefined();
    app.tui.renderNow(true);
    const mcpScreen = app.tui.render(100).join("\n");
    expect(mcpScreen).toContain("Rook recommends an MCP call");
    expect(mcpScreen).toContain("mcp__docs__search");
    expect(mcpScreen).toContain("outside Rook's workspace policy");
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    expect(app.tui.render(100).join("\n")).toContain(
      "3. [Allow this tool from docs for this session]",
    );
    terminal.input("\r");
    await expect(mcpRequest).resolves.toBe("session");

    gateway.externalGrants.push({
      id: "grant-123",
      path: "/Users/test/Downloads",
      requestedPath: "/Users/test/Downloads",
      access: "read",
    });
    await app.submit("/permissions");
    await app.submit("/permissions revoke grant-123");
    expect(gateway.externalGrants).toHaveLength(0);

    const writesBeforeResize = terminal.writes.length;
    terminal.resize(60, 20);
    app.tui.renderNow(true);
    expect(terminal.writes.length).toBeGreaterThan(writesBeforeResize);
    expect(app.tui.render(60).every((line) => visibleWidth(line) <= 60)).toBe(
      true,
    );

    terminal.input("\u0003");
    await finished;
    expect(terminal.stopped).toBe(1);
    expect(gateway.externalAccessPrompt).toBeUndefined();
  });

  it("renders the prompt shortcut chips and footer status layout", async () => {
    const terminal = new FakeTerminal();
    terminal.columns = 160;
    const gateway = new EventGateway();
    gateway.selectedModel = {
      provider: "openai",
      id: "gpt-5",
      name: "GPT-5",
    };
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const screen = app.tui.render(160).map(stripTerminalSequences);
    const prompt = screen.findIndex((line) => line.includes("rook >"));
    expect(prompt).toBeGreaterThanOrEqual(0);
    const footer = screen.slice(prompt + 1).join("\n");
    expect(footer).toContain("/ Commands");
    expect(footer).toContain("@ Files");
    expect(footer).toContain("# Context");
    expect(footer).toContain("⑂ Mode");
    expect(footer).toContain("╭");
    expect(footer).toContain("╮");
    expect(footer).toContain("Rook v0.1.0");
    expect(footer).toContain("GPT-5");
    expect(footer).toContain("openai");
    expect(footer).toContain("PLAN (read-only)");
    expect(screen.at(-1)).toMatch(/^\s+$/);
    terminal.input("\u0003");
    await finished;
  });

  it("shows recent commit file changes on the home dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-dashboard-git-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        });
      git("init", "-b", "main");
      git("config", "user.name", "Rook Test");
      git("config", "user.email", "rook@example.test");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "app.ts"), "export {}\n");
      git("add", "src/app.ts");
      git("commit", "-m", "Add sample application");
      const terminal = new FakeTerminal();
      const gateway = new EventGateway();
      const app = createRookTui({
        cwd: root,
        repository: {
          id: "repo-dashboard-test",
          logicalId: "repo-dashboard-test",
          kind: "git",
          root,
          displayName: "dashboard-test",
          remoteFingerprint: null,
        },
        gateway,
        terminal,
      });
      const finished = app.start();
      const screen = app.tui.render(160).map(stripTerminalSequences).join("\n");
      expect(screen).toContain("Add sample application");
      expect(screen).toContain("src/app.ts");
      expect(screen).not.toContain("Plan:");
      terminal.input("\u0003");
      await finished;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the dashboard visible when switching modes", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const screen = (): string =>
      app.tui.render(100).map(stripTerminalSequences).join("\n");
    expect(screen()).toContain("▶ /plan  Analyze and plan · read-only");
    terminal.input("\u001b[Z");
    expect(screen()).toContain("⚒ /build  Implement · approved shell");
    expect(screen()).toContain("QUICK ACTIONS");
    expect(screen()).toContain("BUILD  │");
    expect(gateway.getActiveTools()).toContain("edit");
    terminal.input("\u001b[Z");
    expect(screen()).toContain("▶ /plan  Analyze and plan · read-only");
    expect(screen()).toContain("QUICK ACTIONS");
    expect(screen()).toContain("PLAN  │");
    expect(gateway.getActiveTools()).not.toContain("edit");

    terminal.input("\u0003");
    await finished;
  });

  it("shows a Rook loading phrase until response text starts", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const pendingRun = app.submit("long running prompt");
    const loadingScreen = app.tui.render(100);
    const loadingLine = loadingScreen.findIndex((line) => line.includes("♜ "));
    const promptLine = loadingScreen.findIndex((line) =>
      line.includes("\u001b_pi:c"),
    );
    expect(loadingLine).toBeGreaterThanOrEqual(0);
    expect(loadingLine).toBeLessThan(promptLine);

    gateway.completePendingRun();
    await pendingRun;
    expect(app.tui.render(100).join("\n")).not.toContain("♜ ");

    terminal.input("\u0003");
    await finished;
  });

  it("renders streamed text and tool activity in the order they occur", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("hello");
    app.tui.renderNow(true);
    const transcript = app.tui
      .render(100)
      .join("\n")
      .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
    const firstText = transcript.indexOf("draft answer");
    const toolCall = transcript.indexOf("package.json");
    const followingText = transcript.indexOf("final answer");
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(firstText).toBeLessThan(toolCall);
    expect(toolCall).toBeLessThan(followingText);

    terminal.input("\u0003");
    await finished;
  });

  it("opens a centered searchable model picker and selects a filtered model", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    gateway.models.push({
      provider: "RONE_Models",
      id: "gpt-6-luna",
      name: "GPT-6 Luna AWS",
    });
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/model");
    const plainScreen = (): string => {
      app.tui.renderNow(true);
      return app.tui
        .getScreenLines()
        .join("\n")
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
    };
    let screen = plainScreen();
    expect(screen).toContain("Choose a model");
    expect(screen).toContain("Search by name");
    expect(screen).toContain("anthropic/");
    expect(screen).toContain("openai/");
    expect(screen).toContain("RONE_Models/");
    expect(screen).toContain("Claude Sonnet 4");
    expect(screen).toContain("╭");
    expect(screen).toContain("╰");
    const titleRow = screen
      .split("\n")
      .findIndex((line) => line.includes("Choose a model"));
    expect(titleRow).toBeGreaterThan(2);
    expect(titleRow).toBeLessThan(terminal.rows - 4);

    terminal.input("\r");
    expect(plainScreen()).not.toContain("Claude Sonnet 4");
    terminal.input("\r");
    expect(plainScreen()).toContain("Claude Sonnet 4");

    for (const character of "anthropic") terminal.input(character);
    let filtered = plainScreen();
    expect(filtered).toContain("Claude Sonnet 4");
    expect(filtered).not.toContain("GPT-4.1");
    for (let index = 0; index < "anthropic".length; index++) {
      terminal.input("\x7f");
    }

    for (const character of "claude") terminal.input(character);
    filtered = plainScreen();
    expect(filtered).toContain("Claude Sonnet 4");
    expect(filtered).not.toContain("GPT-4.1");
    for (let index = 0; index < "claude".length; index++) {
      terminal.input("\x7f");
    }

    for (const character of "claude-sonnet-4") terminal.input(character);
    expect(plainScreen()).toContain("Claude Sonnet 4");

    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.selectedModel).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
    });
    expect(plainScreen()).not.toContain("Search by name");

    await app.submit("/model");
    for (const character of "RONE_Models") terminal.input(character);
    expect(plainScreen()).toContain("GPT-6 Luna AWS");
    terminal.input("\u001b");
    expect(plainScreen()).not.toContain("Search by name");

    await app.submit("/model");
    expect(plainScreen()).toContain("current");
    terminal.input("\u001b");
    expect(plainScreen()).not.toContain("Search by name");

    terminal.input("\u0003");
    await finished;
  });

  it("uses the shared modal and routes arrows to thinking-level selection", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    await app.submit("/settings");
    app.tui.renderNow(true);
    const screen = app.tui
      .getScreenLines()
      .join("\n")
      .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
    expect(screen).toContain("Thinking level · current: medium");
    expect(screen).toContain("╭");
    expect(screen).toContain("╰");

    terminal.input("\u001b[B");
    terminal.input("\r");
    expect(gateway.selectedThinkingLevel).toBe("medium");

    terminal.input("\u0003");
    await finished;
  });

  it("pins the latest checklist in the wide sidebar and falls back above the prompt", async () => {
    const terminal = new FakeTerminal();
    terminal.columns = 110;
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const pendingRun = app.submit("long running prompt");

    gateway.updateChecklist([
      { id: "inspect", title: "Inspect the project", status: "completed" },
      {
        id: "implement",
        title: "Implement the feature",
        status: "in_progress",
      },
    ]);
    const plainScreen = (): string =>
      app.tui
        .render(terminal.columns)
        .join("\n")
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
    let screen = plainScreen();
    expect(screen).toContain("TASKS · 1/2");
    expect(screen).toContain("✓ Inspect the project");
    expect(screen).toContain("› Implement the feature");

    gateway.updateChecklist([
      { id: "review", title: "Review the result", status: "pending" },
    ]);
    screen = plainScreen();
    expect(screen).toContain("TASKS · 0/1");
    expect(screen).toContain("○ Review the result");
    expect(screen).not.toContain("Inspect the project");
    expect(screen).not.toContain("Implement the feature");

    // Keep the existing terminal-width sidebar breakpoint with shared gutters.
    for (const [width, sidebar] of [
      [90, true],
      [89, false],
    ] as const) {
      terminal.resize(width, 36);
      app.tui.renderNow(true);
      const lines = app.tui.getScreenLines().map(stripTerminalSequences);
      const taskLine = lines.find((line) => line.includes("TASKS ·"))!;
      expect(taskLine).toBeDefined();
      expect(taskLine.indexOf("TASKS") > 45).toBe(sidebar);
      expect(
        lines.every(
          (line) =>
            !line.trim() || (line.startsWith("  ") && line.endsWith("  ")),
        ),
      ).toBe(true);
    }

    terminal.resize(70, 36);
    gateway.updateChecklist([
      {
        id: "narrow",
        title: "Compact checklist fallback",
        status: "in_progress",
      },
    ]);
    screen = plainScreen();
    expect(screen).toContain("TASKS · 0/1");
    expect(screen).toContain("› Compact checklist fallback");

    gateway.completePendingRun();
    await pendingRun;
    terminal.input("\u0003");
    await finished;
  });

  it("suggests slash commands and accepts a selected command without submitting it", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();

    for (const character of "prior prompt") terminal.input(character);
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const character of "/m") terminal.input(character);
    let suggestions = app.tui.render(100).join("\n");
    expect(suggestions).toContain("/memory");
    expect(suggestions).toContain("/mode");
    expect(suggestions).toContain("/model");

    terminal.input("\u001b[A");
    let promptLine = app.tui
      .render(100)
      .find((line) => line.includes("\u001b_pi:c"));
    expect(promptLine).toContain("prior prompt");
    expect(app.tui.render(100).join("\n")).not.toContain("COMMANDS ·");

    terminal.input("\u001b[B");
    suggestions = app.tui.render(100).join("\n");
    expect(suggestions).toContain("COMMANDS ·");
    terminal.input("\t");
    terminal.input("\r");
    promptLine = app.tui
      .render(100)
      .find((line) => line.includes("\u001b_pi:c"));
    expect(promptLine).toContain("/mode");
    expect(gateway.sentPrompts).toEqual(["prior prompt"]);

    terminal.input("\u0003");
    await finished;
  });

  it("uses Up and Down exclusively to browse submitted prompt history", async () => {
    const terminal = new FakeTerminal();
    const gateway = new EventGateway();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      gateway,
      terminal,
    });
    const finished = app.start();
    const type = (text: string): void => {
      for (const character of text) terminal.input(character);
    };
    const submitInput = async (text: string): Promise<void> => {
      type(text);
      terminal.input("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    await submitInput("first prompt");
    await submitInput("second prompt");

    type("unfinished draft");
    terminal.input("\u001b[B");
    let promptLine = app.tui
      .render(100)
      .find((line) => line.includes("\u001b_pi:c"));
    expect(promptLine).toContain("unfinished draft");

    terminal.input("\u001b[A");
    terminal.input("\u001b[A");
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    promptLine = app.tui
      .render(100)
      .find((line) => line.includes("\u001b_pi:c"));
    expect(promptLine).toContain("unfinished draft");

    terminal.input("\u001b[A");
    terminal.input("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(gateway.sentPrompts).toEqual([
      "first prompt",
      "second prompt",
      "second prompt",
    ]);

    terminal.input("\u0003");
    await finished;
  });

  it("exposes repository memory pause and project opt-out controls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rook-memory-tui-"));
    const store = await RookStore.open(join(directory, "state.sqlite"));
    const repository: RepositoryIdentity = {
      id: "memory-tui-repo",
      logicalId: "memory-tui-repo",
      kind: "directory",
      root: directory,
      displayName: "memory-tui",
      remoteFingerprint: null,
    };
    store.saveWorkspace(repository, null);
    const evidencePath = join(directory, "decision.ts");
    const evidenceContent = "export const mode = 'safe';\n";
    await writeFile(evidencePath, evidenceContent);
    const memory = store.recordMemory({
      repoId: repository.id,
      kind: "decision",
      title: "Use safe mode",
      body: "The project uses safe mode for new workspaces.",
      status: "stale",
      confidence: 0.9,
      sourceClass: "code",
      evidence: [
        {
          path: "decision.ts",
          contentSha256: createHash("sha256")
            .update(evidenceContent)
            .digest("hex"),
          sourceType: "code",
        },
      ],
    }).memory;
    const memoryCapture = new MemoryCaptureManager(store, repository, null);
    const terminal = new FakeTerminal();
    const app = createRookTui({
      cwd: directory,
      repository,
      memoryCapture,
      gateway: new EventGateway(),
      terminal,
    });
    const finished = app.start();
    try {
      await app.submit("/memory pause");
      expect(memoryCapture.status().paused).toBe(true);
      await app.submit("/memory opt-out");
      expect(memoryCapture.status().optedOut).toBe(true);
      await app.submit("/memory opt-in");
      expect(memoryCapture.status().optedOut).toBe(false);
      await app.submit("/memory resume");
      expect(memoryCapture.status().paused).toBe(false);
      await app.submit("/memory status");
      await app.submit("/memory detail " + memory.id);
      await app.submit(`/memory verify ${memory.id}`);
      expect(store.getMemory(memory.id)?.status).toBe("stale");
      expect(app.tui.render(100).join(" ")).toContain("Review this claim");
      await app.submit(`/memory verify ${memory.id} confirm`);
      expect(store.getMemory(memory.id)?.status).toBe("verified");
      await app.submit("/memory refresh");
      await app.submit(`/memory forget ${memory.id} confirm`);
      expect(store.getMemory(memory.id)).toBeUndefined();
      app.tui.renderNow(true);
      expect(terminal.writes.join(" ")).toContain("Memory capture paused");
      expect(terminal.writes.join(" ")).toContain(
        "Project memory capture is off",
      );
    } finally {
      terminal.input("\u0003");
      await finished;
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
