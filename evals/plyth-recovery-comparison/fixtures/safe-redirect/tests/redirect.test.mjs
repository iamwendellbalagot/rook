import assert from "node:assert/strict";
import test from "node:test";
import { isSafeRedirect } from "../src/redirect.mjs";

const base = "https://app.example.test/account";

test("accepts same-origin relative paths", () => {
  assert.equal(isSafeRedirect("/settings", base), true);
});

test("accepts absolute URLs on the same origin", () => {
  assert.equal(isSafeRedirect("https://app.example.test/help", base), true);
});

test("rejects an external absolute URL", () => {
  assert.equal(isSafeRedirect("https://evil.example.test/", base), false);
});

test("rejects protocol-relative external URLs", () => {
  assert.equal(isSafeRedirect("//evil.example.test/", base), false);
});

test("rejects non-HTTP schemes", () => {
  assert.equal(isSafeRedirect("javascript:alert(1)", base), false);
});
