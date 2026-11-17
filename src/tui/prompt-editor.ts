import {
  Editor,
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { tone } from "./theme.js";

/** Keep Pi's editing/cursor behavior while framing the main prompt. */
export class PromptEditor extends Editor {
  private editorX = 0;
  private editorWidth = 1;
  private hiddenAbove = 0;
  private hiddenBelow = 0;

  protected override renderTopBorder(_width: number, hidden: number): string {
    this.hiddenAbove = hidden;
    return "";
  }

  protected override renderBottomBorder(
    _width: number,
    hidden: number,
  ): string {
    this.hiddenBelow = hidden;
    return "";
  }

  override render(width: number): string[] {
    this.setPaddingX(0);
    this.editorX = 0;
    // Pi reserves a cursor column; a two-cell layout also accommodates wide
    // Unicode graphemes without its word wrapper recursing at width one.
    this.editorWidth = Math.max(3, width);
    if (width < 11) {
      return super
        .render(this.editorWidth)
        .map((line) => truncateToWidth(line, Math.max(0, width), ""));
    }

    const margin = "  ";
    const insideWidth = width - margin.length * 2 - 2;
    const contentWidth = insideWidth - 2;
    const label = contentWidth >= 10 ? "rook > " : "";
    this.editorWidth = contentWidth - label.length;
    this.editorX = margin.length + 2 + label.length;
    const rows = super.render(this.editorWidth);
    const border = (top: boolean, hidden: number): string => {
      const indicator = hidden > 0 ? ` ${top ? "↑" : "↓"} ${hidden} ` : "";
      const text = truncateToWidth(indicator, insideWidth, "");
      const edge = `${text}${"━".repeat(insideWidth - visibleWidth(text))}`;
      return `${margin}${tone(`${top ? "╭" : "╰"}${edge}${top ? "╮" : "╯"}`, "border", true)}${margin}`;
    };
    return [
      border(true, this.hiddenAbove),
      ...rows.slice(1, -1).map((line, index) => {
        const prefix =
          index === 0 ? tone(label, "cyan", true) : " ".repeat(label.length);
        return `${margin}${tone("┃", "border", true)} ${prefix}${line} ${tone("┃", "border", true)}${margin}`;
      }),
      border(false, this.hiddenBelow),
    ];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({
      ...event,
      x: event.x - this.editorX,
      width: this.editorWidth,
    });
  }
}
