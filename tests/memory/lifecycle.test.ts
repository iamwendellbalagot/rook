import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RookStore } from "../../src/db/store.js";
import { MemoryCaptureManager } from "../../src/memory/capture.js";
import {
  createMemoryContextExtension,
  retrieveMemoryContext,
} from "../../src/memory/context.js";
import type { RepositoryIdentity } from "../../src/repo/workspace.js";

const roots: string[] = [];
type Hook = (event: any) => unknown;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository memory lifecycle", () => {
  it("captures, requires review, injects after restart, then abstains when evidence changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-memory-lifecycle-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const evidencePath = join(root, "src", "storage.ts");
    await writeFile(evidencePath, "export const storage = 'sqlite';\n");
    const dbPath = join(root, "state.sqlite");
    const repository: RepositoryIdentity = {
      id: "lifecycle-repo",
      logicalId: "lifecycle-repo",
      kind: "directory",
      root,
      displayName: "lifecycle-repo",
      remoteFingerprint: null,
    };

    let store = await RookStore.open(dbPath);
    store.saveWorkspace(repository, null);
    let capture = new MemoryCaptureManager(store, repository, null);
    const captureHooks = new Map<string, Hook>();
    (capture.createExtension() as { factory(api: ExtensionAPI): void }).factory(
      {
        on: (name: string, handler: unknown) =>
          captureHooks.set(name, handler as Hook),
      } as unknown as ExtensionAPI,
    );
    await captureHooks.get("before_agent_start")?.({
      messageType: "user",
      prompt: "We use SQLite because schema history needs an audit trail.",
    });
    await captureHooks.get("tool_execution_start")?.({
      toolCallId: "read-storage",
      toolName: "read",
      args: { path: "src/storage.ts" },
    });
    await captureHooks.get("tool_execution_end")?.({
      toolCallId: "read-storage",
      toolName: "read",
      isError: false,
    });
    await captureHooks.get("agent_settled")?.({ aborted: false });
    await capture.flush();

    let [memory] = store.listMemories(repository.id);
    expect(memory?.status).toBe("candidate");
    expect(memory?.kind).toBe("convention");
    expect(memory?.evidence[0]?.path).toBe("src/storage.ts");
    const review = await capture.verify(memory!.id);
    expect(review).toContain(memory!.body);
    expect(review).toContain("src/storage.ts");
    expect(review).toContain("/memory verify");
    expect(store.getMemory(memory!.id)?.status).toBe("candidate");
    expect(await capture.verify(memory!.id, true)).toContain("Verified memory");
    store.close();

    // Resume with a fresh store/manager to prove persistence and the real hook path.
    store = await RookStore.open(dbPath);
    capture = new MemoryCaptureManager(store, repository, null);
    const prompt = "Why does this repository use SQLite for schema history?";
    let contextHook: Hook | undefined;
    (
      createMemoryContextExtension(async (query) => {
        await capture.refresh();
        return retrieveMemoryContext(
          store,
          repository.id,
          query,
          capture.currentSnapshot(),
          { repositoryName: repository.displayName },
        );
      }) as { factory(api: ExtensionAPI): void }
    ).factory({
      on: (_name: string, handler: unknown) => (contextHook = handler as Hook),
    } as unknown as ExtensionAPI);

    const injected = await contextHook?.({
      messageType: "user",
      prompt,
      systemPrompt: "base prompt",
    });
    memory = store.listMemories(repository.id)[0];
    expect(injected).toMatchObject({
      message: {
        customType: "rook-memory-context",
        display: false,
      },
    });
    expect(JSON.stringify(injected)).toContain(memory!.id);
    expect(JSON.stringify(injected)).toContain("schema history");

    await writeFile(evidencePath, "export const storage = 'postgres';\n");
    const refreshed = await capture.refresh();
    expect(refreshed.invalidated).toBe(1);
    expect(store.getMemory(memory!.id)?.status).toBe("stale");
    const afterChange = await contextHook?.({
      messageType: "user",
      prompt,
      systemPrompt: "base prompt",
    });
    expect(afterChange).toBeUndefined();
    store.close();
  });
});
