import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EventJournal } from "../../src/protocol/event-journal.js";
it("replays a bounded durable tail with gap detection and workspace/session isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-events-"));
  try {
    const journal = await EventJournal.open("/workspace", "session", root);
    for (let index = 0; index < 505; index++)
      journal.append({ event: { type: "text_delta", text: `text-${index}` } });
    await journal.flush();
    const restored = await EventJournal.open("/workspace", "session", root);
    expect(restored.replay(0)).toMatchObject({ cursor: 505, gap: true });
    expect(restored.replay(503).events.map((event) => event.cursor)).toEqual([
      504, 505,
    ]);
    expect(restored.replay(503).gap).toBe(false);
    expect(
      (await EventJournal.open("/workspace", "other", root)).replay(0).events,
    ).toEqual([]);
    restored.append({ event: { type: "run_settled" } });
    await restored.flush();
    expect(restored.replay(505).cursor).toBe(506);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
