import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { HomeBrand } from "../../src/tui/home-brand.js";
import {
  HOME_ROOK_PIXELS,
  HOME_WORDMARK_PIXELS,
} from "../../src/tui/home-brand-art.js";

describe("home brand", () => {
  beforeEach(() => setCapabilityOverrides({ trueColor: true, images: null }));
  afterEach(() => setCapabilityOverrides({}));

  it("renders the icon and wordmark in solid pixels without image protocols", () => {
    const lines = new HomeBrand().render(120);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).map(visibleWidth)).toEqual(Array(7).fill(48));
    const artwork = lines.slice(0, 7).join("\n");
    expect(artwork).toContain("\x1b[38;2;");
    expect(artwork).toContain("\x1b[48;2;");
    expect(artwork).not.toMatch(/[\u2800-\u28FF]/);
    expect(artwork).toContain("█");
    expect(artwork).toContain("▀");
    expect(artwork).toContain("▄");
    expect(artwork).not.toMatch(/\x1b_G|1337;File|\.png|NaN|undefined/);
    expect(lines.at(-1)).toContain(
      "A coding agent that grows with your codebase.",
    );
  });

  it("keeps the crenellated rook at fourteen solid pixels wide", () => {
    expect(HOME_ROOK_PIXELS).toHaveLength(14);
    expect(HOME_ROOK_PIXELS.every((row) => /^[.12]{14}$/.test(row))).toBe(true);
    expect(HOME_ROOK_PIXELS[0]).toBe("..11..11..11..");
    expect(HOME_ROOK_PIXELS.at(-1)).toBe(".111111111111.");
  });

  it("renders a crenellated top, tower, and flared base beside the title", () => {
    const contours = new HomeBrand()
      .render(60)
      .slice(0, 7)
      .map((line) => stripTerminalSequences(line).slice(0, 16).trimEnd());

    expect(contours).toEqual([
      "    ██  ██  ██",
      "    ██████████",
      "     ████████",
      "      █▀▀▀▀█",
      "      ██████",
      "    ▄████████▄",
      "   ████████████",
    ]);
  });

  it("uses a solid ivory wordmark with letter spacing and a cyan dot", () => {
    expect(HOME_WORDMARK_PIXELS).toHaveLength(10);
    expect(HOME_WORDMARK_PIXELS.every((row) => /^[.12]{29}$/.test(row))).toBe(
      true,
    );
    const lines = new HomeBrand().render(60).slice(2, 7);
    const wordmark = lines.map((line) =>
      stripTerminalSequences(line).slice(19),
    );
    expect(wordmark).toEqual([
      "                    ██       ",
      "▄▄▄▄▄  ▄▄▄▄   ▄▄▄▄  ██ ▄▄▄   ",
      "██▀▀█ ██▀▀██ ██▀▀██ ████▀    ",
      "██    ██  ██ ██  ██ ████▄  ▄▄",
      "██    ▀████▀ ▀████▀ ██ ▀█▄ ██",
    ]);
    expect(wordmark.join("")).not.toMatch(/[\u2800-\u28FF]/);
    expect(lines.join("")).toContain("\x1b[38;2;39;216;243m");
  });

  it("aligns the title and divider with the icon's bottom row", () => {
    const lines = new HomeBrand()
      .render(60)
      .slice(0, 7)
      .map(stripTerminalSequences);
    expect(
      lines.slice(0, 2).every((line) => line.slice(16).trim() === ""),
    ).toBe(true);
    expect(lines.slice(2).every((line) => line[17] === "│")).toBe(true);
    const baseline = lines.at(-1)!;
    expect(baseline.slice(0, 16).trim()).not.toBe("");
    expect(baseline.slice(19)).toBe("██    ▀████▀ ▀████▀ ██ ▀█▄ ██");
  });

  it("shows the complete wordmark without the icon when side-by-side is too narrow", () => {
    const lines = new HomeBrand().render(38);
    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 5).join("")).not.toMatch(/[\u2800-\u28FF]/);
    expect(lines.every((line) => visibleWidth(line) <= 38)).toBe(true);
    expect(stripTerminalSequences(lines[4]!)).toContain("▀████▀");
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
