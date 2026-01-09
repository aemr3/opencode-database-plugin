import { join } from "node:path";
import postgres from "postgres";
import { createOpencodeClient } from "@opencode-ai/sdk";

const PROJECT_NAME = "agent-test";
const COMPOSE_FILE = join(import.meta.dir, "../compose.test.yml");
const PROJECT_ROOT = join(import.meta.dir, "../..");

// Test-specific ports (different from local stack)
export const TEST_PORTS = {
  opencode: 24096,
  postgres: 25432,
} as const;

export const TEST_OPENCODE_URL = `http://localhost:${TEST_PORTS.opencode}`;
export const TEST_DATABASE_URL = `postgres://opencode:opencode@localhost:${TEST_PORTS.postgres}/opencode`;

export async function startTestStack(): Promise<void> {
  console.log("[test] Starting test Docker stack...");

  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-p",
      PROJECT_NAME,
      "-f",
      COMPOSE_FILE,
      "up",
      "-d",
      "--build",
      "--wait",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      cwd: PROJECT_ROOT,
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to start test stack (exit code: ${exitCode})`);
  }

  await waitForServices();
  console.log("[test] Test stack ready!");
}

export async function stopTestStack(): Promise<void> {
  console.log("[test] Stopping test Docker stack...");

  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-p",
      PROJECT_NAME,
      "-f",
      COMPOSE_FILE,
      "down",
      "--remove-orphans",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      cwd: PROJECT_ROOT,
    },
  );

  await proc.exited;
}

async function waitForServices(maxRetries = 60): Promise<void> {
  // Wait for PostgreSQL
  console.log("[test] Waiting for PostgreSQL...");
  const sql = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
  for (let i = 0; i < maxRetries; i++) {
    try {
      await sql`SELECT 1`;
      console.log("[test] PostgreSQL ready");
      break;
    } catch {
      if (i === maxRetries - 1) {
        await sql.end();
        throw new Error("PostgreSQL not ready after max retries");
      }
      await Bun.sleep(1000);
    }
  }
  await sql.end();

  // Wait for OpenCode
  console.log("[test] Waiting for OpenCode...");
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${TEST_OPENCODE_URL}/project`);
      if (res.ok) {
        console.log("[test] OpenCode ready");
        break;
      }
    } catch {
      if (i === maxRetries - 1) {
        throw new Error("OpenCode not ready after max retries");
      }
      await Bun.sleep(1000);
    }
  }
}

export function createTestClient() {
  return createOpencodeClient({ baseUrl: TEST_OPENCODE_URL });
}

export function createTestDatabase() {
  return postgres(TEST_DATABASE_URL);
}
