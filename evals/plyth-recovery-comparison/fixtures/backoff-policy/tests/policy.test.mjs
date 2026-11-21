import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetry } from "../src/policy.mjs";

test("retries a transient server error when attempts remain", () => {
  assert.equal(shouldRetry({ status: 503 }, 1, 4), true);
});

test("does not retry a permanent client error", () => {
  assert.equal(shouldRetry({ status: 400 }, 1, 4), false);
});

test("does not retry an aborted request", () => {
  assert.equal(shouldRetry({ status: 503, name: "AbortError" }, 1, 4), false);
});

test("does not exceed the total attempt limit", () => {
  assert.equal(shouldRetry({ status: 503 }, 4, 4), false);
});
