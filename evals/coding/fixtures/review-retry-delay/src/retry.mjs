export function retryDelay(attempt, baseDelayMs, requestedDelayMs) {
  return Math.min(baseDelayMs * 2 ** attempt, requestedDelayMs);
}
