import { describe, expect, it } from "vitest";
import {
  LOADING_DOT_INTERVAL_MS,
  LOADING_WORDS,
  LOADING_WORD_INTERVAL_MS,
  shuffleLoadingWords,
} from "../../src/tui/loading-phrases.js";

describe("loading words", () => {
  it("provides 100 distinct coined words", () => {
    expect(LOADING_WORDS).toHaveLength(100);
    expect(new Set(LOADING_WORDS).size).toBe(100);
    expect(LOADING_WORDS.every((word) => /^[a-z]+$/.test(word))).toBe(true);
  });

  it("shuffles the full word pool without dropping or duplicating entries", () => {
    const shuffled = shuffleLoadingWords(() => 0);

    expect(shuffled).toHaveLength(LOADING_WORDS.length);
    expect(new Set(shuffled).size).toBe(LOADING_WORDS.length);
    expect([...shuffled].sort()).toEqual([...LOADING_WORDS].sort());
    expect(shuffled).not.toEqual([...LOADING_WORDS]);
  });

  it("avoids repeating the word from the previous shuffled cycle", () => {
    const shuffled = shuffleLoadingWords(() => 0, LOADING_WORDS[0]);

    expect(shuffled[0]).not.toBe(LOADING_WORDS[0]);
    expect(new Set(shuffled).size).toBe(LOADING_WORDS.length);
  });

  it("keeps the dots animated while changing words every 10 seconds", () => {
    expect(LOADING_WORD_INTERVAL_MS).toBe(10_000);
    expect(LOADING_DOT_INTERVAL_MS).toBeLessThan(LOADING_WORD_INTERVAL_MS);
  });
});
