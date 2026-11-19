import {
  Container,
  Editor,
  HStack,
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
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type Terminal,
} from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import {
  captureRecentCommits,
  type GitSnapshot,
  type RepositoryIdentity,
} from "../repo/workspace.js";
import type { AppState, RookMode } from "../app/state.js";
import { initialAppState, reduceAppState } from "../app/state.js";
import type {
  AgentGateway,
  ExternalAccessChoice,
  ExternalAccessRequest,
  ModelInfo,
  ProviderInfo,
  ProviderAuthInteraction,
  ProviderAuthMethod,
} from "../pi/agent-gateway.js";
import type { TaskChecklistItem } from "../pi/task-checklist.js";
import type { MemoryCaptureManager } from "../memory/capture.js";
import {
  editorTheme,
  markdownTheme,
  roleColors,
  selectListTheme,
  tone,
} from "./theme.js";
import {
  LOADING_DOT_INTERVAL_MS,
  LOADING_WORD_INTERVAL_MS,
  shuffleLoadingWords,
} from "./loading-phrases.js";
import { HomeScreenBody } from "./home-screen.js";
import { PromptEditor } from "./prompt-editor.js";
import { InferenceStatsLine } from "./inference-stats.js";
import { InferenceTimings } from "./inference-timings.js";
import { ProviderAuthDialog } from "./provider-auth-dialog.js";
import { openBrowser } from "./open-browser.js";

const CHECKLIST_SIDEBAR_MIN_WIDTH = 90;
const CHECKLIST_SIDEBAR_WIDTH = 34;
const MAX_PROMPT_HISTORY = 100;
const SCREEN_GUTTER = 2;

interface SlashCommandSuggestion {
  command: string;
  description: string;
}

class FooterShortcuts implements Component {
  render(width: number): string[] {
    const shortcuts = [
      ["/", "Commands"],
      ["@", "Files"],
      ["#", "Context"],
      ["⑂", "Mode"],
    ];
    return [
      truncateToWidth(
        shortcuts
          .map(
            ([symbol, label]) =>
              `${tone("╭", "border")}─ ${tone(symbol!, "cyan", true)} ${label} ─${tone("╮", "border")}`,
          )
          .join("  "),
        Math.max(0, width),
      ),
    ];
  }

  invalidate(): void {}
}

class BottomMargin implements Component {
  render(width: number): string[] {
    return [" ".repeat(Math.max(0, width))];
  }

  invalidate(): void {}
}

const BUILTIN_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { command: "/plan", description: "Enable read-only mode" },
  { command: "/build", description: "Enable workspace edits" },
  { command: "/mode", description: "Set plan or build mode" },
  { command: "/ask", description: "Ask a read-only one-turn question" },
  { command: "/model", description: "Choose a model" },
  { command: "/login", description: "Sign in to a provider" },
  { command: "/logout", description: "Sign out of a provider" },
  { command: "/settings", description: "Adjust thinking level" },
  {
    command: "/plyth",
    description: "Show prediction coverage and verdict counts",
  },
  { command: "/new", description: "Start a new session" },
  { command: "/sessions", description: "Browse saved sessions" },
  { command: "/resume", description: "Resume a session" },
  { command: "/fork", description: "Fork the current session" },
  { command: "/compact", description: "Compact session context" },
  { command: "/skills", description: "List available skills" },
  { command: "/prompts", description: "List prompt templates" },
  {
    command: "/instructions",
    description: "Show applicable repository instruction files",
  },
  { command: "/steer", description: "Steer the current response" },
  { command: "/follow-up", description: "Queue a follow-up" },
  { command: "/permissions", description: "Review access grants" },
  { command: "/diff", description: "Review current Git changes" },
  { command: "/review", description: "Run a separate read-only code review" },
  { command: "/explore", description: "Research a question in fresh context" },
  {
    command: "/architect",
    description: "Propose an implementation in fresh context",
  },
  { command: "/agents", description: "List or invoke read-only subagents" },
  { command: "/undo", description: "Review or restore Rook's last file edit" },
  { command: "/memory", description: "Manage repository memory" },
  { command: "/help", description: "Show available commands" },
  { command: "/cancel", description: "Cancel the current response" },
  { command: "/exit", description: "Exit Rook" },
  { command: "/quit", description: "Exit Rook" },
];

