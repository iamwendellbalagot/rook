import {
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { HOME_ROOK_PIXELS, HOME_WORDMARK_PIXELS } from "./home-brand-art.js";
import { tone } from "./theme.js";

const logoCache = new Map<TerminalColorMode, string[]>();

function pixelLines(
  pixels: readonly string[],
  colors: Record<string, string>,
  mode: TerminalColorMode,
): string[] {
  return Array.from({ length: pixels.length / 2 }, (_, row) =>
    [...pixels[row * 2]!]
      .map((top, x) => {
        const bottom = pixels[row * 2 + 1]![x]!;
        if (top === "." && bottom === ".") return " ";
        const fg = parseColor(colors[top === "." ? bottom : top]!);
        if (top === ".") return styleText("▄", { fg }, mode);
        if (bottom === ".") return styleText("▀", { fg }, mode);
        if (top === bottom) return styleText("█", { fg }, mode);
        return styleText("▀", { fg, bg: parseColor(colors[bottom]!) }, mode);
      })
      .join(""),
  );
}

function wordmarkLines(mode: TerminalColorMode): string[] {
  return pixelLines(
    HOME_WORDMARK_PIXELS,
    { "1": "#F1EEE7", "2": "#27D8F3" },
    mode,
  );
}

function logoLines(mode: TerminalColorMode): string[] {
  let lines = logoCache.get(mode);
  if (!lines) {
    const wordmark = wordmarkLines(mode);
    const icon = pixelLines(
      HOME_ROOK_PIXELS,
      { "1": "#35BDF4", "2": "#0876C3" },
      mode,
    );
    const titleOffset = icon.length - wordmark.length;
    lines = icon.map((row, index) => {
      const title = wordmark[index - titleOffset];
      return `${row} ${title ?? " ".repeat(29)}`;
    });
    logoCache.set(mode, lines);
  }
  return lines;
}

export class HomeBrand implements Component {
  render(width: number): string[] {
    const mode = getTerminalColorMode();
    const logo = logoLines(mode);
    const logoWidth = visibleWidth(logo[0]!);
    const availableWidth = Math.max(0, width);
    const lines =
      availableWidth >= logoWidth
        ? logo
        : availableWidth >= 29
          ? wordmarkLines(mode)
          : [tone("rook", "text", true) + tone(".", "cyan", true)];
    const contentWidth = visibleWidth(lines[0]!);
    const centered = lines.map((line) => {
      const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
      return " ".repeat(padding) + line;
    });
    if (width >= 64 && contentWidth + 6 <= width) {
      const ruleLength = Math.floor((width - contentWidth - 6) / 2);
      const centerRow = Math.floor((centered.length - 1) / 2);
      centered[centerRow] =
        `${tone("─".repeat(ruleLength), "cyan")} ${tone("◇", "cyan", true)} ` +
        lines[centerRow]! +
        ` ${tone("◇", "cyan", true)} ${tone("─".repeat(ruleLength), "cyan")}`;
      const linePadding = Math.max(
        0,
        Math.floor((width - visibleWidth(centered[centerRow]!)) / 2),
      );
      centered[centerRow] = " ".repeat(linePadding) + centered[centerRow]!;
    }
    const tagline = tone(
      "A coding agent that grows with your codebase.",
      "muted",
    );
    const taglinePadding = Math.max(
      0,
      Math.floor((width - visibleWidth(tagline)) / 2),
    );
    return [
      ...centered.map((line) => truncateToWidth(line, width, "")),
      truncateToWidth(" ".repeat(taglinePadding) + tagline, width, ""),
    ];
  }

  invalidate(): void {}
}
