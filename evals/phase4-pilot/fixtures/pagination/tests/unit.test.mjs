import test from "node:test";
import assert from "node:assert/strict";
import { readPage } from "../src/page.mjs";
import { mergeItems } from "../src/merge.mjs";

test("numeric zero is a valid continuation cursor", () => {
  assert.equal(readPage({ items: [], next: 0 }).next, 0);
});
test("missing and null cursors end pagination", () => {
  assert.equal(readPage({}).next, undefined);
  assert.equal(readPage({ next: null }).next, undefined);
});
test("first copy of an item wins without mutating inputs", () => {
  const first = Object.freeze({ id: "a", value: 1 });
  const current = Object.freeze([first]);
  const incoming = Object.freeze([
    { id: "a", value: 2 },
    { id: "b", value: 3 },
  ]);
  const result = mergeItems(current, incoming);
  assert.deepEqual(result, [first, { id: "b", value: 3 }]);
  assert.equal(result[0], first);
});
test("duplicates within one page also keep the first value", () => {
  assert.deepEqual(
    mergeItems(
      [],
      [
        { id: 0, value: 1 },
        { id: 0, value: 2 },
      ],
    ),
    [{ id: 0, value: 1 }],
  );
});
