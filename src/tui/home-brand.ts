import {
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { HOME_BRAND_CELLS } from "./home-brand-art.js";
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

function logoLines(mode: TerminalColorMode): string[] {
  let lines = logoCache.get(mode);
  if (!lines) {
    lines = HOME_BRAND_CELLS.map((row) =>
      row
        .split(" ")
        .map((cell) => renderCell(cell, mode))
        .join(""),
    );
    logoCache.set(mode, lines);
  }
  return lines;
}

export class HomeBrand implements Component {
  render(width: number): string[] {
    return [
      ...logoLines(getTerminalColorMode()).map((line) =>
        truncateToWidth(`  ${line}`, width, ""),
      ),
      truncateToWidth(
        `  ${tone("A coding agent that grows with your codebase.", "muted")}`,
        width,
        "",
      ),
    ];
  }

  invalidate(): void {}
}
