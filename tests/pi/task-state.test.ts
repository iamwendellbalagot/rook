import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskState } from "../../src/pi/task-state.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("restores structured handoffs and marks unfinished tools interrupted, without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-task-"));
  roots.push(root);
  const state = new TaskState(root);
  await state.bind("/workspace", "session-a");
  await state.update({
    goal: "Fix retry behavior",
    constraints: ["Preserve user changes"],
    remaining: ["Verify final diff"],
  });
  await state.started("unknown-result", "bash");
  await state.started("read", "read");
  await state.finished("read", false);
  const resumed = new TaskState(root);
  await resumed.bind("/workspace", "session-a");
  expect(resumed.snapshot()).toMatchObject({
    goal: "Fix retry behavior",
    constraints: ["Preserve user changes"],
    operations: [
      { id: "unknown-result", tool: "bash", status: "interrupted" },
      { id: "read", tool: "read", status: "succeeded" },
    ],
  });
  await resumed.bind("/workspace", "session-b");
  expect(resumed.snapshot().goal).toBe("");
  await expect(
    resumed.update({ remaining: ["x".repeat(1001)] }),
  ).rejects.toThrow("limit");
});
