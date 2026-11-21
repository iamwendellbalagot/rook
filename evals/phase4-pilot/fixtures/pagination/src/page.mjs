export function readPage(response) {
  return { items: response.items ?? [], next: response.next || undefined };
}
