import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RookStore } from "../../src/db/store.js";
import {
  manuallyVerifyMemory,
  reconcileMemoryEvidence,
} from "../../src/memory/impact.js";
import { retrieveMemoryContext } from "../../src/memory/context.js";
import type {
  GitSnapshot,
  RepositoryIdentity,
} from "../../src/repo/workspace.js";

const directories: string[] = [];

async function setup(): Promise<{
  root: string;
  store: RookStore;
  repository: RepositoryIdentity;
  snapshot: GitSnapshot;
  memoryId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "rook-impact-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  const filePath = join(root, "src", "auth.ts");
  const source = "export const AUTH_MODE = 'strict';\n";
  await writeFile(filePath, source);
  const store = await RookStore.open(join(directory, "state.sqlite"));
  const repository: RepositoryIdentity = {
    id: "impact-repo",
    logicalId: "impact-repo",
    kind: "directory",
    root,
    displayName: "repo",
    remoteFingerprint: null,
  };
  const snapshot: GitSnapshot = {
    repoId: repository.id,
    branch: "main",
    headCommit: "commit-1",
    dirtyFingerprint: null,
    capturedAt: "2026-11-17T12:00:00.000Z",
  };
  store.saveWorkspace(repository, snapshot);
  const recorded = store.recordMemory({
    repoId: repository.id,
    kind: "architecture",
    title: "Auth mode is strict",
    body: "The authentication module uses strict mode.",
    status: "verified",
    confidence: 0.95,
    sourceClass: "code",
    validAtCommit: "commit-1",
    evidence: [
      {
        path: "src/auth.ts",
        contentSha256: createHash("sha256").update(source).digest("hex"),
        commitSha: "commit-1",
        sourceType: "code",
      },
    ],
  });
  return { root, store, repository, snapshot, memoryId: recorded.memory.id };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Git-aware memory evidence", () => {
  it("invalidates changed or deleted evidence before retrieval", async () => {
    const { root, store, repository, snapshot, memoryId } = await setup();
    await writeFile(
      join(root, "src", "auth.ts"),
      "export const AUTH_MODE = 'permissive';\n",
    );
    const changed = await reconcileMemoryEvidence(store, repository, {
      ...snapshot,
      headCommit: "commit-2",
      capturedAt: "2026-11-18T12:00:00.000Z",
    });
    expect(changed.invalidated).toBe(1);
    expect(store.getMemory(memoryId)?.status).toBe("stale");
    const context = retrieveMemoryContext(
      store,
      repository.id,
      "authentication strict mode",
      { ...snapshot, headCommit: "commit-2" },
    );
    expect(context.memoryIds).not.toContain(memoryId);
    expect(store.listMemoryRevisions(memoryId).at(-1)?.reason).toContain(
      "changed since evidence capture",
    );

    await rm(join(root, "src", "auth.ts"));
    await reconcileMemoryEvidence(store, repository, snapshot);
    expect(store.getMemory(memoryId)?.status).toBe("stale");
    store.close();
  });

  it("keeps identical evidence fresh across commits and stores refreshed provenance", async () => {
    const { store, repository, snapshot, memoryId } = await setup();
    const result = await reconcileMemoryEvidence(store, repository, {
      ...snapshot,
      branch: "feature",
      headCommit: "commit-2",
    });
    expect(result.invalidated).toBe(0);
    expect(store.getMemory(memoryId)?.status).toBe("verified");
    expect(
      store
        .getMemory(memoryId)
        ?.evidence.some((item) => item.commitSha === "commit-2"),
    ).toBe(true);
    expect(store.listMemoryRevisions(memoryId).at(-1)?.reason).toContain(
      "hashes still match",
    );
    store.close();
  });

  it("invalidates commit-only claims after a branch snapshot change", async () => {
    const { store, repository, snapshot } = await setup();
    const memory = store.recordMemory({
      repoId: repository.id,
      kind: "decision",
      title: "Branch-specific decision",
      body: "This decision was recorded for the current branch.",
      status: "verified",
      confidence: 0.9,
      sourceClass: "commit",
      evidence: [{ sourceType: "commit", commitSha: "commit-1" }],
    }).memory;
    await reconcileMemoryEvidence(store, repository, {
      ...snapshot,
      branch: "other",
      headCommit: "commit-2",
    });
    expect(store.getMemory(memory.id)?.status).toBe("stale");
    store.close();
  });

  it("allows explicit user review to re-verify stale evidence with a revision", async () => {
    const { root, store, repository, snapshot, memoryId } = await setup();
    await writeFile(
      join(root, "src", "auth.ts"),
      "export const AUTH_MODE = 'permissive';\n",
    );
    await reconcileMemoryEvidence(store, repository, snapshot);
    const verified = await manuallyVerifyMemory(store, repository, memoryId, {
      ...snapshot,
      headCommit: "commit-2",
    });
    expect(verified.verified).toBe(true);
    expect(store.getMemory(memoryId)?.status).toBe("verified");
    expect(store.listMemoryRevisions(memoryId).at(-1)?.actor).toBe("user");
    store.close();
  });

  it("does not reveal or forget another repository's memories by ID", async () => {
    const { store, repository, memoryId } = await setup();
    expect(
      await manuallyVerifyMemory(
        store,
        { ...repository, id: "other-repo" },
        memoryId,
        null,
      ),
    ).toMatchObject({ verified: false });
    expect(
      store.forgetRepositoryMemory("other-repo", memoryId, "user request"),
    ).toBe(false);
    expect(store.getMemory(memoryId)).toBeDefined();
    store.close();
  });
});
