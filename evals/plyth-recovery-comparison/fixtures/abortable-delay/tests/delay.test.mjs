import assert from "node:assert/strict";
import test from "node:test";
import { delay } from "../src/delay.mjs";

test("resolves when not aborted", async () => {
  await delay(1);
});

test("rejects promptly when aborted during the wait", async () => {
  const controller = new AbortController();
  const pending = delay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("rejects immediately for an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(delay(10_000, controller.signal), {
    name: "AbortError",
  });
});
