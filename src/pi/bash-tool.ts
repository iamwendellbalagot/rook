import {
  createBashToolDefinition,
  createLocalBashOperations,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_SHELL_TIMEOUT,
  MAX_SHELL_TIMEOUT,
  MAX_SHELL_COMMAND_LENGTH,
  shellTimeout,
} from "../policy/shell-limits.js";
import {
  createSandboxCommand,
  detectSandboxRuntime,
  runSandboxCommand,
  type SandboxRuntime,
} from "../policy/sandbox.js";
import { realpath } from "node:fs/promises";

/** Reuse Pi's output truncation and process-tree cancellation with a bounded timeout. */
export function createRookBashTool(
  cwd: string,
  options: { sandbox?: boolean; sandboxRuntime?: SandboxRuntime } = {},
) {
  const local = createLocalBashOperations();
  const useSandbox = options.sandbox ?? true;
  const sandboxRuntime = useSandbox
    ? (options.sandboxRuntime ?? undefined)
    : undefined;
  const tool = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, cwd }),
    operations: {
      exec: async (command, directory, executionOptions) => {
        const timeout = shellTimeout(executionOptions.timeout);
        if (!useSandbox) {
          const result = await local.exec(command, directory, {
            ...executionOptions,
            timeout,
          });
          return result;
        }
        const runtime = sandboxRuntime ?? (await detectSandboxRuntime());
        if (!runtime) {
          throw new Error(
            "Sandboxed shell execution is unavailable on this host; Rook will not run the command without isolation. Install Bubblewrap (Linux), or explicitly configure sandbox=false in .rook/policy.json to allow host execution.",
          );
        }
        const sandboxCwd = await realpath(directory);
        const sandboxEnv = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: "/tmp",
        };
        const sandbox = await createSandboxCommand(
          command,
          sandboxCwd,
          runtime,
          sandboxEnv,
        );
        const result = await runSandboxCommand(
          sandbox.executable,
          sandbox.args,
          {
            cwd: sandboxCwd,
            env: {
              ...sandboxEnv,
              ...(executionOptions.env?.PI_CODING_AGENT_DIR
                ? {
                    PI_CODING_AGENT_DIR:
                      executionOptions.env.PI_CODING_AGENT_DIR,
                  }
                : {}),
            },
            timeout: timeout * 1000,
            maxOutputBytes: 50 * 1024,
            ...(executionOptions.signal
              ? { signal: executionOptions.signal }
              : {}),
          },
        );
        if (result.cancelled) throw new Error("aborted");
        if (result.timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        if (result.truncated)
          executionOptions.onData(
            Buffer.from("\n[Output truncated at 50 KiB.]\n"),
          );
        if (result.stdout) executionOptions.onData(Buffer.from(result.stdout));
        if (result.stderr) executionOptions.onData(Buffer.from(result.stderr));
        return {
          exitCode: result.exitCode,
        };
      },
    },
  });
  return defineTool({
    name: tool.name,
    label: tool.label,
    execute: tool.execute,
    promptSnippet: "Run approved terminal commands in build mode.",
    description: `${tool.description} For test, build, or diagnostic commands, optionally provide expect.outcome (pass, fail, or error) and a short expect.evidence label; this metadata does not change the command. Rook requires build mode. Routine allowlisted commands run without prompts in the sandbox; destructive or unclassified commands require approval, with optional exact-command session grants. ${useSandbox ? "Commands run in an OS sandbox with network disabled and workspace-only writes; sandbox runtime is required and execution fails closed when unavailable." : "Commands run on the host with the user's permissions and are not sandboxed (explicit opt-out)."} Timeout defaults to ${DEFAULT_SHELL_TIMEOUT}s; maximum ${MAX_SHELL_TIMEOUT}s.`,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        command: {
          ...tool.parameters.properties.command,
          minLength: 1,
          maxLength: MAX_SHELL_COMMAND_LENGTH,
        },
        timeout: {
          ...tool.parameters.properties.timeout,
          description: `Timeout in seconds (default ${DEFAULT_SHELL_TIMEOUT}, maximum ${MAX_SHELL_TIMEOUT})`,
          exclusiveMinimum: 0,
          maximum: MAX_SHELL_TIMEOUT,
        },
        expect: Type.Optional(
          Type.Object(
            {
              outcome: Type.Union([
                Type.Literal("pass"),
                Type.Literal("fail"),
                Type.Literal("error"),
              ]),
              evidence: Type.Optional(Type.String({ maxLength: 200 })),
            },
            { additionalProperties: false },
          ),
        ),
      },
    },
  });
}
