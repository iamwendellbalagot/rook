import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../../src/index.js";

describe("CLI argument parsing", () => {
  it("preserves a single one-shot prompt", () => {
    expect(
      parseCliArguments(["Summarize this repository"], "/workspace"),
    ).toEqual({
      cwd: "/workspace",
      prompt: "Summarize this repository",
      mock: false,
      smoke: false,
      noMemory: false,
    });
  });

  it("removes the cwd option and its value without consuming the prompt", () => {
    expect(
      parseCliArguments(
        ["--cwd", "/project", "Explain", "the", "entry points"],
        "/workspace",
      ),
    ).toEqual({
      cwd: "/project",
      prompt: "Explain the entry points",
      mock: false,
      smoke: false,
      noMemory: false,
    });
  });

  it("retains mock smoke defaults", () => {
    expect(parseCliArguments(["--smoke"], "/workspace")).toEqual({
      cwd: "/workspace",
      prompt: "smoke test",
      mock: true,
      smoke: true,
      noMemory: false,
    });
  });

  it("parses mode, model, and memory opt-out flags without changing the prompt", () => {
    expect(
      parseCliArguments(
        [
          "--mode",
          "plan",
          "--model",
          "openai/gpt-test",
          "--no-memory",
          "Explain",
          "this",
        ],
        "/workspace",
      ),
    ).toEqual({
      cwd: "/workspace",
      prompt: "Explain this",
      mock: false,
      smoke: false,
      noMemory: true,
      mode: "plan",
      model: "openai/gpt-test",
    });
  });

  it.each([["--mode", "unsafe"], ["--model", "missing-provider"], ["--cwd"]])(
    "rejects invalid or incomplete options: %s",
    (...args) => {
      expect(() => parseCliArguments(args, "/workspace")).toThrow();
    },
  );
});
