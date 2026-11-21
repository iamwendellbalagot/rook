import test from "node:test";
import assert from "node:assert/strict";
import { summarizeByRegion, summarizeByTeam } from "../src/summarize.mjs";

test("aggregates finite numeric rows by key in first-seen order", () => {
  const rows = [
    { team: "b", region: "west", value: 2 },
    { team: "a", region: "east", value: 3 },
    { team: "b", region: "west", value: 4 },
    { team: "a", region: "east", value: Infinity },
    null,
  ];
  assert.deepEqual(summarizeByTeam(rows), [
    { key: "b", value: 6 },
    { key: "a", value: 3 },
  ]);
  assert.deepEqual(summarizeByRegion(rows), [
    { key: "west", value: 6 },
    { key: "east", value: 3 },
  ]);
  assert.deepEqual(rows[0], { team: "b", region: "west", value: 2 });
});

test("returns a fresh empty result for empty input", () => {
  assert.deepEqual(summarizeByTeam([]), []);
  assert.notEqual(summarizeByTeam([]), summarizeByTeam([]));
});
