import {
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { HOME_BRAND_CELLS, HOME_WORDMARK_PIXELS } from "./home-brand-art.js";
import { tone } from "./theme.js";

// Solid quadrants replace Braille only when their 2×4 masks are identical.
// This keeps flat artwork filled without reducing fine contour resolution.
const SOLID_GLYPHS: Record<number, string> = {
  0x00: " ",
  0x03: "▘",
  0x18: "▝",
  0x1b: "▀",
  0x44: "▖",
  0x47: "▌",
  0x5c: "▞",
  0x5f: "▛",
  0xa0: "▗",
  0xa3: "▚",
  0xb8: "▐",
  0xbb: "▜",
  0xe4: "▄",
  0xe7: "▙",
  0xfc: "▟",
  0xff: "█",
};

function renderCell(cell: string, mode: TerminalColorMode): string {
  if (cell === "-") return " ";
  const [maskHex, foreground, background] = cell.split("/");
  const mask = Number.parseInt(maskHex!, 16);
  const glyph = SOLID_GLYPHS[mask] ?? String.fromCodePoint(0x2800 + mask);
  return styleText(
    glyph,
    {
      fg: parseColor(`#${foreground}`),
      ...(background === "-" ? {} : { bg: parseColor(`#${background}`) }),
    },
    mode,
  );
}

const logoCache = new Map<TerminalColorMode, string[]>();

function wordmarkLines(mode: TerminalColorMode): string[] {
  const colors: Record<string, string> = { "1": "#F1EEE7", "2": "#27D8F3" };
  return Array.from({ length: 5 }, (_, row) =>
    [...HOME_WORDMARK_PIXELS[row * 2]!]
      .map((top, x) => {
        const bottom = HOME_WORDMARK_PIXELS[row * 2 + 1]![x]!;
        if (top === "." && bottom === ".") return " ";
        const fg = parseColor(colors[top === "." ? bottom : top]!);
        if (top === ".") return styleText("▄", { fg }, mode);
        if (bottom === ".") return styleText("▀", { fg }, mode);
        return styleText("█", { fg }, mode);
      })
      .join(""),
  );
}

function logoLines(mode: TerminalColorMode): string[] {
  let lines = logoCache.get(mode);
  if (!lines) {
    const wordmark = wordmarkLines(mode);
    const divider = tone("│", "border");
    lines = HOME_BRAND_CELLS.map((row, index) => {
      const icon = row
        .split(" ")
        .slice(0, 14)
        .map((cell) => renderCell(cell, mode))
        .join("");
      const title = wordmark[index - 1];
      return `${icon} ${title ? divider : " "} ${title ?? " ".repeat(29)}`;
    });
    logoCache.set(mode, lines);
  }
  return lines;
}

export class HomeBrand implements Component {
  render(width: number): string[] {
    const mode = getTerminalColorMode();
    const logo = logoLines(mode);
    const availableWidth = Math.max(0, width - 2);
    const lines =
      availableWidth >= visibleWidth(logo[0]!)
        ? logo
        : availableWidth >= 29
          ? wordmarkLines(mode)
          : [tone("rook", "text", true) + tone(".", "cyan", true)];
    return [
      ...lines.map((line) => truncateToWidth(`  ${line}`, width, "")),
      truncateToWidth(
        `  ${tone("A coding agent that grows with your codebase.", "muted")}`,
        width,
        "",
      ),
    ];
  }

  invalidate(): void {}
}
