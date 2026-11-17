import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { format } from "prettier";
import { RookStore } from "../src/db/store.js";
import { reconcileMemoryEvidence } from "../src/memory/impact.js";
import type { RepositoryIdentity } from "../src/repo/workspace.js";

const fixtureTime = "2026-11-17T12:00:00.000Z";
const measuredAt = new Date().toISOString();
const directory = await mkdtemp(join(tmpdir(), "rook-fts-benchmark-"));
const source = "export const sharedEvidence = true;\n";
const sourceHash = createHash("sha256").update(source).digest("hex");

try {
  const measurements = [];
  for (const size of [1_000, 10_000]) {
    const root = join(directory, `repo-${size}`);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "shared.ts"), source);
    const store = await RookStore.open(join(directory, `state-${size}.sqlite`));
    const repository: RepositoryIdentity = {
      id: `repo-${size}`,
      logicalId: `repo-${size}`,
      kind: "directory",
      root,
      displayName: `repo-${size}`,
      remoteFingerprint: null,
    };
    store.saveWorkspace(repository, null, fixtureTime);
    populate(store, repository.id, size);

    const samples: number[] = [];
    for (let run = 0; run < 15; run += 1) {
      const start = performance.now();
      store.searchMemories(repository.id, '"needle"', 10);
      const elapsed = performance.now() - start;
      if (run >= 3) samples.push(elapsed);
    }
    const reconciliationStart = performance.now();
    const reconciliation = await reconcileMemoryEvidence(
      store,
      repository,
      null,
    );
    const reconciliationMs = performance.now() - reconciliationStart;
    measurements.push({
      size,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      reconciliationMs,
      checkedEvidence: reconciliation.checked,
      refreshedMemories: reconciliation.refreshed,
    });
    store.close();
  }

  const report = [
    "# SQLite FTS and reconciliation microbenchmark",
    "",
    `Generated: ${fixtureTime} (fixed fixture timestamp; local timings are machine-specific)`,
    "",
    `Measurement runtime: Node ${process.version}, ${process.platform}/${process.arch}; measured ${measuredAt}.`,
    "",
    "Synthetic records are inserted directly through SQLite so the test measures FTS and reconciliation rather than application capture cost. Each memory has one evidence reference to the same small file, exercising path-hash deduplication. FTS measurements include warmup and 12 timed searches of the term `needle`.",
    "",
    "| Memories | FTS p50 (ms) | FTS p95 (ms) | Reconcile all (ms) | Evidence checks |",
    "|---:|---:|---:|---:|---:|",
    ...measurements.map(
      (item) =>
        `| ${item.size.toLocaleString("en-US")} | ${item.p50Ms.toFixed(2)} | ${item.p95Ms.toFixed(2)} | ${item.reconciliationMs.toFixed(2)} | ${item.checkedEvidence.toLocaleString("en-US")} |`,
    ),
    "",
    "This is a focused local microbenchmark, not a cross-machine performance guarantee. It does not measure startup, provider latency, or unique-file hashing at 10k paths. No repository-wide file scan is performed; reconciliation visits only stored evidence paths.",
    "",
  ].join("\n");
  const formatted = await format(report, { filepath: "docs/PERFORMANCE.md" });
  await writeFile(
    new URL("../docs/PERFORMANCE.md", import.meta.url),
    formatted,
  );
  process.stdout.write(formatted);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function populate(store: RookStore, repoId: string, size: number): void {
  const insert = store.db.prepare(`
    INSERT INTO memories(
      id, repo_id, kind, title, body, status, confidence, source_class,
      created_at, updated_at, verified_at, valid_at_commit, supersedes_id,
      dedupe_key, pinned
    ) VALUES (?, ?, 'architecture', ?, ?, 'verified', 0.9, 'code', ?, ?, ?, NULL, NULL, ?, 0)
  `);
  const insertEvidence = store.db.prepare(`
    INSERT INTO memory_evidence(
      id, memory_id, path, start_line, end_line, symbol, content_sha256,
      commit_sha, source_type, quote_excerpt, created_at
    ) VALUES (?, ?, 'src/shared.ts', 1, 1, 'sharedEvidence', ?, NULL, 'code', NULL, ?)
  `);
  const transaction = store.db.transaction(() => {
    for (let index = 0; index < size; index += 1) {
      const id = randomUUID();
      const title = `Fixture memory ${index}`;
      const body =
        index % 20 === 0
          ? `Needle searchable benchmark item ${index}`
          : `Ordinary fixture item ${index}`;
      insert.run(
        id,
        repoId,
        title,
        body,
        fixtureTime,
        fixtureTime,
        fixtureTime,
        `architecture:fixture-${index}`,
      );
      insertEvidence.run(randomUUID(), id, sourceHash, fixtureTime);
    }
  });
  transaction();
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(
        sorted.length - 1,
        Math.ceil(percentileValue * sorted.length) - 1,
      )
    ] ?? 0
  );
}
