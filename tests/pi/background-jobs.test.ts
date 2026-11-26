import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BackgroundJobs } from "../../src/pi/background-jobs.js";
it("owns, awaits, inspects, and cancels bounded session jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-jobs-"));
  vi.stubEnv("ROOK_HOME", join(root, "home"));
  const jobs = new BackgroundJobs(root);
  try {
    const id = jobs.start("echo BACKGROUND_OK", 5);
    expect(JSON.parse(await jobs.inspect(id, "wait")).result.exitCode).toBe(0);
    expect(JSON.parse(await jobs.inspect(id, "output")).output).toContain(
      "BACKGROUND_OK",
    );
    const active = jobs.start("sleep 30", 60);
    expect(() => jobs.clear()).toThrow("Cancel");
    const result = JSON.parse(await jobs.inspect(active, "cancel"));
    expect(result.result.cancelled).toBe(true);
    jobs.clear();
    await expect(jobs.inspect(id, "status")).rejects.toThrow("Unknown job");
  } finally {
    await jobs.cancelAll();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
