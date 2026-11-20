import {
  constants,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTraceRecord } from "plyth";
import { PlythTraceStore } from "../../src/pi/plyth-trace.js";
import { plythWorkspaceRevision } from "../../src/pi/plyth-workspace.js";
import { resolvePlythMode } from "../../src/pi/plyth-mode.js";

const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "rook-plyth-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const record = () =>
  createTraceRecord({
    sessionKey: "a".repeat(32),
    nowMs: 123000,
    commandClass: "test",
    verdict: "hit",
    predictionOutcome: "pass",
    observedOutcome: "pass",
  })!;

describe.skipIf(typeof process.getuid !== "function" || !constants.O_NOFOLLOW)(
  "PLYTH private opt-in traces",
  () => {
    it("writes nothing by default; supports explicit enable, disable, safe export and deletion", () => {
      const root = join(temporary(), "rook-home");
      const store = new PlythTraceStore(false, root);
      store.append(record());
      expect(existsSync(root)).toBe(false);
      store.setEnabled(true);
      store.append(record());
      expect(JSON.parse(store.export())).toEqual(record());
      if (process.getuid) {
        expect(statSync(store.file).mode & 0o777).toBe(0o600);
        expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      }
      store.setEnabled(false);
      store.append(record());
      expect(readFileSync(store.file, "utf8").trim().split("\n")).toHaveLength(
        1,
      );
      expect(store.clear()).toContain("cleared");
      expect(existsSync(store.file)).toBe(false);
      store.append(record());
      expect(existsSync(store.file)).toBe(false);
    });

    it("caps storage and rejects unknown fields on both append and export", () => {
      const store = new PlythTraceStore(true, temporary());
      for (let i = 0; i < 500; i++) store.append(record());
      expect(statSync(store.file).size).toBeLessThanOrEqual(65536);
      expect(store.status()).not.toContain("dropped 0");
      const contents = readFileSync(store.file, "utf8");
      store.append({ ...record(), command: "secret" } as ReturnType<
        typeof record
      >);
      expect(readFileSync(store.file, "utf8")).toBe(contents);
      writeFileSync(
        store.file,
        JSON.stringify({ ...record(), output: "secret" }) + "\n",
      );
      expect(store.export()).toContain("no raw records exported");
      expect(store.export()).not.toContain("secret");
    });

    it("does not follow a symlinked trace file or directory", () => {
      const root = temporary();
      const target = join(root, "target");
      writeFileSync(target, "untouched");
      const store = new PlythTraceStore(true, root);
      mkdirSync(store.directory, { mode: 0o700 });
      symlinkSync(target, store.file);
      expect(() => store.append(record())).not.toThrow();
      expect(store.export()).toContain("unavailable");
      expect(store.clear()).toContain("deletion unavailable");
      expect(readFileSync(target, "utf8")).toBe("untouched");
      const other = temporary();
      symlinkSync(root, join(other, "plyth"));
      const linked = new PlythTraceStore(true, other);
      linked.append(record());
      expect(linked.status()).toContain("storage unavailable");
    });

    it("fails open on append contention and refuses a publicly readable ledger", () => {
      const store = new PlythTraceStore(true, temporary());
      store.append(record());
      const before = readFileSync(store.file, "utf8");
      writeFileSync(join(store.directory, "append.lock"), "", { mode: 0o600 });
      expect(() => store.append(record())).not.toThrow();
      expect(readFileSync(store.file, "utf8")).toBe(before);
      expect(store.status()).toContain("storage unavailable");
      chmodSync(store.file, 0o644);
      expect(store.export()).toContain("no raw records exported");
    });
  },
);

describe.skipIf(!constants.O_NOFOLLOW)(
  "PLYTH baseline workspace revision",
  () => {
    it("detects source changes and returns unavailable for linked or oversized inputs", () => {
      const root = temporary();
      writeFileSync(join(root, "source.js"), "one");
      const first = plythWorkspaceRevision(root);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(plythWorkspaceRevision(root)).toBe(first);
      writeFileSync(join(root, "source.js"), "two");
      expect(plythWorkspaceRevision(root)).not.toBe(first);
      symlinkSync(join(root, "source.js"), join(root, "linked.js"));
      expect(plythWorkspaceRevision(root)).toBeUndefined();
      const big = temporary();
      writeFileSync(join(big, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
      expect(plythWorkspaceRevision(big)).toBeUndefined();
    });

    it("does not inspect hidden sensitive inputs or confuse runtime state with source edits", () => {
      const root = temporary();
      writeFileSync(join(root, "a.js"), "a");
      const before = plythWorkspaceRevision(root);
      mkdirSync(join(root, ".rook"));
      writeFileSync(join(root, ".rook", "state"), "changed");
      expect(plythWorkspaceRevision(root)).toBe(before);
      writeFileSync(join(root, ".env"), "sensitive");
      expect(plythWorkspaceRevision(root)).toBeUndefined();
    });
  },
);

it("keeps observation, feedback, persistence and disabled modes independent", () => {
  expect(resolvePlythMode({})).toBe("observe");
  expect(resolvePlythMode({ ROOK_PLYTH_TRACE: "1" })).toBe("observe");
  expect(resolvePlythMode({ ROOK_PLYTH_FEEDBACK: "1" })).toBe("feedback");
  expect(
    resolvePlythMode({ ROOK_PLYTH_MODE: "off", ROOK_PLYTH_FEEDBACK: "1" }),
  ).toBe("off");
  expect(
    resolvePlythMode({ ROOK_PLYTH_MODE: "observe", ROOK_PLYTH_FEEDBACK: "1" }),
  ).toBe("observe");
  expect(
    resolvePlythMode({ ROOK_PLYTH_MODE: "invalid", ROOK_PLYTH_FEEDBACK: "1" }),
  ).toBe("observe");
});
