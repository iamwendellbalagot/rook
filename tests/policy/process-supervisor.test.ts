import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runHostCommand } from "../../src/policy/process-supervisor.js";
const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "rook-process-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("streams and bounds output without killing verbose commands", async () => {
  const cwd = await directory();
  let output = "";
  const result = await runHostCommand(
    "i=0; while [ $i -lt 1000 ]; do echo verbose-line; i=$((i+1)); done; echo FINISHED",
    {
      cwd,
      timeout: 5000,
      onData: (data) => (output += data.toString()),
      artifactDirectory: cwd,
      presentationLimit: 100,
      artifactLimit: 100_000,
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.outputLimited).toBe(true);
  expect(Buffer.byteLength(output)).toBe(100);
  expect(await readFile(result.artifact, "utf8")).toContain("FINISHED");
});
it("cancels and escalates even if the leader closes before a TERM-resistant child", async () => {
  const cwd = await directory();
  const result = await runHostCommand(
    "(trap '' TERM; while :; do sleep 1; done) & wait",
    { cwd, timeout: 100, artifactDirectory: cwd, onData: () => {} },
  );
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
});
it("honors an already cancelled signal", async () => {
  const cwd = await directory();
  const result = await runHostCommand("sleep 30", {
    cwd,
    timeout: 5000,
    signal: AbortSignal.abort(),
    artifactDirectory: cwd,
    onData: () => {},
  });
  expect(result.cancelled).toBe(true);
});
