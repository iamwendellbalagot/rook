import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GitSnapshot, RepositoryIdentity } from "../repo/workspace.js";

export type MemoryStatus =
  | "candidate"
  | "verified"
  | "possibly_stale"
  | "stale"
  | "contradicted"
  | "superseded"
  | "deleted";

export interface MemoryRecord {
  id: string;
  repoId: string;
  kind: string;
  title: string;
  body: string;
  status: MemoryStatus;
  confidence: number;
  sourceClass: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string | null;
  validAtCommit?: string | null;
  supersedesId?: string | null;
}

export interface RepositorySummary {
  id: string;
  logicalId: string;
  kind: RepositoryIdentity["kind"];
  displayName: string;
  canonicalRoot: string;
  remoteFingerprint: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface SnapshotRecord {
  id: string;
  repoId: string;
  branch: string | null;
  headCommit: string | null;
  dirtyFingerprint: string | null;
  createdAt: string;
}

export interface SearchResult {
  memoryId: string;
  title: string;
  body: string;
  rank: number;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_memory_schema",
    sql: `
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        logical_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('git', 'directory')),
        display_name TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        remote_fingerprint TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE repo_snapshots (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        branch TEXT,
        head_commit TEXT,
        dirty_fingerprint TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_snapshots_repo_created ON repo_snapshots(repo_id, created_at);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('candidate','verified','possibly_stale','stale','contradicted','superseded','deleted')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_class TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        valid_at_commit TEXT,
        supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
        CHECK (length(body) <= 10000)
      );

      CREATE TABLE memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        symbol TEXT,
        content_sha256 TEXT,
        commit_sha TEXT,
        source_type TEXT NOT NULL,
        quote_excerpt TEXT CHECK (quote_excerpt IS NULL OR length(quote_excerpt) <= 1000),
        created_at TEXT NOT NULL
      );

      CREATE TABLE memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        previous_body TEXT,
        next_body TEXT,
        previous_status TEXT,
        next_status TEXT,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        UNIQUE (memory_id, revision_number)
      );

      CREATE TABLE memory_links (
        from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, relation),
        CHECK (from_id <> to_id)
      );

      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE memory_search USING fts5(
        memory_id UNINDEXED, title, body, tokenize='unicode61'
      );
      CREATE TRIGGER memories_search_insert AFTER INSERT ON memories
        WHEN new.status <> 'deleted' BEGIN
          INSERT INTO memory_search(memory_id, title, body)
          VALUES (new.id, new.title, new.body);
        END;
      CREATE TRIGGER memories_search_update AFTER UPDATE ON memories BEGIN
        DELETE FROM memory_search WHERE memory_id = old.id;
        INSERT INTO memory_search(memory_id, title, body)
          SELECT new.id, new.title, new.body WHERE new.status <> 'deleted';
      END;
      CREATE TRIGGER memories_search_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_search WHERE memory_id = old.id;
      END;

      CREATE INDEX idx_memory_repo_status ON memories(repo_id, status, updated_at);
      CREATE INDEX idx_evidence_path ON memory_evidence(path, memory_id);
    `,
  },
];

export function defaultDatabasePath(): string {
  return join(
    resolve(process.env.ROOK_HOME || join(homedir(), ".rook")),
    "state.sqlite",
  );
}

