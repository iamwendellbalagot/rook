export function shouldRetry(completedAttempts, maxAttempts) {
  return completedAttempts <= maxAttempts;
}
