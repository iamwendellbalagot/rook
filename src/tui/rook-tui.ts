import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  SelectList,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import type { AppState } from "../app/state.js";
import { initialAppState, reduceAppState } from "../app/state.js";
import type {
  AgentGateway,
  ExternalAccessChoice,
  ExternalAccessRequest,
} from "../pi/agent-gateway.js";
import type { GitSnapshot, RepositoryIdentity } from "../repo/workspace.js";
import type { MemoryCaptureManager } from "../memory/capture.js";
import {
  editorTheme,
  markdownTheme,
  roleColors,
  selectListTheme,
  tone,
} from "./theme.js";

const TAGLINE = "A coding agent that grows with your codebase.";

export interface RookTuiOptions {
  cwd: string;
  branch?: string;
  repository?: RepositoryIdentity;
  snapshot?: GitSnapshot | null;
  memoryCapture?: MemoryCaptureManager;
  gateway: AgentGateway;
  terminal?: Terminal;
}

export interface RookTuiController {
  tui: TuiAltScreen;
  start(): Promise<void>;
  submit(text: string): Promise<void>;
  stop(): void;
}

class Header implements Component {
  constructor(
    private readonly cwd: string,
    private readonly branch: string | undefined,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const brand = tone("rook", "text", true);
    const branch = this.branch ? tone(`⌁ ${this.branch}`, "blue") : "";
    const brandWidth = visibleWidth(brand);
    const branchWidth = visibleWidth(branch);
    const separators = branch ? 2 : 1;
    const pathWidth = Math.max(
      0,
      width - brandWidth - branchWidth - separators,
    );
    const path = compactPath(this.cwd, pathWidth);
    const remaining = Math.max(
      0,
      width - brandWidth - visibleWidth(path) - branchWidth,
    );
    const leftGap = Math.max(1, Math.floor(remaining / (branch ? 2 : 1)));
    const rightGap = branch ? Math.max(1, remaining - leftGap) : 0;
    const line = `${brand}${" ".repeat(leftGap)}${path}${" ".repeat(rightGap)}${branch}`;
    return [truncateToWidth(line, width)];
  }

  invalidate(): void {}
}

function compactPath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(path) <= maxWidth) return path;
  const tail = `…/${path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}`;
  return truncateToWidth(tail, maxWidth, "…");
}

class ExternalAccessPromptPanel implements Component {
  private request: ExternalAccessRequest | undefined;
  private selected = 0;
  private onChoose: ((choice: ExternalAccessChoice) => void) | undefined;

  constructor(private readonly onChange: () => void) {}

  show(
    request: ExternalAccessRequest,
    onChoose: (choice: ExternalAccessChoice) => void,
  ): void {
    this.request = request;
    this.selected = 0;
    this.onChoose = onChoose;
  }

  clear(): void {
    this.request = undefined;
    this.onChoose = undefined;
  }

