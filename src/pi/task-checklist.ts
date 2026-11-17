import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TASK_CHECKLIST_TOOL_NAME = "rook_todo";

export type TaskChecklistStatus = "pending" | "in_progress" | "completed";

export interface TaskChecklistItem {
  id: string;
  title: string;
  status: TaskChecklistStatus;
}

const taskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 40 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
    ]),
  },
  { additionalProperties: false },
);

export function createTaskChecklistTool(
  onUpdate: (tasks: TaskChecklistItem[]) => void,
) {
  return defineTool({
    name: TASK_CHECKLIST_TOOL_NAME,
    label: "Update task checklist",
    description:
      "Create or update Rook's visible, in-memory checklist for the current user task. For substantial multi-step tasks, create a concise ordered checklist before doing the work, then resend the full list with statuses updated as you progress. Use pending, in_progress, or completed. Mark an item completed only after finishing it. Do not use this tool for simple questions or one-step requests.",
    promptSnippet: "Manage the visible checklist for a multi-step user task.",
    promptGuidelines: [
      "For a substantial multi-step task, initialize Rook's visible checklist before doing the work and keep its statuses current. Do not create a checklist for simple questions or one-step requests.",
    ],
    parameters: Type.Object(
      {
        tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 12 }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const tasks = normalizeTaskChecklist(params.tasks);
      onUpdate(tasks);
      const completed = tasks.filter(
        (task) => task.status === "completed",
      ).length;
      return {
        content: [
          {
            type: "text",
            text: `Checklist updated (${completed}/${tasks.length} complete).`,
          },
        ],
        details: { taskCount: tasks.length, completedCount: completed },
      };
    },
  });
}

export function normalizeTaskChecklist(
  tasks: TaskChecklistItem[],
): TaskChecklistItem[] {
  if (tasks.length < 1 || tasks.length > 12) {
    throw new Error("A Rook checklist must contain between 1 and 12 tasks.");
  }
  const ids = new Set<string>();
  return tasks.map((task) => {
    const id = task.id.trim();
    const title = task.title.trim();
    if (!id || id.length > 40) {
      throw new Error("Checklist task IDs must contain 1–40 characters.");
    }
    if (!title || title.length > 120) {
      throw new Error("Checklist task titles must contain 1–120 characters.");
    }
    if (ids.has(id)) throw new Error(`Duplicate checklist task ID '${id}'.`);
    ids.add(id);
    return { id, title, status: task.status };
  });
}
