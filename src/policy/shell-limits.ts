export const DEFAULT_SHELL_TIMEOUT = 120;
export const MAX_SHELL_TIMEOUT = 300;
export const MAX_SHELL_COMMAND_LENGTH = 4096;

export function shellTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_SHELL_TIMEOUT;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_SHELL_TIMEOUT
  ) {
    throw new Error(
      `Shell timeout must be greater than 0 and at most ${MAX_SHELL_TIMEOUT} seconds.`,
    );
  }
  return value;
}
