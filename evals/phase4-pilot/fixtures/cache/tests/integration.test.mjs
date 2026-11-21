import test from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/cache.mjs";

test("in-flight loads coalesce even when the clock passes the TTL", async () => {
  let clock = 0;
  let calls = 0;
  const resolves = [];
  const cache = createCache(
    () => {
      calls++;
      return new Promise((resolve) => resolves.push(resolve));
    },
    { ttlMs: 10, now: () => clock },
  );
  const first = cache.get("a");
  clock = 20;
  const second = cache.get("a");
  const observedCalls = calls;
  for (const resolve of resolves) resolve("ready");
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  assert.equal(observedCalls, 1);
  clock = 29;
  assert.equal(await cache.get("a"), "ready");
  assert.equal(calls, 1, "TTL starts when loading resolves");
});
test("a rejected load is evicted so the next request retries", async () => {
  let calls = 0;
  const cache = createCache(
    async () => {
      if (++calls === 1) throw new Error("transient");
      return "ok";
    },
    { ttlMs: 10, now: () => 0 },
  );
  await assert.rejects(cache.get("a"), /transient/);
  assert.equal(await cache.get("a"), "ok");
  assert.equal(calls, 2);
});
test("successful values reload at the exact expiry time", async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCache(async () => ++calls, {
    ttlMs: 10,
    now: () => clock,
  });
  assert.equal(await cache.get("a"), 1);
  clock = 10;
  assert.equal(await cache.get("a"), 2);
});
