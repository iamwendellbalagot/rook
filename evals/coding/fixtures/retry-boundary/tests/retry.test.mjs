import test from "node:test";
import assert from "node:assert/strict";
import { shouldRetry } from "../src/retry.mjs";

test("allows another attempt below the configured maximum", () => {
  assert.equal(shouldRetry(1, 3), true);
});

test("does not allow another attempt at the configured maximum", () => {
  assert.equal(shouldRetry(3, 3), false);
});

test("does not retry when the configured maximum is zero", () => {
  assert.equal(shouldRetry(0, 0), false);
});