  render(width: number): string[] {
    if (!this.request || width <= 0) return [];
    const operation = this.request.access;
    const options: { choice: ExternalAccessChoice; label: string }[] = [
      { choice: "deny", label: "Deny" },
      { choice: "once", label: `Allow ${operation} once` },
      {
        choice: "session",
        label: `Allow ${operation} in folder for this session`,
      },
    ];
    const lines = [
      tone(
        `External ${operation} access · ${safeTerminalText(this.request.toolName)}`,
        "amber",
        true,
      ),
      `${tone("Path:", "muted")} ${compactPath(
        safeTerminalText(this.request.path),
        Math.max(1, width - visibleWidth("Path: ")),
      )}`,
      `${tone("Folder:", "muted")} ${compactPath(
        safeTerminalText(this.request.folderPath),
        Math.max(1, width - visibleWidth("Folder: ")),
      )}`,
      ...options.map((option, index) => {
        const label =
          index === this.selected ? `[${option.label}]` : option.label;
        return tone(
          `${index === this.selected ? "›" : " "} ${index + 1}. ${label}`,
          index === this.selected ? "text" : "muted",
          index === this.selected,
        );
      }),
      tone("↑/↓ choose · Enter confirm · Esc deny", "dim"),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (!this.request || !this.onChoose) return;
    if (matchesKey(data, "escape")) {
      this.onChoose("deny");
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = (this.selected + 2) % 3;
      this.onChange();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % 3;
      this.onChange();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.onChoose(
        (["deny", "once", "session"] as const)[this.selected] ?? "deny",
      );
      return;
    }
    const shortcut = Number(data);
    if (shortcut >= 1 && shortcut <= 3) {
      this.onChoose(
        (["deny", "once", "session"] as const)[shortcut - 1] ?? "deny",
      );
    }
  }

  invalidate(): void {}
}

function safeTerminalText(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .slice(0, 1000);
}

function createHome(
  cwd: string,
  repository?: RepositoryIdentity,
  snapshot?: GitSnapshot | null,
): Text {
  const commands = [
    ["/plan", "Read and search workspace files without mutations"],
    ["/build", "Enable policy-gated workspace edits"],
    ["/model", "Choose a model from Pi's catalog"],
    ["/new", "Start a new persistent session"],
    ["/sessions", "Browse and resume saved sessions"],
    ["/fork", "Fork the current session from a user message"],
    ["/compact", "Compact the current Pi session"],
    ["/skills", "List Pi skills available in this workspace"],
    ["/prompts", "List Pi prompt templates"],
    ["/login", "Sign in to a Pi provider"],
    ["/settings", "Adjust thinking level"],
    ["/permissions", "Review or revoke session access grants"],
    ["/memory", "Show, pause, resume, or control repository memory"],
    ["/help", "Show available commands"],
  ] as const;
  const commandLines = commands
    .map(
      ([command, description]) =>
        `  ${tone(command, "text", true)}  ${tone(description, "muted")}`,
    )
    .join("\n");

  return new Text(
    [
      "",
      tone("rook.", "text", true),
      tone(TAGLINE, "muted"),
      "",
      tone("GET STARTED", "dim", true),
      commandLines,
      "",
      tone(
        repository
          ? "◇  Repository memory available · /memory show"
          : "◇  No repository memory yet",
        "dim",
      ),
      `   ${tone(resolve(cwd), "dim")}`,
      ...(repository
        ? [
            `   ${tone(`Repository ${repository.id.slice(0, 8)} · ${repository.kind}`, "dim")}`,
          ]
        : []),
      ...(snapshot
        ? [
            `   ${tone(`Snapshot ${snapshot.headCommit?.slice(0, 7) ?? "unborn"} · ${snapshot.dirtyFingerprint ? "dirty" : "clean"}`, "dim")}`,
          ]
        : []),
    ].join("\n"),
    2,
    1,
  );
}

export function createRookTui(options: RookTuiOptions): RookTuiController {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const transcript = new Container();
  const home = createHome(options.cwd, options.repository, options.snapshot);
  transcript.addChild(home);

  const header = new Header(resolve(options.cwd), options.branch);
  const scrollView = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const externalAccessPanel = new ExternalAccessPromptPanel(() =>
    tui.requestRender(),
  );
  const loadingIndicator = new Text("", 1, 0);
  const footer = new Text("", 1, 0);
  const bottom = new VStack([
    loadingIndicator,
    editor,
    externalAccessPanel,
    footer,
  ]);
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto", shrink: 0 },
      { component: scrollView, basis: 0, grow: 1, minSize: 1 },
      { component: bottom, basis: "auto", shrink: 0, minSize: 3 },
    ]),
  );
  tui.setFocus(editor);

  let state: AppState = reduceAppState(initialAppState(), {
    type: "startup_complete",
  });
  state = reduceAppState(state, { type: "mode_changed", mode: "plan" });
  const initialModel = options.gateway.currentModel();
  const initialSession = options.gateway.currentSession();
  let modelLabel = initialModel
    ? `${initialModel.provider}/${initialModel.name}`
    : "no model selected";
  let sessionLabel = initialSession.id.slice(0, 8);
  const repositoryLabel = options.repository?.id.slice(0, 8);
  let settled = false;
  let resolveRun: (() => void) | undefined;
  const toolCards = new Map<string, Text>();
  const permissionQueue: {
    request: ExternalAccessRequest;
    resolve: (choice: ExternalAccessChoice) => void;
  }[] = [];
  const thinkingPhrases = [
    "Rook is thinking",
    "Connecting the pieces",
    "Working through it",
  ];
  let loadingTimer: ReturnType<typeof setInterval> | undefined;
  let loadingTick = 0;
  let loadingStatus: string | undefined;
  let activePermissionPrompt:
    | {
        resolve: (choice: ExternalAccessChoice) => void;
      }
    | undefined;
  const finished = new Promise<void>((resolvePromise) => {
    resolveRun = resolvePromise;
  });
  const updateFooter = (): void => {
    const status = state.runState === "running" ? " · running" : "";
    const usage = state.usage
      ? ` · ↑ ${state.usage.inputTokens ?? 0} ↓ ${state.usage.outputTokens ?? 0}`
      : "";
    footer.setText(
      truncateToWidth(
        `${tone(modelLabel, "muted")} · ${tone(`S:${sessionLabel}`, "dim")}${repositoryLabel ? ` · ${tone(`R:${repositoryLabel}`, "dim")}` : ""} · ${tone(state.mode.toUpperCase(), state.mode === "plan" ? "blue" : "amber", true)} · ${state.mode === "plan" ? "read-only tools" : "workspace edits enabled"}${usage}${status} · Ctrl+C exit`,
        Math.max(1, terminal.columns),
      ),
    );
    tui.requestRender();
  };
  updateFooter();

  function startLoadingStatus(reset = false): void {
    stopLoadingStatus();
    if (reset) loadingTick = 0;
    const update = (): void => {
      const phrase =
        thinkingPhrases[Math.floor(loadingTick / 3) % thinkingPhrases.length]!;
      const dots = ".".repeat((loadingTick % 3) + 1);
      loadingStatus = `${phrase}${dots}`;
      loadingIndicator.setText(tone(`♜ ${loadingStatus}`, "blue"));
      loadingTick += 1;
      tui.requestRender();
    };
    update();
    loadingTimer = setInterval(update, 650);
  }

  function stopLoadingStatus(): void {
    if (loadingTimer) clearInterval(loadingTimer);
    loadingTimer = undefined;
    if (loadingStatus) {
      loadingStatus = undefined;
      loadingIndicator.setText("");
      tui.requestRender();
    }
  }

  const unsubscribe = options.gateway.subscribe((event) => {
    if (event.type === "text_delta") {
      stopLoadingStatus();
      state = reduceAppState(state, event);
      activeResponse?.setText(state.response);
      tui.requestRender();
    } else if (event.type === "message_complete") {
      stopLoadingStatus();
      state = reduceAppState(state, event);
      activeResponse?.setText(state.response);
      tui.requestRender();
    } else if (event.type === "tool_started") {
      stopLoadingStatus();
      state = reduceAppState(state, {
        type: "tool_started",
        tool: { id: event.id, name: event.name, summary: event.summary },
      });
      const card = new Text(
        formatToolCard(event.name, event.summary, "running"),
        2,
        0,
      );
      toolCards.set(event.id, card);
      transcript.addChild(card);
      tui.requestRender();
    } else if (event.type === "tool_finished") {
      state = reduceAppState(state, {
        type: "tool_finished",
        id: event.id,
        status: event.status,
      });
      const tool = state.tools.find((candidate) => candidate.id === event.id);
      const card = toolCards.get(event.id);
      if (tool && card) {
        card.setText(formatToolCard(tool.name, tool.summary, tool.status));
      }
      toolCards.delete(event.id);
      if (state.runState === "running") startLoadingStatus();
      tui.requestRender();
    } else if (event.type === "usage") {
      state = reduceAppState(state, event);
      updateFooter();
    } else if (event.type === "run_settled") {
      stopLoadingStatus();
      state = reduceAppState(state, { type: "run_state", state: "settled" });
      if (event.aborted) appendText("Run cancelled.", "muted");
      updateFooter();
    } else if (event.type === "error") {
      stopLoadingStatus();
      state = reduceAppState(state, event);
      activeResponse?.setText(tone(event.message, roleColors.error));
      updateFooter();
    }
  });

  let activeResponse: Markdown | undefined;
  const appendText = (text: string, color: keyof typeof roleColors): void => {
    transcript.addChild(new Text(tone(text, roleColors[color]), 2, 0));
    tui.requestRender();
  };

  const unsubscribeMemory = options.memoryCapture?.subscribeNotices(
    (notice) => {
      appendText(safeTerminalText(notice), "muted");
    },
  );

  const exit = (): void => {
    if (settled) return;
    settled = true;
    options.gateway.setExternalAccessPrompt(undefined);
    denyPendingPermissionPrompts();
    unsubscribe();
    unsubscribeMemory?.();
    stopLoadingStatus();
    tui.stop();
    resolveRun?.();
  };

  const removeHome = (): void => {
    if (transcript.children.includes(home)) transcript.removeChild(home);
  };

  const submitPrompt = async (text: string): Promise<void> => {
    const prompt = text.trim();
    if (!prompt) return;
    const command = prompt.split(/\s+/, 1)[0];
    const canQueueInput = command === "/steer" || command === "/follow-up";
    if (
      state.runState === "running" &&
      prompt !== "/cancel" &&
      !canQueueInput
    ) {
      appendText(
        "A response is still running. Use /cancel or Ctrl+C.",
        "muted",
      );
      return;
    }

    if (prompt.startsWith("/")) {
      switch (command) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          removeHome();
          appendText(
            "Available: /help, /login, /logout, /model, /settings, /new, /sessions, /resume, /fork, /compact, /skills, /prompts, /steer <text>, /follow-up <text>, /plan, /build, /permissions [revoke <grant-id>], /memory status|show|detail|verify|refresh|pause|resume|opt-out|opt-in|pending|confirm|cancel|forget, /cancel, /exit",
            "muted",
          );
          return;
        case "/model":
          await showModelMenu();
          return;
        case "/login":
        case "/logout":
          await showProviderMenu(prompt === "/login" ? "login" : "logout");
          return;
        case "/settings":
          showThinkingMenu();
          return;
        case "/permissions":
          if (prompt.startsWith("/permissions revoke ")) {
            revokeExternalGrant(prompt.slice("/permissions revoke ".length));
          } else {
            showPermissionDecisions();
          }
          return;
        case "/new":
          await startNewSession();
          return;
        case "/sessions":
        case "/resume":
          await showSessionMenu();
          return;
        case "/fork":
          showForkMenu();
          return;
        case "/compact":
          try {
            await options.gateway.compact(
              prompt.slice("/compact".length).trim() || undefined,
            );
            appendText("Pi compacted the current session context.", "muted");
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        case "/skills":
          showAgentResources("Rook skills", options.gateway.listSkills());
          return;
        case "/prompts":
          showAgentResources(
            "Pi prompt templates",
            options.gateway.listPromptTemplates(),
          );
          return;
        case "/steer":
        case "/follow-up": {
          const text = prompt.slice(command.length).trim();
          if (!text) {
            appendText(`Usage: ${command} <text>`, "error");
            return;
          }
          if (state.runState !== "running") {
            appendText(
              `${command} is only available while Rook is responding.`,
              "error",
            );
            return;
          }
          const disposition = command === "/steer" ? "steer" : "follow_up";
          try {
            await options.gateway.send(text, disposition);
            appendText(
              `${command === "/steer" ? "Steering" : "Follow-up"} message queued.`,
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        }
        case "/plan":
          state = reduceAppState(state, { type: "mode_changed", mode: "plan" });
          options.gateway.setMode("plan");
          removeHome();
          appendText(
            "Plan mode enabled: workspace reads and file discovery are allowed; outside-folder reads require approval, mutations and shell execution are blocked.",
            "muted",
          );
          updateFooter();
          return;
        case "/build":
          state = reduceAppState(state, {
            type: "mode_changed",
            mode: "build",
          });
          options.gateway.setMode("build");
          removeHome();
          appendText(
            "Build mode enabled: workspace edits are allowed; outside-folder access requires separate approval; shell, content grep, sensitive paths, links, and unknown tools remain blocked.",
            "muted",
          );
          updateFooter();
          return;
        case "/mode": {
          const requestedMode = prompt.split(/\s+/)[1];
          if (requestedMode !== "plan" && requestedMode !== "build") {
            appendText("Usage: /mode plan|build", "error");
            return;
          }
          state = reduceAppState(state, {
            type: "mode_changed",
            mode: requestedMode,
          });
          options.gateway.setMode(requestedMode);
          removeHome();
          appendText(
            `${requestedMode === "plan" ? "Plan" : "Build"} mode enabled.`,
            "muted",
          );
          updateFooter();
          return;
        }
        case "/memory":
          removeHome();
          await handleMemoryCommand(prompt);
          return;
        case "/cancel":
          await options.gateway.cancel();
          return;
        default:
          if (options.gateway.isResourceCommand(prompt)) break;
          removeHome();
          appendText(
            "Unknown command. Use /help for available commands.",
            "error",
          );
          return;
      }
    }

    removeHome();
    state = reduceAppState(state, { type: "prompt_submitted" });
    if (state.runState !== "running") return;
    appendText(`› ${prompt}`, "user");
    activeResponse = new Markdown("", 2, 0, markdownTheme, {
      color: (content) => tone(content, "text"),
    });
    startLoadingStatus(true);
    transcript.addChild(activeResponse);
    updateFooter();
    try {
      await options.gateway.send(prompt);
      if (state.runState === "running") {
        state = reduceAppState(state, { type: "run_state", state: "settled" });
      }
    } catch (error) {
      if (state.runState !== "failed") {
        state = reduceAppState(state, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        activeResponse.setText(tone(state.error ?? "Request failed", "error"));
      }
    } finally {
      stopLoadingStatus();
      activeResponse = undefined;
      updateFooter();
    }
  };

  async function handleMemoryCommand(command: string): Promise<void> {
    const [, action = "status", ...args] = command.trim().split(/\s+/);
    const memory = options.memoryCapture;
    if (!memory) {
      appendText("Repository memory is unavailable in this run.", "muted");
      return;
    }
    switch (action) {
      case "status": {
        const status = memory.status();
        appendText(
          `Memory ${status.total} total · ${status.verified} verified · ${status.candidates} candidates · ${status.stale} stale; capture ${status.optedOut ? "opted out" : status.paused ? "paused" : "active"}; ${status.capturedThisSession}/${status.sessionCaptureLimit} session captures; ${status.pendingConfirmations} pending confirmation(s).`,
          "muted",
        );
        return;
      }
      case "pause": {
        memory.pause();
        appendText("Memory capture paused for this repository.", "muted");
        return;
      }
      case "resume": {
        const status = memory.resume();
        appendText(
          status.optedOut
            ? "Capture remains disabled because this project is opted out; use /memory opt-in."
            : "Memory capture resumed for this repository.",
          "muted",
        );
        return;
      }
      case "opt-out": {
        memory.optOut();
        appendText(
          "Project memory capture is off; pending confirmations were cleared. Use /memory opt-in to re-enable it.",
          "muted",
        );
        return;
      }
      case "opt-in": {
        const status = memory.optIn();
        appendText(
          status.paused
            ? "Project memory capture is enabled but remains paused; use /memory resume."
            : "Project memory capture is enabled.",
          "muted",
        );
        return;
      }
      case "show": {
        const entries = memory.show();
        appendText(
          entries.length
            ? entries.map(safeTerminalText).join("\n")
            : "No memories are stored for this repository.",
          "muted",
        );
        return;
      }
      case "detail": {
        if (!args[0]) {
          appendText("Usage: /memory detail <memory-id>", "error");
          return;
        }
        const detail = memory.inspect(args[0]);
        appendText(
          detail
            ? detail.map(safeTerminalText).join("\n")
            : "No memory matches that ID in this repository.",
          "muted",
        );
        return;
      }
      case "verify": {
        if (!args[0]) {
          appendText("Usage: /memory verify <memory-id>", "error");
          return;
        }
        appendText(safeTerminalText(await memory.verify(args[0])), "muted");
        return;
      }
      case "refresh": {
        const result = await memory.refresh();
        appendText(
          `Memory refresh: checked ${result.checked} evidence item(s), refreshed ${result.refreshed}, invalidated ${result.invalidated}, skipped ${result.skipped}.`,
          "muted",
        );
        return;
      }
      case "pending": {
        const pending = memory.pending();
        appendText(
          pending.length
            ? pending
                .map(
                  (item) =>
                    `[${item.id}] ${safeTerminalText(item.title)} — /memory confirm ${item.id} or /memory cancel ${item.id}`,
                )
                .join("\n")
            : "No explicit memories are awaiting confirmation.",
          "muted",
        );
        return;
      }
      case "confirm": {
        if (!args[0]) {
          appendText("Usage: /memory confirm <pending-id>", "error");
          return;
        }
        appendText(safeTerminalText(memory.confirm(args[0])), "muted");
        return;
      }
      case "cancel": {
        if (!args[0]) {
          appendText("Usage: /memory cancel <pending-id>", "error");
          return;
        }
        appendText(
          memory.cancel(args[0])
            ? "Pending memory discarded."
            : "No pending memory matches that ID in this repository.",
          "muted",
        );
        return;
      }
      case "forget": {
        if (!args[0] || args[1]?.toLowerCase() !== "confirm") {
          appendText("Usage: /memory forget <memory-id> confirm", "error");
          return;
        }
        appendText(
          memory.forget(args[0])
            ? "Memory and its evidence/history were forgotten from the live database. Existing external backups are unaffected."
            : "No memory matches that ID in this repository.",
          "muted",
        );
        return;
      }
      default:
        appendText(
          "Usage: /memory [status|show|detail <id>|verify <id>|refresh|pause|resume|opt-out|opt-in|pending|confirm <id>|cancel <id>|forget <id> confirm]. Use `remember: <claim>` in a prompt to request a memory, then confirm its pending ID.",
          "muted",
        );
    }
  }

  async function showModelMenu(): Promise<void> {
    try {
      const models = await options.gateway.listModels();
      if (models.length === 0) {
        removeHome();
        appendText(
          "Pi did not report any models in its current catalog.",
          "muted",
        );
        return;
      }
      showSelection(
        "Select a Pi model",
        models.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: model.name,
          description: model.provider,
        })),
        async (value) => {
          const model = models.find(
            (candidate) => `${candidate.provider}/${candidate.id}` === value,
          );
          if (!model) return;
          try {
            await options.gateway.selectModel(model);
            modelLabel = `${model.provider}/${model.name}`;
            appendText(`Selected ${modelLabel}.`, "muted");
            updateFooter();
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
        },
      );
    } catch (error) {
      appendText(errorMessage(error), "error");
    }
  }

  async function startNewSession(): Promise<void> {
    try {
      await options.gateway.newSession();
      renderCurrentSession();
      appendText("Started a new persistent session.", "muted");
    } catch (error) {
      appendText(errorMessage(error), "error");
    }
  }

  async function showSessionMenu(): Promise<void> {
    try {
      const sessions = await options.gateway.listSessions();
      if (sessions.length === 0) {
        appendText("No saved sessions were found for this workspace.", "muted");
        return;
      }
      const currentPath = options.gateway.currentSession().path;
      showSelection(
        "Resume a session",
        sessions.map((session) => ({
          value: session.path,
          label: compactSessionLabel(
            session.name || session.firstMessage || session.id,
          ),
          description: [
            session.path === currentPath ? "current" : undefined,
            `${session.messageCount} messages`,
            session.modified.toLocaleString(),
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        async (path) => {
          try {
            await options.gateway.resumeSession(path);
            renderCurrentSession();
            appendText("Resumed saved session history.", "muted");
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
        },
      );
    } catch (error) {
      appendText(errorMessage(error), "error");
    }
  }

  function showPermissionDecisions(): void {
    const grants = options.gateway.getExternalAccessGrants();
    if (grants.length) {
      appendText(
        `External folder grants (session only):\n${grants
          .map(
            (grant) =>
              `${grant.access.toUpperCase()} ${safeTerminalText(grant.path)} · /permissions revoke ${grant.id}`,
          )
          .join("\n")}`,
        "muted",
      );
    }
    const decisions = options.gateway.getPermissionDecisions();
    if (decisions.length === 0 && grants.length === 0) {
      appendText(
        "No tool permission decisions have been recorded this session.",
        "muted",
      );
      return;
    }
    for (const decision of decisions.slice(-10)) {
      const result = decision.allowed ? "ALLOWED" : "BLOCKED";
      appendText(
        `${result} ${decision.toolName}: ${decision.reason}`,
        decision.allowed ? "muted" : "error",
      );
    }
  }

  function revokeExternalGrant(id: string): void {
    const revoked = options.gateway.revokeExternalAccessGrant(id.trim());
    appendText(
      revoked
        ? "External folder grant revoked."
        : "No external folder grant matches that ID.",
      revoked ? "muted" : "error",
    );
  }

  function showAgentResources(
    title: string,
    resources: { name: string; description: string }[],
  ): void {
    appendText(
      resources.length
        ? `${title}:\n${resources
            .map(
              (resource) =>
                `/${safeTerminalText(resource.name)} — ${safeTerminalText(resource.description)}`,
            )
            .join("\n")}`
        : `No ${title.toLocaleLowerCase()} are available.`,
      "muted",
    );
  }

  function showForkMenu(): void {
    const forkPoints = options.gateway.listForkPoints();
    if (!forkPoints.length) {
      appendText("No user messages are available to fork from.", "muted");
      return;
    }
    showSelection(
      "Fork session from a user message",
      forkPoints.map((point, index) => ({
        value: point.entryId,
        label: compactSessionLabel(point.text || `User message ${index + 1}`),
      })),
      async (entryId) => {
        try {
          await options.gateway.fork(entryId);
          renderCurrentSession();
          appendText("Forked the session from the selected message.", "muted");
        } catch (error) {
          appendText(errorMessage(error), "error");
        }
      },
    );
  }

  function requestExternalAccess(
    request: ExternalAccessRequest,
  ): Promise<ExternalAccessChoice> {
    return new Promise((resolveChoice) => {
      permissionQueue.push({ request, resolve: resolveChoice });
      showNextPermissionPrompt();
    });
  }

  function showNextPermissionPrompt(): void {
    if (activePermissionPrompt || settled) return;
    const pending = permissionQueue.shift();
    if (!pending) return;
    const operation = pending.request.access === "read" ? "read" : "write";
    const finish = (choice: ExternalAccessChoice): void => {
      if (activePermissionPrompt?.resolve !== pending.resolve) return;
      activePermissionPrompt = undefined;
      externalAccessPanel.clear();
      tui.requestRender();
      pending.resolve(choice);
      showNextPermissionPrompt();
    };
    activePermissionPrompt = { resolve: pending.resolve };
    externalAccessPanel.show(pending.request, finish);
    tui.requestRender();
    appendText(
      `${pending.request.toolName} requests ${operation} access to ${safeTerminalText(pending.request.path)}.`,
      "muted",
    );
  }

  function denyPendingPermissionPrompts(): void {
    const active = activePermissionPrompt;
    activePermissionPrompt = undefined;
    externalAccessPanel.clear();
    tui.requestRender();
    active?.resolve("deny");
    for (const pending of permissionQueue.splice(0)) pending.resolve("deny");
  }

  function renderCurrentSession(): void {
    removeHome();
    for (const child of [...transcript.children]) transcript.removeChild(child);
    toolCards.clear();
    const session = options.gateway.currentSession();
    sessionLabel = session.id.slice(0, 8);
    for (const message of options.gateway.sessionHistory()) {
      if (message.role === "user") {
        transcript.addChild(
          new Text(tone(`› ${message.text}`, "purple"), 2, 0),
        );
      } else {
        transcript.addChild(
          new Markdown(message.text, 2, 0, markdownTheme, {
            color: (content) => tone(content, "text"),
          }),
        );
      }
    }
    updateFooter();
  }

  async function showProviderMenu(action: "login" | "logout"): Promise<void> {
    const providers = options.gateway.listProviders();
    if (providers.length === 0) {
      removeHome();
      appendText(
        "No providers are registered in Pi's current configuration.",
        "muted",
      );
      return;
    }
    showSelection(
      action === "login"
        ? "Pi providers · sign-in options"
        : "Select provider to log out",
      providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.configured
          ? "configured in Pi"
          : provider.authMethods.length
            ? `not configured · ${provider.authMethods.join(", ")}`
            : "not configured",
      })),
      async (providerId) => {
        const provider = providers.find(
          (candidate) => candidate.id === providerId,
        );
        if (!provider) return;
        if (action === "login") {
          appendText(
            `Sign in to ${provider.name} with Pi: exit Rook, run \`pi\`, and use Pi's /login flow. Then restart Rook.`,
            "muted",
          );
          return;
        }
        try {
          await options.gateway.logout(providerId);
          appendText(`Logged out of ${provider.name} in Pi.`, "muted");
        } catch (error) {
          appendText(errorMessage(error), "error");
        }
      },
    );
  }

  function showThinkingMenu(): void {
    const thinking = options.gateway.getThinkingInfo();
    if (thinking.available.length === 0) {
      appendText(
        "Thinking-level selection is unavailable for this model.",
        "muted",
      );
      return;
    }
    showSelection(
      `Thinking level · current: ${thinking.current}`,
      thinking.available.map((level) => ({
        value: level,
        label: level,
        ...(level === thinking.current ? { description: "current" } : {}),
      })),
      (level) => {
        try {
          options.gateway.setThinkingLevel(level);
          appendText(`Thinking level set to ${level}.`, "muted");
          updateFooter();
        } catch (error) {
          appendText(errorMessage(error), "error");
        }
      },
    );
  }

  function showSelection(
    title: string,
    items: { value: string; label: string; description?: string }[],
    onSelect: (value: string) => void | Promise<void>,
    onCancel?: () => void,
  ): () => void {
    const list = new SelectList(items, 10, selectListTheme);
    const panel = new VStack([new Text(tone(title, "text", true), 1, 0), list]);
    const overlay = tui.showOverlay(panel, {
      width: "80%",
      maxHeight: "70%",
      margin: 1,
    });
    list.onSelect = (item) => {
      overlay.hide();
      void onSelect(item.value);
    };
    list.onCancel = () => {
      overlay.hide();
      onCancel?.();
    };
    tui.setFocus(list);
    return () => overlay.hide();
  }

  options.gateway.setExternalAccessPrompt(requestExternalAccess);

  editor.onSubmit = (text) => {
    void submitPrompt(text);
  };

  tui.addInputListener((data) => {
    if (activePermissionPrompt) {
      if (matchesKey(data, "ctrl+c")) {
        denyPendingPermissionPrompts();
        void options.gateway.cancel().catch(() => undefined);
      } else {
        externalAccessPanel.handleInput(data);
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (state.runState === "running") {
        denyPendingPermissionPrompts();
        void options.gateway.cancel().catch(() => undefined);
      } else {
        exit();
      }
      return { consume: true };
    }
    return undefined;
  });

  return {
    tui,
    start() {
      tui.start();
      return finished;
    },
    submit: submitPrompt,
    stop: exit,
  };
}

function formatToolCard(
  name: string,
  summary: string,
  status: "running" | "ok" | "error" | "blocked",
): string {
  const icon = status === "running" ? "▸" : status === "ok" ? "✓" : "×";
  const color =
    status === "ok" ? "green" : status === "error" ? "error" : "muted";
  const detail = summary === name ? "" : `  ${summary}`;
  return `${tone(icon, color, true)}  ${tone(name, "text", true)}${tone(detail, "muted")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactSessionLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
}
