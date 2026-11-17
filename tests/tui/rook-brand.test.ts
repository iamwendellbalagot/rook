import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RookBrand } from "../../src/tui/rook-brand.js";

describe("RookBrand", () => {
  it("renders a compact icon and wordmark with a tight tagline", () => {
    const lines = new RookBrand({ indent: 2 }).render(120);

    expect(lines).toHaveLength(5);
    expect(visibleWidth(lines[1]!)).toBe(18);
    expect(lines[1]).toContain("rook");
    expect(lines[4]).toContain("A coding agent that grows with your codebase.");
  });
});
