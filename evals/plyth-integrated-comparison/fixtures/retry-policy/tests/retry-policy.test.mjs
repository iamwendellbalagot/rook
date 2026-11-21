import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetry } from "../src/retry.mjs";

test("retries a retryable error when attempts remain", () => {
  assert.equal(shouldRetry({ retryable: true }, 1, 3), true);
});

test("does not retry a non-retryable error", () => {
  assert.equal(shouldRetry({ retryable: false }, 1, 3), false);
});

test("does not retry cancellation", () => {
  assert.equal(
    shouldRetry({ retryable: true, name: "AbortError" }, 1, 3),
    false,
  );
});

test("stops after the total-attempt limit", () => {
  assert.equal(shouldRetry({ retryable: true }, 3, 3), false);
});
