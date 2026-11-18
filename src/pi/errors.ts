/** Keep upstream HTML and terminal controls out of user-facing errors. */
export function formatAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b504\b|gateway time[ -]?out/i.test(message))
    return "Provider timed out (504). Wait for the run to finish, then retry; completed edits are retained.";
  if (/<(?:!doctype|html|head|body)\b/i.test(message))
    return "Provider returned an unexpected HTML error. Check the endpoint or retry after the run finishes.";
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);
}
