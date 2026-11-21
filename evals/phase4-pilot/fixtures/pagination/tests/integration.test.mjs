import test from "node:test";
import assert from "node:assert/strict";
import { collectItems } from "../src/collect.mjs";

test("follows cursors across empty pages and preserves first-seen items", async () => {
  const calls = [];
  const pages = [
    { items: [{ id: "a", value: 1 }], next: 0 },
    { items: [], next: "tail" },
    {
      items: [
        { id: "a", value: 9 },
        { id: "b", value: 2 },
      ],
      next: null,
    },
  ];
  const result = await collectItems(async (cursor) => {
    calls.push(cursor);
    assert.ok(calls.length <= 3, "pagination must terminate");
    return pages[calls.length - 1];
  });
  assert.deepEqual(calls, [undefined, 0, "tail"]);
  assert.deepEqual(result, [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);
});
test("an empty terminal page returns no items", async () => {
  assert.deepEqual(
    await collectItems(async () => ({ items: [], next: null })),
    [],
  );
});
test("fetch errors propagate without a retry", async () => {
  let calls = 0;
  await assert.rejects(
    collectItems(async () => {
      calls++;
      throw new Error("network unavailable");
    }),
    /network unavailable/,
  );
  assert.equal(calls, 1);
});
