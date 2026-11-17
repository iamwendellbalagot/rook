import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HomeBrand } from "../../src/tui/rook-tui.js";

describe("home brand", () => {
  it("renders the compact PNG-derived lockup and tight tagline", () => {
    const lines = new HomeBrand().render(120);

    expect(lines).toHaveLength(6);
    expect(visibleWidth(lines[1]!)).toBe(30);
    expect(lines.slice(0, 5).join("")).toContain("▀");
    expect(lines[5]).toContain("A coding agent that grows with your codebase.");
  });
});
