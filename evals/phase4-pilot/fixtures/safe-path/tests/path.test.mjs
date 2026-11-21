import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveChild } from "../src/path.mjs";

const root = resolve("/fixture/workspace");
test("accepts ordinary nested children", () => {
  assert.equal(
    resolveChild(root, "src/lib/file.mjs"),
    resolve(root, "src/lib/file.mjs"),
  );
});
test("rejects absolute paths, parent traversal, and the root itself", () => {
  for (const child of [
    "/etc/passwd",
    "../outside",
    "src/../../outside",
    ".",
    "src/..",
  ])
    assert.throws(() => resolveChild(root, child));
});
