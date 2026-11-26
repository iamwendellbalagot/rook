import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rookHome } from "../policy/permissions.js";

export interface JournalEvent {
  cursor: number;
  [key: string]: unknown;
}
/** Bounded, private replay tail. Not a command execution or exactly-once ledger. */
export class EventJournal {
  private events: JournalEvent[] = [];
  private cursor = 0;
  private writes = Promise.resolve();
  private writing = false;
  private dirty = false;
  private bytes = 0;
  private constructor(
    private readonly directory: string,
    private readonly path: string,
  ) {}
  static async open(
    workspace: string,
    session: string,
    directory = join(rookHome(), "events"),
  ): Promise<EventJournal> {
    const journal = new EventJournal(
      directory,
      join(
        directory,
        `${createHash("sha256").update(`${workspace}\0${session}`).digest("hex")}.json`,
      ),
    );
    try {
      const text = await readFile(journal.path, "utf8");
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new Error("Event journal exceeds limit");
      const value = JSON.parse(text);
      if (
        !Number.isSafeInteger(value.cursor) ||
        value.cursor < 0 ||
        !Array.isArray(value.events) ||
        value.events.length > 500 ||
        value.events.some(
          (event: any) =>
            !Number.isSafeInteger(event.cursor) ||
            event.cursor <= 0 ||
            event.cursor > value.cursor,
        )
      )
        throw new Error("Invalid event journal");
      journal.cursor = value.cursor;
      journal.events = value.events;
      journal.bytes = journal.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
        0,
      );
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
    return journal;
  }
  append(event: Record<string, unknown>): JournalEvent {
    const record = { ...event, cursor: ++this.cursor };
    this.events.push(record);
    this.bytes += Buffer.byteLength(JSON.stringify(record));
    while (this.events.length > 500 || this.bytes > 1024 * 1024)
      this.bytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
    this.dirty = true;
    this.queueWrite();
    return record;
  }
  private queueWrite(): void {
    if (!this.writing) {
      this.writing = true;
      this.writes = this.writes
        .then(async () => {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          while (this.dirty) {
            this.dirty = false;
            const data = JSON.stringify({
              cursor: this.cursor,
              events: this.events,
            });
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
            await rename(temporary, this.path);
          }
        })
        .then(
          () => {
            this.writing = false;
            if (this.dirty) this.queueWrite();
          },
          (error: unknown) => {
            this.writing = false;
            throw error;
          },
        );
    }
  }
  replay(after: number) {
    const first = this.events[0]?.cursor ?? this.cursor + 1;
    return {
      events: this.events.filter((event) => event.cursor > after),
      cursor: this.cursor,
      gap: after < first - 1 || after > this.cursor,
    };
  }
  async flush(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.writes;
      await pending;
    } while (pending !== this.writes);
  }
}
