export function lineTotals(lines, catalog) {
  return lines.map(({ sku, quantity }) => ({ sku, cents: catalog[sku] }));
}
