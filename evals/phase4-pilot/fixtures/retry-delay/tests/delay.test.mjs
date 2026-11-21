import test from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/delay.mjs";

test("uses injected symmetric jitter around exponential backoff", () => {
  assert.equal(retryDelay(0, 100, 1000, 0), 50);
  assert.equal(retryDelay(0, 100, 1000, 0.5), 100);
  assert.equal(retryDelay(0, 100, 1000, 1), 150);
});
test("clamps attempts and caps delay", () => {
  assert.equal(retryDelay(-3, 100, 1000, 0.5), 100);
  assert.equal(retryDelay(20, 100, 1000, 0.5), 1000);
});
test("returns integer in range and does not use global randomness", () => {
  for (let i = 0; i <= 100; i++) {
    const value = retryDelay(2, 25, 1000, i / 100);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 0 && value <= 1000);
  }
});
