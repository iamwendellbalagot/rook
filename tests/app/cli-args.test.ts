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
    });
  });

  it("retains mock smoke defaults", () => {
    expect(parseCliArguments(["--smoke"], "/workspace")).toEqual({
      cwd: "/workspace",
      prompt: "smoke test",
      mock: true,
      smoke: true,
    });
  });
});
