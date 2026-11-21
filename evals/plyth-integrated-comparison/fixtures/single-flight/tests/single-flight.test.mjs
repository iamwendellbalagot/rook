import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlight } from "../src/cache.mjs";

test("coalesces concurrent loads for the same key", async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;
  let resolve;
  const load = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const first = singleFlight("k", load);
  const second = singleFlight("k", load);
  assert.equal(calls, 1);
  resolve("value");
  assert.deepEqual(await Promise.all([first, second]), ["value", "value"]);
});

test("does not coalesce different keys", async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(
    await Promise.all([singleFlight("a", load), singleFlight("b", load)]),
    [1, 2],
  );
});

test("clears rejected work so a later call can retry", async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;
  await assert.rejects(
    singleFlight("k", async () => {
      calls++;
      throw new Error("temporary");
    }),
    /temporary/,
  );
  assert.equal(
    await singleFlight("k", async () => {
      calls++;
      return "ok";
    }),
    "ok",
  );
  assert.equal(calls, 2);
});
