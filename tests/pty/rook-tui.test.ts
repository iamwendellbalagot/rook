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
  ExternalAccessChoice,
  ExternalAccessGrant,
  ExternalAccessRequest,
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

  async send(): Promise<void> {
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

    await app.submit("/build");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("Build mode enabled");
    await app.submit("/plan");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("Plan mode enabled");

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
