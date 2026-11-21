import assert from "node:assert/strict";
import test from "node:test";
import { uniqueKeys } from "../src/keys.mjs";

test("normalizes and deduplicates keys while preserving order", () => {
  assert.deepEqual(uniqueKeys([" Alpha ", "alpha", "BETA", " beta "]), [
    "alpha",
    "beta",
  ]);
});

test("ignores non-strings and blank values", () => {
  assert.deepEqual(uniqueKeys([" ", 3, null, "Gamma"]), ["gamma"]);
});

test("does not mutate the input", () => {
  const input = [" A ", "a"];
  uniqueKeys(input);
  assert.deepEqual(input, [" A ", "a"]);
});
