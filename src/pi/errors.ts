/** Keep upstream HTML and terminal controls out of user-facing errors. */
export function formatAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b504\b|gateway time[ -]?out/i.test(message))
    return "Provider timed out (504). Wait for the run to finish, then retry; completed edits are retained.";
  if (/<(?:!doctype|html|head|body)\b/i.test(message))
    return "Provider returned an unexpected HTML error. Check the endpoint or retry after the run finishes.";
  return redactCredentials(message)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .slice(0, 500);
}

function redactCredentials(message: string): string {
  return message
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
      "[redacted token]",
    )
    .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted AWS key]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g,
      "[redacted token]",
    );
}
