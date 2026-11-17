import { describe, expect, it } from "vitest";
import {
  createTaskChecklistTool,
  normalizeTaskChecklist,
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
});
