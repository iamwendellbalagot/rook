import test from "node:test";
import assert from "node:assert/strict";
import { isFresh } from "../src/entry.mjs";
import { createCache } from "../src/cache.mjs";

test("entry expires exactly at the boundary", () => {
  assert.equal(isFresh({ expiresAt: 10 }, 10), false);
  assert.equal(isFresh({ expiresAt: 11 }, 10), true);
  assert.equal(isFresh(undefined, 0), false);
});
test("cached falsy values are reused", async () => {
  let calls = 0;
  const cache = createCache(
    async () => {
      calls++;
      return 0;
    },
    { ttlMs: 10, now: () => 0 },
  );
  assert.equal(await cache.get("a"), 0);
  assert.equal(await cache.get("a"), 0);
  assert.equal(calls, 1);
});
test("keys have independent cached values", async () => {
  const cache = createCache(async (key) => key, { ttlMs: 10, now: () => 0 });
  assert.equal(await cache.get("a"), "a");
  assert.equal(await cache.get("b"), "b");
});
