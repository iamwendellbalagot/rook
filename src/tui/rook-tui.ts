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
import type { AgentGateway } from "../pi/agent-gateway.js";
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

function createHome(cwd: string): Text {
  const commands = [
    ["/plan", "Chat with tools disabled in this initial shell"],
    ["/build", "Unavailable until tool permissions are implemented"],
    ["/model", "Choose a model from Pi's catalog"],
    ["/login", "Sign in to a Pi provider"],
    ["/settings", "Adjust thinking level"],
    ["/memory", "Repository memory is not available yet"],
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
      tone("◇  No repository memory yet", "dim"),
      `   ${tone(resolve(cwd), "dim")}`,
    ].join("\n"),
    2,
    1,
  );
}

export function createRookTui(options: RookTuiOptions): RookTuiController {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const transcript = new Container();
  const home = createHome(options.cwd);
  transcript.addChild(home);

  const header = new Header(resolve(options.cwd), options.branch);
  const scrollView = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const footer = new Text("", 1, 0);
  const bottom = new VStack([editor, footer]);
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
  let modelLabel = initialModel
    ? `${initialModel.provider}/${initialModel.name}`
    : "no model selected";
  let settled = false;
  let resolveRun: (() => void) | undefined;
  const toolCards = new Map<string, Text>();
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
        `${tone(modelLabel, "muted")} · ${tone("PLAN", "blue", true)} · tools disabled${usage}${status} · Ctrl+C exit`,
        Math.max(1, terminal.columns),
      ),
    );
    tui.requestRender();
  };
  updateFooter();

  const unsubscribe = options.gateway.subscribe((event) => {
    if (event.type === "text_delta") {
      state = reduceAppState(state, event);
      activeResponse?.setText(state.response);
      tui.requestRender();
    } else if (event.type === "message_complete") {
      state = reduceAppState(state, event);
      activeResponse?.setText(state.response);
      tui.requestRender();
    } else if (event.type === "tool_started") {
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
      tui.requestRender();
    } else if (event.type === "usage") {
      state = reduceAppState(state, event);
      updateFooter();
    } else if (event.type === "run_settled") {
      state = reduceAppState(state, { type: "run_state", state: "settled" });
      if (event.aborted) appendText("Run cancelled.", "muted");
      updateFooter();
    } else if (event.type === "error") {
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

  const exit = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    tui.stop();
    resolveRun?.();
  };

  const removeHome = (): void => {
    if (transcript.children.includes(home)) transcript.removeChild(home);
  };

  const submitPrompt = async (text: string): Promise<void> => {
    const prompt = text.trim();
    if (!prompt) return;
    if (state.runState === "running" && prompt !== "/cancel") {
      appendText(
        "A response is still running. Use /cancel or Ctrl+C.",
        "muted",
      );
      return;
    }

    if (prompt.startsWith("/")) {
      switch (prompt.split(/\s+/, 1)[0]) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          removeHome();
          appendText(
            "Available: /help, /login, /logout, /model, /settings, /plan, /build, /memory, /cancel, /exit",
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
        case "/plan":
          state = reduceAppState(state, { type: "mode_changed", mode: "plan" });
          removeHome();
          appendText("Plan mode: tools are disabled in this shell.", "muted");
          updateFooter();
          return;
        case "/build":
          removeHome();
          appendText(
            "Build mode is unavailable until tool permissions are implemented.",
            "error",
          );
          return;
        case "/memory":
          removeHome();
          appendText("Repository memory is not available yet.", "muted");
          return;
        case "/cancel":
          await options.gateway.cancel();
          return;
        default:
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
      activeResponse = undefined;
      updateFooter();
    }
  };

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
  ): void {
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
    list.onCancel = () => overlay.hide();
    tui.setFocus(list);
  }

  editor.onSubmit = (text) => {
    void submitPrompt(text);
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (state.runState === "running") {
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
