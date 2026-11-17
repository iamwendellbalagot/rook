import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
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
  pinned?: boolean;
  dedupeKey?: string;
}

export type MemoryEvidenceType =
  | "code"
  | "test"
  | "docs"
  | "user_explicit"
  | "commit";

export interface MemoryEvidenceInput {
  path?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  symbol?: string | null;
  contentSha256?: string | null;
  commitSha?: string | null;
  sourceType: MemoryEvidenceType;
  quoteExcerpt?: string | null;
}

export interface MemoryEvidence extends MemoryEvidenceInput {
  id: string;
  memoryId: string;
  createdAt: string;
}

export interface MemoryDraft {
  repoId: string;
  kind: string;
  title: string;
  body: string;
  status: Exclude<MemoryStatus, "deleted">;
  confidence: number;
  sourceClass: string;
  semanticKey?: string;
  validAtCommit?: string | null;
  supersedesId?: string | null;
  evidence?: MemoryEvidenceInput[];
}

export interface MemoryEntry extends MemoryRecord {
  pinned: boolean;
  evidence: MemoryEvidence[];
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  revisionNumber: number;
  previousTitle: string | null;
  nextTitle: string | null;
  previousBody: string | null;
  nextBody: string | null;
  previousStatus: MemoryStatus | null;
  nextStatus: MemoryStatus | null;
  reason: string;
  actor: string;
  changedAt: string;
}

export interface RecordMemoryResult {
  memory: MemoryEntry;
  created: boolean;
}

export interface MemoryCaptureSettings {
  paused: boolean;
  optedOut: boolean;
}

