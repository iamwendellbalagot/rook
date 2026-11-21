export function shouldRetry(error, completedAttempts, maxAttempts) {
  return completedAttempts < maxAttempts;
}
