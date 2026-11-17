import type { RookStore, MemoryEntry } from "../db/store.js";
import { hashSafeWorkspaceFile } from "./capture.js";
import type { GitSnapshot, RepositoryIdentity } from "../repo/workspace.js";

export interface ReconciliationResult {
  checked: number;
  refreshed: number;
  invalidated: number;
  skipped: number;
}

const SOURCE_TYPES_WITH_FILES = new Set(["code", "test", "docs"]);

export async function reconcileMemoryEvidence(
  store: Pick<RookStore, "listMemories" | "addMemoryEvidence" | "reviseMemory">,
  repository: RepositoryIdentity,
  snapshot: GitSnapshot | null,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    checked: 0,
    refreshed: 0,
    invalidated: 0,
    skipped: 0,
  };
  for (const memory of store.listMemories(repository.id)) {
    const latestByPath = new Map<string, (typeof memory.evidence)[number]>();
    for (const evidence of memory.evidence) {
      if (
        evidence.path &&
        SOURCE_TYPES_WITH_FILES.has(evidence.sourceType) &&
        !latestByPath.has(evidence.path)
      ) {
        latestByPath.set(evidence.path, evidence);
      }
    }
    const fileEvidence = [...latestByPath.values()];
    if (fileEvidence.length === 0) {
      const commitEvidence = memory.evidence.filter(
        (evidence) =>
          evidence.sourceType !== "user_explicit" && evidence.commitSha,
      );
      if (
        snapshot?.headCommit &&
        commitEvidence.some(
          (evidence) => evidence.commitSha !== snapshot.headCommit,
        )
      ) {
        result.checked += commitEvidence.length;
        if (memory.status !== "stale") {
          store.reviseMemory(
            memory.id,
            { status: "stale" },
            "Commit-only evidence belongs to a different repository snapshot and cannot be revalidated by file hash.",
            "git-reconciliation",
            snapshot.capturedAt,
          );
          result.invalidated += 1;
        }
        continue;
      }
      result.skipped += 1;
      continue;
    }

    let evidenceChanged = false;
    for (const evidence of fileEvidence) {
      result.checked += 1;
      const current = await hashSafeWorkspaceFile(
        repository.root,
        evidence.path!,
      );
      if (!current) {
        evidenceChanged = true;
        break;
      }
      if (
        evidence.contentSha256 &&
        evidence.contentSha256 !== current.contentSha256
      ) {
        evidenceChanged = true;
        break;
      }
      if (
        !evidence.contentSha256 &&
        snapshot?.headCommit !== evidence.commitSha
      ) {
        evidenceChanged = true;
        break;
      }
      if (
        snapshot?.headCommit &&
        (evidence.commitSha !== snapshot.headCommit || !evidence.contentSha256)
      ) {
        store.addMemoryEvidence(
          memory.id,
          {
            path: evidence.path!,
            ...(evidence.startLine != null
              ? { startLine: evidence.startLine }
              : {}),
            ...(evidence.endLine != null ? { endLine: evidence.endLine } : {}),
            ...(evidence.symbol ? { symbol: evidence.symbol } : {}),
            contentSha256: current.contentSha256,
            commitSha: snapshot.headCommit,
            sourceType: evidence.sourceType,
          },
          snapshot.capturedAt,
        );
      }
    }

    if (evidenceChanged) {
      if (memory.status !== "stale") {
        store.reviseMemory(
          memory.id,
          { status: "stale" },
          "Supporting file was deleted, became unsafe, or changed since evidence capture.",
          "git-reconciliation",
          snapshot?.capturedAt,
        );
        result.invalidated += 1;
      }
    } else if (
      snapshot?.headCommit &&
      memory.validAtCommit !== snapshot.headCommit
    ) {
      store.reviseMemory(
        memory.id,
        { validAtCommit: snapshot.headCommit },
        "Supporting file hashes still match at the current repository snapshot.",
        "git-reconciliation",
        snapshot.capturedAt,
      );
      result.refreshed += 1;
    }
  }
  return result;
}

export async function manuallyVerifyMemory(
  store: Pick<RookStore, "listMemories" | "addMemoryEvidence" | "reviseMemory">,
  repository: RepositoryIdentity,
  memoryId: string,
  snapshot: GitSnapshot | null,
): Promise<{ verified: boolean; message: string }> {
  const memory = store
    .listMemories(repository.id)
    .find(({ id }) => id === memoryId);
  if (!memory)
    return {
      verified: false,
      message: "No memory matches that ID in this repository.",
    };
  const evidence = memory.evidence.filter(
    (item) => item.path && SOURCE_TYPES_WITH_FILES.has(item.sourceType),
  );
  if (evidence.length === 0) {
    return {
      verified: false,
      message:
        "This memory has no file evidence to verify. User assertions remain separately labeled.",
    };
  }
  const currentEvidence = [];
  for (const item of evidence) {
    const current = await hashSafeWorkspaceFile(repository.root, item.path!);
    if (!current) {
      return {
        verified: false,
        message: `Could not safely verify evidence file ${item.path}.`,
      };
    }
    currentEvidence.push({ item, current });
  }
  for (const { item, current } of currentEvidence) {
    store.addMemoryEvidence(
      memory.id,
      {
        path: item.path!,
        ...(item.startLine != null ? { startLine: item.startLine } : {}),
        ...(item.endLine != null ? { endLine: item.endLine } : {}),
        ...(item.symbol ? { symbol: item.symbol } : {}),
        contentSha256: current.contentSha256,
        commitSha: snapshot?.headCommit ?? null,
        sourceType: item.sourceType,
      },
      snapshot?.capturedAt,
    );
  }
  store.reviseMemory(
    memory.id,
    {
      status: "verified",
      ...(snapshot?.headCommit ? { validAtCommit: snapshot.headCommit } : {}),
    },
    "User manually reviewed this claim against its current evidence files.",
    "user",
    snapshot?.capturedAt,
  );
  return {
    verified: true,
    message: `Verified memory ${memoryId} against ${evidence.length} file(s).`,
  };
}

export function formatMemoryInspection(memory: MemoryEntry): string[] {
  const lines = [
    `${memory.id} · ${memory.status} · ${memory.kind}`,
    `Title: ${memory.title}`,
    `Claim: ${memory.body}`,
    `Source: ${memory.sourceClass} · confidence ${memory.confidence.toFixed(2)}${memory.pinned ? " · pinned" : ""}`,
    `Updated: ${memory.updatedAt}${memory.validAtCommit ? ` · valid at ${memory.validAtCommit}` : ""}`,
    "Evidence:",
  ];
  if (!memory.evidence.length) lines.push("  (none)");
  for (const evidence of memory.evidence) {
    lines.push(
      `  ${evidence.sourceType}: ${evidence.path ?? evidence.symbol ?? "user assertion"}${evidence.startLine ? `:${evidence.startLine}${evidence.endLine ? `-${evidence.endLine}` : ""}` : ""}${evidence.commitSha ? ` · ${evidence.commitSha}` : ""}${evidence.contentSha256 ? ` · sha256 ${evidence.contentSha256.slice(0, 12)}` : ""}`,
    );
  }
  return lines;
}
