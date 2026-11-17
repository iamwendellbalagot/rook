import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRookBashTool } from "../../src/pi/bash-tool.js";
import { shellTimeout } from "../../src/policy/shell-limits.js";

const nodeCommand = (script: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

describe("Rook's Pi bash tool", () => {
  it("uses a bounded default timeout and rejects attempts to disable its limit", async () => {
    expect(shellTimeout(undefined)).toBe(120);
    expect(shellTimeout(300)).toBe(300);
    for (const timeout of [0, -1, 301, Infinity, NaN, "300"]) {
      expect(() => shellTimeout(timeout)).toThrow("timeout");
    }
    const tool = createRookBashTool(process.cwd());
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
      const tool = createRookBashTool(root);
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
    const tool = createRookBashTool(process.cwd());
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
    const tool = createRookBashTool(process.cwd());
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
});