export interface PendingMemoryConfirmation {
  id: string;
  repoId: string;
  kind: string;
  title: string;
  body: string;
  semanticKey: string | null;
  createdAt: string;
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
  {
    version: 2,
    name: "memory_identity_and_revision_titles",
    sql: `
      ALTER TABLE memories ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
      UPDATE memories
        SET dedupe_key = lower(trim(kind)) || ':' || lower(trim(title))
        WHERE dedupe_key = '';
      ALTER TABLE memory_revisions ADD COLUMN previous_title TEXT;
      ALTER TABLE memory_revisions ADD COLUMN next_title TEXT;
      CREATE INDEX idx_memory_dedupe ON memories(repo_id, kind, dedupe_key, status);
      CREATE INDEX idx_evidence_identity ON memory_evidence(
        memory_id, path, symbol, content_sha256, commit_sha, source_type
      );
    `,
  },
  {
    version: 3,
    name: "memory_capture_controls_and_confirmation",
    sql: `
      CREATE TABLE memory_capture_settings (
        repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
        opted_out INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_pending_confirmations (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) <= 200),
        body TEXT NOT NULL CHECK (length(body) <= 1000),
        semantic_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_pending_repo_created
        ON memory_pending_confirmations(repo_id, created_at);
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
    this.db.pragma("secure_delete = ON");
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

  getMemoryCaptureSettings(repoId: string): MemoryCaptureSettings {
    this.db
      .prepare(
        `
      INSERT INTO memory_capture_settings(repo_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(repo_id) DO NOTHING
    `,
      )
      .run(repoId, new Date().toISOString());
    const row = this.db
      .prepare(
        `
      SELECT paused, opted_out FROM memory_capture_settings WHERE repo_id = ?
    `,
      )
      .get(repoId) as { paused: number; opted_out: number };
    return { paused: row.paused === 1, optedOut: row.opted_out === 1 };
  }

  setMemoryCaptureSettings(
    repoId: string,
    settings: Partial<MemoryCaptureSettings>,
    now = new Date().toISOString(),
  ): MemoryCaptureSettings {
    const current = this.getMemoryCaptureSettings(repoId);
    const next = {
      paused: settings.paused ?? current.paused,
      optedOut: settings.optedOut ?? current.optedOut,
    };
    this.db
      .prepare(
        `
      UPDATE memory_capture_settings SET paused = ?, opted_out = ?, updated_at = ?
      WHERE repo_id = ?
    `,
      )
      .run(next.paused ? 1 : 0, next.optedOut ? 1 : 0, now, repoId);
    return next;
  }

  queueMemoryConfirmation(
    repoId: string,
    input: { kind: string; title: string; body: string; semanticKey?: string },
    now = new Date().toISOString(),
  ): PendingMemoryConfirmation {
    const kind = normalizeMemoryKind(input.kind);
    assertSafeMemoryText(kind);
    assertSafeMemoryText(input.title);
    assertSafeMemoryText(input.body);
    if (input.semanticKey) assertSafeMemoryText(input.semanticKey);
    const title = input.title.trim().slice(0, 200);
    const body = input.body.trim().slice(0, 1000);
    if (!title || !body)
      throw new Error("A memory title and claim are required.");
    const pending: PendingMemoryConfirmation = {
      id: randomUUID().slice(0, 12),
      repoId,
      kind,
      title,
      body,
      semanticKey: input.semanticKey?.trim() || null,
      createdAt: now,
    };
    this.db
      .prepare(
        `
      INSERT INTO memory_pending_confirmations(id, repo_id, kind, title, body, semantic_key, created_at)
      VALUES (@id, @repoId, @kind, @title, @body, @semanticKey, @createdAt)
    `,
      )
      .run(pending);
    return pending;
  }

  listPendingMemoryConfirmations(repoId: string): PendingMemoryConfirmation[] {
    return this.db
      .prepare(
        `
      SELECT id, repo_id AS repoId, kind, title, body,
        semantic_key AS semanticKey, created_at AS createdAt
      FROM memory_pending_confirmations WHERE repo_id = ? ORDER BY created_at, id
    `,
      )
      .all(repoId) as PendingMemoryConfirmation[];
  }

  confirmPendingMemory(
    repoId: string,
    pendingId: string,
    now = new Date().toISOString(),
  ): RecordMemoryResult | undefined {
    const confirm = this.db.transaction(() => {
      const pending = this.db
        .prepare(
          `
        SELECT * FROM memory_pending_confirmations WHERE id = ? AND repo_id = ?
      `,
        )
        .get(pendingId, repoId) as
        | {
            id: string;
            repo_id: string;
            kind: string;
            title: string;
            body: string;
            semantic_key: string | null;
          }
        | undefined;
      if (!pending) return undefined;
      const result = this.recordMemory(
        {
          repoId,
          kind: pending.kind,
          title: pending.title,
          body: pending.body,
          ...(pending.semantic_key
            ? { semanticKey: pending.semantic_key }
            : {}),
          status: "verified",
          confidence: 1,
          sourceClass: "user_explicit",
          evidence: [{ sourceType: "user_explicit" }],
        },
        now,
      );
      this.db
        .prepare("DELETE FROM memory_pending_confirmations WHERE id = ?")
        .run(pendingId);
      return result;
    });
    return confirm.immediate();
  }

  cancelPendingMemory(repoId: string, pendingId: string): boolean {
    return (
      this.db
        .prepare(
          `
      DELETE FROM memory_pending_confirmations WHERE id = ? AND repo_id = ?
    `,
        )
        .run(pendingId, repoId).changes > 0
    );
  }

  clearPendingMemoryConfirmations(repoId: string): number {
    return this.db
      .prepare(
        `
      DELETE FROM memory_pending_confirmations WHERE repo_id = ?
    `,
      )
      .run(repoId).changes;
  }

  private insertMemory(memory: MemoryRecord): void {
    assertSafeMemoryText(memory.title);
    assertSafeMemoryText(memory.body);
    assertSafeMemoryText(memory.sourceClass);
    this.db
      .prepare(
        `
      INSERT INTO memories(
        id, repo_id, kind, title, body, status, confidence, source_class,
        created_at, updated_at, verified_at, valid_at_commit, supersedes_id,
        dedupe_key, pinned
      ) VALUES (
        @id, @repoId, @kind, @title, @body, @status, @confidence, @sourceClass,
        @createdAt, @updatedAt, @verifiedAt, @validAtCommit, @supersedesId,
        @dedupeKey, @pinned
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
        dedupeKey: memory.dedupeKey ?? makeDedupeKey(memory.kind, memory.title),
        pinned: memory.pinned ? 1 : 0,
      });
  }

