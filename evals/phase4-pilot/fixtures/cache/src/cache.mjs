import { isFresh } from "./entry.mjs";

export function createCache(load, { ttlMs, now }) {
  const entries = new Map();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (isFresh(entry, now())) return entry.value;
      const pending = load(key);
      entries.set(key, { value: pending, expiresAt: now() + ttlMs });
      const value = await pending;
      entries.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    },
  };
}
