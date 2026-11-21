export function normalizeList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
