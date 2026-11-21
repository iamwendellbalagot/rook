import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetry } from "../src/retry.mjs";

test("allows another attempt below the total-attempt limit", () => {
  assert.equal(shouldRetry(2, 3), true);
});

test("does not allow an attempt after the total-attempt limit", () => {
  assert.equal(shouldRetry(3, 3), false);
});

test("does not retry when no attempts remain", () => {
  assert.equal(shouldRetry(1, 1), false);
});