export interface RookTuiOptions {
  cwd: string;
  branch?: string;
  repository?: RepositoryIdentity;
  snapshot?: GitSnapshot | null;
  memoryCapture?: MemoryCaptureManager;
  gateway: AgentGateway;
  terminal?: Terminal;
  openBrowser?: (url: string) => Promise<void>;
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
  private canApproveShell = false;
  private onChoose: ((choice: ExternalAccessChoice) => void) | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly availableRows: () => number,
  ) {}

  private choices(): { choice: ExternalAccessChoice; label: string }[] {
    if (this.request?.access === "mcp") {
      return [
        { choice: "deny", label: "Deny MCP call" },
        { choice: "once", label: "Allow this call once" },
        {
          choice: "session",
          label: `Allow this tool from ${safeTerminalText(this.request.serverName)} for this session`,
        },
      ];
    }
    if (this.request?.access === "execute") {
      return [
        { choice: "deny", label: "Deny" },
        ...(this.canApproveShell
          ? [
              { choice: "once" as const, label: "Allow once" },
              {
                choice: "session" as const,
                label: "Allow this command for this session",
              },
            ]
          : []),
      ];
    }
    if (this.request?.access === "tool") {
      return [
        { choice: "deny", label: "Deny tool call" },
        { choice: "once", label: "Allow this call once" },
        {
          choice: "session",
          label: `Allow this tool from ${safeTerminalText(this.request.sourceName)} for this session`,
        },
      ];
    }
    return [
      { choice: "deny", label: "Deny" },
      { choice: "once", label: `Allow ${this.request?.access} once` },
      {
        choice: "session",
        label: `Allow ${this.request?.access} in folder for this session`,
      },
    ];
  }

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
    let body =
      this.request.access === "mcp" || this.request.access === "tool"
        ? [
            tone(
              this.request.access === "mcp"
                ? `Rook recommends an MCP call · ${safeTerminalText(this.request.serverName)}`
                : `Unclassified tool call · ${safeTerminalText(this.request.sourceName)}`,
              "amber",
              true,
            ),
            ...wrapTextWithAnsi(
              tone(
                this.request.access === "mcp"
                  ? "This external MCP server may access data or perform actions outside Rook's workspace policy."
                  : "Rook has no policy classification for this registered tool. Review its arguments before allowing it.",
                "amber",
              ),
              width,
            ),
            ...wrapTextWithAnsi(
              `Tool: ${safeTerminalText(this.request.toolName)}`,
              width,
            ),
            ...(this.request.reason
              ? wrapTextWithAnsi(
                  `Why approval: ${safeTerminalText(this.request.reason)}`,
                  width,
                )
              : []),
            ...wrapTextWithAnsi(
              `Arguments: ${safeTerminalText(this.request.inputSummary)}`,
              width,
            ),
          ]
        : this.request.access === "execute"
          ? [
              tone("Run terminal command · bash", "amber", true),
              ...wrapTextWithAnsi(
                tone(
                  this.request.sandboxed
                    ? "Runs in an OS sandbox: writes are limited to the workspace and temporary directory; network access is disabled."
                    : "Runs on your host, NOT sandboxed: can access files outside the project, credentials, and network (explicit policy opt-out).",
                  "amber",
                ),
                width,
              ),
              ...wrapTextWithAnsi(
                `Why approval: ${safeTerminalText(this.request.reason ?? "Command needs review.")}`,
                width,
              ),
              ...wrapTextWithAnsi(
                `Command: ${JSON.stringify(this.request.command)}`,
                width,
              ),
              ...wrapTextWithAnsi(
                `Cwd: ${JSON.stringify(this.request.path)}`,
                width,
              ),
              `Timeout: ${this.request.timeoutSeconds}s · output: 2000 lines / 50 KiB to model`,
            ]
          : [
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
            ];
    this.canApproveShell = body.length + 4 <= this.availableRows();
    if (this.request.access === "execute" && !this.canApproveShell) {
      body = wrapTextWithAnsi(
        "Command cannot be fully reviewed at this terminal size. Enlarge the terminal or deny and request a shorter command.",
        width,
      );
    }
    const options = this.choices();
    const lines = [
      ...body,
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
    const options = this.choices();
    if (matchesKey(data, "escape")) {
      this.onChoose("deny");
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = (this.selected + options.length - 1) % options.length;
      this.onChange();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % options.length;
      this.onChange();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.onChoose(options[this.selected]?.choice ?? "deny");
      return;
    }
    const shortcut = Number(data);
    if (
      Number.isInteger(shortcut) &&
      shortcut >= 1 &&
      shortcut <= options.length
    ) {
      this.onChoose(options[shortcut - 1]!.choice);
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

class TaskChecklistPanel implements Component {
  private tasks: TaskChecklistItem[] = [];
  private rendered = new Text("", 1, 0);

  setTasks(tasks: TaskChecklistItem[]): void {
    this.tasks = tasks;
  }

  render(width: number): string[] {
    this.rendered.setText(formatTaskChecklist(this.tasks, width - 2));
    return this.rendered.render(width);
  }

  invalidate(): void {
    this.rendered.invalidate();
  }
}

class SlashCommandSuggestionPanel implements Component {
  private suggestions: SlashCommandSuggestion[] = [];
  private selectedIndex = 0;

  setSuggestions(suggestions: SlashCommandSuggestion[]): void {
    this.suggestions = suggestions;
    this.selectedIndex = 0;
  }

  get isOpen(): boolean {
    return this.suggestions.length > 0;
  }

  selected(): SlashCommandSuggestion | undefined {
    return this.suggestions[this.selectedIndex];
  }

  moveSelection(direction: -1 | 1): void {
    if (!this.suggestions.length) return;
    this.selectedIndex =
      (this.selectedIndex + direction + this.suggestions.length) %
      this.suggestions.length;
  }

  render(width: number): string[] {
    if (width <= 0 || !this.suggestions.length) return [];
    const visibleCount = Math.min(5, this.suggestions.length);
    const firstIndex = Math.min(
      Math.max(0, this.selectedIndex - visibleCount + 1),
      this.suggestions.length - visibleCount,
    );
    return [
      tone("COMMANDS · Tab/Shift+Tab choose · Enter accept", "dim"),
      ...this.suggestions
        .slice(firstIndex, firstIndex + visibleCount)
        .map((suggestion, offset) => {
          const index = firstIndex + offset;
          const selected = index === this.selectedIndex;
          const command = safeTerminalText(suggestion.command);
          const description = safeTerminalText(suggestion.description);
          const line = `${selected ? "›" : " "} ${tone(command, selected ? "text" : "blue", selected)}  ${tone(description, "muted")}`;
          return truncateToWidth(line, width);
        }),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

interface ModelPickerItem {
  value: string;
  label: string;
  provider: string;
  description?: string;
  current?: boolean;
}

interface ModelProviderFolder {
  provider: string;
  models: ModelPickerItem[];
}

type ModelPickerRow =
  | { kind: "provider"; provider: string }
  | { kind: "model"; provider: string; model: ModelPickerItem };

class SearchableModelList implements Component {
  readonly capturesViewportInput = true;
  private folders: ModelProviderFolder[];
  private expandedProviders: Set<string>;
  private rows: ModelPickerRow[] = [];
  private renderedRows: (ModelPickerRow | undefined)[] = [];
  private selectedIndex = 0;
  private readonly initialProvider: string;

  constructor(
    folders: ModelProviderFolder[],
    initialProvider: string,
    private readonly onSelect: (value: string) => void,
    private readonly onCancel: () => void,
    selectFirstModel = false,
  ) {
    this.folders = folders;
    this.initialProvider = initialProvider;
    this.expandedProviders = new Set([initialProvider]);
    this.rebuildRows();
    const currentModelIndex = this.rows.findIndex(
      (row) => row.kind === "model" && row.model.current,
    );
    if (currentModelIndex >= 0) this.selectedIndex = currentModelIndex;
    else if (selectFirstModel) {
      const firstModelIndex = this.rows.findIndex(
        (row) => row.kind === "model",
      );
      if (firstModelIndex >= 0) this.selectedIndex = firstModelIndex;
    }
  }

  setFolders(folders: ModelProviderFolder[], query: string): void {
    this.folders = folders;
    this.expandedProviders = query.trim()
      ? new Set(folders.map((folder) => folder.provider))
      : new Set([this.initialProvider]);
    this.rebuildRows();
    const firstModel = query.trim()
      ? this.rows.findIndex((row) => row.kind === "model")
      : -1;
    this.selectedIndex = firstModel >= 0 ? firstModel : 0;
  }

  private rebuildRows(): void {
    this.rows = [];
    for (const folder of this.folders) {
      this.rows.push({ kind: "provider", provider: folder.provider });
      if (this.expandedProviders.has(folder.provider)) {
        this.rows.push(
          ...folder.models.map((model) => ({
            kind: "model" as const,
            provider: folder.provider,
            model,
          })),
        );
      }
    }
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, this.rows.length - 1),
    );
  }

  private rowKey(row: ModelPickerRow | undefined): string | undefined {
    if (!row) return undefined;
    return row.kind === "provider"
      ? `provider:${row.provider}`
      : `model:${row.model.value}`;
  }

  private toggleFolder(provider: string): void {
    const selectedKey = this.rowKey(this.rows[this.selectedIndex]);
    if (this.expandedProviders.has(provider)) {
      this.expandedProviders.delete(provider);
    } else {
      this.expandedProviders.add(provider);
    }
    this.rebuildRows();
    const preservedIndex = this.rows.findIndex(
      (row) => this.rowKey(row) === selectedKey,
    );
    const folderIndex = this.rows.findIndex(
      (row) => row.kind === "provider" && row.provider === provider,
    );
    this.selectedIndex = preservedIndex >= 0 ? preservedIndex : folderIndex;
  }

  private moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.rows.length) % this.rows.length;
  }

  private activateSelection(): void {
    const row = this.rows[this.selectedIndex];
    if (row?.kind === "provider") {
      this.toggleFolder(row.provider);
    } else if (row?.kind === "model") {
      this.onSelect(row.model.value);
    }
  }

  render(width: number): string[] {
    const maxVisible = 10;
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.rows.length - maxVisible,
      ),
    );
    const end = Math.min(start + maxVisible, this.rows.length);
    const visibleRows = this.rows.slice(start, end);
    const lines: string[] = [];
    this.renderedRows = [];
    if (this.rows.length === 0) {
      lines.push(tone("  No matching providers or models", "dim"));
      this.renderedRows.push(undefined);
      return lines;
    }
    if (start > 0) {
      lines.push(tone(`  ↑ ${start} earlier rows`, "dim"));
      this.renderedRows.push(undefined);
    }
    for (const [offset, row] of visibleRows.entries()) {
      const selected = start + offset === this.selectedIndex;
      if (row.kind === "provider") {
        const folder = this.folders.find(
          (candidate) => candidate.provider === row.provider,
        );
        const expanded = this.expandedProviders.has(row.provider);
        const icon = expanded ? "▾" : "▸";
        const label = `  ${selected ? "›" : " "} ${icon}  ${row.provider}/`;
        const count = tone(
          `${folder?.models.length ?? 0} ${(folder?.models.length ?? 0) === 1 ? "model" : "models"}`,
          "muted",
        );
        const line = `${selected ? selectListTheme.selectedText(label) : tone(label, "blue", true)}  ${count}`;
        lines.push(truncateToWidth(line, width));
      } else {
        const folder = this.folders.find(
          (candidate) => candidate.provider === row.provider,
        );
        const isLast = folder?.models.at(-1)?.value === row.model.value;
        const prefix = `      ${isLast ? "└─" : "├─"} `;
        const label = selected
          ? selectListTheme.selectedText(`${prefix}${row.model.label}`)
          : `${prefix}${row.model.label}`;
        const metadata = tone(row.model.description ?? "", "muted");
        const current = row.model.current
          ? tone("  ·  current", "green", true)
          : "";
        lines.push(truncateToWidth(`${label}  ${metadata}${current}`, width));
      }
      this.renderedRows.push(row);
    }
    if (end < this.rows.length) {
      lines.push(tone(`  ↓ ${this.rows.length - end} more rows`, "dim"));
      this.renderedRows.push(undefined);
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.moveSelection(-1);
    else if (matchesKey(data, "down")) this.moveSelection(1);
    else if (matchesKey(data, "pageUp")) this.moveSelection(-10);
    else if (matchesKey(data, "pageDown")) this.moveSelection(10);
    else if (matchesKey(data, "enter")) this.activateSelection();
    else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancel();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const previous = this.selectedIndex;
      this.moveSelection(event.wheelDelta && event.wheelDelta < 0 ? 1 : -1);
      return { handled: true, render: previous !== this.selectedIndex };
    }
    const row = this.renderedRows[event.y];
    if (!row || event.button !== "left") return undefined;
    const rowIndex = this.rows.findIndex(
      (candidate) => this.rowKey(candidate) === this.rowKey(row),
    );
    if (rowIndex < 0) return undefined;
    this.selectedIndex = rowIndex;
    if (event.type === "press") {
      return { handled: true, focus: true, render: true };
    }
    if (event.type === "click") {
      if (row.kind === "provider") this.toggleFolder(row.provider);
      else this.onSelect(row.model.value);
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {}
}

class RoundedModal extends Container {
  render(width: number): string[] {
    const safeWidth = Math.max(2, width);
    const insideWidth = safeWidth - 2;
    const horizontal = "─".repeat(Math.max(0, safeWidth - 2));
    const content = super.render(insideWidth).map((line) => {
      const clipped = truncateToWidth(line, insideWidth);
      return `${tone("│", "border")}${clipped}${" ".repeat(Math.max(0, insideWidth - visibleWidth(clipped)))}${tone("│", "border")}`;
    });
    return [
      tone(`╭${horizontal}╮`, "border"),
      ...content,
      tone(`╰${horizontal}╯`, "border"),
    ];
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    if (event.y <= 0 || event.y >= event.height - 1) return undefined;
    return super.handleMouse({
      ...event,
      x: event.x - 1,
      y: event.y - 1,
      width: Math.max(1, event.width - 2),
      height: Math.max(1, event.height - 2),
    });
  }
}

class ModalSeparator implements Component {
  render(width: number): string[] {
    return [tone("─".repeat(width), "border")];
  }

  invalidate(): void {}
}

export function createRookTui(options: RookTuiOptions): RookTuiController {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const transcript = new Container();
  const home = new HomeScreenBody();
  transcript.addChild(home);

  const header = new Header(resolve(options.cwd), options.branch);
  const scrollView = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const checklistSidebar = new TaskChecklistPanel();
  const compactChecklist = new TaskChecklistPanel();
  const mainContent = new HStack(
    [
      { component: scrollView, basis: 0, grow: 1, minSize: 1 },
      {
        component: checklistSidebar,
        basis: CHECKLIST_SIDEBAR_WIDTH,
        shrink: 0,
        visible: ({ width }) =>
          width >= CHECKLIST_SIDEBAR_MIN_WIDTH &&
          !transcript.children.includes(home),
      },
    ],
    { gap: 1, align: "start" },
  );
  const editor = new PromptEditor(tui, editorTheme, { paddingX: 0 });
  const slashSuggestions = new SlashCommandSuggestionPanel();
  const promptHistory: string[] = [];
  let historyIndex = -1;
  let historyDraft = "";
  let changingHistory = false;
  let acceptingSlashSuggestion = false;
  let dismissedSuggestionText: string | undefined;
  let modalInputHandler: ((data: string) => void) | undefined;
  let modalInputCaptureAll = false;

  const suggestionsFor = (text: string): SlashCommandSuggestion[] => {
    const query = text.trimStart();
    if (!query.startsWith("/") || /\s/.test(query)) return [];
    const resources: SlashCommandSuggestion[] = [
      ...options.gateway.listSkills().map((skill) => ({
        command: `/skill:${skill.name}`,
        description: skill.description,
      })),
      ...options.gateway.listPromptTemplates().map((template) => ({
        command: `/${template.name}`,
        description: template.description,
      })),
    ];
    const unique = new Map<string, SlashCommandSuggestion>();
    for (const suggestion of [...BUILTIN_SLASH_COMMANDS, ...resources]) {
      if (suggestion.command.startsWith(query)) {
        unique.set(suggestion.command, suggestion);
      }
    }
    return [...unique.values()];
  };

  const updateSlashSuggestions = (text: string): void => {
    slashSuggestions.setSuggestions(
      changingHistory ||
        historyIndex >= 0 ||
        acceptingSlashSuggestion ||
        text === dismissedSuggestionText
        ? []
        : suggestionsFor(text),
    );
  };

  const externalAccessPanel = new ExternalAccessPromptPanel(
    () => tui.requestRender(),
    () => {
      const width = Math.max(1, terminal.columns - SCREEN_GUTTER * 2);
      return (
        terminal.rows -
        1 -
        header.render(width).length -
        editor.render(width).length -
        loadingIndicator.render(width).length -
        shortcuts.render(width).length -
        footerDivider.render(width).length -
        footer.render(width).length -
        bottomMargin.render(width).length -
        slashSuggestions.render(width).length -
        (terminal.columns < CHECKLIST_SIDEBAR_MIN_WIDTH
          ? compactChecklist.render(width).length
          : 0)
      );
    },
  );
  const loadingIndicator = new Text("", 1, 0);
  const footer = new Text("", 1, 0);
  const footerDivider = new Text("", 1, 0);
  const shortcuts = new FooterShortcuts();
  const bottomMargin = new BottomMargin();
  const bottom = new VStack([
    slashSuggestions,
    {
      component: compactChecklist,
      basis: "auto",
      shrink: 0,
      visible: ({ width }) => width < CHECKLIST_SIDEBAR_MIN_WIDTH,
    },
    loadingIndicator,
    externalAccessPanel,
    editor,
    shortcuts,
    footerDivider,
    footer,
    bottomMargin,
  ]);
  const screenContent = new VStack([
    { component: header, basis: "auto", shrink: 0 },
    { component: mainContent, basis: "auto", grow: 1, minSize: 1 },
    { component: bottom, basis: "auto", shrink: 0, minSize: 3 },
  ]);
  // Native layout gutters preserve viewport sizing, scroll, and mouse routing.
  // They can shrink away on extremely narrow terminals instead of clipping input.
  tui.setLayoutRoot(
    new HStack([
      { component: new Text("", 0, 0), basis: SCREEN_GUTTER, minSize: 0 },
      { component: screenContent, basis: 0, grow: 1, shrink: 0, minSize: 1 },
      { component: new Text("", 0, 0), basis: SCREEN_GUTTER, minSize: 0 },
    ]),
  );
  tui.setFocus(editor);

  let state: AppState = reduceAppState(initialAppState(), {
    type: "startup_complete",
  });
  state = reduceAppState(state, { type: "mode_changed", mode: "plan" });
  const initialModel = options.gateway.currentModel();
  let modelLabel = initialModel?.name ?? "no model selected";
  let providerLabel = initialModel?.provider ?? "—";
  let settled = false;
  let resolveRun: (() => void) | undefined;
  const toolCards = new Map<string, Text>();
  let activeResponse: Markdown | undefined;
  let activeResponseText = "";
  let activeInference:
    | {
        startedAt: number;
        timings: InferenceTimings;
        inputTokens?: number;
        outputTokens?: number;
      }
    | undefined;
  const permissionQueue: {
    request: ExternalAccessRequest;
    resolve: (choice: ExternalAccessChoice) => void;
  }[] = [];
  let loadingTimer: ReturnType<typeof setInterval> | undefined;
  let loadingWordTimer: ReturnType<typeof setInterval> | undefined;
  let loadingWordOrder: string[] = [];
  let loadingWordIndex = 0;
  let loadingDotTick = 0;
  let activeLoadingWord = "";
  let lastLoadingWord: string | undefined;
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
    const width = Math.max(1, terminal.columns - SCREEN_GUTTER * 2);
    const context = state.usage?.inputTokens;
    const compactCount = (value: number | undefined): string =>
      value === undefined
        ? "—"
        : value >= 1000
          ? `${(value / 1000).toFixed(1)}k`
          : String(value);
    footerDivider.setText(tone("─".repeat(Math.max(0, width - 4)), "border"));
    const mode =
      state.mode.toUpperCase() + (state.mode === "plan" ? " (read-only)" : "");
    const memory = options.memoryCapture ? "ready" : "unavailable";
    const footerText =
      width >= 120
        ? `${tone("Rook v0.1.0", "muted")}  │  ${tone("Model:", "muted")} ${tone(modelLabel, "text")}  │  ${tone("Provider:", "muted")} ${tone(providerLabel, "text")}  │  ${tone("Mode:", "muted")} ${tone(mode, state.mode === "plan" ? "blue" : "amber", true)}  │  ${tone("Context:", "muted")} ${tone(compactCount(context), "text")}  │  ${tone("Memory:", "muted")} ${tone(memory, options.memoryCapture ? "green" : "dim", Boolean(options.memoryCapture))}`
        : `${tone("Rook v0.1.0", "muted")}  │  ${tone(modelLabel, "text")}  │  ${tone(providerLabel, "text")}  │  ${tone(state.mode.toUpperCase(), state.mode === "plan" ? "blue" : "amber", true)}  │  ${tone(`Ctx ${compactCount(context)}`, "muted")}  │  ${tone(`Mem ${memory}`, options.memoryCapture ? "green" : "dim")}`;
    footer.setText(truncateToWidth(footerText, Math.max(0, width - 2)));
    tui.requestRender();
  };
  const updateHomeDashboard = (): void => {
    const memoryStatus = options.memoryCapture?.status();
    const snapshot = options.snapshot;
    home.setDashboardData({
      cwd: resolve(options.cwd),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.repository
        ? {
            repositoryName: options.repository.displayName,
            repositoryId: options.repository.id,
          }
        : {}),
      mode: state.mode,
      ...(memoryStatus ? { memoryCount: memoryStatus.total } : {}),
      ...(snapshot
        ? { snapshotDirty: snapshot.dirtyFingerprint !== null }
        : {}),
      recentActivity:
        options.repository?.kind === "git"
          ? captureRecentCommits(options.repository.root)
          : [],
      onModeChange: (mode) => {
        if (
          state.mode === mode ||
          activeInference ||
          options.gateway.isRunning()
        )
          return;
        options.gateway.setMode(mode);
        state = reduceAppState(state, { type: "mode_changed", mode });
        updateHomeDashboard();
        updateFooter();
      },
    });
    tui.requestRender();
  };
  updateHomeDashboard();
  updateFooter();

  function startLoadingStatus(reset = false): void {
    stopLoadingStatus();
    if (reset) {
      loadingWordOrder = shuffleLoadingWords(Math.random, lastLoadingWord);
      loadingWordIndex = 0;
      loadingDotTick = 0;
      activeLoadingWord = "";
    }
    const updateLabel = (): void => {
      if (loadingWordIndex >= loadingWordOrder.length) {
        loadingWordOrder = shuffleLoadingWords(Math.random, lastLoadingWord);
        loadingWordIndex = 0;
      }
      activeLoadingWord = loadingWordOrder[loadingWordIndex]!;
      loadingWordIndex += 1;
      lastLoadingWord = activeLoadingWord;
      update();
    };
    const update = (): void => {
      loadingStatus = `Rook is ${activeLoadingWord}${".".repeat(loadingDotTick + 1)}`;
      loadingDotTick = (loadingDotTick + 1) % 3;
      loadingIndicator.setText(tone(`♜ ${loadingStatus}`, "blue"));
      tui.requestRender();
    };
    updateLabel();
    loadingTimer = setInterval(update, LOADING_DOT_INTERVAL_MS);
    loadingWordTimer = setInterval(updateLabel, LOADING_WORD_INTERVAL_MS);
  }

  function stopLoadingStatus(): void {
    if (loadingTimer) clearInterval(loadingTimer);
    if (loadingWordTimer) clearInterval(loadingWordTimer);
    loadingTimer = undefined;
    loadingWordTimer = undefined;
    loadingStatus = undefined;
    loadingIndicator.setText("");
    tui.requestRender();
  }

  function finishInference(inference = activeInference): void {
    if (!inference || inference !== activeInference) return;
    activeInference = undefined;
    const { startedAt, timings, ...usage } = inference;
    transcript.addChild(
      new InferenceStatsLine({
        ...usage,
        ...timings.finish(performance.now()),
        elapsedMs: performance.now() - startedAt,
      }),
    );
    tui.requestRender();
  }

  const unsubscribe = options.gateway.subscribe((event) => {
    if (event.type === "model_request_started") {
      activeInference?.timings.request();
      if (activeInference) startLoadingStatus();
    } else if (event.type === "text_delta") {
      activeInference?.timings.response(performance.now());
      stopLoadingStatus();
      state = reduceAppState(state, event);
      activeResponseText += event.text;
      ensureActiveResponse().setText(activeResponseText);
      tui.requestRender();
    } else if (event.type === "message_complete") {
      stopLoadingStatus();
      state = { ...reduceAppState(state, event), error: null };
      if (event.text) {
        activeResponseText = event.text;
        ensureActiveResponse().setText(activeResponseText);
      }
      activeResponse = undefined;
      activeResponseText = "";
      tui.requestRender();
    } else if (event.type === "tool_started") {
      activeInference?.timings.tool(event.id, true, performance.now());
      stopLoadingStatus();
      loadingIndicator.setText(tone(`♜ Running tool · ${event.name}`, "blue"));
      activeResponse = undefined;
      activeResponseText = "";
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
      activeInference?.timings.tool(event.id, false, performance.now());
      state = reduceAppState(state, {
        type: "tool_finished",
        id: event.id,
        status: event.status,
      });
      const tool = state.tools.find((candidate) => candidate.id === event.id);
      const card = toolCards.get(event.id);
      if (tool && card) {
        const hint = event.error ? ` · ${event.error}` : "";
        card.setText(
          formatToolCard(tool.name, tool.summary, tool.status) + hint,
        );
      }
      toolCards.delete(event.id);
      loadingIndicator.setText("");
      if (state.runState === "running") startLoadingStatus();
      tui.requestRender();
    } else if (event.type === "todo_updated") {
      checklistSidebar.setTasks(event.tasks);
      compactChecklist.setTasks(event.tasks);
      tui.requestRender();
    } else if (event.type === "usage") {
      // Pi reports usage once per assistant message, including tool-call turns.
      if (activeInference) {
        if (event.inputTokens !== undefined) {
          activeInference.inputTokens =
            (activeInference.inputTokens ?? 0) + event.inputTokens;
        }
        if (event.outputTokens !== undefined) {
          activeInference.outputTokens =
            (activeInference.outputTokens ?? 0) + event.outputTokens;
        }
      }
      state = reduceAppState(state, event);
      updateFooter();
    } else if (event.type === "run_settled") {
      stopLoadingStatus();
      state = reduceAppState(state, {
        type: "run_state",
        state: state.error ? "failed" : "settled",
      });
      if (event.aborted) appendText("Run cancelled.", "muted");
      finishInference();
      updateFooter();
    } else if (event.type === "error") {
      stopLoadingStatus();
      state = reduceAppState(state, event);
      // A retryable provider error does not mean Pi has released the run.
      if (options.gateway.isRunning() || activeInference)
        state = reduceAppState(state, { type: "run_state", state: "running" });
      appendText(event.message, "error");
      activeResponse = undefined;
      activeResponseText = "";
      updateFooter();
    }
  });

  function ensureActiveResponse(): Markdown {
    if (!activeResponse) {
      activeResponse = new Markdown("", 2, 0, markdownTheme, {
        color: (content) => tone(content, "text"),
      });
      transcript.addChild(activeResponse);
    }
    return activeResponse;
  }

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

  const openHome = (): void => {
    if (!transcript.children.includes(home)) {
      for (const child of [...transcript.children])
        transcript.removeChild(child);
      transcript.addChild(home);
    }
    updateHomeDashboard();
    tui.requestRender();
  };

  const submitPrompt = async (text: string): Promise<void> => {
    const prompt = text.trim();
    if (!prompt) return;
    const command = prompt.split(/\s+/, 1)[0];
    let inferencePrompt = prompt;
    let restoreMode: RookMode | undefined;
    const canQueueInput = command === "/steer" || command === "/follow-up";
    if (
      (activeInference || options.gateway.isRunning()) &&
      prompt !== "/cancel" &&
      !canQueueInput
    ) {
      if (!prompt.startsWith("/")) {
        try {
          await options.gateway.send(prompt, "follow_up");
          appendText(`Queued follow-up: ${prompt}`, "user");
        } catch (error) {
          appendText(
            `Follow-up not queued: ${prompt}\n${errorMessage(error)}`,
            "error",
          );
        }
      } else
        appendText(
          "A response is still running. Use /cancel, /steer, or /follow-up.",
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
            "Available: /help, /login, /logout, /model, /settings, /plyth, /mcp, /new, /sessions, /resume, /fork, /compact, /skills, /prompts, /ask <question>, /explore <question>, /architect <task>, /agents [name <task>], /steer <text>, /follow-up <text>, /plan, /build, /permissions [revoke <grant-id>], /diff, /review, /undo [confirm], /memory status|show|detail|verify|refresh|pause|resume|opt-out|opt-in|pending|confirm|cancel|forget, /cancel, /exit",
            "muted",
          );
          return;
        case "/ask": {
          inferencePrompt = prompt.slice("/ask".length).trim();
          if (!inferencePrompt) {
            appendText("Usage: /ask <read-only question>", "error");
            return;
          }
          restoreMode = state.mode;
          break;
        }
        case "/diff":
          removeHome();
          try {
            appendText(
              safeTerminalText(await options.gateway.inspectGitChanges()),
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        case "/review":
          removeHome();
          appendText(
            "Running a separate read-only review of current changes…",
            "muted",
          );
          try {
            appendText(
              safeTerminalText(await options.gateway.reviewGitChanges()),
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        case "/explore": {
          const task = prompt.slice("/explore".length).trim();
          if (!task) {
            appendText("Usage: /explore <read-only question>", "error");
            return;
          }
          removeHome();
          appendText("Exploring in a fresh read-only session…", "muted");
          try {
            appendText(
              safeTerminalText(await options.gateway.exploreReadOnly(task)),
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        }
        case "/architect": {
          const task = prompt.slice("/architect".length).trim();
          if (!task) {
            appendText("Usage: /architect <implementation task>", "error");
            return;
          }
          removeHome();
          appendText(
            "Preparing a proposal in a fresh read-only session…",
            "muted",
          );
          try {
            appendText(
              safeTerminalText(await options.gateway.architectReadOnly(task)),
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        }
        case "/agents": {
          const agents = options.gateway.listSubagents();
          const request = prompt.slice("/agents".length).trim();
          if (!request) {
            appendText(
              agents.length
                ? `Configured read-only subagents:\n${agents.map((agent) => `  /agents ${agent.name} <task> — ${agent.description}`).join("\n")}`
                : "No project subagents configured. Add read-only profiles to .rook/agents.json.",
              "muted",
            );
            return;
          }
          if (request.length > 4_200) {
            appendText(
              "Subagent tasks are limited to 4,200 characters.",
              "error",
            );
            return;
          }
          const [name, ...taskParts] = request.split(/\s+/);
          const task = taskParts.join(" ").trim();
          if (!task) {
            appendText("Usage: /agents <name> <task>", "error");
            return;
          }
          if (!agents.some((agent) => agent.name === name)) {
            appendText(
              `Unknown subagent '${name}'. Use /agents to list configured agents.`,
              "error",
            );
            return;
          }
          removeHome();
          appendText(
            `Running read-only subagent '${name}' in fresh context…`,
            "muted",
          );
          try {
            appendText(
              safeTerminalText(await options.gateway.runSubagent(name!, task)),
              "muted",
            );
          } catch (error) {
            appendText(errorMessage(error), "error");
          }
          return;
        }
        case "/undo":
          removeHome();
          if (prompt === "/undo") {
            appendText(options.gateway.getUndoPreview(), "muted");
            return;
          }
          if (prompt === "/undo confirm") {
            appendText(await options.gateway.undoLastFileChange(), "muted");
            return;
          }
          appendText("Usage: /undo [confirm]", "error");
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
        case "/plyth": {
          removeHome();
          const stats = options.gateway.getPlythStats();
          appendText(
            `PLYTH observe-only · eligible ${stats.eligibleCommands} · predicted ${stats.predictedCommands} · invalid ${stats.invalidPredictions} · specific ${stats.specificPredictions}\nhit ${stats.verdicts.hit} · miss ${stats.verdicts.miss} · vague ${stats.verdicts.vague} · none ${stats.verdicts.none} · unscorable ${stats.verdicts.unscorable}\ncommand time ${stats.durationMs}ms across ${stats.durationSamples} commands`,
            "muted",
          );
          return;
        }
        case "/permissions":
          if (prompt === "/permissions") {
            showPermissionDecisions();
          } else if (prompt === "/permissions revoke") {
            appendText("Usage: /permissions revoke <grant-id>", "error");
          } else if (prompt.startsWith("/permissions revoke ")) {
            revokeExternalGrant(prompt.slice("/permissions revoke ".length));
          } else {
            appendText("Usage: /permissions [revoke <grant-id>]", "error");
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
        case "/instructions": {
          removeHome();
          const files =
            (await options.gateway.listRepositoryInstructions?.()) ?? [];
          appendText(
            files.length
              ? `Loaded repository instructions:\n${files.map((path) => `  ${safeTerminalText(path)}`).join("\n")}`
              : "No applicable AGENTS.md files were loaded.",
            "muted",
          );
          return;
        }
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
          openHome();
          updateFooter();
          return;
        case "/build":
          state = reduceAppState(state, {
            type: "mode_changed",
            mode: "build",
          });
          options.gateway.setMode("build");
          openHome();
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
          openHome();
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
    if (restoreMode) {
      options.gateway.setMode("plan");
      state = reduceAppState(state, { type: "mode_changed", mode: "plan" });
    }
    state = reduceAppState(state, { type: "prompt_submitted" });
    if (state.runState !== "running") return;
    appendText(`› ${prompt}`, "user");
    activeResponse = undefined;
    activeResponseText = "";
    const startedAt = performance.now();
    const inference = { startedAt, timings: new InferenceTimings(startedAt) };
    activeInference = inference;
    startLoadingStatus(true);
    updateFooter();
    try {
      await options.gateway.send(inferencePrompt);
      if (state.runState === "running") {
        state = reduceAppState(state, {
          type: "run_state",
          state: state.error ? "failed" : "settled",
        });
      }
    } catch (error) {
      if (!state.error) {
        state = reduceAppState(state, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        ensureActiveResponse().setText(
          tone(state.error ?? "Request failed", "error"),
        );
      }
    } finally {
      if (state.runState === "running")
        state = reduceAppState(state, {
          type: "run_state",
          state: state.error ? "failed" : "settled",
        });
      stopLoadingStatus();
      // Fallback for gateways that finish or throw without run_settled.
      finishInference(inference);
      activeResponse = undefined;
      activeResponseText = "";
      if (restoreMode) {
        options.gateway.setMode(restoreMode);
        state = reduceAppState(state, {
          type: "mode_changed",
          mode: restoreMode,
        });
      }
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
        if (!args[0] || args.length > 2 || (args[1] && args[1] !== "confirm")) {
          appendText("Usage: /memory verify <memory-id> [confirm]", "error");
          return;
        }
        appendText(
          safeTerminalText(await memory.verify(args[0], args[1] === "confirm")),
          "muted",
        );
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
          "Usage: /memory [status|show|detail <id>|verify <id> [confirm]|refresh|pause|resume|opt-out|opt-in|pending|confirm <id>|cancel <id>|forget <id> confirm]. Review a memory claim and its evidence before running `/memory verify <id> confirm`. Use `remember: <claim>` in a prompt to request a memory, then confirm its pending ID.",
          "muted",
        );
    }
  }

  async function showModelMenu(providerScope?: string): Promise<void> {
    try {
      const models = await options.gateway.listModels();
      const scopedModels = providerScope
        ? models.filter((model) => model.provider === providerScope)
        : models;
      if (scopedModels.length === 0) {
        removeHome();
        const providerName =
          options.gateway
            .listProviders()
            .find((provider) => provider.id === providerScope)?.name ??
          providerScope;
        appendText(
          providerScope
            ? `Signed in, but Pi has no available models for ${providerName} yet.`
            : "Pi did not report any models in its current catalog.",
          "muted",
        );
        return;
      }
      showModelPicker(scopedModels, providerScope);
    } catch (error) {
      appendText(errorMessage(error), "error");
    }
  }

  function showModelPicker(models: ModelInfo[], providerScope?: string): void {
    const scopeLabel = providerScope
      ? (options.gateway
          .listProviders()
          .find((provider) => provider.id === providerScope)?.name ??
        providerScope)
      : undefined;
    const currentModel = options.gateway.currentModel();
    const sortedModels = [...models].sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
    const foldersFor = (query: string): ModelProviderFolder[] => {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const matches = sortedModels
        .filter((model) =>
          [model.name, model.provider, model.id]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
        .map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: model.name,
          provider: model.provider,
          description: model.id,
          current: Boolean(
            currentModel &&
              model.provider === currentModel.provider &&
              model.id === currentModel.id,
          ),
        }));
      const providers = [...new Set(matches.map((model) => model.provider))];
      return providers.map((provider) => ({
        provider,
        models: matches.filter((model) => model.provider === provider),
      }));
    };
    const searchEditor = new Editor(tui, editorTheme, { paddingX: 1 });
    let hideOverlay = (): void => {};
    const initialProvider =
      providerScope ??
      currentModel?.provider ??
      sortedModels[0]?.provider ??
      "";
    const list = new SearchableModelList(
      foldersFor(""),
      initialProvider,
      (value) => {
        hideOverlay();
        const model = sortedModels.find(
          (candidate) => `${candidate.provider}/${candidate.id}` === value,
        );
        if (model) void selectModel(model);
      },
      () => hideOverlay(),
      providerScope !== undefined,
    );
    const providerCount = new Set(sortedModels.map((model) => model.provider))
      .size;
    const modelSummary = new Text(
      tone(
        `${models.length.toLocaleString()} models · ${providerCount} provider folders`,
        "muted",
      ),
      1,
      0,
    );
    searchEditor.onChange = (query) => {
      const matches = foldersFor(query);
      list.setFolders(matches, query);
      const matchCount = matches.reduce(
        (total, folder) => total + folder.models.length,
        0,
      );
      modelSummary.setText(
        tone(
          query.trim()
            ? `${matchCount.toLocaleString()} matches · ${matches.length} provider folders`
            : `${models.length.toLocaleString()} models · ${providerCount} provider folders`,
          "muted",
        ),
      );
      tui.requestRender();
    };
    const content = new VStack([
      new Text(
        tone(
          providerScope ? `Choose a model · ${scopeLabel}` : "Choose a model",
          "text",
          true,
        ),
        1,
        0,
      ),
      modelSummary,
      new Text(tone("⌕  Search by name, provider, or model ID", "dim"), 1, 0),
      searchEditor,
      new ModalSeparator(),
      list,
      new ModalSeparator(),
      new Text(
        tone("↑/↓ navigate   Enter open/select   Esc close", "dim"),
        1,
        0,
      ),
    ]);
    const panel = new RoundedModal();
    panel.addChild(content);
    const overlay = tui.showOverlay(panel, {
      anchor: "center",
      width: "84%",
      minWidth: 58,
      maxHeight: "90%",
      margin: SCREEN_GUTTER,
    });
    const handleModelPickerInput = (data: string): void =>
      list.handleInput(data);
    hideOverlay = () => {
      overlay.hide();
      if (modalInputHandler === handleModelPickerInput) {
        modalInputHandler = undefined;
      }
      tui.setFocus(editor);
    };
    modalInputHandler = handleModelPickerInput;
    tui.setFocus(searchEditor);
  }

  async function selectModel(model: ModelInfo): Promise<void> {
    try {
      await options.gateway.selectModel(model);
      modelLabel = model.name;
      providerLabel = model.provider;
      appendText(`Selected ${providerLabel}/${modelLabel}.`, "muted");
      updateFooter();
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
    const sessionGrants = options.gateway.getSessionPermissionGrants();
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
    if (sessionGrants.length)
      appendText(
        `Session permission grants:\n${formatSessionPermissionGrants(sessionGrants)}`,
        "muted",
      );
    const decisions = options.gateway.getPermissionDecisions();
    if (
      decisions.length === 0 &&
      grants.length === 0 &&
      sessionGrants.length === 0
    ) {
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

  function formatSessionPermissionGrants(
    grants: ReturnType<AgentGateway["getSessionPermissionGrants"]>,
  ): string {
    return grants
      .map((grant) =>
        grant.type === "shell"
          ? `SHELL ${safeTerminalText(JSON.stringify(grant.description))} in ${safeTerminalText(grant.workspace ?? "workspace")} · ${grant.sandboxed ? "sandboxed" : "host"} · /permissions revoke ${grant.id}`
          : `TOOL ${safeTerminalText(grant.description)} from ${safeTerminalText(grant.sourceName)} · /permissions revoke ${grant.id}`,
      )
      .join("\n");
  }

  function revokeExternalGrant(id: string): void {
    const revoked = options.gateway.revokeExternalAccessGrant(id.trim());
    appendText(
      revoked
        ? "Permission grant revoked."
        : "No permission grant matches that ID.",
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
    if (settled) return Promise.resolve("deny");
    return new Promise((resolveChoice) => {
      permissionQueue.push({ request, resolve: resolveChoice });
      showNextPermissionPrompt();
    });
  }

  function showNextPermissionPrompt(): void {
    if (activePermissionPrompt || settled) return;
    const pending = permissionQueue.shift();
    if (!pending) return;
    const operation = pending.request.access;
    const finish = (choice: ExternalAccessChoice): void => {
      if (activePermissionPrompt?.resolve !== pending.resolve) return;
      activeInference?.timings.approval(false, performance.now());
      activePermissionPrompt = undefined;
      externalAccessPanel.clear();
      loadingIndicator.setText("");
      tui.requestRender();
      pending.resolve(choice);
      showNextPermissionPrompt();
    };
    activePermissionPrompt = { resolve: pending.resolve };
    activeInference?.timings.approval(true, performance.now());
    stopLoadingStatus();
    loadingIndicator.setText(tone("♜ Waiting for approval", "blue"));
    externalAccessPanel.show(pending.request, finish);
    tui.requestRender();
    appendText(
      operation === "execute"
        ? "bash requests approval to run a terminal command on your host."
        : operation === "mcp"
          ? `Rook recommends calling MCP tool ${safeTerminalText(pending.request.toolName)}; approval is required before the external call.`
          : operation === "tool"
            ? `Unclassified tool ${safeTerminalText(pending.request.toolName)} requests approval before execution.`
            : `${pending.request.toolName} requests ${operation} access to ${safeTerminalText(pending.request.path)}.`,
      "muted",
    );
  }

  function denyPendingPermissionPrompts(): void {
    const active = activePermissionPrompt;
    if (active) activeInference?.timings.approval(false, performance.now());
    activePermissionPrompt = undefined;
    externalAccessPanel.clear();
    loadingIndicator.setText("");
    tui.requestRender();
    active?.resolve("deny");
    for (const pending of permissionQueue.splice(0)) pending.resolve("deny");
  }

  function renderCurrentSession(): void {
    removeHome();
    for (const child of [...transcript.children]) transcript.removeChild(child);
    toolCards.clear();
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
    updateHomeDashboard();
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
    if (action === "login") {
      const loginOptions = providers.flatMap((provider) =>
        provider.authMethods.map((method) => ({ provider, method })),
      );
      if (!loginOptions.length) {
        removeHome();
        appendText(
          "No registered provider exposes an interactive sign-in method.",
          "muted",
        );
        return;
      }
      showSearchableSelection(
        "Choose provider sign-in method",
        loginOptions.map(({ provider, method }) => ({
          value: JSON.stringify({ providerId: provider.id, type: method.type }),
          label: safeTerminalText(
            `${provider.name} · ${method.loginLabel ?? method.name}`,
          ),
          description:
            method.type === "oauth"
              ? method.isSubscription === false
                ? "OAuth account sign-in"
                : "OAuth subscription sign-in"
              : "API key sign-in",
        })),
        "Search by provider or sign-in method",
        async (value) => {
          const selected = JSON.parse(value) as {
            providerId: string;
            type: ProviderAuthMethod["type"];
          };
          const provider = providers.find(
            (candidate) => candidate.id === selected.providerId,
          );
          const method = provider?.authMethods.find(
            (candidate) => candidate.type === selected.type,
          );
          if (provider && method) await runProviderLogin(provider, method);
        },
      );
      return;
    }
    showSearchableSelection(
      "Select provider to log out",
      providers.map((provider) => ({
        value: provider.id,
        label: safeTerminalText(provider.name),
        description: provider.configured
          ? "configured in Pi"
          : provider.authMethods.length
            ? safeTerminalText(
                `not configured · ${provider.authMethods.map((method) => method.name).join(", ")}`,
              )
            : "not configured",
      })),
      "Search by provider name or ID",
      async (providerId) => {
        const provider = providers.find(
          (candidate) => candidate.id === providerId,
        );
        if (!provider) return;
        try {
          await options.gateway.logout(providerId);
          appendText(`Logged out of ${provider.name} in Pi.`, "muted");
        } catch (error) {
          appendText(errorMessage(error), "error");
        }
      },
    );
  }

  async function runProviderLogin(
    provider: ProviderInfo,
    method: ProviderAuthMethod,
  ): Promise<void> {
    const controller = new AbortController();
    let loginSucceeded = false;
    const dialog = new ProviderAuthDialog(
      tui,
      provider.name,
      () => controller.abort(),
      options.openBrowser ?? openBrowser,
    );
    const handleAuthInput = (data: string): void => dialog.handleInput(data);
    modalInputHandler = handleAuthInput;
    modalInputCaptureAll = true;
    try {
      const interaction: ProviderAuthInteraction = {
        signal: controller.signal,
        prompt: (prompt) =>
          dialog.prompt({
            ...prompt,
            signal: prompt.signal
              ? AbortSignal.any([controller.signal, prompt.signal])
              : controller.signal,
          }),
        notify: (event) => dialog.notify(event),
      };
      await options.gateway.login(provider.id, method.type, interaction);
      appendText(`Signed in to ${provider.name}.`, "muted");
      updateFooter();
      loginSucceeded = true;
    } catch (error) {
      const message = dialog.redact(errorMessage(error));
      appendText(
        controller.signal.aborted || message === "Login cancelled"
          ? `Sign-in to ${provider.name} cancelled.`
          : `Sign-in to ${provider.name} failed: ${message}`,
        controller.signal.aborted || message === "Login cancelled"
          ? "muted"
          : "error",
      );
    } finally {
      dialog.close();
      if (modalInputHandler === handleAuthInput) {
        modalInputHandler = undefined;
        modalInputCaptureAll = false;
      }
      tui.setFocus(editor);
      updateFooter();
    }
    if (loginSucceeded) await showModelMenu(provider.id);
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
    const content = new VStack([
      new Text(tone(title, "text", true), 1, 0),
      new ModalSeparator(),
      list,
      new ModalSeparator(),
      new Text(tone("↑/↓ navigate   Enter select   Esc close", "dim"), 1, 0),
    ]);
    const panel = new RoundedModal();
    panel.addChild(content);
    const overlay = tui.showOverlay(panel, {
      anchor: "center",
      width: "72%",
      minWidth: 48,
      maxHeight: "85%",
      margin: SCREEN_GUTTER,
    });
    const handleSelectionInput = (data: string): void => list.handleInput(data);
    const hide = (): void => {
      overlay.hide();
      if (modalInputHandler === handleSelectionInput) {
        modalInputHandler = undefined;
        modalInputCaptureAll = false;
      }
      tui.setFocus(editor);
    };
    list.onSelect = (item) => {
      hide();
      void onSelect(item.value);
    };
    list.onCancel = () => {
      hide();
      onCancel?.();
    };
    modalInputHandler = handleSelectionInput;
    modalInputCaptureAll = false;
    tui.setFocus(list);
    return hide;
  }

  function showSearchableSelection(
    title: string,
    items: { value: string; label: string; description?: string }[],
    searchHint: string,
    onSelect: (value: string) => void | Promise<void>,
    onCancel?: () => void,
  ): () => void {
    const searchEditor = new Editor(tui, editorTheme, { paddingX: 1 });
    const resultSummary = new Text(
      tone(`${items.length} options`, "muted"),
      1,
      0,
    );
    const listContainer = new Container();
    let list: SelectList;
    let hide = (): void => {};
    const filteredItems = (query: string) => {
      const normalized = query.trim().toLocaleLowerCase();
      return normalized
        ? items.filter((item) =>
            [item.label, item.value, item.description ?? ""].some((field) =>
              field.toLocaleLowerCase().includes(normalized),
            ),
          )
        : items;
    };
    const updateList = (query: string): void => {
      const filtered = filteredItems(query);
      resultSummary.setText(
        tone(
          query.trim()
            ? `${filtered.length} matches`
            : `${items.length} options`,
          "muted",
        ),
      );
      list = new SelectList(filtered, 10, selectListTheme);
      list.onSelect = (item) => {
        hide();
        void onSelect(item.value);
      };
      list.onCancel = () => {
        hide();
        onCancel?.();
      };
      listContainer.clear();
      listContainer.addChild(list);
      tui.requestRender();
    };
    const content = new VStack([
      new Text(tone(title, "text", true), 1, 0),
      resultSummary,
      new Text(tone(`⌕  ${searchHint}`, "dim"), 1, 0),
      searchEditor,
      new ModalSeparator(),
      listContainer,
      new ModalSeparator(),
      new Text(tone("↑/↓ navigate   Enter select   Esc close", "dim"), 1, 0),
    ]);
    const panel = new RoundedModal();
    panel.addChild(content);
    const overlay = tui.showOverlay(panel, {
      anchor: "center",
      width: "78%",
      minWidth: 52,
      maxHeight: "85%",
      margin: SCREEN_GUTTER,
    });
    const handleInput = (data: string): void => list.handleInput(data);
    hide = () => {
      overlay.hide();
      if (modalInputHandler === handleInput) {
        modalInputHandler = undefined;
        modalInputCaptureAll = false;
      }
      tui.setFocus(editor);
    };
    searchEditor.onChange = updateList;
    updateList("");
    modalInputHandler = handleInput;
    modalInputCaptureAll = false;
    tui.setFocus(searchEditor);
    return hide;
  }

  options.gateway.setExternalAccessPrompt(requestExternalAccess);

  const browsePromptHistory = (direction: -1 | 1): void => {
    if (direction === -1) {
      if (!promptHistory.length) return;
      if (historyIndex < 0) {
        historyDraft = editor.getText();
        historyIndex = 0;
      } else if (historyIndex < promptHistory.length - 1) {
        historyIndex += 1;
      }
    } else {
      if (historyIndex < 0) return;
      if (historyIndex === 0) {
        historyIndex = -1;
      } else {
        historyIndex -= 1;
      }
    }

    changingHistory = true;
    editor.setText(
      historyIndex < 0 ? historyDraft : (promptHistory[historyIndex] ?? ""),
    );
    changingHistory = false;
    if (historyIndex < 0) historyDraft = "";
    updateSlashSuggestions(editor.getText());
    tui.requestRender();
  };

  editor.onChange = (text) => {
    if (!changingHistory) {
      historyIndex = -1;
      historyDraft = "";
      dismissedSuggestionText = undefined;
    }
    updateSlashSuggestions(text);
    tui.requestRender();
  };

  editor.onSubmit = (text) => {
    const prompt = text.trim();
    if (prompt && promptHistory[0] !== prompt) {
      promptHistory.unshift(prompt);
      if (promptHistory.length > MAX_PROMPT_HISTORY) promptHistory.pop();
    }
    historyIndex = -1;
    historyDraft = "";
    dismissedSuggestionText = undefined;
    slashSuggestions.setSuggestions([]);
    void submitPrompt(text);
  };

  tui.addInputListener((data) => {
    if (modalInputHandler) {
      if (
        modalInputCaptureAll ||
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown") ||
        matchesKey(data, "enter") ||
        matchesKey(data, "escape") ||
        matchesKey(data, "ctrl+c")
      ) {
        modalInputHandler(data);
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (activePermissionPrompt) {
      if (matchesKey(data, "ctrl+c")) {
        denyPendingPermissionPrompts();
        void options.gateway.cancel().catch(() => undefined);
      } else {
        externalAccessPanel.render(
          Math.max(1, terminal.columns - SCREEN_GUTTER * 2),
        );
        externalAccessPanel.handleInput(data);
      }
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      browsePromptHistory(-1);
      return { consume: true };
    }
    if (matchesKey(data, "down")) {
      browsePromptHistory(1);
      return { consume: true };
    }
    if (slashSuggestions.isOpen) {
      if (matchesKey(data, "shift+tab")) {
        slashSuggestions.moveSelection(-1);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "tab")) {
        slashSuggestions.moveSelection(1);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        const selected = slashSuggestions.selected();
        if (selected && editor.getText().trim() === selected.command) {
          return undefined;
        }
        if (selected) {
          acceptingSlashSuggestion = true;
          editor.setText(selected.command);
          acceptingSlashSuggestion = false;
          dismissedSuggestionText = selected.command;
          slashSuggestions.setSuggestions([]);
          tui.requestRender();
        }
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        dismissedSuggestionText = editor.getText();
        slashSuggestions.setSuggestions([]);
        tui.requestRender();
        return { consume: true };
      }
    }
    if (matchesKey(data, "shift+tab")) {
      if (activeInference || options.gateway.isRunning())
        return { consume: true };
      const mode = state.mode === "plan" ? "build" : "plan";
      state = reduceAppState(state, { type: "mode_changed", mode });
      options.gateway.setMode(mode);
      updateHomeDashboard();
      updateFooter();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (activeInference || options.gateway.isRunning()) {
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

function formatTaskChecklist(
  tasks: TaskChecklistItem[],
  width: number,
): string {
  if (!tasks.length || width < 1) return "";
  const completed = tasks.filter((task) => task.status === "completed").length;
  return [
    tone(
      truncateToWidth(`TASKS · ${completed}/${tasks.length}`, width),
      "blue",
      true,
    ),
    ...tasks.map((task) => {
      const marker =
        task.status === "completed"
          ? tone("✓", "green", true)
          : task.status === "in_progress"
            ? tone("›", "amber", true)
            : tone("○", "dim");
      const title = safeTerminalText(task.title).replace(/\s+/g, " ").trim();
      return truncateToWidth(`${marker} ${title}`, width);
    }),
  ].join("\n");
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
