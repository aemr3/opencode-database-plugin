import postgres from "postgres";

const DATABASE_URL =
  process.env.OPENCODE_DATABASE_URL ||
  "postgres://opencode:opencode@postgres:5432/opencode";

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 0,
  connect_timeout: 30,
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
