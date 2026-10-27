import postgres from "postgres";
import { withRetry } from "./retry";

const DATABASE_URL =
  process.env.OPENCODE_DATABASE_URL ||
  "postgres://opencode:opencode@postgres:5432/opencode";

export const sql = postgres(DATABASE_URL, {
  max: 30,
  idle_timeout: 30,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  onnotice: () => {},
});

export async function ensureConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    console.error("[database] Database connection failed:", error);
    return false;
  }
}

/**
 * Writes have no timeout, so one held up by a lock, such as an index being built, waits
 * for it rather than being lost.
 */
export function fireAndForget(
  queryFn: () => Promise<unknown>,
  onError: (error: unknown) => void
): Promise<void> {
  return withRetry(queryFn).then(() => {}, onError);
}
