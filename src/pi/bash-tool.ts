import {
  createBashToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_SHELL_TIMEOUT,
  MAX_SHELL_TIMEOUT,
  MAX_SHELL_COMMAND_LENGTH,
  shellTimeout,
} from "../policy/shell-limits.js";
import { runHostCommand } from "../policy/process-supervisor.js";

/** Reuse Pi's output truncation and process-tree cancellation with a bounded timeout. */
export function createRookBashTool(
  cwd: string,
  options: {
    sandbox?: boolean;
    predictions?: boolean;
  } = {},
) {
  if (options.sandbox === true)
    throw new Error(
      "Sandboxed Bash was retired; configure host tool permissions explicitly.",
    );
  const predictionDescription =
    options.predictions === false
      ? ""
      : " For test, build, or diagnostic commands, optionally provide expect.outcome (pass, fail, or error) and a short expect.evidence label; this metadata does not change the command.";
  const tool = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, cwd }),
    operations: {
      exec: async (command, directory, executionOptions) => {
        const timeout = shellTimeout(executionOptions.timeout);
        const result = await runHostCommand(command, {
          cwd: directory,
          timeout: timeout * 1000,
          onData: executionOptions.onData,
          ...(executionOptions.signal
            ? { signal: executionOptions.signal }
            : {}),
        });
        if (result.outputLimited)
          executionOptions.onData(
            Buffer.from(
              `\n[Output limited; command was not killed. Log (up to 2 MiB): ${result.artifact}]\n`,
            ),
          );
        if (result.cancelled) throw new Error("aborted");
        if (result.timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: result.exitCode };
      },
    },
  });
  return defineTool({
    name: tool.name,
    label: tool.label,
    execute: tool.execute,
    promptSnippet: "Run approved terminal commands in build mode.",
    description: `${tool.description}${predictionDescription} Rook requires Build mode. Commands are checked against configured tool permissions and higher-authority policies. Host execution has the user's filesystem and network authority, NOT OS isolation. Output streams live and presentation limits do not kill commands. Timeout defaults to ${DEFAULT_SHELL_TIMEOUT}s; maximum ${MAX_SHELL_TIMEOUT}s.`,
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
        ...(options.predictions === false
          ? {}
          : {
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
            }),
      },
    },
  });
}
