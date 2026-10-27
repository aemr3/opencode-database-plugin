const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// Failures where the database applied nothing: it could not be reached, was starting up or
// shutting down, or rolled the statement back. A connection dropped mid-query is left out,
// since the statement may have committed before it dropped.
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

/**
 * Each attempt runs the whole of `queryFn`, so the statements before the one that failed
 * run again: they have to be safe to repeat, or share a transaction with the rest.
 */
export async function withRetry<T>(
  queryFn: () => Promise<T>,
  delaysMs: readonly number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await queryFn();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
