export function discountCents(subtotal, basisPoints) {
  return Math.floor((subtotal * basisPoints) / 10000);
}
