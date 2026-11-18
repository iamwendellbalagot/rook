import {
  getCapabilities,
  getTerminalColorMode,
  indexedColor,
  parseColor,
  styleText,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import type { PermissionMode } from "../pi/agent-gateway.js";
import { HomeBrand } from "./home-brand.js";
import { tone } from "./theme.js";

const QUICK_ACTIONS = [
  ["/plan", "Create an implementation plan"],
  ["/build", "Implement and apply changes"],
  ["/memory", "View or update project memory"],
  ["/sessions", "Browse recent work sessions"],
  ["/model", "Choose an AI model"],
  ["/help", "Show all commands"],
] as const;

const MOUNTAIN_WIDTH = 72;
const MOUNTAIN_HEIGHT = 14;
type Pixel = " " | "d" | "m" | "b" | "i" | "w" | "o" | "*" | "p";
type ColorLevel = "256" | "16" | "plain";

// ANSI 256-color indices: night sky, layered ridges, snow, moon, stars, pines.
const COLORS_256: Record<Pixel, number> = {
  " ": 17,
  d: 18,
  m: 19,
  b: 20,
  i: 39,
  w: 231,
  o: 153,
  "*": 87,
  p: 18,
};
const COLORS_16: Record<Pixel, number> = {
  " ": 0,
  d: 0,
  m: 4,
  b: 4,
  i: 12,
  w: 15,
  o: 14,
  "*": 11,
  p: 4,
};

export interface HomeDashboardData {
  cwd: string;
  branch?: string;
  repositoryName?: string;
  repositoryId?: string;
  mode: PermissionMode;
  memoryCount?: number;
  snapshotDirty?: boolean;
  recentActivity: { text: string; role: "user" | "assistant" }[];
  onModeChange?: (mode: PermissionMode) => void;
}

function makeMountain(): Pixel[][] {
  const pixels = Array.from({ length: MOUNTAIN_HEIGHT }, () =>
    Array.from({ length: MOUNTAIN_WIDTH }, (): Pixel => " "),
  );
  const put = (x: number, y: number, pixel: Pixel): void => {
    if (x >= 0 && x < MOUNTAIN_WIDTH && y >= 0 && y < MOUNTAIN_HEIGHT)
      pixels[y]![x] = pixel;
  };
  const peak = (center: number, top: number, left: number, right: number) => {
    for (let y = top; y < MOUNTAIN_HEIGHT; y++) {
      const radius = (y - top) * 2;
      for (
        let x = Math.max(left, center - radius);
        x <= Math.min(right, center + radius);
        x++
      ) {
        const distance = Math.abs(x - center);
        put(x, y, distance < radius / 2 ? "d" : "m");
        if (distance <= Math.max(1, radius - 2) && y <= top + 6) put(x, y, "i");
      }
      put(center, top, "w");
      if (top + 1 < MOUNTAIN_HEIGHT) {
        put(center - 1, top + 1, "w");
        put(center + 1, top + 1, "w");
      }
    }
  };

  // Moon behind a layered mountain range.
  for (let y = 1; y <= 6; y++) {
    for (let x = 47; x <= 54; x++) {
      const dx = x - 50;
      const dy = y - 3;
      if (dx * dx + dy * dy <= 12) put(x, y, "o");
    }
  }
  peak(14, 7, 0, 30);
  peak(33, 3, 12, 58);
  peak(49, 6, 34, 68);
  peak(63, 8, 52, 71);

  for (const [x, y] of [
    [4, 3],
    [9, 1],
    [27, 2],
    [41, 4],
    [59, 1],
    [68, 4],
  ])
    put(x!, y!, "*");
  for (const [x, y, height] of [
    [59, 9, 4],
    [63, 8, 5],
    [67, 9, 4],
    [70, 8, 5],
  ]) {
    for (let row = 0; row < height!; row++) {
      const radius = Math.floor(row / 2);
      for (let dx = -radius; dx <= radius; dx++) put(x! + dx, y! + row, "p");
    }
  }
  return pixels;
}

const MOUNTAIN = makeMountain();
const ART_CACHE = new Map<string, string[]>();

function colorLevel(): ColorLevel {
  const capabilities = getCapabilities();
  if (process.env.TERM === "dumb") return "plain";
  if (capabilities.trueColor) return "256";
  const term = process.env.TERM ?? "";
  return process.env.NO_COLOR !== undefined || !/256color/i.test(term)
    ? "16"
    : "256";
}

function mountainLines(width: number, mode: TerminalColorMode): string[] {
  const level = colorLevel();
  if (level === "plain") {
    const ascii = [
      "                 *                 *",
      "            /\\        /\\              /\\",
      "     /\\   /  \\ /\\  /  \\   /\\     /  \\ /\\",
      "____/  \\_/    V   V    \\_/  \\__/    V   \\__",
    ];
    return ascii.map((line) =>
      truncateToWidth(line, width, "").padStart(width, " "),
    );
  }

  const cacheKey = `${level}:${mode}`;
  let lines = ART_CACHE.get(cacheKey);
  if (!lines) {
    const palette = level === "256" ? COLORS_256 : COLORS_16;
    lines = Array.from({ length: MOUNTAIN_HEIGHT / 2 }, (_, row) => {
      const top = MOUNTAIN[row * 2]!;
      const bottom = MOUNTAIN[row * 2 + 1]!;
      return Array.from({ length: MOUNTAIN_WIDTH }, (_, x) =>
        top[x] === " " && bottom[x] === " "
          ? " "
          : top[x] === " "
            ? styleText("▄", { fg: indexedColor(palette[bottom[x]!]) }, mode)
            : bottom[x] === " "
              ? styleText("▀", { fg: indexedColor(palette[top[x]!]) }, mode)
              : styleText(
                  "▀",
                  {
                    fg: indexedColor(palette[top[x]!]),
                    bg: indexedColor(palette[bottom[x]!]),
                  },
                  mode,
                ),
      ).join("");
    });
    ART_CACHE.set(cacheKey, lines);
  }
  return lines.map((line) =>
    truncateToWidth(line, width, "").padStart(width, " "),
  );
}

function safeText(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function color(text: string, hex: string, bold = false): string {
  return styleText(text, { fg: parseColor(hex), bold }, getTerminalColorMode());
}

function clip(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "");
}

function frame(title: string, content: string[], width: number): string[] {
  if (width < 4) return content.map((line) => clip(line, width));
  const inner = width - 2;
  const label = title ? `  ${title.toUpperCase()} ` : "";
  const header = `${tone("╭", "border", true)}${tone(label, "cyan", true)}${tone("─".repeat(Math.max(0, inner - visibleWidth(label))), "border", true)}${tone("╮", "border", true)}`;
  const body = content.map((line) => {
    const clipped = clip(line, inner);
    return `${tone("│", "border")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${tone("│", "border")}`;
  });
  return [
    header,
    ...body,
    `${tone("╰", "border", true)}${tone("─".repeat(inner), "border", true)}${tone("╯", "border", true)}`,
  ];
}

function activityLines(data: HomeDashboardData, width: number): string[] {
  if (data.recentActivity.length === 0)
    return [tone("  No recent activity", "muted")];
  return data.recentActivity.slice(0, 5).map((item) => {
    const icon =
      item.role === "assistant"
        ? color("✓", "#1BEA72", true)
        : color("▣", "#25C4FF", true);
    const text = safeText(item.text).slice(0, 120) || "Session activity";
    return `${icon} ${tone(clip(text, Math.max(1, width - 3)), "text")}`;
  });
}

export class HomeScreenBody implements Component {
  private readonly brand = new HomeBrand();
  private data: HomeDashboardData = {
    cwd: "",
    mode: "plan",
    recentActivity: [],
  };

  setDashboardData(data: HomeDashboardData): void {
    this.data = data;
  }

  handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
    if (event.type !== "click") return undefined;
    if (event.y === 8 && this.data.onModeChange) {
      this.data.onModeChange(event.x < event.width / 2 ? "plan" : "build");
      return { handled: true, render: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    if (width < 4) return [clip("rook.", width)];
    if (width < 78) return this.renderCompact(width);

    const hero = this.renderHero(width);
    const mode = this.renderMode(width);
    const panels = this.renderPanels(width);
    const tip =
      width >= 110
        ? frame(
            "◉  Tip",
            [
              `Start with ${color("/plan", "#21D9F4", true)} to analyze a task, then switch to ${color("/build", "#21D9F4", true)} to implement it.`,
            ],
            width,
          )
        : [];
    return [
      "",
      ...hero,
      "",
      ...mode,
      "",
      ...panels,
      ...(tip.length ? ["", ...tip, ""] : []),
    ].map((line) => clip(line, width));
  }

  private renderHero(width: number): string[] {
    const artWidth = width >= 120 ? Math.min(76, width - 54) : 0;
    const brandWidth = Math.min(48, width - artWidth - (artWidth ? 4 : 0));
    const brand = this.brand.render(brandWidth);
    const mountains =
      artWidth >= 36 ? mountainLines(artWidth, getTerminalColorMode()) : [];
    const rows = Math.max(brand.length, mountains.length);
    const brandOffset = rows - brand.length;
    return Array.from({ length: rows }, (_, row) => {
      const left = row >= brandOffset ? brand[row - brandOffset]! : "";
      const right = mountains[row] ?? "";
      return `${right}${" ".repeat(artWidth ? 4 : 0)}${left}${" ".repeat(Math.max(0, brandWidth - visibleWidth(left)))}`;
    });
  }

  private renderMode(width: number): string[] {
    const plan = this.data.mode === "plan";
    const left = `${tone("MODE", "muted", true)}  ${plan ? color("▶ /plan", "#25D9FF", true) : tone("/plan", "muted")}  ${tone("Analyze and plan · read-only", "text")}`;
    const right = `${!plan ? color("⚒ /build", "#25D9FF", true) : tone("/build", "muted")}  ${tone("Implement · approved shell", "text")}`;
    const text =
      width < 90
        ? `${plan ? color("▶ /plan", "#25D9FF", true) : tone("/plan", "muted")} · read-only   │   ${!plan ? color("⚒ /build", "#25D9FF", true) : tone("/build", "muted")} · build`
        : `${left}   │   ${right}`;
    return frame("◈  Mode", [clip(text, width - 4)], width);
  }

  private renderPanels(width: number): string[] {
    if (width >= 140) {
      const gap = 2;
      const usable = width - gap * 2;
      const leftWidth = Math.floor(usable * 0.34);
      const middleWidth = Math.floor(usable * 0.34);
      const rightWidth = usable - leftWidth - middleWidth;
      const left = frame(
        "⬡  Quick Actions",
        QUICK_ACTIONS.map(
          ([command, description]) =>
            `${color(command, "#21D9F4", true)}  ${tone(description, "muted")}`,
        ),
        leftWidth,
      );
      const middle = frame(
        "◷  Recent Activity",
        activityLines(this.data, middleWidth - 4),
        middleWidth,
      );
      const context = [
        `${tone("Path", "muted")}      ${tone(clip(this.data.cwd, rightWidth - 13), "text")}`,
        ...(this.data.repositoryName
          ? [
              `${tone("Project", "muted")}  ${tone(this.data.repositoryName, "text")}`,
            ]
          : []),
        `${tone("Branch", "muted")}   ${tone(this.data.branch ?? "not a git repo", "text")}`,
        `${tone("Status", "muted")}    ${tone(this.data.snapshotDirty === undefined ? "unknown" : this.data.snapshotDirty ? "changes" : "clean", "text")}`,
        ...(this.data.repositoryId
          ? [
              `${tone("Repo ID", "muted")}  ${this.data.repositoryId.slice(0, 8)}`,
            ]
          : []),
        `${tone("Memory", "muted")}   ${tone(this.data.memoryCount === undefined ? "unavailable" : `${this.data.memoryCount} entries`, "text")}`,
      ];
      const right = frame(
        "▰  Project Context",
        context.map((line) => clip(line, rightWidth - 4)),
        rightWidth,
      );
      const height = Math.max(left.length, middle.length, right.length);
      const pad = (rows: string[], w: number): string[] => {
        while (rows.length < height)
          rows.splice(
            rows.length - 1,
            0,
            `${tone("│", "border")}${" ".repeat(w - 2)}${tone("│", "border")}`,
          );
        return rows;
      };
      const a = pad(left, leftWidth);
      const b = pad(middle, middleWidth);
      const c = pad(right, rightWidth);
      return Array.from(
        { length: height },
        (_, row) =>
          `${a[row]}${" ".repeat(gap)}${b[row]}${" ".repeat(gap)}${c[row]}`,
      );
    }

    if (width >= 78) {
      const gap = 2;
      const leftWidth = Math.floor((width - gap) / 2);
      const rightWidth = width - gap - leftWidth;
      const left = frame(
        "⬡  Quick Actions",
        QUICK_ACTIONS.map(
          ([command, description]) =>
            `${color(command, "#21D9F4", true)}  ${tone(clip(description, leftWidth - 16), "muted")}`,
        ),
        leftWidth,
      );
      const right = frame(
        "◷  Recent Activity",
        activityLines(this.data, rightWidth - 4),
        rightWidth,
      );
      const height = Math.max(left.length, right.length);
      while (left.length < height)
        left.splice(
          left.length - 1,
          0,
          `${tone("│", "border")}${" ".repeat(leftWidth - 2)}${tone("│", "border")}`,
        );
      while (right.length < height)
        right.splice(
          right.length - 1,
          0,
          `${tone("│", "border")}${" ".repeat(rightWidth - 2)}${tone("│", "border")}`,
        );
      const paired = Array.from(
        { length: height },
        (_, row) => `${left[row]}${" ".repeat(gap)}${right[row]}`,
      );
      const context = `${tone("PROJECT", "cyan", true)}  ${tone(this.data.repositoryName ?? this.data.cwd, "text")}   ${tone("BRANCH", "cyan", true)} ${tone(this.data.branch ?? "—", "text")}   ${tone("MEMORY", "cyan", true)} ${tone(this.data.memoryCount === undefined ? "—" : String(this.data.memoryCount), "text")}`;
      return [...paired, clip(context, width)];
    }

    return [
      ...frame(
        "⬡  Quick Actions",
        QUICK_ACTIONS.map(
          ([command, description]) =>
            `${color(command, "#21D9F4", true)}  ${tone(description, "muted")}`,
        ),
        width,
      ),
      "",
      ...frame(
        "◷  Recent Activity",
        activityLines(this.data, width - 4),
        width,
      ),
      "",
      ...frame(
        "▰  Project Context",
        [
          `${tone("Path", "muted")} ${this.data.cwd}`,
          `${tone("Branch", "muted")} ${this.data.branch ?? "not a git repo"}`,
          `${tone("Memory", "muted")} ${this.data.memoryCount === undefined ? "unavailable" : `${this.data.memoryCount} entries`}`,
        ],
        width,
      ),
    ];
  }

  private renderCompact(width: number): string[] {
    return [
      ...this.brand.render(width),
      tone(
        "Switch between planning and building with the current mode command.",
        "muted",
      ),
      tone(
        `Mode: ${this.data.mode.toUpperCase()} · use /plan or /build`,
        "cyan",
        true,
      ),
      ...QUICK_ACTIONS.map(
        ([command, description]) =>
          `${color(command, "#21D9F4", true)}  ${tone(description, "muted")}`,
      ),
      tone(
        `Branch: ${this.data.branch ?? "not a git repo"} · Memory: ${this.data.memoryCount ?? "—"}`,
        "muted",
      ),
    ].map((line) => clip(line, width));
  }

  invalidate(): void {
    this.brand.invalidate();
  }
}
