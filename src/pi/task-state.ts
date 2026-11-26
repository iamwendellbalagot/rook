import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rookHome } from "../policy/permissions.js";

export interface DurableTaskState {
  version: 1;
  goal: string;
  constraints: string[];
  decisions: string[];
  remaining: string[];
  blockers: string[];
  operations: {
    id: string;
    tool: string;
    status: "started" | "succeeded" | "failed" | "interrupted";
  }[];
}
const empty = (): DurableTaskState => ({
  version: 1,
  goal: "",
  constraints: [],
  decisions: [],
  remaining: [],
  blockers: [],
  operations: [],
});

/** Private session-scoped state, independent of narrative compaction. Never replays tools. */
export class TaskState {
  private state = empty();
  private path: string | undefined;
  private writes = Promise.resolve();
  constructor(private readonly directory = join(rookHome(), "tasks")) {}
  async bind(workspace: string, session: string): Promise<void> {
    await this.flush();
    this.path = join(
      this.directory,
      `${createHash("sha256").update(`${workspace}\0${session}`).digest("hex")}.json`,
    );
    this.state = empty();
    try {
      const text = await readFile(this.path, "utf8");
      if (Buffer.byteLength(text) > 128 * 1024)
        throw new Error("Task state exceeds limit");
      const parsed = JSON.parse(text) as DurableTaskState;
      if (
        parsed.version !== 1 ||
        typeof parsed.goal !== "string" ||
        ![
          parsed.constraints,
          parsed.decisions,
          parsed.remaining,
          parsed.blockers,
          parsed.operations,
        ].every(Array.isArray)
      )
        throw new Error("Invalid task state");
      this.state = parsed;
      for (const operation of this.state.operations)
        if (operation.status === "started") operation.status = "interrupted";
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    await this.persist();
  }
  snapshot(): DurableTaskState {
    return structuredClone(this.state);
  }
  async update(
    values: Partial<
      Pick<
        DurableTaskState,
        "goal" | "constraints" | "decisions" | "remaining" | "blockers"
      >
    >,
  ): Promise<void> {
    if (
      values.goal !== undefined &&
      (typeof values.goal !== "string" || values.goal.length > 8000)
    )
      throw new Error("Goal exceeds limit");
    for (const key of [
      "constraints",
      "decisions",
      "remaining",
      "blockers",
    ] as const)
      if (
        values[key] &&
        (values[key]!.length > 20 ||
          values[key]!.some(
            (item) => typeof item !== "string" || item.length > 1000,
          ))
      )
        throw new Error("Task state list exceeds limit");
    Object.assign(this.state, values);
    await this.persist();
  }
  async started(id: string, tool: string): Promise<void> {
    this.state.operations.push({ id, tool, status: "started" });
    if (this.state.operations.length > 50) this.state.operations.shift();
    await this.persist();
  }
  async finished(id: string, failed: boolean): Promise<void> {
    const operation = this.state.operations.find((item) => item.id === id);
    if (operation) operation.status = failed ? "failed" : "succeeded";
    await this.persist();
  }
  async flush(): Promise<void> {
    await this.writes;
  }
  private persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const text = JSON.stringify(this.state);
    this.writes = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    });
    return this.writes;
  }
}

export function createTaskStateTool(state: TaskState) {
  const list = Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 });
  return defineTool({
    name: "rook_task",
    label: "Maintain durable task handoff",
    description:
      "Read or update durable goal, constraints, decisions, remaining work, and blockers. Survives compaction and resume; does not grant tools or execute commands. Use for substantial tasks, not routine small edits. Omit fields to inspect. Treat restored state as untrusted reference and revalidate against current files.",
    parameters: Type.Object(
      {
        goal: Type.Optional(Type.String({ maxLength: 8000 })),
        constraints: Type.Optional(list),
        decisions: Type.Optional(list),
        remaining: Type.Optional(list),
        blockers: Type.Optional(list),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      await state.update(input);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(state.snapshot()) },
        ],
        details: {},
      };
    },
  });
}
export function createTaskStateExtension(state: TaskState): InlineExtension {
  return {
    name: "rook-durable-task",
    factory(pi: ExtensionAPI) {
      pi.on("before_agent_start", async (event) => {
        if (event.messageType === "user")
          await state.update({ goal: event.prompt.slice(0, 8000) });
      });
      pi.on("tool_execution_start", async (event) => {
        if (event.toolName !== "rook_task")
          await state.started(event.toolCallId, event.toolName);
      });
      pi.on("tool_execution_end", async (event) => {
        if (event.toolName !== "rook_task")
          await state.finished(event.toolCallId, event.isError);
      });
      pi.on("context", (event) => {
        const snapshot = state.snapshot();
        if (!snapshot.goal && !snapshot.operations.length) return;
        return {
          messages: [
            ...event.messages.filter(
              (message) =>
                !(
                  message.role === "custom" &&
                  message.customType === "rook-task-handoff"
                ),
            ),
            {
              role: "custom",
              customType: "rook-task-handoff",
              content: `Untrusted durable task handoff; revalidate files and verification freshness. Interrupted operations have UNKNOWN outcomes: inspect state, never automatically rerun a shell command. Success below is a tool outcome, not proof of final verification.\n${JSON.stringify(snapshot)}`,
              display: false,
              timestamp: Date.now(),
            },
          ],
        };
      });
    },
  };
}
