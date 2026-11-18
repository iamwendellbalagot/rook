import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { InferenceStatsLine } from "../../src/tui/inference-stats.js";

describe("inference stats", () => {
  it("shows the latency breakdown when available", () => {
    const text = new InferenceStatsLine({
      elapsedMs: 10000,
      requests: 3,
      firstResponseMs: 1200,
      toolMs: 600,
      approvalMs: 4000,
    })
      .render(220)
      .map(stripTerminalSequences)
      .join("");
    expect(text).toContain(
      "3 requests · first 1.2s · tools 0.6s · approval 4.0s",
    );
  });
  it("shows token counts, average output rate, and elapsed duration on one muted line", () => {
    const lines = new InferenceStatsLine({
      inputTokens: 456,
      outputTokens: 123,
      elapsedMs: 12400,
    }).render(100);
    expect(lines).toHaveLength(1);
    expect(stripTerminalSequences(lines[0]!)).toBe(
      "  in 456 · out 123 · 9.9 tok/s · 12.4s elapsed",
    );
    expect(lines[0]).toContain("\x1b[");
  });

  it("does not invent token counts or rates when usage is unavailable", () => {
    const text = new InferenceStatsLine({ elapsedMs: 2500 })
      .render(100)
      .map(stripTerminalSequences)
      .join("");
    expect(text).toContain("in — · out — · — tok/s · 2.5s elapsed");
  });

  it("distinguishes zero tokens from missing usage", () => {
    const text = new InferenceStatsLine({
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 1000,
    })
      .render(100)
      .map(stripTerminalSequences)
      .join("");
    expect(text).toContain("in 0 · out 0 · 0.0 tok/s · 1.0s elapsed");
  });

  it.each([0, -1, NaN, Infinity])(
    "handles invalid or zero elapsed time (%s) without dividing by zero",
    (elapsedMs) => {
      const text = new InferenceStatsLine({
        inputTokens: 10,
        outputTokens: 20,
        elapsedMs,
      })
        .render(100)
        .map(stripTerminalSequences)
        .join("");
      expect(text).toContain("— tok/s · 0.0s elapsed");
      expect(text).not.toMatch(/NaN|Infinity/);
    },
  );

  it.each([0, 1, 4, 10, 24, 40, 80, 120])(
    "never wraps or exceeds %i columns",
    (width) => {
      const stats = new InferenceStatsLine({
        inputTokens: 123456,
        outputTokens: 7890,
        elapsedMs: 120000,
      });
      const lines = stats.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
      stats.invalidate();
      expect(stats.render(width)).toEqual(lines);
    },
  );
});
