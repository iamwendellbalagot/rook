export function isFresh(entry, now) {
  return Boolean(entry) && entry.expiresAt >= now;
}
