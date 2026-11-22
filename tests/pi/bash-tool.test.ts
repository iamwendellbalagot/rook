import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRookBashTool } from "../../src/pi/bash-tool.js";
import { shellTimeout } from "../../src/policy/shell-limits.js";
import {
  createSandboxCommand,
  detectSandboxRuntime,
  runSandboxCommand,
  sandboxRuntimeCandidates,
} from "../../src/policy/sandbox.js";

const nodeCommand = (script: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

describe("Rook's Pi bash tool", () => {
  it("removes prediction schema and guidance when PLYTH is disabled", () => {
    const tool = createRookBashTool(process.cwd(), {
      sandbox: false,
      predictions: false,
    });
    expect(tool.parameters.properties).not.toHaveProperty("expect");
    expect(tool.description).not.toContain("expect.outcome");
    expect(
      createRookBashTool(process.cwd(), { sandbox: false }).parameters
        .properties,
    ).toHaveProperty("expect");
  });
  it("accepts a separate bounded expectation without changing the command", async () => {
    const tool = createRookBashTool(process.cwd(), { sandbox: false });
    const command = nodeCommand("console.log('unchanged command')");
    const result = await tool.execute(
      "expected-result",
      { command, expect: { outcome: "pass", evidence: "unchanged command" } },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("unchanged command"),
    });
  });

  it("uses a bounded default timeout and rejects attempts to disable its limit", async () => {
    expect(shellTimeout(undefined)).toBe(120);
    expect(shellTimeout(300)).toBe(300);
    for (const timeout of [0, -1, 301, Infinity, NaN, "300"]) {
      expect(() => shellTimeout(timeout)).toThrow("timeout");
    }
    const tool = createRookBashTool(process.cwd(), { sandbox: false });
    await expect(
      tool.execute(
        "invalid-timeout",
        { command: nodeCommand("process.exit(0)"), timeout: 301 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Shell timeout");
  });

  it("runs real terminal commands in the project cwd and returns stdout, stderr, and exit errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "rook-bash-"));
    try {
      const tool = createRookBashTool(root, { sandbox: false });
      const result = await tool.execute(
        "node",
        {
          command: nodeCommand(
            "console.log(process.cwd()); console.error('stderr works')",
          ),
        },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(await realpath(root)),
        }),
      ]);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("stderr works"),
      });
      const failure = await tool.execute(
        "exit",
        { command: nodeCommand("process.exit(7)") },
        undefined,
        undefined,
        {} as never,
      );
      expect(failure.isError).toBe(true);
      expect(failure.content[0]).toMatchObject({
        text: expect.stringContaining("code 7"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a real long-running command on timeout or cancellation", async () => {
    const tool = createRookBashTool(process.cwd(), { sandbox: false });
    const command = nodeCommand("setInterval(() => {}, 1000)");
    await expect(
      tool.execute(
        "timeout",
        { command, timeout: 0.1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("timed out");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        tool.execute(
          "abort",
          { command },
          controller.signal,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("aborted");
    } finally {
      clearTimeout(timer);
    }
  });

  it("retains Pi's model-output truncation for noisy commands", async () => {
    const tool = createRookBashTool(process.cwd(), { sandbox: false });
    const result = await tool.execute(
      "output",
      { command: nodeCommand("console.log('x'.repeat(70000))") },
      undefined,
      undefined,
      {} as never,
    );
    try {
      expect(result.details?.truncation?.truncated).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("Full output:"),
      });
      const text = result.content[0];
      if (text?.type === "text") expect(text.text.length).toBeLessThan(53000);
    } finally {
      if (result.details?.fullOutputPath)
        await rm(result.details.fullOutputPath, { force: true });
    }
  });

  it("fails closed when the Bubblewrap runtime is not executable", async () => {
    const tool = createRookBashTool(process.cwd());
    const runtimeMissing =
      process.platform !== "linux" || !(await detectSandboxRuntime());
    if (!runtimeMissing) {
      expect(await detectSandboxRuntime()).toBe("bwrap");
      return;
    }
    await expect(
      tool.execute(
        "no-sandbox",
        { command: nodeCommand("0") },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/will not run the command without isolation/);
  });

  it("selects only native OS sandbox backends", () => {
    expect(sandboxRuntimeCandidates("linux")).toEqual(["bwrap"]);
    expect(sandboxRuntimeCandidates("darwin")).toEqual(["seatbelt"]);
    expect(sandboxRuntimeCandidates("win32")).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")(
    "builds a network-disabled Bubblewrap command rooted at the workspace",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rook-bwrap-"));
      try {
        await mkdir(join(root, ".git"));
        const sandbox = await createSandboxCommand("npm test", root, "bwrap", {
          PATH: "/usr/bin",
        });
        expect(sandbox.executable).toContain("bwrap");
        expect(sandbox.args).toContain("--unshare-net");
        expect(sandbox.args).toContain("--bind");
        expect(sandbox.args).toContain("--tmpfs");
        expect(
          sandbox.args.some(
            (value, index) =>
              value === "--ro-bind" &&
              sandbox.args[index + 1] === "/" &&
              sandbox.args[index + 2] === "/",
          ),
        ).toBe(false);
        expect(sandbox.args).toContain(await realpath(root));
        const gitPath = join(root, ".git");
        const gitMountIndex = sandbox.args.findIndex(
          (value, index) =>
            value === "--ro-bind" && sandbox.args[index + 1] === gitPath,
        );
        expect(sandbox.args.slice(gitMountIndex, gitMountIndex + 3)).toEqual([
          "--ro-bind",
          gitPath,
          gitPath,
        ]);
        expect(sandbox.args).toContain("/tmp");
        expect(sandbox.args).not.toContain("--share-net");
        expect(sandbox.args.at(-1)).toBe("npm test");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "enforces workspace filesystem boundaries or fails closed when unavailable",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rook-seatbelt-"));
      const outside = `${root}-outside`;
      const inside = join(root, "allowed.txt");
      try {
        await writeFile(outside, "secret");
        const runtime = await detectSandboxRuntime();
        if (!runtime) {
          await expect(
            createSandboxCommand(
              "true",
              root,
              process.platform === "darwin" ? "seatbelt" : "bwrap",
              {
                PATH: "/usr/bin:/bin",
                HOME: "/tmp",
              },
            ),
          ).rejects.toThrow(/failed its isolation probe/);
          return;
        }
        const sandbox = await createSandboxCommand(
          `printf ok > ${JSON.stringify(inside)} && cat ${JSON.stringify(outside)}`,
          root,
          runtime,
          { PATH: "/usr/bin:/bin", HOME: "/tmp" },
        );
        try {
          const result = await runSandboxCommand(
            sandbox.executable,
            sandbox.args,
            {
              cwd: root,
              env: {
                PATH: "/usr/bin:/bin",
                HOME: sandbox.env?.HOME ?? "/tmp",
                ...sandbox.env,
              },
              timeout: 5_000,
            },
          );
          expect(result.exitCode).not.toBe(0);
          expect(await readFile(inside, "utf8")).toBe("ok");
          expect(result.stdout).toBe("");
        } finally {
          await sandbox.cleanup?.();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { force: true });
      }
    },
  );

  it("runs a sandbox runner process with bounded time and cancellation", async () => {
    const success = await runSandboxCommand(
      process.execPath,
      ["-e", "console.log('ok')"],
      { cwd: process.cwd(), env: {}, timeout: 2_000 },
    );
    expect(success.stdout.trim()).toBe("ok");
    const timeout = await runSandboxCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), env: {}, timeout: 50 },
    );
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).toBe(124);
    const noisy = await runSandboxCommand(
      process.execPath,
      ["-e", "console.log('x'.repeat(100000))"],
      { cwd: process.cwd(), env: {}, timeout: 2_000, maxOutputBytes: 1024 },
    );
    expect(noisy.truncated).toBe(true);
    expect(noisy.exitCode).toBe(125);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200).unref();
    const startedAt = Date.now();
    await expect(
      runSandboxCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        {
          cwd: process.cwd(),
          env: {},
          timeout: 5_000,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("aborted");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });
});
