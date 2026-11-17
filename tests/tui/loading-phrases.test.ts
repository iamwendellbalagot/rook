import { describe, expect, it } from "vitest";
import {
  LOADING_PHRASES,
  shuffleLoadingPhrases,
} from "../../src/tui/loading-phrases.js";

describe("loading phrases", () => {
  it("provides 100 distinct phrases", () => {
    expect(LOADING_PHRASES).toHaveLength(100);
    expect(new Set(LOADING_PHRASES).size).toBe(100);
  });

  it("shuffles the full phrase pool without dropping or duplicating entries", () => {
    const shuffled = shuffleLoadingPhrases(() => 0);

    expect(shuffled).toHaveLength(LOADING_PHRASES.length);
    expect(new Set(shuffled).size).toBe(LOADING_PHRASES.length);
    expect([...shuffled].sort()).toEqual([...LOADING_PHRASES].sort());
    expect(shuffled).not.toEqual([...LOADING_PHRASES]);
  });

  it("avoids repeating the phrase from the previous shuffled cycle", () => {
    const shuffled = shuffleLoadingPhrases(() => 0, LOADING_PHRASES[0]);

    expect(shuffled[0]).not.toBe(LOADING_PHRASES[0]);
    expect(new Set(shuffled).size).toBe(LOADING_PHRASES.length);
  });
});
