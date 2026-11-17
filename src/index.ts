import { stdin, stdout } from "node:process";
import { MockAgentGateway } from "./pi/mock-agent-gateway.js";
import { createPiAgentGateway } from "./pi/pi-agent-gateway.js";
import type { AgentGateway } from "./pi/agent-gateway.js";
import { createRookTui } from "./tui/rook-tui.js";
import { execFileSync } from "node:child_process";
import { initialAppState, reduceAppState, type AppState } from "./app/state.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: rook [--cwd PATH] [--mock] [PROMPT]\n\nStart the Rook TUI, or send a one-shot headless prompt.",
    );
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log("rook 0.1.0");
    return;
  }

  const mock = args.includes("--mock") || args.includes("--smoke");
  const smoke = args.includes("--smoke");
  const cwdIndex = args.indexOf("--cwd");
  const cwdArgument = cwdIndex === -1 ? undefined : args[cwdIndex + 1];
  if (cwdIndex !== -1 && !cwdArgument) throw new Error("--cwd requires a path");
  const cwd = cwdArgument ?? process.cwd();
  const prompt =
    args
      .filter(
        (arg, index) =>
          arg !== "--mock" &&
          arg !== "--smoke" &&
          arg !== "--cwd" &&
          index !== cwdIndex + 1,
      )
      .join(" ") || (smoke ? "smoke test" : "");
  if (!prompt && !stdin.isTTY) {
    throw new Error("Pass a prompt argument when running non-interactively.");
  }
  const gateway = mock
    ? new MockAgentGateway()
    : await createPiAgentGateway(cwd);
  let state = reduceAppState(initialAppState(), { type: "startup_complete" });

  try {
    if (prompt) {
      state = await runPrompt(gateway, prompt, state);
      return;
    }
    const branch = readGitBranch(cwd);
    const app = createRookTui({ cwd, gateway, ...(branch ? { branch } : {}) });
    await app.start();
  } finally {
    await gateway.dispose();
  }
}

function readGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

async function runPrompt(
  gateway: AgentGateway,
  prompt: string,
  previousState: AppState,
): Promise<AppState> {
  let state = reduceAppState(previousState, { type: "prompt_submitted" });
  if (state.runState !== "running") {
    throw new Error("Cannot submit a prompt while the app is not ready.");
  }

  const unsubscribe = gateway.subscribe((event) => {
    if (event.type === "text_delta") {
      state = reduceAppState(state, event);
      stdout.write(event.text);
    }
    if (event.type === "run_settled") {
      state = reduceAppState(state, { type: "run_state", state: "settled" });
    }
    if (event.type === "error") {
      state = reduceAppState(state, event);
      console.error(`\nrook: ${event.message}`);
    }
  });
  try {
    await gateway.send(prompt);
    if (state.runState === "running") {
      state = reduceAppState(state, { type: "run_state", state: "settled" });
    }
    stdout.write("\n");
    return state;
  } catch (error) {
    if (state.runState !== "failed") {
      state = reduceAppState(state, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    unsubscribe();
  }
}
