import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
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
  SessionInfo,
  SessionMessage,
  ThinkingInfo,
} from "../../src/pi/agent-gateway.js";
import type {
  GitSnapshot,
  RepositoryIdentity,
} from "../../src/repo/workspace.js";
import { RookStore } from "../../src/db/store.js";
import { MemoryCaptureManager } from "../../src/memory/capture.js";
import { createRookTui } from "../../src/tui/rook-tui.js";

class EventGateway implements AgentGateway {
  private handlers = new Set<(event: AgentEvent) => void>();
  private sessionId = "session-12345678";
  private mode: PermissionMode = "plan";
  externalAccessPrompt:
    | ((request: ExternalAccessRequest) => Promise<ExternalAccessChoice>)
    | undefined = undefined;
  externalGrants: ExternalAccessGrant[] = [];
  queuedMessages: { text: string; disposition: string }[] = [];
  sentPrompts: string[] = [];
  forkedEntry?: string;
  compactedInstructions: string | undefined = undefined;
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

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  currentModel(): undefined {
    return undefined;
  }

  async selectModel(): Promise<void> {}

  listProviders(): [] {
    return [];
  }

  async logout(): Promise<void> {}

  getThinkingInfo(): ThinkingInfo {
    return { current: "medium", available: ["low", "medium", "high"] };
  }

  setThinkingLevel(): void {}

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

  async compact(customInstructions?: string): Promise<void> {
    this.compactedInstructions = customInstructions;
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
  }

  async resumeSession(): Promise<void> {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
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

  revokeExternalAccessGrant(id: string): boolean {
    const previous = this.externalGrants.length;
    this.externalGrants = this.externalGrants.filter(
      (grant) => grant.id !== id,
    );
    return previous !== this.externalGrants.length;
  }

  getActiveTools(): string[] {
    return this.mode === "build" ? ["read", "edit", "write"] : ["read"];
  }

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
  }

  private emit(event: AgentEvent): void {
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
    expect(terminal.writes.join("")).toContain("rook.");
    expect(terminal.writes.join("")).toContain("Repository repo-12");
    expect(terminal.writes.join("")).toContain("Snapshot 0123456 · clean");

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
    expect(app.tui.render(100).join("\n")).toContain("S:session-");

    const pendingRun = app.submit("long running prompt");
    await app.submit("/steer Continue with the simpler approach");
    await app.submit("/follow-up Add tests after that");
    expect(gateway.queuedMessages).toEqual([
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
    expect(app.tui.render(100).join("\n")).toContain("workspace edits enabled");
    await app.submit("/plan");
    app.tui.renderNow(true);
    expect(app.tui.render(100).join("\n")).toContain("PLAN");
    expect(app.tui.render(100).join("\n")).toContain("read-only tools");

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
    ).toBeLessThan(accessScreen.indexOf("Ctrl+C exit"));
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
    const loadingLine = loadingScreen.findIndex((line) =>
      line.includes("Rook is thinking."),
    );
    const promptLine = loadingScreen.findIndex((line) =>
      line.includes("\u001b_pi:c"),
    );
    expect(loadingLine).toBeGreaterThanOrEqual(0);
    expect(loadingLine).toBeLessThan(promptLine);

    gateway.completePendingRun();
    await pendingRun;
    expect(app.tui.render(100).join("\n")).not.toContain("Rook is thinking");

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
