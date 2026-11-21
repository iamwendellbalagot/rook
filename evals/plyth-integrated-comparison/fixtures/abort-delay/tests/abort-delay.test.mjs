import assert from "node:assert/strict";
import test from "node:test";
import { delay } from "../src/delay.mjs";

test("resolves after the requested delay", async () => {
  await delay(1);
});

test("rejects promptly when aborted", async () => {
  const controller = new AbortController();
  const pending = delay(1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("does not reject when an optional signal is omitted", async () => {
  await delay(1, undefined);
});
