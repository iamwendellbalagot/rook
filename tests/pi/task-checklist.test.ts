import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createTaskChecklistTool,
  normalizeTaskChecklist,
  restoreTaskChecklistFromEntries,
  TASK_CHECKLIST_SESSION_ENTRY,
} from "../../src/pi/task-checklist.js";

describe("Rook task checklist", () => {
  it("publishes a normalized checklist and reports completion progress", async () => {
    let update: unknown;
    const tool = createTaskChecklistTool((tasks) => {
      update = tasks;
    });
    const tasks = [
      {
        id: " inspect ",
        title: " Inspect the project ",
        status: "completed" as const,
      },
      {
        id: "implement",
        title: "Implement the feature",
        status: "in_progress" as const,
      },
    ];

    const result = await tool.execute(
      "call-1",
      { tasks },
      undefined,
      undefined,
      {} as never,
    );

    expect(update).toEqual([
      { id: "inspect", title: "Inspect the project", status: "completed" },
      {
        id: "implement",
        title: "Implement the feature",
        status: "in_progress",
      },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "Checklist updated (1/2 complete)." },
    ]);
  });

  it("rejects duplicate task IDs", () => {
    expect(() =>
      normalizeTaskChecklist([
        { id: "same", title: "First", status: "pending" },
        { id: "same", title: "Second", status: "pending" },
      ]),
    ).toThrow("Duplicate checklist task ID 'same'.");
  });

  it("accepts an empty checklist as an explicit clear", async () => {
    let update: unknown;
    const tool = createTaskChecklistTool((tasks) => {
      update = tasks;
    });
    const result = await tool.execute(
      "call-clear",
      { tasks: [] },
      undefined,
      undefined,
      {} as never,
    );

    expect(update).toEqual([]);
    expect(result.content).toEqual([
      { type: "text", text: "Checklist cleared." },
    ]);
  });

  it("restores the latest branch-local state and treats an empty snapshot as cleared", () => {
    const first = [
      { id: "inspect", title: "Inspect", status: "completed" as const },
    ];
    const latest = [
      { id: "implement", title: "Implement", status: "in_progress" as const },
    ];
    const entries = [
      { type: "custom", customType: "unrelated", data: { tasks: first } },
      {
        type: "custom",
        customType: TASK_CHECKLIST_SESSION_ENTRY,
        data: { tasks: first },
      },
      {
        type: "custom",
        customType: TASK_CHECKLIST_SESSION_ENTRY,
        data: { tasks: latest },
      },
    ];
    expect(restoreTaskChecklistFromEntries(entries)).toEqual(latest);
    expect(
      restoreTaskChecklistFromEntries([
        ...entries,
        {
          type: "custom",
          customType: TASK_CHECKLIST_SESSION_ENTRY,
          data: { tasks: [] },
        },
      ]),
    ).toEqual([]);
  });

  it("ignores malformed persisted checklist data", () => {
    expect(
      restoreTaskChecklistFromEntries([
        {
          type: "custom",
          customType: TASK_CHECKLIST_SESSION_ENTRY,
          data: {
            tasks: [
              { id: "same", title: "First", status: "pending" },
              { id: "same", title: "Duplicate", status: "pending" },
            ],
          },
        },
      ]),
    ).toEqual([]);
  });

  it("rejects malformed persisted statuses and field types at runtime", () => {
    for (const tasks of [
      [{ id: "x", title: "Task", status: "blocked" }],
      [{ id: "x", title: 3, status: "pending" }],
      [{ id: "x", title: "Task" }],
      [null],
    ]) {
      expect(
        restoreTaskChecklistFromEntries([
          {
            type: "custom",
            customType: TASK_CHECKLIST_SESSION_ENTRY,
            data: { tasks },
          },
        ]),
      ).toEqual([]);
    }
  });

  it("survives closing and reopening the owning Pi session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rook-checklist-session-"));
    try {
      const sessionDir = join(directory, "sessions");
      const manager = SessionManager.create(directory, sessionDir);
      manager.appendMessage({
        role: "user",
        content: "Implement a multi-step change",
        timestamp: Date.now(),
      });
      const tasks = [
        {
          id: "inspect",
          title: "Inspect the code",
          status: "completed" as const,
        },
        {
          id: "implement",
          title: "Implement the change",
          status: "in_progress" as const,
        },
      ];
      manager.appendCustomEntry(TASK_CHECKLIST_SESSION_ENTRY, { tasks });
      const sessionPath = manager.getSessionFile();
      expect(sessionPath).toBeTruthy();

      const reopened = SessionManager.open(sessionPath!);
      expect(restoreTaskChecklistFromEntries(reopened.getBranch())).toEqual(
        tasks,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
