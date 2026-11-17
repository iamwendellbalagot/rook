import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { HomeBrand } from "../../src/tui/home-brand.js";
import { HOME_BRAND_CELLS } from "../../src/tui/home-brand-art.js";

describe("home brand", () => {
  beforeEach(() => setCapabilityOverrides({ trueColor: true, images: null }));
  afterEach(() => setCapabilityOverrides({}));

  it("renders finer Braille contours and solid fills without image protocols", () => {
    const lines = new HomeBrand().render(120);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).map(visibleWidth)).toEqual(Array(7).fill(38));
    const artwork = lines.slice(0, 7).join("\n");
    expect(artwork).toContain("\x1b[38;2;");
    expect(artwork).toContain("\x1b[48;2;");
    expect(artwork).toMatch(/[\u2801-\u28FF]/);
    expect(artwork).toContain("█");
    expect(artwork).toContain("▟");
    expect(artwork).not.toMatch(/\x1b_G|1337;File|\.png|NaN|undefined/);
    expect(lines.at(-1)).toContain(
      "A coding agent that grows with your codebase.",
    );
  });

  it("packs the artwork into valid 2×4 masks without enlarging the lockup", () => {
    expect(HOME_BRAND_CELLS).toHaveLength(7);
    for (const row of HOME_BRAND_CELLS) {
      const cells = row.split(" ");
      expect(cells).toHaveLength(36);
      for (const cell of cells) {
        expect(cell).toMatch(
          /^(?:-|[0-9A-F]{2}\/[0-9A-F]{6}\/(?:[0-9A-F]{6}|-))$/,
        );
      }
    }
  });

  it("preserves the reviewed tower, orbit, star, and lowercase wordmark contours", () => {
    const contours = new HomeBrand()
      .render(60)
      .slice(0, 7)
      .map((line) => stripTerminalSequences(line).trimEnd());

    expect(contours).toEqual([
      "       ⣀▟⣇⣀",
      "     ⢀⣀⡉⢹⡏⢁⣀⡀",
      "     ▐⠹⣷⠏⠹▟⠉▌⣀⣀⡀              ▗⣶⡆",
      "     ⠹⡈⠒⠒⠒⠒⢡⠋⢉⣽⠇▗⣶⣶⣶⣦⣠⣶⣶⣶⣄⣠⣶⣶⣦⣸█⣇⣴⣶⡶",
      "  ⢀⣴⠞▜⠇▌⠰⠆⠇⡘⡶▀⠁ ▐▐▛▀▀▐⣟⠙⡆▌▐⣟⢹⡆▌█⠁⠰⡏ ⣀⣀",
      "  ⠿▙⢤⣾⢀⠓⣠⣄⢀⡘⣇   ⠸⣀▌  ⠻⣈⠶⣠⠟⠻⣈⠶⡿▜⣀▛⢿⣈⡾⣀⠇",
      "    ⣾⠚⠩▀▀▀▀⠍⠓⣦",
    ]);
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
    expect(indexedLines.map(stripTerminalSequences)).toEqual(
      rgbLines.map(stripTerminalSequences),
    );
  });
});
