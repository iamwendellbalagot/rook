import { lineTotals } from "./lines.mjs";
import { discountCents } from "./discount.mjs";

export function quote(
  lines,
  catalog,
  { basisPoints, freeShippingAt, shippingCents },
) {
  const subtotal = lineTotals(lines, catalog).reduce(
    (sum, line) => sum + line.cents,
    0,
  );
  const discount = discountCents(subtotal, basisPoints);
  const shipping = subtotal >= freeShippingAt ? 0 : shippingCents;
  return {
    subtotal,
    discount,
    shipping,
    total: subtotal - discount + shipping,
  };
}