  recordMemory(
    draft: MemoryDraft,
    now = new Date().toISOString(),
  ): RecordMemoryResult {
    assertSafeMemoryText(draft.kind);
    assertSafeMemoryText(draft.title);
    assertSafeMemoryText(draft.body);
    assertSafeMemoryText(draft.sourceClass);
    if (
      !draft.title.trim() ||
      !draft.body.trim() ||
      !draft.sourceClass.trim()
    ) {
      throw new Error("Memory title, body, and source class are required.");
    }
    const kind = normalizeMemoryKind(draft.kind);
    if (draft.semanticKey) assertSafeMemoryText(draft.semanticKey);
    const dedupeKey = makeDedupeKey(kind, draft.semanticKey ?? draft.title);
    const evidence = (draft.evidence ?? []).map((item) =>
      validateEvidence(item),
    );
    const record = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `
        SELECT id FROM memories
        WHERE repo_id = ? AND lower(kind) = ? AND dedupe_key IN (?, ?) AND status <> 'deleted'
        ORDER BY updated_at DESC, id LIMIT 1
      `,
        )
        .get(
          draft.repoId,
          kind,
          dedupeKey,
          makeLegacyDedupeKey(kind, draft.semanticKey ?? draft.title),
        ) as { id: string } | undefined;
      if (existing) {
        for (const item of evidence)
          this.insertEvidence(existing.id, item, now);
        return { memory: this.getMemory(existing.id)!, created: false };
      }

