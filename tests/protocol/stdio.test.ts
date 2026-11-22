import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { AgentEvent, AgentGateway } from "../../src/pi/agent-gateway.js";
import {
  readProtocolLines,
  runStdioProtocol,
} from "../../src/protocol/stdio.js";

class InputQueue implements AsyncIterable<string> {
  private values: string[] = [];
  private waiters: ((value: IteratorResult<string>) => void)[] = [];
  private closed = false;

  push(value: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<string>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

function createFixtureGateway(
  expectedPermission: "once" | "deny" = "once",
  deferRun = false,
) {
  const listeners = new Set<(event: AgentEvent) => void>();
  let permissionHandler:
    | Parameters<AgentGateway["setExternalAccessPrompt"]>[0]
    | undefined;
  let session = { id: "session-1", path: "/workspace/session-1" };
  let completeRun: (() => void) | undefined;
  let cancelled = false;
  const sessions = [
    {
      id: session.id,
      path: session.path,
      created: new Date(0),
      modified: new Date(1),
      messageCount: 0,
      firstMessage: "",
    },
  ];
  const gateway = {
    isRunning: () => Boolean(completeRun),
    send: vi.fn(async (prompt: string) => {
      const choice = await permissionHandler?.({
        toolName: "read",
        path: "/outside/readme",
        folderPath: "/outside",
        access: "read",
      });
      expect(choice).toBe(expectedPermission);
      listeners.forEach((listener) =>
        listener({ type: "text_delta", text: "source-linked answer" }),
      );
      if (deferRun)
        await new Promise<void>((resolve) => {
          completeRun = resolve;
        });
      else completeRun = () => undefined;
      listeners.forEach((listener) =>
        listener({ type: "run_settled", aborted: cancelled }),
      );
    }),
    cancel: vi.fn(async () => {
      cancelled = true;
      completeRun?.();
    }),
    listProviders: () => [
      { id: "fixture", name: "Fixture", configured: false, authMethods: [] },
    ],
    setMode: vi.fn(),
    setExternalAccessPrompt: vi.fn((handler) => {
      permissionHandler = handler;
    }),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    currentSession: () => session,
    newSession: vi.fn(async () => {
      session = { id: "session-2", path: "/workspace/session-2" };
    }),
    listSessions: vi.fn(async () => sessions),
    resumeSession: vi.fn(async (path: string) => {
      const found = sessions.find((entry) => entry.path === path);
      if (!found) throw new Error("missing session");
      session = { id: found.id, path: found.path };
    }),
    sessionHistory: () => [{ role: "user", text: "fixture history" }],
    dispose: vi.fn(async () => undefined),
  } as unknown as AgentGateway;
  return {
    gateway,
    sessions,
    get cancelled() {
      return cancelled;
    },
  };
}

function harness(
  createGateway = vi.fn(async () => createFixtureGateway().gateway),
) {
  const input = new InputQueue();
  const output: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const task = runStdioProtocol({
    cwd: process.cwd(),
    input,
    createGateway,
    write: (message) => {
      output.push(message);
      for (const wake of waiters.splice(0)) wake();
    },
  });
  const next = async (
    predicate: (message: Record<string, unknown>) => boolean,
  ) => {
    while (true) {
      const found = output.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const send = (message: Record<string, unknown>) =>
    input.push(JSON.stringify(message));
  return { input, output, task, next, send };
}

const rpc = (
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("Rook stdio protocol v1", () => {
  it("rejects incompatible protocol versions without starting a gateway", async () => {
    const createGateway = vi.fn();
    const h = harness(createGateway);
    h.send(rpc(1, "initialize", { protocolVersion: 999 }));
    const response = await h.next((message) => message.id === 1);
    expect(response.error).toMatchObject({ code: -32010 });
    expect(createGateway).not.toHaveBeenCalled();
    h.input.close();
    await h.task;
  });

  it("streams an Ask session and scopes permission responses to explicit requests", async () => {
    const fixture = createFixtureGateway();
    const createGateway = vi.fn(async () => fixture.gateway);
    const h = harness(createGateway);
    h.send(rpc(1, "initialize", { protocolVersion: 1 }));
    const initialized = await h.next((message) => message.id === 1);
    expect(
      initialized,
      JSON.stringify(initialized).slice(0, 300),
    ).toMatchObject({
      result: {
        protocolVersion: 1,
        capabilities: { buildSessions: false, arbitraryMcp: false },
      },
    });
    expect(createGateway).toHaveBeenCalledWith(process.cwd());
    expect(fixture.gateway.setMode).toHaveBeenCalledWith("plan");
    expect(fixture.gateway.setExternalAccessPrompt).toHaveBeenCalled();

    h.send(rpc(2, "session/new", { mode: "build" }));
    const badSession = await h.next((message) => message.id === 2);
    expect(badSession.error).toMatchObject({
      code: -32011,
    });
    h.send(rpc(3, "session/new", { mode: "ask" }));
    const newSession = await h.next((message) => message.id === 3);
    expect(newSession.result).toMatchObject({
      sessionId: "session-2",
      mode: "ask",
    });

    h.send(
      rpc(4, "session/prompt", {
        text: "Explain this",
        context: "fixture context",
      }),
    );
    const permission = await h.next(
      (message) => message.method === "session/request_permission",
    );
    expect(permission.params).toMatchObject({
      sessionId: "session-2",
      request: { access: "read", folderPath: "/outside" },
    });
    h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { choice: "once" },
    });
    const update = await h.next(
      (message) =>
        message.method === "session/update" &&
        JSON.stringify(message).includes("source-linked answer"),
    );
    expect(update.params).toMatchObject({
      workspaceId: `file://${process.cwd()}`,
      sessionId: "session-2",
      runId: "run-1",
      event: { type: "text_delta" },
    });
    const promptResult = await h.next((message) => message.id === 4);
    expect(promptResult.result).toMatchObject({
      settled: true,
      runId: "run-1",
    });
    expect(fixture.gateway.send).toHaveBeenCalledWith(
      expect.stringContaining("User request:\nExplain this"),
    );
    expect(fixture.gateway.send).toHaveBeenCalledOnce();
    h.input.close();
    await h.task;
    expect(fixture.gateway.dispose).toHaveBeenCalledOnce();
  });

  it("cancels an active run and denies permissions when input disconnects", async () => {
    const fixture = createFixtureGateway("once", true);
    const h = harness(vi.fn(async () => fixture.gateway));
    h.send(rpc(1, "initialize", { protocolVersion: 1 }));
    await h.next((message) => message.id === 1);
    h.send(rpc(2, "session/new"));
    await h.next((message) => message.id === 2);
    h.send(rpc(3, "session/prompt", { text: "Cancel this" }));
    const permission = await h.next(
      (message) => message.method === "session/request_permission",
    );
    const update = h.next(
      (message) =>
        message.method === "session/update" &&
        JSON.stringify(message).includes("source-linked answer"),
    );
    h.send({ jsonrpc: "2.0", id: permission.id, result: { choice: "once" } });
    await update;
    h.send(rpc(4, "session/cancel", { runId: "run-1" }));
    expect((await h.next((message) => message.id === 4)).result).toMatchObject({
      accepted: true,
      settled: false,
    });
    await h.next(
      (message) =>
        message.method === "session/update" &&
        JSON.stringify(message).includes('"aborted":true'),
    );
    await h.next((message) => message.id === 3);
    expect(fixture.cancelled).toBe(true);
    h.input.close();
    await h.task;
  });

  it("denies a pending permission when the client disconnects", async () => {
    const fixture = createFixtureGateway("deny");
    const h = harness(vi.fn(async () => fixture.gateway));
    h.send(rpc(1, "initialize", { protocolVersion: 1 }));
    await h.next((message) => message.id === 1);
    h.send(rpc(2, "session/new"));
    await h.next((message) => message.id === 2);
    h.send(rpc(3, "session/prompt", { text: "Request an external read" }));
    await h.next((message) => message.method === "session/request_permission");
    h.input.close();
    await h.task;
    expect(fixture.gateway.dispose).toHaveBeenCalledOnce();
  });

  it("loads sessions by workspace-local ID and bounds history", async () => {
    const fixture = createFixtureGateway();
    const h = harness(vi.fn(async () => fixture.gateway));
    h.send(rpc(1, "initialize", { protocolVersion: 1 }));
    await h.next((message) => message.id === 1);
    h.send(rpc(2, "session/load", { sessionId: "../../outside" }));
    expect((await h.next((message) => message.id === 2)).error).toMatchObject({
      code: -32006,
    });
    h.send(rpc(3, "session/load", { sessionId: "session-1" }));
    expect((await h.next((message) => message.id === 3)).result).toMatchObject({
      sessionId: "session-1",
    });
    h.send(rpc(4, "session/history", { limit: 1 }));
    expect((await h.next((message) => message.id === 4)).result).toMatchObject({
      messages: [{ text: "fixture history" }],
      truncated: false,
    });
    h.input.close();
    await h.task;
  });

  it("rejects oversized frames without buffering the following request", async () => {
    const stream = Readable.from([
      Buffer.from("x".repeat(1024 * 1024 + 10)),
      Buffer.from('\n{"jsonrpc":"2.0","id":7,"method":"noop"}\n'),
    ]);
    const frames = [];
    for await (const frame of readProtocolLines(stream)) frames.push(frame);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBeInstanceOf(Error);
    expect(frames[1]).toBe('{"jsonrpc":"2.0","id":7,"method":"noop"}');
  });
});
