import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { HomeBrand } from "./home-brand.js";
import { tone } from "./theme.js";

const HOME_ACTIONS = [
  ["/plan", "Think through a task before making changes"],
  ["/build", "Make and apply changes to your codebase"],
  ["/memory", "View what Rook knows about this repository"],
  ["/help", "Show all commands"],
] as const;

export class HomeScreenBody implements Component {
  private readonly brand = new HomeBrand();

  render(width: number): string[] {
    if (width < 6) return [truncateToWidth("rook.", width, "")];
    const margin = "  ";
    const boxWidth = Math.min(width - margin.length, 76);
    const insideWidth = boxWidth - 2;
    const contentWidth = Math.max(1, insideWidth - 2);
    const lines = ["", ...this.brand.render(contentWidth), ""];

    for (const [command, description] of HOME_ACTIONS) {
      const label = `⟮ ${command} ⟯`;
      const descriptionWidth = contentWidth - 16;
      if (descriptionWidth >= 24) {
        const descriptionLines = wrapTextWithAnsi(
          description,
          descriptionWidth,
        );
        descriptionLines.forEach((line, index) => {
          const action = index === 0 ? tone(label, "cyan") : "";
          lines.push(
            `  ${action}${" ".repeat(14 - visibleWidth(action))}${tone(line, "muted")}`,
          );
        });
      } else {
        lines.push(`  ${tone(label, "cyan")}`);
        lines.push(
          ...wrapTextWithAnsi(description, Math.max(1, contentWidth - 4)).map(
            (line) => `    ${tone(line, "muted")}`,
          ),
        );
      }
    }
    lines.push("");

    const horizontal = "─".repeat(insideWidth);
    return [
      `${margin}${tone(`╭${horizontal}╮`, "border")}`,
      ...lines.map((line) => {
        const clipped = truncateToWidth(line, insideWidth, "");
        return `${margin}${tone("│", "border")}${clipped}${" ".repeat(insideWidth - visibleWidth(clipped))}${tone("│", "border")}`;
      }),
      `${margin}${tone(`╰${horizontal}╯`, "border")}`,
    ];
  }

  invalidate(): void {
    this.brand.invalidate();
  }
}
