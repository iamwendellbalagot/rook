import { mergeItems } from "./merge.mjs";
import { readPage } from "./page.mjs";

export async function collectItems(fetchPage) {
  let cursor;
  let items = [];
  do {
    const page = readPage(await fetchPage(cursor));
    items = mergeItems(items, page.items);
    if (page.items.length === 0) break;
    cursor = page.next;
  } while (cursor);
  return items;
}
