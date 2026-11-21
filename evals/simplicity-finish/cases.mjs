export const cases = [
  {
    id: "fixed-transform-pipeline",
    class: "removable",
    task: "Implement normalizeLabel(value): trim edges, collapse internal whitespace to hyphens, lowercase, and preserve punctuation. This is one fixed operation; add no dependencies and preserve the current test behavior.",
    source: `const steps = [value => value.trim(), value => value.replace(/\\s+/g, "-"), value => value.toLowerCase()];\nfunction runSteps(value, operations) { return operations.reduce((result, operation) => operation(result), value); }\nexport function normalizeLabel(value) { return runSteps(value, steps); }\n`,
    candidate: `export function normalizeLabel(value) { return value.trim().replace(/\\s+/g, "-").toLowerCase(); }\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { normalizeLabel } from "../src/main.js";\ntest("normalizes whitespace and case while preserving punctuation", () => { assert.equal(normalizeLabel("  Hello,  World! "), "hello,-world!"); });\n`,
  },
  {
    id: "single-use-query-adapters",
    class: "removable",
    task: "Build a query string from a string-valued object, omit empty values, preserve insertion order, percent-encode keys and values, and join pairs with ampersands. No dependencies; preserve the current encoding behavior.",
    source: `function encodeEntry([key, value]) { return encodeURIComponent(key) + "=" + encodeURIComponent(value); }\nfunction encodeEntries(entries) { return entries.map(encodeEntry); }\nfunction joinEntries(entries) { return entries.join("&"); }\nexport function buildQuery(input) { const entries = Object.entries(input).filter(([, value]) => value !== ""); return joinEntries(encodeEntries(entries)); }\n`,
    candidate: `export function buildQuery(input) { return Object.entries(input).filter(([, value]) => value !== "").map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&"); }\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { buildQuery } from "../src/main.js";\ntest("preserves order, omits empty values, and encodes both sides", () => { assert.equal(buildQuery({ q: "red fox", "x y": "a&b", empty: "" }), "q=red%20fox&x%20y=a%26b"); });\n`,
  },
  {
    id: "single-use-clamp-policy",
    class: "removable",
    task: "Implement clamp(value, min, max) for finite numbers where min <= max. Return min below range, max above range, otherwise value. Keep the exported API and tested boundary behavior.",
    source: `const bounds = (min, max) => ({ lower: min, upper: max });\nfunction applyBounds(value, policy) { if (value < policy.lower) return policy.lower; if (value > policy.upper) return policy.upper; return value; }\nexport function clamp(value, min, max) { return applyBounds(value, bounds(min, max)); }\n`,
    candidate: `export function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { clamp } from "../src/main.js";\ntest("clamps below, above, and inside the interval", () => { assert.deepEqual([-1, 2, 12].map(value => clamp(value, 0, 10)), [0, 2, 10]); });\n`,
  },
  {
    id: "single-use-line-projection",
    class: "removable",
    task: "Return the sum of price times quantity for an array of line items. Inputs are valid finite numbers. Preserve the exported function and exact numeric results.",
    source: `function projectLine(item) { return { amount: item.price * item.quantity }; }\nfunction readAmount(projected) { return projected.amount; }\nfunction totalProjected(items) { return items.map(projectLine).map(readAmount).reduce((sum, amount) => sum + amount, 0); }\nexport function total(items) { return totalProjected(items); }\n`,
    candidate: `export function total(items) { return items.reduce((sum, item) => sum + item.price * item.quantity, 0); }\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { total } from "../src/main.js";\ntest("totals line amounts and handles an empty list", () => { assert.equal(total([{ price: 2.5, quantity: 4 }, { price: 3, quantity: 2 }]), 16); assert.equal(total([]), 0); });\n`,
  },
  {
    id: "retry-cancellation-backoff",
    class: "necessary",
    task: "Implement retry(operation, options): at most maxAttempts, retry only when shouldRetry(error) says so, wait delayMs(attempt) between retries, and stop promptly on AbortSignal. Preserve these separately tested semantics; do not remove policy hooks as 'extra abstraction'.",
    source: `export async function retry(operation, { maxAttempts, shouldRetry, delayMs, sleep, signal }) {\n  let attempt = 0;\n  for (;;) {\n    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");\n    try { return await operation(attempt); } catch (error) {\n      attempt++;\n      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;\n      await sleep(delayMs(attempt), signal);\n    }\n  }\n}\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { retry } from "../src/main.js";\ntest("retries only transient failures with increasing policy delays", async () => { let calls = 0; const delays = []; const value = await retry(async () => { if (++calls < 3) throw Error("temporary"); return "ok"; }, { maxAttempts: 3, shouldRetry: () => true, delayMs: n => n * 10, sleep: async ms => delays.push(ms) }); assert.equal(value, "ok"); assert.deepEqual(delays, [10, 20]); });\ntest("does not retry permanent failures and respects abort", async () => { let calls = 0; await assert.rejects(retry(async () => { calls++; throw Error("permanent"); }, { maxAttempts: 4, shouldRetry: () => false, delayMs: () => 1, sleep: async () => {}, signal: undefined }), /permanent/); assert.equal(calls, 1); const controller = new AbortController(); controller.abort(Error("stop")); await assert.rejects(retry(async () => "never", { maxAttempts: 2, shouldRetry: () => true, delayMs: () => 1, sleep: async () => {}, signal: controller.signal }), /stop/); });\n`,
  },
  {
    id: "path-containment",
    class: "necessary",
    task: "Resolve a user-supplied relative path under a trusted root. Reject absolute paths and any resolution that escapes the root, including sibling-prefix tricks. Preserve safe nested paths and traversal protection.",
    source:
      `import { isAbsolute, relative, resolve } from "node:path";\nexport function resolveWithin(root, requested) {\n  if (isAbsolute(requested)) throw new Error("Absolute paths are not allowed");\n  const base = resolve(root);\n  const target = resolve(base, requested);\n  const fromBase = relative(base, target);\n  if (fromBase === ".." || fromBase.startsWith(` +
      '`..${process.platform === "win32" ? "\\\\" : "/"}`' +
      `) || isAbsolute(fromBase)) throw new Error("Path escapes root");\n  return target;\n}\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { resolveWithin } from "../src/main.js";\ntest("allows nested relative paths and blocks absolute and escaping paths", () => { assert.match(resolveWithin("/safe/root", "src/file.js"), /safe[\\/]root[\\/]src[\\/]file.js$/); assert.throws(() => resolveWithin("/safe/root", "../root-evil/file"), /escapes/); assert.throws(() => resolveWithin("/safe/root", "/etc/passwd"), /Absolute/); });\n`,
  },
  {
    id: "ttl-singleflight-cache",
    class: "necessary",
    task: "Implement an in-memory TTL cache around an async loader. Concurrent misses for one key share a load; successful results expire; rejected loads are removed so later calls retry. Preserve independent keys and protect newer entries from stale completions.",
    source: `export function createCache(load, { ttlMs, now }) {\n  const entries = new Map();\n  return { async get(key) {\n    const entry = entries.get(key);\n    if (entry?.pending) return entry.pending;\n    if (entry && entry.expiresAt > now()) return entry.value;\n    const pending = Promise.resolve().then(() => load(key));\n    entries.set(key, { pending });\n    try { const value = await pending; if (entries.get(key)?.pending === pending) entries.set(key, { value, expiresAt: now() + ttlMs }); return value; }\n    catch (error) { if (entries.get(key)?.pending === pending) entries.delete(key); throw error; }\n  } };\n}\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { createCache } from "../src/main.js";\ntest("coalesces concurrent misses and caches successful values until expiry", async () => { let calls = 0; let time = 0; const cache = createCache(async key => { calls++; return key + calls; }, { ttlMs: 5, now: () => time }); const [a, b] = await Promise.all([cache.get("x"), cache.get("x")]); assert.equal(a, b); assert.equal(calls, 1); time = 6; await cache.get("x"); assert.equal(calls, 2); });\ntest("retries a rejected load instead of caching failure", async () => { let calls = 0; const cache = createCache(async () => { if (++calls === 1) throw Error("temporary"); return "ok"; }, { ttlMs: 5, now: () => 0 }); await assert.rejects(cache.get("x"), /temporary/); assert.equal(await cache.get("x"), "ok"); });\n`,
  },
  {
    id: "cursor-pagination-termination",
    class: "necessary",
    task: "Collect all pages from an async fetchPage(cursor) API. Stop on nextCursor=null, reject repeated cursors to prevent an infinite loop, and enforce maxPages. Preserve page order and all three termination behaviors.",
    source: `export async function collectPages(fetchPage, { maxPages }) {\n  const pages = [];\n  const seen = new Set();\n  let cursor = null;\n  for (let count = 0; count < maxPages; count++) {\n    const page = await fetchPage(cursor);\n    pages.push(...page.items);\n    cursor = page.nextCursor;\n    if (cursor === null) return pages;\n    if (seen.has(cursor)) throw new Error("Pagination cursor repeated");\n    seen.add(cursor);\n  }\n  throw new Error("Pagination page limit exceeded");\n}\n`,
    test: `import test from "node:test"; import assert from "node:assert/strict"; import { collectPages } from "../src/main.js";\ntest("collects in order and stops at the terminal cursor", async () => { const cursors = []; const result = await collectPages(async cursor => { cursors.push(cursor); return cursor === null ? { items: [1], nextCursor: "a" } : { items: [2], nextCursor: null }; }, { maxPages: 3 }); assert.deepEqual(result, [1, 2]); assert.deepEqual(cursors, [null, "a"]); });\ntest("rejects repeated cursors and page-limit exhaustion", async () => { await assert.rejects(collectPages(async () => ({ items: [], nextCursor: "same" }), { maxPages: 4 }), /repeated/); await assert.rejects(collectPages(async () => ({ items: [], nextCursor: "next" }), { maxPages: 1 }), /limit/); });\n`,
  },
];
