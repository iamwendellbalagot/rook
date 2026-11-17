import {
  createBashToolDefinition,
  createLocalBashOperations,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SHELL_TIMEOUT,
  MAX_SHELL_TIMEOUT,
  MAX_SHELL_COMMAND_LENGTH,
  shellTimeout,
} from "../policy/shell-limits.js";

/** Reuse Pi's output truncation and process-tree cancellation with a bounded timeout. */
export function createRookBashTool(cwd: string) {
  const local = createLocalBashOperations();
  const tool = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, cwd }),
    operations: {
      exec: (command, directory, options) =>
        local.exec(command, directory, {
          ...options,
          timeout: shellTimeout(options.timeout),
        }),
    },
  });
  return defineTool({
    name: tool.name,
    label: tool.label,
    execute: tool.execute,
    promptSnippet: "Run approved terminal commands in build mode.",
    description: `${tool.description} Rook requires build mode and one-time command approval. Commands run on the host, not in a sandbox. Timeout defaults to ${DEFAULT_SHELL_TIMEOUT}s; maximum ${MAX_SHELL_TIMEOUT}s.`,
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
      },
    },
  });
}
