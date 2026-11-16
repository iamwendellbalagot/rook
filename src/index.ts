import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MockAgentGateway } from "./pi/mock-agent-gateway.js";
import { createPiAgentGateway } from "./pi/pi-agent-gateway.js";
import type { AgentGateway } from "./pi/agent-gateway.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: rook [--cwd PATH] [--mock] [PROMPT]\n\nHeadless Pi SDK smoke client.",
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
  const cwd = cwdIndex === -1 ? process.cwd() : args[cwdIndex + 1];
  if (cwdIndex !== -1 && !cwd) throw new Error("--cwd requires a path");
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
  const gateway = mock
    ? new MockAgentGateway()
    : await createPiAgentGateway(cwd);

  try {
    if (prompt) {
      await runPrompt(gateway, prompt);
      return;
    }
    if (!stdin.isTTY)
      throw new Error("Pass a prompt argument when running non-interactively.");

    const input = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        const line = await input.question("\n› ");
        if (line.trim() === "/quit" || line.trim() === "/exit") break;
        if (line.trim()) await runPrompt(gateway, line);
      }
    } finally {
      input.close();
    }
  } finally {
    await gateway.dispose();
  }
}

async function runPrompt(gateway: AgentGateway, prompt: string): Promise<void> {
  const unsubscribe = gateway.subscribe((event) => {
    if (event.type === "text_delta") stdout.write(event.text);
    if (event.type === "error") console.error(`\nrook: ${event.message}`);
  });
  try {
    await gateway.send(prompt);
    stdout.write("\n");
  } finally {
    unsubscribe();
  }
}
