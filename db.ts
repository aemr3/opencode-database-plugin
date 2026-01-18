import postgres from "postgres";

const DATABASE_URL =
  process.env.OPENCODE_DATABASE_URL ||
  "postgres://opencode:opencode@postgres:5432/opencode";

const QUERY_TIMEOUT = parseInt(
  process.env.OPENCODE_DB_QUERY_TIMEOUT || "10000",
  10
);

export const sql = postgres(DATABASE_URL, {
  max: 30,
  idle_timeout: 30,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  onnotice: () => {},
});

let consecutiveFailures = 0;
let lastFailureTime = 0;
const MAX_BACKOFF_MS = 60000;
const BASE_BACKOFF_MS = 1000;

export function isDatabaseHealthy(): boolean {
  if (consecutiveFailures === 0) {
    return true;
  }

  const backoffMs = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
    MAX_BACKOFF_MS
  );
  const timeSinceFailure = Date.now() - lastFailureTime;

  return timeSinceFailure >= backoffMs;
}

function markHealthy(): void {
  consecutiveFailures = 0;
  lastFailureTime = 0;
}

function markUnhealthy(): void {
  consecutiveFailures++;
  lastFailureTime = Date.now();
}

export async function ensureConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    markHealthy();
    return true;
  } catch (error) {
    console.error("[database] Database connection failed:", error);
    markUnhealthy();
    return false;
  }
}

export async function safeQuery<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = QUERY_TIMEOUT
): Promise<T | undefined> {
  if (!isDatabaseHealthy()) {
    return undefined;
  }

  try {
    const result = await Promise.race([
      queryFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Query timeout")), timeoutMs)
      ),
    ]);
    markHealthy();
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("connection") ||
        error.message.includes("timeout") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ETIMEDOUT"))
    ) {
      markUnhealthy();
    }
    throw error;
  }
}

export function fireAndForget(
  queryFn: () => Promise<unknown>,
  onError?: (error: unknown) => void
): void {
  safeQuery(queryFn).catch((error) => {
    if (onError) {
      onError(error);
    }
  });
}
