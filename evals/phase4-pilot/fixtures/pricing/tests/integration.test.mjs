import test from "node:test";
import assert from "node:assert/strict";
import { quote } from "../src/quote.mjs";

test("shipping threshold uses the discounted merchandise amount", () => {
  const result = quote(
    [{ sku: "a", quantity: 2 }],
    { a: 600 },
    { basisPoints: 2500, freeShippingAt: 1000, shippingCents: 99 },
  );
  assert.deepEqual(result, {
    subtotal: 1200,
    discount: 300,
    shipping: 99,
    total: 999,
  });
});
test("exact threshold qualifies for free shipping", () => {
  assert.deepEqual(
    quote(
      [{ sku: "a", quantity: 2 }],
      { a: 500 },
      { basisPoints: 0, freeShippingAt: 1000, shippingCents: 99 },
    ),
    { subtotal: 1000, discount: 0, shipping: 0, total: 1000 },
  );
});
test("rounds the aggregate discount once across repeated SKUs", () => {
  assert.deepEqual(
    quote(
      [
        { sku: "a", quantity: 1 },
        { sku: "a", quantity: 1 },
      ],
      { a: 105 },
      { basisPoints: 1000, freeShippingAt: 1000, shippingCents: 50 },
    ),
    { subtotal: 210, discount: 21, shipping: 50, total: 239 },
  );
});
