import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  RookStore,
  type MemoryRecord,
} from "../../src/db/store.js";
import type {
  GitSnapshot,
  RepositoryIdentity,
} from "../../src/repo/workspace.js";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rook-sqlite-"));
  temporaryDirectories.push(directory);
  return directory;
}

function repository(id = "repo-1"): RepositoryIdentity {
  return {
    id,
    logicalId: "logical-1",
    kind: "git",
    root: "/work/project",
    displayName: "project",
    remoteFingerprint: "fingerprint",
  };
}

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    repoId: "repo-1",
    branch: "main",
    headCommit: "abc123",
    dirtyFingerprint: null,
    capturedAt: "2026-11-17T12:00:00.000Z",
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    repoId: "repo-1",
    kind: "convention",
    title: "Use SQLite migrations",
    body: "Database schema changes are applied with transactional migrations.",
    status: "verified",
    confidence: 0.9,
    sourceClass: "docs",
    createdAt: "2026-11-17T12:00:00.000Z",
    updatedAt: "2026-11-17T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Rook SQLite store", () => {
  it("applies versioned migrations once with foreign keys, WAL, and FTS5", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "state.sqlite");
    const store = await RookStore.open(path);
    const versions = store.db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    store.close();

    const reopened = await RookStore.open(path);
    expect(versions).toEqual([{ version: 1, name: "initial_memory_schema" }]);
    expect(reopened.db.pragma("user_version", { simple: true })).toBe(1);
    expect(reopened.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(reopened.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memory_search'")
        .get(),
    ).toEqual({ name: "memory_search" });
    reopened.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rolls back a failed migration without recording or leaving partial schema", () => {
    const db = new Database(":memory:");
    expect(() =>
      applyMigrations(db, [
        {
          version: 1,
          name: "broken",
          sql: "CREATE TABLE partial(value TEXT); THIS IS NOT SQL;",
        },
      ]),
    ).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
    ).toBe(undefined);
    expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    db.close();
  });

  it("persists repository identity and snapshot history", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    store.saveWorkspace(repository(), snapshot());
    store.saveWorkspace(
      repository(),
      snapshot({
        branch: "feature",
        headCommit: "def456",
        dirtyFingerprint: "dirty",
        capturedAt: "2026-11-17T12:01:00.000Z",
      }),
    );

    expect(store.getRepository("repo-1")).toMatchObject({
      id: "repo-1",
      canonicalRoot: "/work/project",
      remoteFingerprint: "fingerprint",
    });
    expect(store.listSnapshots("repo-1")).toHaveLength(2);
    expect(store.listSnapshots("repo-1")[1]).toMatchObject({
      branch: "feature",
      headCommit: "def456",
      dirtyFingerprint: "dirty",
    });
    expect(() =>
      store.saveWorkspace(repository("missing"), null),
    ).not.toThrow();
    store.close();
  });

  it("keeps FTS in sync transactionally, scopes search, and removes soft-deleted content", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    store.saveWorkspace(repository(), null);
    store.saveWorkspace(repository("repo-2"), null);
    store.saveMemory(memory());
    store.saveMemory(
      memory({
        id: "memory-2",
        repoId: "repo-2",
        title: "Other repository",
        body: "Transactional migrations use SQLite.",
      }),
    );
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(1);
    expect(store.searchMemories("repo-2", "migrations")).toHaveLength(1);

    store.updateMemory("memory-1", {
      title: "Updated convention",
      body: "A distinctive quasar phrase is searchable.",
      status: "verified",
      updatedAt: "2026-11-17T12:02:00.000Z",
    });
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(0);
    expect(store.searchMemories("repo-1", "quasar")[0]?.title).toBe(
      "Updated convention",
    );

    store.db
      .prepare(
        `
      INSERT INTO memory_revisions(
        id, memory_id, revision_number, previous_body, next_body,
        reason, actor, changed_at
      ) VALUES ('revision-1', 'memory-1', 1, 'private old text', 'private new text', 'edit', 'user', 'now')
    `,
      )
      .run();
    store.db
      .prepare(
        `
      INSERT INTO memory_evidence(id, memory_id, source_type, quote_excerpt, created_at)
      VALUES ('evidence-1', 'memory-1', 'docs', 'private excerpt', 'now')
    `,
      )
      .run();
    store.softDeleteMemory("memory-1");
    expect(store.searchMemories("repo-1", "quasar")).toHaveLength(0);
    expect(
      store.db
        .prepare("SELECT title, body FROM memories WHERE id = ?")
        .get("memory-1"),
    ).toEqual({ title: "", body: "" });
    expect(
      store.db
        .prepare(
          "SELECT previous_body, next_body FROM memory_revisions WHERE memory_id = ?",
        )
        .get("memory-1"),
    ).toEqual({ previous_body: null, next_body: null });
    expect(
      store.db
        .prepare(
          "SELECT quote_excerpt FROM memory_evidence WHERE memory_id = ?",
        )
        .get("memory-1"),
    ).toEqual({ quote_excerpt: null });
    store.purgeMemory("memory-1");
    expect(
      store.db
        .prepare("SELECT id FROM memory_evidence WHERE id = ?")
        .get("evidence-1"),
    ).toBeUndefined();
    store.close();
  });

  it("enforces foreign-key and content constraints", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    expect(() => store.saveMemory(memory())).toThrow(/FOREIGN KEY/);
    store.saveWorkspace(repository(), null);
    expect(() => store.saveMemory(memory({ confidence: 1.1 }))).toThrow(
      /CHECK/,
    );
    expect(() =>
      store.saveMemory(memory({ status: "unknown" as "verified" })),
    ).toThrow(/CHECK/);
    expect(() =>
      store.saveMemory(memory({ body: "x".repeat(10_001) })),
    ).toThrow(/CHECK/);
    store.close();
  });

  it("rebuilds FTS, creates a consistent SQLite backup, and exports JSON", async () => {
    const directory = await tempDirectory();
    const databasePath = join(directory, "state.sqlite");
    const backupPath = join(directory, "backup", "state.sqlite");
    const store = await RookStore.open(databasePath);
    store.saveWorkspace(repository(), null);
    store.saveMemory(memory());
    store.db.prepare("DELETE FROM memory_search").run();
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(0);

    store.rebuildSearchIndex();
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(1);
    await store.backup(backupPath);
    const backupDb = new Database(backupPath, { readonly: true });
    expect(
      backupDb.prepare("SELECT count(*) AS count FROM memories").get(),
    ).toEqual({
      count: 1,
    });
    backupDb.close();

    const exported = store.exportJson();
    expect(exported.format).toBe("rook-sqlite-export-v1");
    expect(exported.schemaVersion).toBe(1);
    expect(exported.tables).toHaveProperty("repo_snapshots");
    expect(await readFile(backupPath)).toBeInstanceOf(Buffer);
    store.close();
  });
});
