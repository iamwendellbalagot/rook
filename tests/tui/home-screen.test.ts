import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { HomeScreenBody } from "../../src/tui/home-screen.js";

describe("home screen body", () => {
  it("encloses the brand, tagline, and all four actions in a rounded frame", () => {
    const lines = new HomeScreenBody().render(65).map(stripTerminalSequences);
    expect(lines[0]).toMatch(/^  ╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^  ╰─+╯$/);
    expect(lines.slice(1, -1).every((line) => /^  │.*│$/.test(line))).toBe(
      true,
    );
    expect(lines.every((line) => visibleWidth(line) === 65)).toBe(true);
    const screen = lines.join("\n");
    expect(screen).toContain("A coding agent that grows with your codebase.");
    for (const command of ["/plan", "/build", "/memory", "/help"]) {
      const row = lines.findIndex((line) => line.includes(command));
      expect(row).toBeGreaterThan(0);
      expect(row).toBeLessThan(lines.length - 1);
    }
    const descriptions = [
      "Think through",
      "Make and apply",
      "View what",
      "Show all",
    ];
    expect(
      descriptions.map((description) =>
        lines.find((line) => line.includes(description))!.indexOf(description),
      ),
    ).toEqual([19, 19, 19, 19]);
  });

  it.each([0, 1, 4, 6, 12, 30, 48, 60, 80, 120])(
    "fits within %i columns",
    (width) => {
      const lines = new HomeScreenBody().render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it("wraps action descriptions instead of losing them on narrow terminals", () => {
    const lines = new HomeScreenBody().render(38).map(stripTerminalSequences);
    const content = lines
      .slice(1, -1)
      .map((line) => line.slice(3, -1).trim())
      .join(" ");
    expect(content).toContain("Think through a task before making changes");
    expect(content).toContain("View what Rook knows about this repository");
    expect(content).toContain("Show all commands");
  });

  it("caps the panel width on wide terminals and survives invalidation", () => {
    const body = new HomeScreenBody();
    const lines = body.render(160);
    expect(visibleWidth(lines[0]!)).toBe(78);
    body.invalidate();
    expect(body.render(160)).toEqual(lines);
  });
});
