import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeMemoryContent, RookStore } from "../../src/db/store.js";
import {
  extractHighSignalStatement,
  MemoryCaptureManager,
  parseRememberPrompt,
} from "../../src/memory/capture.js";
import type {
  GitSnapshot,
  RepositoryIdentity,
} from "../../src/repo/workspace.js";

const directories: string[] = [];
type Hook = (event: unknown) => unknown;

async function setup(): Promise<{
  root: string;
  store: RookStore;
  manager: MemoryCaptureManager;
}> {
  const temp = await mkdtemp(join(tmpdir(), "rook-capture-"));
  directories.push(temp);
  const root = join(temp, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  const store = await RookStore.open(join(temp, "state.sqlite"));
  const repo: RepositoryIdentity = {
    id: "repo-capture",
    logicalId: "logical-capture",
    kind: "git",
    root,
    displayName: "workspace",
    remoteFingerprint: null,
  };
  const snapshot: GitSnapshot = {
    repoId: repo.id,
    branch: "main",
    headCommit: "head-1",
    dirtyFingerprint: null,
    capturedAt: "2026-11-17T12:00:00.000Z",
  };
  store.saveWorkspace(repo, snapshot);
  return {
    root,
    store,
    manager: new MemoryCaptureManager(store, repo, snapshot),
  };
}

function installHooks(manager: MemoryCaptureManager): {
  fire(name: string, event?: unknown): Promise<void>;
} {
  const hooks = new Map<string, Hook>();
  const extension = manager.createExtension() as {
    factory(api: ExtensionAPI): void;
  };
  extension.factory({
    on: (name: string, callback: unknown) => hooks.set(name, callback as Hook),
  } as unknown as ExtensionAPI);
  return {
    async fire(name, event = {}) {
      await hooks.get(name)?.(event);
    },
  };
}

function userPrompt(prompt: string): unknown {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt,
    systemPrompt: "base",
    systemPromptOptions: {} as never,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded memory capture", () => {
  it("recognizes only high-signal and explicit remember statements", () => {
    expect(
      extractHighSignalStatement(
        "We chose SQLite because schema history needs an audit trail.",
      ),
    ).toBe("We chose SQLite because schema history needs an audit trail.");
    expect(
      extractHighSignalStatement(
        "We use SQLite because schema history needs an audit trail.",
      ),
    ).toBe("We use SQLite because schema history needs an audit trail.");
    expect(
      extractHighSignalStatement(
        "The convention is to keep migrations transactional.",
      ),
    ).toBe("The convention is to keep migrations transactional.");
    expect(
      extractHighSignalStatement("Can you explain SQLite to me?"),
    ).toBeUndefined();
    expect(
      parseRememberPrompt("remember: Keep migrations transactional."),
    ).toBe("Keep migrations transactional.");
    expect(parseRememberPrompt("remember: short")).toBeUndefined();
    expect(isSafeMemoryContent("My SSN is 123-45-6789.")).toBe(false);
    expect(
      isSafeMemoryContent(
        "My access token is eyJabcdefghijk.abcdefghijk.abcdefghijk",
      ),
    ).toBe(false);
  });

  it("captures a candidate only after a successful safe read and stores a hash, not file content", async () => {
    const { root, store, manager } = await setup();
    const secretFixture =
      "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nsource code\n";
    await writeFile(join(root, "src", "schema.ts"), secretFixture);
    const hooks = installHooks(manager);
    const notices: string[] = [];
    manager.subscribeNotices((notice) => notices.push(notice));
    await hooks.fire("session_start");
    await hooks.fire(
      "before_agent_start",
      userPrompt(
        "We chose SQLite because schema history needs an audit trail.",
      ),
    );
    await hooks.fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "src/schema.ts" },
    });
    await hooks.fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: {},
      isError: false,
    });
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();

    const memories = store.listMemories("repo-capture");
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "decision",
      status: "candidate",
      sourceClass: "user",
      body: "We chose SQLite because schema history needs an audit trail.",
    });
    expect(memories[0]?.evidence).toMatchObject([
      {
        path: "src/schema.ts",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        commitSha: "head-1",
      },
    ]);
    const exportText = JSON.stringify(store.exportJson());
    expect(exportText).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(notices[0]).toContain("Saved a memory candidate");
    expect(manager.status().capturedThisSession).toBe(1);
    store.close();
  });

  it("does not capture without successful evidence, or when a run was aborted", async () => {
    const { store, manager } = await setup();
    const hooks = installHooks(manager);
    await hooks.fire(
      "before_agent_start",
      userPrompt(
        "We chose SQLite because schema history needs an audit trail.",
      ),
    );
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();
    expect(store.listMemories("repo-capture")).toHaveLength(0);

    await hooks.fire(
      "before_agent_start",
      userPrompt(
        "We chose WAL because multiple readers need consistent access.",
      ),
    );
    await hooks.fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "read-2",
      toolName: "read",
      args: { path: "src/missing.ts" },
    });
    await hooks.fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "read-2",
      toolName: "read",
      result: {},
      isError: false,
    });
    await hooks.fire("agent_settled", { type: "agent_settled", aborted: true });
    await manager.flush();
    expect(store.listMemories("repo-capture")).toHaveLength(0);
    store.close();
  });

  it("queues explicit remembers for confirmation, and persists pause/opt-out controls", async () => {
    const { store, manager } = await setup();
    const hooks = installHooks(manager);
    await hooks.fire(
      "before_agent_start",
      userPrompt("remember: We prefer small focused TypeScript modules."),
    );
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();
    expect(store.listMemories("repo-capture")).toHaveLength(0);
    const [pending] = manager.pending();
    expect(pending?.title).toBe("We prefer small focused TypeScript modules");
    expect(manager.confirm(pending!.id)).toContain("Confirmed memory");
    expect(store.listMemories("repo-capture")[0]).toMatchObject({
      status: "verified",
      sourceClass: "user_explicit",
      evidence: [{ sourceType: "user_explicit" }],
    });

    manager.pause();
    expect(manager.status().paused).toBe(true);
    await hooks.fire(
      "before_agent_start",
      userPrompt("remember: We use deterministic identifiers for records."),
    );
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();
    expect(manager.pending()).toHaveLength(0);
    manager.resume();
    const another = store.queueMemoryConfirmation("repo-capture", {
      kind: "preference",
      title: "Temporary pending claim",
      body: "This claim should be discarded by project opt-out.",
    });
    manager.optOut();
    expect(manager.status().optedOut).toBe(true);
    expect(manager.cancel(another.id)).toBe(false);
    const resumedManager = new MemoryCaptureManager(
      store,
      {
        id: "repo-capture",
        logicalId: "logical-capture",
        kind: "git",
        root: "/unused",
        displayName: "workspace",
        remoteFingerprint: null,
      },
      null,
    );
    expect(resumedManager.status().optedOut).toBe(true);
    store.close();
  });

  it("rejects explicit secret claims and does not capture sensitive paths", async () => {
    const { root, store, manager } = await setup();
    await writeFile(join(root, ".env.local"), "irrelevant\n");
    const hooks = installHooks(manager);
    await hooks.fire(
      "before_agent_start",
      userPrompt("remember: API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456"),
    );
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();
    expect(manager.pending()).toHaveLength(0);

    await hooks.fire(
      "before_agent_start",
      userPrompt(
        "We chose environment files because runtime configuration is separated.",
      ),
    );
    await hooks.fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "read-env",
      toolName: "read",
      args: { path: ".env.local" },
    });
    await hooks.fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "read-env",
      toolName: "read",
      result: {},
      isError: false,
    });
    await hooks.fire("agent_settled", {
      type: "agent_settled",
      aborted: false,
    });
    await manager.flush();
    expect(store.listMemories("repo-capture")).toHaveLength(0);
    store.close();
  });

  it("caps automatic captures at three records per agent session", async () => {
    const { root, store, manager } = await setup();
    await writeFile(
      join(root, "src", "decisions.ts"),
      "export const ready = true;\n",
    );
    const hooks = installHooks(manager);
    for (let index = 1; index <= 4; index += 1) {
      await hooks.fire(
        "before_agent_start",
        userPrompt(
          `We chose option ${index} because each decision needs an audit trail.`,
        ),
      );
      await hooks.fire("tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: `read-${index}`,
        toolName: "read",
        args: { path: "src/decisions.ts" },
      });
      await hooks.fire("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: `read-${index}`,
        toolName: "read",
        result: {},
        isError: false,
      });
      await hooks.fire("agent_settled", {
        type: "agent_settled",
        aborted: false,
      });
      await manager.flush();
    }
    expect(manager.status().capturedThisSession).toBe(3);
    expect(store.listMemories("repo-capture")).toHaveLength(3);
    store.close();
  });
});
