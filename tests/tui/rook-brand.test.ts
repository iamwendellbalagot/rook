import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";
import { HomeBrand } from "../../src/tui/home-brand.js";

describe("home brand", () => {
  beforeEach(() => setCapabilityOverrides({ trueColor: true, images: null }));
  afterEach(() => setCapabilityOverrides({}));

  it("renders the compact artwork using RGB half-blocks without image protocols", () => {
    const lines = new HomeBrand().render(120);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).map(visibleWidth)).toEqual(Array(7).fill(38));
    const artwork = lines.slice(0, 7).join("\n");
    expect(artwork).toContain("\x1b[38;2;");
    expect(artwork).toContain("\x1b[48;2;");
    expect(artwork).toContain("▀");
    expect(artwork).toContain("▄");
    expect(artwork).not.toMatch(/\x1b_G|1337;File|\.png|NaN|undefined/);
    expect(lines.at(-1)).toContain(
      "A coding agent that grows with your codebase.",
    );
  });

  it.each([1, 12, 30, 38, 60])("fits within %i terminal columns", (width) => {
    const lines = new HomeBrand().render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("keeps the raster stable after invalidation", () => {
    const brand = new HomeBrand();
    const before = brand.render(60);
    brand.invalidate();
    expect(brand.render(60)).toEqual(before);
  });

  it("uses the same artwork with 256 colors on terminals without truecolor", () => {
    const brand = new HomeBrand();
    const rgbLines = brand.render(60);
    setCapabilityOverrides({ trueColor: false, images: null });
    const indexedLines = brand.render(60);

    expect(indexedLines.join("")).toContain("\x1b[38;5;");
    expect(indexedLines.join("")).not.toContain("\x1b[38;2;");
    expect(indexedLines.map(visibleWidth)).toEqual(rgbLines.map(visibleWidth));
  });
});
