/**
 * ROOK BRAND — standalone terminal-compatible 8-bit logo.
 * Source asset: rook_icon.png (transparent). The 34×34 palette-indexed sprite
 * below is derived from that PNG so the terminal version retains the orbit,
 * star, and shaded tower. No Kitty/Sixel/iTerm image protocol is required.
 *
 * Usage in Pi-powered custom TUI:
 *   import { RookBrand } from "./rook-brand.js";
 *   container.addChild(new RookBrand());
 *
 * Required dependency: @earendil-works/pi-tui
 * The class is display-only; keep Pi's normal Editor as a separate component.
 */
import type { Component } from "@earendil-works/pi-tui";

const ICON_PIXELS = [
  "................EE................",
  "................9A................",
  "................B14...............",
  "..............7A11B7..............",
  "............E8B1141C87............",
  ".............47811874.............",
  "................A3E...............",
  "................9A................",
  ".........EEEE...44....EEEE........",
  "........9DDD2..22222.2AAA9C.......",
  ".......CD1119.2D1B14.211114.......",
  ".......CD1E19.CCEEB2.2AE619.......",
  ".......CD1EBA99C65BA99CEE19.......",
  ".......C31E8B118EEE1118EE14E443E..",
  ".......CD1EEEEEEEEE6EE56819EEEEEEE",
  ".......E931EEEEEEEEEEEEE192...EE14",
  "........E411111EDDDDDDD19E.....E13",
  ".........ED18899777777AD2.....EEE.",
  "..........21EEEEEEEEEEB9.....EEEE.",
  ".......E4E41E5E127CECE19E...EEEE..",
  ".....EEE5CA1E5EE9CE1EE8A2.2EE7E...",
  "....EEEE.CDEEEE9E1AEE4E14EE5E.....",
  "..E884...CD1EEE4D192E3EC9E3.......",
  ".EBB4....91EEEEE39EE5EE8AC........",
  ".B17.....A1EEEEEE56EEE51DC........",
  "81B.....CA1EEEEE5EEEEEEED2........",
  "8138777791888E4ECD2E2E4E1A........",
  ".A111AA9ABE6E2E2111CEEEE1AE.......",
  "..555..E9B6DAE211B1322198AE.......",
  "......229A111D21EEE13113D92E......",
  "......24611E811EE11E1DEE1132......",
  ".....2D11EE91BE8EEEEECA5EE1D2.....",
  "....1ABEEE6ABE6EEEEEEEB656E8B2....",
  "....EEEEEEEEECEEEEEEEEEEEE2EEE....",
] as const;

const PALETTE: Record<string, string> = {
  "1": "#030D46",
  "2": "#0D235D",
  "3": "#012581",
  "4": "#0F3E9A",
  "5": "#0040B9",
  "6": "#0051CF",
  "7": "#1753A8",
  "8": "#047BE7",
  "9": "#3B73AC",
  A: "#4B9FD2",
  B: "#3FB6F1",
  C: "#56DBFC",
  D: "#A5D1E4",
  E: "#B8F2FC",
};
const RESET = "\x1b[0m";
const IVORY = "#F1EEE7";
const CYAN = "#27D8F3";
const MUTED = "#B7C7D7";
const TAGLINE = "A coding agent that grows with your codebase.";

function fg(hex: string): string {
  const n = parseInt(hex.substring(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
function bg(hex: string): string {
  const n = parseInt(hex.substring(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
function halfBlock(top: string, bottom: string): string {
  const a = PALETTE[top],
    b = PALETTE[bottom];
  if (!a && !b) return " ";
  if (a && !b) return fg(a!) + "▀" + RESET;
  if (!a && b) return fg(b!) + "▄" + RESET;
  if (a === b) return fg(a!) + "█" + RESET;
  return fg(a!) + bg(b!) + "▀" + RESET;
}
function renderIconRow(row: number): string {
  const sample = (x: number, y: number): string => {
    const sourceX = Math.min(33, Math.floor(((x + 0.5) * 34) / 8));
    const sourceY = Math.min(33, Math.floor(((y + 0.5) * 34) / 8));
    return ICON_PIXELS[sourceY]![sourceX]!;
  };
  return Array.from({ length: 8 }, (_, x) =>
    halfBlock(sample(x, row * 2), sample(x, row * 2 + 1)),
  ).join("");
}
export interface RookBrandOptions {
  tagline?: boolean;
  indent?: number;
}
/** Draw a left-aligned terminal logo using true-color ANSI + Unicode half blocks. */
export class RookBrand implements Component {
  constructor(private readonly options: RookBrandOptions = {}) {}
  render(width: number): string[] {
    const pad = " ".repeat(this.options.indent ?? 2);
    const wordmark = fg(IVORY) + "rook" + RESET + fg(CYAN) + "." + RESET;
    const lines: string[] = [];
    for (let row = 0; row < 4; row++) {
      const divider = fg(MUTED) + "│" + RESET;
      lines.push(
        pad +
          renderIconRow(row) +
          " " +
          divider +
          " " +
          (row === 1 ? wordmark : ""),
      );
    }
    if (this.options.tagline !== false) {
      lines.push(
        pad +
          fg(MUTED) +
          TAGLINE.slice(0, Math.max(0, width - pad.length)) +
          RESET,
      );
    }
    return lines;
  }
  invalidate(): void {
    /* static component */
  }
}
