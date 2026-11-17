import { stdin, stdout } from "node:process";
import { MockAgentGateway } from "./pi/mock-agent-gateway.js";
import { createPiAgentGateway } from "./pi/pi-agent-gateway.js";
import type { AgentGateway } from "./pi/agent-gateway.js";
import { RookStore } from "./db/store.js";
import { retrieveMemoryContext } from "./memory/context.js";
import { MemoryCaptureManager } from "./memory/capture.js";
import { resolveWorkspace } from "./repo/workspace.js";
import { createRookTui } from "./tui/rook-tui.js";
import { initialAppState, reduceAppState, type AppState } from "./app/state.js";
import {
  installSkills,
  listInstalledSkills,
  removeInstalledSkill,
  type SkillScope,
} from "./skills/manager.js";

export function parseCliArguments(
  args: string[],
  defaultCwd = process.cwd(),
): { cwd: string; prompt: string; mock: boolean; smoke: boolean } {
  const mock = args.includes("--mock") || args.includes("--smoke");
  const smoke = args.includes("--smoke");
  const cwdIndex = args.indexOf("--cwd");
  const cwdArgument = cwdIndex === -1 ? undefined : args[cwdIndex + 1];
  if (cwdIndex !== -1 && !cwdArgument) throw new Error("--cwd requires a path");
  const cwd = cwdArgument ?? defaultCwd;
  const prompt =
    args
      .filter(
        (arg, index) =>
          arg !== "--mock" &&
          arg !== "--smoke" &&
          arg !== "--cwd" &&
          (cwdIndex === -1 || index !== cwdIndex + 1),
      )
      .join(" ") || (smoke ? "smoke test" : "");
  return { cwd, prompt, mock, smoke };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (
    args[0] === "skills" &&
    (args.length === 1 ||
      args[1] === "list" ||
      args[1] === "install" ||
      args[1] === "remove" ||
      args[1] === "--help" ||
      args[1] === "-h")
  ) {
    await runSkillCommand(args.slice(1));
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: rook [--cwd PATH] [--mock] [PROMPT]\n       rook skills [list|install|remove] ...\n\nStart the Rook TUI, send a one-shot prompt, or manage Rook-scoped skills.",
    );
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log("rook 0.1.0");
    return;
  }

  const { cwd, prompt, mock } = parseCliArguments(args);
  if (!prompt && !stdin.isTTY) {
    throw new Error("Pass a prompt argument when running non-interactively.");
  }
  const workspace = mock ? undefined : await resolveWorkspace(cwd);
  const store = workspace ? await RookStore.open() : undefined;
  try {
    let memoryCapture: MemoryCaptureManager | undefined;
    if (workspace && store) {
      store.saveWorkspace(workspace.repository, workspace.snapshot);
      memoryCapture = new MemoryCaptureManager(
        store,
        workspace.repository,
        workspace.snapshot,
      );
      await memoryCapture.refresh();
    }
    const memoryContext =
      workspace && store
        ? async (userPrompt: string) => {
            await memoryCapture?.refresh();
            return retrieveMemoryContext(
              store,
              workspace.repository.id,
              userPrompt,
              memoryCapture?.currentSnapshot() ?? workspace.snapshot,
              { repositoryName: workspace.repository.displayName },
            );
          }
        : undefined;
    const gateway = mock
      ? new MockAgentGateway()
      : await createPiAgentGateway(cwd, {
          ...(memoryContext ? { memoryContext } : {}),
          ...(memoryCapture ? { memoryCapture } : {}),
        });
    await runApplication({
      cwd,
      prompt,
      gateway,
      ...(workspace ? { workspace } : {}),
      ...(memoryCapture ? { memoryCapture } : {}),
    });
  } finally {
    store?.close();
  }
}

async function runSkillCommand(args: string[]): Promise<void> {
  const usage =
    "Usage: rook skills [list]\n       rook skills install <local-path|git-url|owner/repo> [--skill NAME] [--project|--global] [--cwd PATH]\n       rook skills remove <NAME> [--project|--global] [--cwd PATH]";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }

  const [action = "list", ...rest] = args;
  if (action !== "list" && action !== "install" && action !== "remove") {
    throw new Error(`Unknown skills action '${action}'.\n${usage}`);
  }

  const options = parseSkillCommandOptions(rest);
  if (action === "list") {
    if (options.value)
      throw new Error(`Unexpected argument '${options.value}'.`);
    const skills = await listInstalledSkills(options.cwd);
    console.log(
      skills.length
        ? skills
            .map(
              (skill) =>
                `${skill.name} [${skill.scope}] — ${skill.description}`,
            )
            .join("\n")
        : "No Rook skills are installed.",
    );
    return;
  }

  if (!options.value) throw new Error(`Missing ${action} target.\n${usage}`);
  if (action === "install") {
    const installed = await installSkills(options.value, {
      cwd: options.cwd,
      scope: options.scope,
      ...(options.skillName ? { skillName: options.skillName } : {}),
    });
    console.log(
      installed
        .map(
          (skill) => `Installed ${skill.name} (${skill.scope}): ${skill.path}`,
        )
        .join("\n"),
    );
    return;
  }

  const removed = await removeInstalledSkill(options.value, {
    cwd: options.cwd,
    scope: options.scope,
  });
  console.log(
    removed
      ? `Removed ${options.value} from ${options.scope} skills.`
      : `No ${options.scope} skill named '${options.value}' was found.`,
  );
}

function parseSkillCommandOptions(args: string[]): {
  value?: string;
  cwd: string;
  scope: SkillScope;
  skillName?: string;
} {
  let value: string | undefined;
  let cwd = process.cwd();
  let scope: SkillScope = "project";
  let skillName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--project" || arg === "--global") {
      scope = arg === "--global" ? "global" : "project";
    } else if (arg === "--cwd" || arg === "--skill") {
      const optionValue = args[index + 1];
      if (!optionValue) throw new Error(`${arg} requires a value.`);
      if (arg === "--cwd") cwd = optionValue;
      else skillName = optionValue;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown skills option '${arg}'.`);
    } else if (value === undefined) {
      value = arg;
    } else {
      throw new Error(`Unexpected argument '${arg}'.`);
    }
  }
  return {
    ...(value ? { value } : {}),
    cwd,
    scope,
    ...(skillName ? { skillName } : {}),
  };
}

async function runApplication(options: {
  cwd: string;
  prompt: string;
  gateway: AgentGateway;
  workspace?: Awaited<ReturnType<typeof resolveWorkspace>>;
  memoryCapture?: MemoryCaptureManager;
}): Promise<void> {
  let state = reduceAppState(initialAppState(), { type: "startup_complete" });
  try {
    if (options.prompt) {
      state = await runPrompt(options.gateway, options.prompt, state);
      await options.memoryCapture?.flush();
      for (const notice of options.memoryCapture?.drainNotices() ?? []) {
        stdout.write(`\n${notice}\n`);
      }
      return;
    }
    const app = createRookTui({
      cwd: options.cwd,
      gateway: options.gateway,
      ...(options.workspace?.snapshot?.branch
        ? { branch: options.workspace.snapshot.branch }
        : {}),
      ...(options.workspace
        ? {
            repository: options.workspace.repository,
            snapshot: options.workspace.snapshot,
          }
        : {}),
      ...(options.memoryCapture
        ? { memoryCapture: options.memoryCapture }
        : {}),
    });
    await app.start();
    await options.memoryCapture?.flush();
  } finally {
    await options.gateway.dispose();
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