export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as {
        version: number;
      }[]
    ).map((row) => row.version),
  );
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const highestVersion = Math.max(
    0,
    ...migrations.map((migration) => migration.version),
  );
  if (currentVersion > highestVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this Rook version supports (${highestVersion}).`,
    );
  }
  const migrate = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
    ).run(migration.version, migration.name, new Date().toISOString());
    db.pragma(`user_version = ${migration.version}`);
  });

  let lastVersion = 0;
  for (const migration of [...migrations].sort(
    (a, b) => a.version - b.version,
  )) {
    if (
      !Number.isInteger(migration.version) ||
      migration.version <= lastVersion
    ) {
      throw new Error(
        "SQLite migrations must have unique, ascending positive versions.",
      );
    }
    lastVersion = migration.version;
    if (!applied.has(migration.version)) migrate(migration);
  }
}

export class RookStore {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    applyMigrations(this.db);
  }

  static async open(path = defaultDatabasePath()): Promise<RookStore> {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Rook database must be a regular file.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const db = new Database(absolutePath);
    try {
      await chmod(absolutePath, 0o600);
      return new RookStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  saveWorkspace(
    repository: RepositoryIdentity,
    snapshot: GitSnapshot | null,
    now = new Date().toISOString(),
  ): void {
    const save = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO repositories(id, logical_id, kind, display_name, canonical_root, remote_fingerprint, created_at, last_seen_at)
        VALUES (@id, @logicalId, @kind, @displayName, @canonicalRoot, @remoteFingerprint, @createdAt, @lastSeenAt)
        ON CONFLICT(id) DO UPDATE SET
          logical_id = excluded.logical_id,
          kind = excluded.kind,
          display_name = excluded.display_name,
          canonical_root = excluded.canonical_root,
          remote_fingerprint = excluded.remote_fingerprint,
          last_seen_at = excluded.last_seen_at
      `,
        )
        .run({
          id: repository.id,
          logicalId: repository.logicalId,
          kind: repository.kind,
          displayName: repository.displayName,
          canonicalRoot: repository.root,
          remoteFingerprint: repository.remoteFingerprint,
          createdAt: now,
          lastSeenAt: now,
        });
      if (snapshot) {
        this.db
          .prepare(
            `
          INSERT INTO repo_snapshots(id, repo_id, branch, head_commit, dirty_fingerprint, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            randomUUID(),
            repository.id,
            snapshot.branch,
            snapshot.headCommit,
            snapshot.dirtyFingerprint,
            snapshot.capturedAt,
          );
      }
    });
    save();
  }

  getRepository(id: string): RepositorySummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM repositories WHERE id = ?")
      .get(id) as
      | {
          id: string;
          logical_id: string;
          kind: RepositoryIdentity["kind"];
          display_name: string;
          canonical_root: string;
          remote_fingerprint: string | null;
          created_at: string;
          last_seen_at: string;
        }
      | undefined;
    return (
      row && {
        id: row.id,
        logicalId: row.logical_id,
        kind: row.kind,
        displayName: row.display_name,
        canonicalRoot: row.canonical_root,
        remoteFingerprint: row.remote_fingerprint,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
      }
    );
  }

  listSnapshots(repoId: string): SnapshotRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM repo_snapshots WHERE repo_id = ? ORDER BY created_at, id",
        )
        .all(repoId) as {
        id: string;
        repo_id: string;
        branch: string | null;
        head_commit: string | null;
        dirty_fingerprint: string | null;
        created_at: string;
      }[]
    ).map((row) => ({
      id: row.id,
      repoId: row.repo_id,
      branch: row.branch,
      headCommit: row.head_commit,
      dirtyFingerprint: row.dirty_fingerprint,
      createdAt: row.created_at,
    }));
  }

  saveMemory(memory: MemoryRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO memories(
        id, repo_id, kind, title, body, status, confidence, source_class,
        created_at, updated_at, verified_at, valid_at_commit, supersedes_id
      ) VALUES (
        @id, @repoId, @kind, @title, @body, @status, @confidence, @sourceClass,
        @createdAt, @updatedAt, @verifiedAt, @validAtCommit, @supersedesId
      )
    `,
      )
      .run({
        ...memory,
        repoId: memory.repoId,
        sourceClass: memory.sourceClass,
        verifiedAt: memory.verifiedAt ?? null,
        validAtCommit: memory.validAtCommit ?? null,
        supersedesId: memory.supersedesId ?? null,
      });
  }

  updateMemory(
    id: string,
    update: {
      title: string;
      body: string;
      status: MemoryStatus;
      updatedAt: string;
    },
  ): void {
    this.db
      .prepare(
        `
      UPDATE memories SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?
    `,
      )
      .run(update.title, update.body, update.status, update.updatedAt, id);
  }

  softDeleteMemory(id: string, updatedAt = new Date().toISOString()): void {
    const softDelete = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE memories SET status = 'deleted', title = '', body = '', updated_at = ? WHERE id = ?",
        )
        .run(updatedAt, id);
      this.db
        .prepare(
          "UPDATE memory_revisions SET previous_body = NULL, next_body = NULL WHERE memory_id = ?",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE memory_evidence SET quote_excerpt = NULL WHERE memory_id = ?",
        )
        .run(id);
    });
    softDelete();
  }

  purgeMemory(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  searchMemories(repoId: string, query: string, limit = 20): SearchResult[] {
    if (!query.trim()) return [];
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db
      .prepare(
        `
      SELECT s.memory_id AS memoryId, s.title, s.body, bm25(memory_search) AS rank
      FROM memory_search s
      JOIN memories m ON m.id = s.memory_id
      WHERE memory_search MATCH ? AND m.repo_id = ? AND m.status <> 'deleted'
      ORDER BY rank LIMIT ?
    `,
      )
      .all(query, repoId, safeLimit) as SearchResult[];
  }

  rebuildSearchIndex(): void {
    const rebuild = this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_search");
      this.db.exec(`
        INSERT INTO memory_search(memory_id, title, body)
        SELECT id, title, body FROM memories WHERE status <> 'deleted'
      `);
    });
    rebuild();
  }

  async backup(destination: string): Promise<void> {
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await this.db.backup(target);
    await chmod(target, 0o600);
  }

  exportJson(): Record<string, unknown> {
    const tableNames = [
      "repositories",
      "repo_snapshots",
      "memories",
      "memory_evidence",
      "memory_revisions",
      "memory_links",
      "memory_events",
    ];
    return {
      format: "rook-sqlite-export-v1",
      exportedAt: new Date().toISOString(),
      schemaVersion: this.db.pragma("user_version", { simple: true }),
      tables: Object.fromEntries(
        tableNames.map((table) => [
          table,
          this.db.prepare(`SELECT * FROM ${table}`).all(),
        ]),
      ),
    };
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
