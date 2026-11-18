import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TASK_CHECKLIST_TOOL_NAME = "rook_todo";
export const TASK_CHECKLIST_SESSION_ENTRY = "rook_task_checklist";

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
      "Create or update Rook's visible checklist for the current user task. It is saved with this session and restored when the session resumes. For substantial multi-step tasks, create a concise ordered checklist before doing the work, then resend the full list with statuses updated as you progress. Use pending, in_progress, or completed. Mark an item completed only after finishing it. Send an empty tasks array to clear a completed or unrelated checklist. Do not use this tool for simple questions or one-step requests unless clearing an old checklist.",
    promptSnippet:
      "Manage the visible, session-persistent checklist for a multi-step user task.",
    promptGuidelines: [
      "Keep an incomplete checklist across ordinary prompts when the user is continuing that task. For a substantial new task, replace it with a concise ordered checklist and keep statuses current; send an empty tasks array to clear a completed or unrelated checklist. Do not create a checklist for simple questions or one-step requests unless clearing an old checklist.",
    ],
    parameters: Type.Object(
      {
        tasks: Type.Array(taskSchema, { maxItems: 12 }),
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
            text: tasks.length
              ? `Checklist updated (${completed}/${tasks.length} complete).`
              : "Checklist cleared.",
          },
        ],
        details: { taskCount: tasks.length, completedCount: completed },
      };
    },
  });
}

export function normalizeTaskChecklist(input: unknown): TaskChecklistItem[] {
  if (!Array.isArray(input)) {
    throw new Error("Checklist tasks must be an array.");
  }
  const tasks: unknown[] = input;
  if (tasks.length > 12) {
    throw new Error("A Rook checklist must contain at most 12 tasks.");
  }
  const ids = new Set<string>();
  return tasks.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Checklist tasks must be objects.");
    }
    const task = value as Record<string, unknown>;
    if (
      typeof task.id !== "string" ||
      typeof task.title !== "string" ||
      (task.status !== "pending" &&
        task.status !== "in_progress" &&
        task.status !== "completed")
    ) {
      throw new Error("Checklist task data is malformed.");
    }
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

export function restoreTaskChecklist(data: unknown): TaskChecklistItem[] {
  if (!data || typeof data !== "object" || !("tasks" in data)) return [];
  const tasks = (data as { tasks?: unknown }).tasks;
  try {
    return normalizeTaskChecklist(tasks);
  } catch {
    return [];
  }
}

export function restoreTaskChecklistFromEntries(
  entries: readonly unknown[],
): TaskChecklistItem[] {
  let tasks: TaskChecklistItem[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (
      entry.type === "custom" &&
      entry.customType === TASK_CHECKLIST_SESSION_ENTRY
    ) {
      tasks = restoreTaskChecklist(entry.data);
    }
  }
  return tasks;
}
