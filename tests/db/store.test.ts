import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  RookStore,
  type MemoryDraft,
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

function memory(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    repoId: "repo-1",
    kind: "convention",
    title: "Use SQLite migrations",
    body: "Database schema changes are applied with transactional migrations.",
    status: "verified",
    confidence: 0.9,
    sourceClass: "docs",
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
    expect(versions).toEqual([
      { version: 1, name: "initial_memory_schema" },
      { version: 2, name: "memory_identity_and_revision_titles" },
      {
        version: 3,
        name: "memory_capture_controls_and_confirmation",
      },
    ]);
    expect(reopened.db.pragma("user_version", { simple: true })).toBe(3);
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
    const first = store.recordMemory(memory());
    const second = store.recordMemory(
      memory({
        repoId: "repo-2",
        title: "Other repository",
        body: "Transactional migrations use SQLite.",
      }),
    );
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(1);
    expect(store.searchMemories("repo-2", "migrations")).toHaveLength(1);

    store.reviseMemory(
      first.memory.id,
      {
        title: "Updated convention",
        body: "A distinctive quasar phrase is searchable.",
      },
      "Update the tested claim",
      "user",
      "2026-11-17T12:02:00.000Z",
    );
    expect(store.searchMemories("repo-1", "migrations")).toHaveLength(0);
    expect(store.searchMemories("repo-1", "quasar")[0]?.title).toBe(
      "Updated convention",
    );

    const evidence = store.addMemoryEvidence(first.memory.id, {
      sourceType: "docs",
      quoteExcerpt: "private excerpt",
    });
    store.softDeleteMemory(first.memory.id);
    expect(store.searchMemories("repo-1", "quasar")).toHaveLength(0);
    expect(
      store.db
        .prepare("SELECT title, body FROM memories WHERE id = ?")
        .get(first.memory.id),
    ).toEqual({ title: "", body: "" });
    expect(
      store.db
        .prepare(
          "SELECT previous_body, next_body FROM memory_revisions WHERE memory_id = ?",
        )
        .all(first.memory.id),
    ).toEqual([
      { previous_body: null, next_body: null },
      { previous_body: null, next_body: null },
    ]);
    expect(
      store.db
        .prepare(
          "SELECT quote_excerpt FROM memory_evidence WHERE memory_id = ?",
        )
        .get(first.memory.id),
    ).toEqual({ quote_excerpt: null });
    expect(store.forgetMemory(first.memory.id, "User requested removal")).toBe(
      true,
    );
    expect(
      store.db
        .prepare("SELECT id FROM memory_evidence WHERE id = ?")
        .get(evidence?.id),
    ).toBeUndefined();
    expect(store.getMemory(second.memory.id)).toBeDefined();
    store.close();
  });

  it("enforces foreign-key and content constraints", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    expect(() => store.recordMemory(memory())).toThrow(/FOREIGN KEY/);
    store.saveWorkspace(repository(), null);
    expect(() => store.recordMemory(memory({ confidence: 1.1 }))).toThrow(
      /CHECK/,
    );
    expect(() =>
      store.recordMemory(memory({ status: "unknown" as "candidate" })),
    ).toThrow(/CHECK/);
    expect(() =>
      store.recordMemory(memory({ body: "x".repeat(10_001) })),
    ).toThrow(/CHECK/);
    store.close();
  });

  it("records evidence-aware memories, deduplicates observations, and revisions edits", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    store.saveWorkspace(repository(), null);
    const draft = {
      repoId: "repo-1",
      kind: "architecture",
      title: "Authentication is delegated to AuthService",
      body: "AuthController delegates authentication to AuthService.",
      status: "verified" as const,
      confidence: 0.95,
      sourceClass: "code",
      semanticKey: "AuthController.authenticate",
      evidence: [
        {
          path: "src/auth/controller.ts",
          startLine: 10,
          endLine: 18,
          symbol: "AuthController.authenticate",
          contentSha256: "a".repeat(64),
          commitSha: "commit-1",
          sourceType: "code" as const,
          quoteExcerpt: "return this.authService.authenticate(input);",
        },
      ],
    };
    const created = store.recordMemory(draft, "2026-11-17T12:00:00.000Z");
    const duplicate = store.recordMemory(
      {
        ...draft,
        title: "A renamed observation",
        body: "A duplicate observation.",
      },
      "2026-11-17T12:01:00.000Z",
    );
    expect(created.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.memory.id).toBe(created.memory.id);
    expect(duplicate.memory.evidence).toHaveLength(1);
    expect(store.listMemories("repo-1")).toHaveLength(1);
    expect(store.listMemoryRevisions(created.memory.id)).toHaveLength(1);

    const revised = store.reviseMemory(
      created.memory.id,
      { title: "Authentication delegates to AuthService", status: "verified" },
      "Clarified from source inspection",
      "verifier",
      "2026-11-17T12:02:00.000Z",
    );
    expect(revised?.title).toBe("Authentication delegates to AuthService");
    expect(store.listMemoryRevisions(created.memory.id)).toHaveLength(2);
    expect(store.listMemoryRevisions(created.memory.id)[1]).toMatchObject({
      previousTitle: draft.title,
      nextTitle: "Authentication delegates to AuthService",
      reason: "Clarified from source inspection",
      actor: "verifier",
    });
    store.setMemoryPinned(created.memory.id, true);
    expect(store.getMemory(created.memory.id)?.pinned).toBe(true);

    const again = store.recordMemory(draft);
    expect(again.created).toBe(false);
    expect(store.listMemories("repo-1")).toHaveLength(1);
    store.close();
  });

  it("rejects secret-bearing memory/evidence and secret-file evidence paths", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    store.saveWorkspace(repository(), null);
    const draft = {
      repoId: "repo-1",
      kind: "decision",
      title: "Provider credential setup",
      body: "Credentials are loaded from environment configuration.",
      status: "candidate" as const,
      confidence: 0.4,
      sourceClass: "user",
    };
    expect(() =>
      store.recordMemory({
        ...draft,
        body: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).toThrow(/Potential secret content/);
    expect(() =>
      store.recordMemory({
        ...draft,
        evidence: [{ path: "config/.env.production", sourceType: "docs" }],
      }),
    ).toThrow(/secret-bearing path/);
    expect(() =>
      store.recordMemory({
        ...draft,
        evidence: [
          {
            quoteExcerpt: "Bearer abcdefghijklmnopqrstuvwxyz",
            sourceType: "docs",
          },
        ],
      }),
    ).toThrow(/Potential secret content/);
    expect(store.listMemories("repo-1")).toHaveLength(0);
    store.close();
  });

  it("forgets a memory immediately and cascades its evidence and revision history", async () => {
    const directory = await tempDirectory();
    const store = await RookStore.open(join(directory, "state.sqlite"));
    store.saveWorkspace(repository(), null);
    const { memory: saved } = store.recordMemory({
      repoId: "repo-1",
      kind: "workflow",
      title: "Run the targeted tests",
      body: "Run the targeted unit tests after a small change.",
      status: "candidate",
      confidence: 0.6,
      sourceClass: "user",
      evidence: [{ path: "CONTRIBUTING.md", sourceType: "docs" }],
    });
    expect(store.searchMemories("repo-1", "targeted")).toHaveLength(1);
    expect(store.forgetMemory(saved.id, "User requested removal")).toBe(true);
    expect(store.getMemory(saved.id)).toBeUndefined();
    expect(store.listMemories("repo-1")).toHaveLength(0);
    expect(store.searchMemories("repo-1", "targeted")).toHaveLength(0);
    expect(
      store.db
        .prepare("SELECT * FROM memory_revisions WHERE memory_id = ?")
        .all(saved.id),
    ).toEqual([]);
    expect(
      store.db
        .prepare("SELECT * FROM memory_evidence WHERE memory_id = ?")
        .all(saved.id),
    ).toEqual([]);
    expect(
      store.db
        .prepare("SELECT event_type, metadata_json FROM memory_events")
        .get(),
    ).toEqual({
      event_type: "memory_forgotten",
      metadata_json: JSON.stringify({ memoryId: saved.id }),
    });
    store.close();
  });

  it("rebuilds FTS, creates a consistent SQLite backup, and exports JSON", async () => {
    const directory = await tempDirectory();
    const databasePath = join(directory, "state.sqlite");
    const backupPath = join(directory, "backup", "state.sqlite");
    const store = await RookStore.open(databasePath);
    store.saveWorkspace(repository(), null);
    store.recordMemory(memory());
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
    expect(exported.schemaVersion).toBe(3);
    expect(exported.tables).toHaveProperty("repo_snapshots");
    expect(await readFile(backupPath)).toBeInstanceOf(Buffer);
    store.close();
  });
});
