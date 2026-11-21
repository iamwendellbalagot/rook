import test from "node:test";
import assert from "node:assert/strict";
import { lineTotals } from "../src/lines.mjs";
import { discountCents } from "../src/discount.mjs";

test("line totals multiply catalog cents by quantity", () => {
  const lines = Object.freeze([Object.freeze({ sku: "a", quantity: 3 })]);
  assert.deepEqual(lineTotals(lines, Object.freeze({ a: 125 })), [
    { sku: "a", cents: 375 },
  ]);
});
test("half-cent discounts round to nearest cent", () => {
  assert.equal(discountCents(105, 1000), 11);
  assert.equal(discountCents(104, 1000), 10);
});
test("zero percent and full discounts retain integer cents", () => {
  assert.equal(discountCents(123, 0), 0);
  assert.equal(discountCents(123, 10000), 123);
});
