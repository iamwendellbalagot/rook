import assert from "node:assert/strict";
import test from "node:test";
import { parseTags } from "../src/tags.mjs";

test("trims tags and keeps the first spelling in stable case-insensitive order", () => {
  assert.deepEqual(parseTags(" Alpha,alpha, Beta ,BETA,Gamma "), [
    "Alpha",
    "Beta",
    "Gamma",
  ]);
});

test("ignores empty comma-separated entries", () => {
  assert.deepEqual(parseTags(",, A, , B,,"), ["A", "B"]);
});

test("accepts an empty value", () => {
  assert.deepEqual(parseTags("  ,  "), []);
});
