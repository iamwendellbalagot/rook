import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLabels } from "../src/labels.mjs";

test("trims labels and removes case-insensitive duplicates, keeping first spelling", () => {
  assert.deepEqual(normalizeLabels(["Urgent", " urgent ", "Review"]), [
    "Urgent",
    "Review",
  ]);
});

test("ignores blank and non-string values", () => {
  assert.deepEqual(normalizeLabels(["  ", null, 3, "Ready"]), ["Ready"]);
});

test("does not mutate the input and preserves order", () => {
  const labels = ["First", "Second", "FIRST"];
  expectNoMutation(labels);
  assert.deepEqual(labels, ["First", "Second", "FIRST"]);
  assert.deepEqual(normalizeLabels(labels), ["First", "Second"]);
});

function expectNoMutation(labels) {
  const before = [...labels];
  normalizeLabels(labels);
  assert.deepEqual(labels, before);
}
