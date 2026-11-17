import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HomeBrand } from "../../src/tui/rook-tui.js";

describe("home brand", () => {
  it("passes through the compact PNG lockup and renders its tagline", () => {
    const lines = new HomeBrand().render(120);

    expect(
      lines.some(
        (line) => line.includes("rook_lockup.png") || line.includes("\x1b_G"),
      ),
    ).toBe(true);
    expect(visibleWidth(lines.at(-1)!)).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain(
      "A coding agent that grows with your codebase.",
    );
  });
});
