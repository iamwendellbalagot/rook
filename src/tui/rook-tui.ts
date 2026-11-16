import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
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
import { editorTheme, markdownTheme, roleColors, tone } from "./theme.js";

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
  let settled = false;
  let resolveRun: (() => void) | undefined;
  const finished = new Promise<void>((resolvePromise) => {
    resolveRun = resolvePromise;
  });
  const updateFooter = (): void => {
    const status = state.runState === "running" ? " · running" : "";
    footer.setText(
      truncateToWidth(
        `${tone("PLAN", "blue", true)} · tools disabled · memory unavailable${status} · Ctrl+C exit`,
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
    } else if (event.type === "run_settled") {
      state = reduceAppState(state, { type: "run_state", state: "settled" });
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
    if (!prompt || state.runState === "running") return;

    if (prompt.startsWith("/")) {
      switch (prompt.split(/\s+/, 1)[0]) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          removeHome();
          appendText(
            "Available: /help, /plan, /build, /memory, /cancel, /exit",
            "muted",
          );
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
    activeResponse = new Markdown("", 2, 0, markdownTheme);
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