      const memory: MemoryRecord = {
        id: randomUUID(),
        repoId: draft.repoId,
        kind,
        title: draft.title,
        body: draft.body,
        status: draft.status,
        confidence: draft.confidence,
        sourceClass: draft.sourceClass,
        createdAt: now,
        updatedAt: now,
        verifiedAt: draft.status === "verified" ? now : null,
        validAtCommit: draft.validAtCommit ?? null,
        supersedesId: draft.supersedesId ?? null,
        dedupeKey,
      };
      this.insertMemory(memory);
      this.insertRevision({
        memoryId: memory.id,
        revisionNumber: 1,
        previousTitle: null,
        nextTitle: memory.title,
        previousBody: null,
        nextBody: memory.body,
        previousStatus: null,
        nextStatus: memory.status,
        reason: "created",
        actor: draft.sourceClass,
        changedAt: now,
      });
      for (const item of evidence) this.insertEvidence(memory.id, item, now);
      return { memory: this.getMemory(memory.id)!, created: true };
    });
    return record.immediate();
  }

  getMemory(id: string): MemoryEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as RawMemoryRow | undefined;
    if (!row) return undefined;
    const evidenceRows = this.db
      .prepare(
        "SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY created_at, id",
      )
      .all(id) as RawEvidenceRow[];
    return {
      ...toMemoryRecord(row),
      pinned: row.pinned === 1,
      evidence: evidenceRows.map(toMemoryEvidence),
    };
  }

  listMemories(repoId: string, includeDeleted = false): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `
      SELECT id FROM memories WHERE repo_id = ? ${includeDeleted ? "" : "AND status <> 'deleted'"}
      ORDER BY pinned DESC, updated_at DESC, id
    `,
      )
      .all(repoId) as { id: string }[];
    return rows.map((row) => this.getMemory(row.id)!).filter(Boolean);
  }

  listMemoryRevisions(memoryId: string): MemoryRevision[] {
    return (
      this.db
        .prepare(
          `
      SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number
    `,
        )
        .all(memoryId) as RawRevisionRow[]
    ).map(toMemoryRevision);
  }

  addMemoryEvidence(
    memoryId: string,
    evidence: MemoryEvidenceInput,
    now = new Date().toISOString(),
  ): MemoryEvidence | undefined {
    const safeEvidence = validateEvidence(evidence);
    const add = this.db.transaction(() => {
      const memory = this.db
        .prepare("SELECT status FROM memories WHERE id = ?")
        .get(memoryId) as { status: MemoryStatus } | undefined;
      if (!memory || memory.status === "deleted") return undefined;
      return this.insertEvidence(memoryId, safeEvidence, now);
    });
    return add.immediate();
  }

  reviseMemory(
    id: string,
    change: {
      title?: string;
      body?: string;
      status?: Exclude<MemoryStatus, "deleted">;
      confidence?: number;
      validAtCommit?: string | null;
      supersedesId?: string | null;
    },
    reason: string,
    actor: string,
    now = new Date().toISOString(),
  ): MemoryEntry | undefined {
    if (!reason.trim() || !actor.trim()) {
      throw new Error("A revision reason and actor are required.");
    }
    assertSafeMemoryText(reason);
    assertSafeMemoryText(actor);
    if (change.title !== undefined) assertSafeMemoryText(change.title);
    if (change.body !== undefined) assertSafeMemoryText(change.body);
    const revise = this.db.transaction(() => {
      const previous = this.getMemory(id);
      if (!previous || previous.status === "deleted") return undefined;
      const next = {
        title: change.title ?? previous.title,
        body: change.body ?? previous.body,
        status: change.status ?? previous.status,
        confidence: change.confidence ?? previous.confidence,
        validAtCommit:
          change.validAtCommit === undefined
            ? (previous.validAtCommit ?? null)
            : change.validAtCommit,
        supersedesId:
          change.supersedesId === undefined
            ? (previous.supersedesId ?? null)
            : change.supersedesId,
      };
      if (
        next.title === previous.title &&
        next.body === previous.body &&
        next.status === previous.status &&
        next.confidence === previous.confidence &&
        next.validAtCommit === (previous.validAtCommit ?? null) &&
        next.supersedesId === (previous.supersedesId ?? null)
      ) {
        return previous;
      }
      const revisionNumber = this.db
        .prepare(
          "SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM memory_revisions WHERE memory_id = ?",
        )
        .get(id) as { next: number };
      this.insertRevision({
        memoryId: id,
        revisionNumber: revisionNumber.next,
        previousTitle: previous.title,
        nextTitle: next.title,
        previousBody: previous.body,
        nextBody: next.body,
        previousStatus: previous.status,
        nextStatus: next.status,
        reason,
        actor,
        changedAt: now,
      });
      const nextDedupeKey =
        previous.dedupeKey === makeDedupeKey(previous.kind, previous.title)
          ? makeDedupeKey(previous.kind, next.title)
          : previous.dedupeKey;
      this.db
        .prepare(
          `
        UPDATE memories SET title = ?, body = ?, status = ?, confidence = ?,
          valid_at_commit = ?, supersedes_id = ?, updated_at = ?,
          verified_at = CASE WHEN ? = 'verified' THEN COALESCE(verified_at, ?) ELSE verified_at END,
          dedupe_key = ?
        WHERE id = ?
      `,
        )
        .run(
          next.title,
          next.body,
          next.status,
          next.confidence,
          next.validAtCommit,
          next.supersedesId,
          now,
          next.status,
          now,
          nextDedupeKey,
          id,
        );
      return this.getMemory(id);
    });
    return revise.immediate();
  }

  setMemoryPinned(
    id: string,
    pinned: boolean,
    now = new Date().toISOString(),
  ): boolean {
    return (
      this.db
        .prepare(
          `
      UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'
    `,
        )
        .run(pinned ? 1 : 0, now, id).changes > 0
    );
  }

  forgetMemory(
    id: string,
    reason: string,
    now = new Date().toISOString(),
  ): boolean {
    if (!reason.trim()) throw new Error("A forget reason is required.");
    const forget = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT repo_id FROM memories WHERE id = ?")
        .get(id) as { repo_id: string } | undefined;
      if (!row) return false;
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.db
        .prepare(
          `
        INSERT INTO memory_events(id, repo_id, event_type, metadata_json, created_at)
        VALUES (?, ?, 'memory_forgotten', ?, ?)
      `,
        )
        .run(randomUUID(), row.repo_id, JSON.stringify({ memoryId: id }), now);
      return true;
    });
    return forget.immediate();
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
          "UPDATE memory_revisions SET previous_title = NULL, next_title = NULL, previous_body = NULL, next_body = NULL WHERE memory_id = ?",
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

  private insertEvidence(
    memoryId: string,
    evidence: MemoryEvidenceInput,
    now: string,
  ): MemoryEvidence {
    const existing = this.db
      .prepare(
        `
      SELECT * FROM memory_evidence
      WHERE memory_id = ?
        AND path IS ? AND symbol IS ? AND content_sha256 IS ?
        AND commit_sha IS ? AND source_type = ?
      ORDER BY created_at, id LIMIT 1
    `,
      )
      .get(
        memoryId,
        evidence.path ?? null,
        evidence.symbol ?? null,
        evidence.contentSha256 ?? null,
        evidence.commitSha ?? null,
        evidence.sourceType,
      ) as RawEvidenceRow | undefined;
    if (existing) return toMemoryEvidence(existing);
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO memory_evidence(
        id, memory_id, path, start_line, end_line, symbol, content_sha256,
        commit_sha, source_type, quote_excerpt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        memoryId,
        evidence.path ?? null,
        evidence.startLine ?? null,
        evidence.endLine ?? null,
        evidence.symbol ?? null,
        evidence.contentSha256 ?? null,
        evidence.commitSha ?? null,
        evidence.sourceType,
        evidence.quoteExcerpt ?? null,
        now,
      );
    return {
      id,
      memoryId,
      ...evidence,
      createdAt: now,
    };
  }

  private insertRevision(revision: Omit<MemoryRevision, "id">): void {
    this.db
      .prepare(
        `
      INSERT INTO memory_revisions(
        id, memory_id, revision_number, previous_title, next_title,
        previous_body, next_body, previous_status, next_status, reason, actor, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        randomUUID(),
        revision.memoryId,
        revision.revisionNumber,
        revision.previousTitle,
        revision.nextTitle,
        revision.previousBody,
        revision.nextBody,
        revision.previousStatus,
        revision.nextStatus,
        revision.reason,
        revision.actor,
        revision.changedAt,
      );
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

  recordMemoryRetrieval(
    repoId: string,
    memoryIds: string[],
    estimatedTokens: number,
    tokenBudget: number,
    now = new Date().toISOString(),
  ): void {
    const ids = memoryIds.filter((id) => typeof id === "string").slice(0, 6);
    const metadata = JSON.stringify({
      memoryIds: ids,
      estimatedTokens: Math.max(0, Math.trunc(estimatedTokens)),
      tokenBudget: Math.max(0, Math.trunc(tokenBudget)),
    });
    this.db
      .prepare(
        `
      INSERT INTO memory_events(id, repo_id, event_type, metadata_json, created_at)
      VALUES (?, ?, 'memory_retrieval', ?, ?)
    `,
      )
      .run(randomUUID(), repoId, metadata, now);
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

interface RawMemoryRow {
  id: string;
  repo_id: string;
  kind: string;
  title: string;
  body: string;
  status: MemoryStatus;
  confidence: number;
  source_class: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  valid_at_commit: string | null;
  supersedes_id: string | null;
  dedupe_key: string;
  pinned: number;
}

interface RawEvidenceRow {
  id: string;
  memory_id: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  symbol: string | null;
  content_sha256: string | null;
  commit_sha: string | null;
  source_type: MemoryEvidenceType;
  quote_excerpt: string | null;
  created_at: string;
}

interface RawRevisionRow {
  id: string;
  memory_id: string;
  revision_number: number;
  previous_title: string | null;
  next_title: string | null;
  previous_body: string | null;
  next_body: string | null;
  previous_status: MemoryStatus | null;
  next_status: MemoryStatus | null;
  reason: string;
  actor: string;
  changed_at: string;
}

function toMemoryRecord(row: RawMemoryRow): MemoryRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    confidence: row.confidence,
    sourceClass: row.source_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    validAtCommit: row.valid_at_commit,
    supersedesId: row.supersedes_id,
    dedupeKey: row.dedupe_key,
    pinned: row.pinned === 1,
  };
}

function toMemoryEvidence(row: RawEvidenceRow): MemoryEvidence {
  return {
    id: row.id,
    memoryId: row.memory_id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol,
    contentSha256: row.content_sha256,
    commitSha: row.commit_sha,
    sourceType: row.source_type,
    quoteExcerpt: row.quote_excerpt,
    createdAt: row.created_at,
  };
}

function toMemoryRevision(row: RawRevisionRow): MemoryRevision {
  return {
    id: row.id,
    memoryId: row.memory_id,
    revisionNumber: row.revision_number,
    previousTitle: row.previous_title,
    nextTitle: row.next_title,
    previousBody: row.previous_body,
    nextBody: row.next_body,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    reason: row.reason,
    actor: row.actor,
    changedAt: row.changed_at,
  };
}

function makeDedupeKey(kind: string, identity: string): string {
  const normalized = `${kind.normalize("NFKC").trim().toLowerCase()}\0${identity
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeMemoryKind(kind: string): string {
  const normalized = kind.normalize("NFKC").trim().toLowerCase();
  if (!normalized || normalized.length > 64) {
    throw new Error("Memory kind must be between 1 and 64 characters.");
  }
  return normalized;
}

function makeLegacyDedupeKey(kind: string, identity: string): string {
  return `${kind.trim().toLowerCase()}:${identity.trim().toLowerCase()}`;
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /(?:^|\b)[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE[_-]?KEY|DATABASE[_-]?URL)[A-Z0-9_-]*\s*[:=]\s*["']?[^\s"']{8,}/im,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

export function isSafeMemoryContent(value: string): boolean {
  if (
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(
      value,
    )
  ) {
    return false;
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return false;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return false;
  const cardNumbers = value.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  return !cardNumbers.some((candidate) => passesLuhn(candidate));
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

function assertSafeMemoryText(value: string): void {
  if (!isSafeMemoryContent(value)) {
    throw new Error(
      "Potential secret content was rejected; remove credentials before recording memory.",
    );
  }
}

function validateEvidence(evidence: MemoryEvidenceInput): MemoryEvidenceInput {
  if (
    !["code", "test", "docs", "user_explicit", "commit"].includes(
      evidence.sourceType,
    )
  ) {
    throw new Error("Unsupported memory evidence source type.");
  }
  if (
    evidence.startLine != null &&
    (!Number.isInteger(evidence.startLine) || evidence.startLine < 1)
  ) {
    throw new Error("Evidence start line must be a positive integer.");
  }
  if (
    evidence.endLine != null &&
    (!Number.isInteger(evidence.endLine) ||
      evidence.endLine < 1 ||
      (evidence.startLine != null && evidence.endLine < evidence.startLine))
  ) {
    throw new Error("Evidence end line must be at or after its start line.");
  }
  if (
    evidence.contentSha256 != null &&
    !/^[a-f0-9]{64}$/i.test(evidence.contentSha256)
  ) {
    throw new Error("Evidence content hash must be a SHA-256 hex digest.");
  }
  if (evidence.quoteExcerpt && evidence.quoteExcerpt.length > 1000) {
    throw new Error("Evidence quote excerpt exceeds the 1000 character limit.");
  }
  const path = evidence.path?.replaceAll("\\", "/");
  if (
    path
      ?.split("/")
      .some((part) =>
        /^\.env(?:\..*)?$|^(?:id_rsa|id_ed25519|private\.key)$/i.test(part),
      )
  ) {
    throw new Error("Evidence from a secret-bearing path cannot be stored.");
  }
  if (evidence.quoteExcerpt) assertSafeMemoryText(evidence.quoteExcerpt);
  return { ...evidence };
}
