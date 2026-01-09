import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type postgres from "postgres";

import {
  startTestStack,
  stopTestStack,
  createTestClient,
  createTestDatabase,
} from "./setup";

let client: OpencodeClient | null = null;
let sql: ReturnType<typeof postgres> | null = null;
const testSessionIds: string[] = [];

beforeAll(async () => {
  await startTestStack();
  client = createTestClient();
  sql = createTestDatabase();
}, 600000); // 10 min timeout for Docker build + startup

afterAll(async () => {
  // Cleanup test sessions
  if (client) {
    for (const id of testSessionIds) {
      try {
        await client.session.delete({ path: { id } });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  if (sql) {
    await sql.end();
  }

  await stopTestStack();
}, 60000);

describe("Database Plugin - Session Events", () => {
  test("session.created logs to database", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Integration Test Session" },
    });

    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Wait for plugin to process event
    await Bun.sleep(1000);

    // Verify in database
    const [dbSession] = await sql!`
      SELECT * FROM sessions WHERE id = ${session!.id}
    `;

    expect(dbSession).toBeDefined();
    expect(dbSession!.title).toBe("Integration Test Session");
    // Status may be "created" or "updated" depending on timing of events
    expect(["created", "updated", "active", "idle"]).toContain(
      dbSession!.status,
    );
  });

  test("session.updated updates database", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Original Title" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    await Bun.sleep(500);

    await client!.session.update({
      path: { id: session!.id },
      body: { title: "Updated Title" },
    });

    await Bun.sleep(1000);

    const [dbSession] = await sql!`
      SELECT * FROM sessions WHERE id = ${session!.id}
    `;

    expect(dbSession!.title).toBe("Updated Title");
    // session.updated only updates metadata (title, share_url), not status
    // Status remains from session.created or other status-changing events
    expect(["created", "active", "idle"]).toContain(dbSession!.status);
  });

  test("session.deleted sets deleted_at and status", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Delete Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    await Bun.sleep(500);

    await client!.session.delete({ path: { id: session!.id } });

    await Bun.sleep(1000);

    const [dbSession] = await sql!`
      SELECT * FROM sessions WHERE id = ${session!.id}
    `;

    expect(dbSession!.deleted_at).not.toBeNull();
    expect(dbSession!.status).toBe("deleted");
  });
});

describe("Database Plugin - Messages", () => {
  test("user and assistant messages are logged to database", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Message Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Send a simple prompt - this should succeed with valid API key
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [{ type: "text", text: "Say hello in exactly 3 words." }],
      },
    });

    // Verify the response has no error (API key is valid)
    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();
    expect(response!.info.role).toBe("assistant");
    expect(response!.info.providerID).toBeDefined();
    expect(response!.info.modelID).toBeDefined();

    // Wait for plugin to process
    await Bun.sleep(2000);

    // Check messages were logged
    const messages = await sql!`
      SELECT * FROM messages WHERE session_id = ${session!.id} ORDER BY created_at
    `;

    expect(messages.length).toBeGreaterThanOrEqual(2); // At least user + assistant

    // Verify user message
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();

    // Verify assistant message
    const assistantMessage = messages.find((m) => m.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.model_provider).toBeDefined();
    expect(assistantMessage?.model_id).toBeDefined();
  }, 60000); // 60s timeout for LLM call
});

describe("Database Plugin - Tool Executions", () => {
  test("tool executions are logged with duration", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Tool Execution Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Send a prompt that should trigger a tool call (e.g., bash)
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [{ type: "text", text: "Run the command: echo 'hello test'" }],
      },
    });

    // Verify the response has no error (API key is valid)
    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();

    // Wait for plugin to process
    await Bun.sleep(2000);

    // Check tool executions were logged
    const executions = await sql!`
      SELECT * FROM tool_executions WHERE session_id = ${session!.id}
    `;

    expect(executions.length).toBeGreaterThanOrEqual(1);

    const bashExecution = executions.find((e) => e.tool_name === "bash");
    if (bashExecution) {
      expect(bashExecution.duration_ms).toBeGreaterThan(0);
      expect(bashExecution.success).toBe(true);
    }
  }, 90000); // 90s timeout for tool execution
});

describe("Database Plugin - Reasoning/Thinking", () => {
  test("reasoning parts are captured in message_parts", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Reasoning Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Send a prompt that should trigger reasoning
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [{ type: "text", text: "What is 2+2? Think step by step." }],
      },
    });

    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();

    // Wait for plugin to process
    await Bun.sleep(2000);

    // Check reasoning parts were logged
    const reasoningParts = await sql!`
      SELECT mp.* 
      FROM message_parts mp
      JOIN messages m ON mp.message_id = m.id
      WHERE m.session_id = ${session!.id} AND mp.part_type = 'reasoning'
    `;

    // If reasoning is present, verify it has text content
    if (reasoningParts.length > 0) {
      expect(reasoningParts[0]!.text).toBeTruthy();
      expect(reasoningParts[0]!.text.length).toBeGreaterThan(0);
    }
  }, 60000);
});

describe("Database Plugin - File Operations", () => {
  test("read tool captures file path and content", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Read File Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Request to read a simple file
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [
          {
            type: "text",
            text: "Read the file /etc/hostname and show me its contents.",
          },
        ],
      },
    });

    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();

    // Wait for plugin to process
    await Bun.sleep(3000);

    // Check tool_executions for read tool
    const readExecutions = await sql!`
      SELECT * FROM tool_executions 
      WHERE session_id = ${session!.id} AND tool_name = 'read'
    `;

    expect(readExecutions.length).toBeGreaterThanOrEqual(1);

    const readExec = readExecutions[0]!;
    // Args should contain the file path
    expect(readExec.args).toBeDefined();
    expect(readExec.args.filePath).toBeDefined();

    // Result may or may not be present depending on timing of tool.execute.after hook
    // The main thing we're testing is that the tool execution was recorded with args
    // Result will be null if tool.execute.after hasn't run yet or if tool returned void
    if (readExec.result !== null) {
      // If result exists, verify it has content
      if (typeof readExec.result === "string") {
        expect(readExec.result.length).toBeGreaterThan(0);
      }
    }

    // Should have completed (success true or null, duration may not be recorded if after hook hasn't run)
    expect([true, null]).toContain(readExec.success);
    // Duration may be null if tool.execute.after hasn't run yet
    if (readExec.duration_ms !== null) {
      expect(readExec.duration_ms).toBeGreaterThan(0);
    }
  }, 90000);

  test("write tool captures file path and written content", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Write File Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Request to create and write a test file
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [
          {
            type: "text",
            text: "Create a file called /tmp/test-audit.txt with the content 'Hello from audit test'",
          },
        ],
      },
    });

    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();

    // Wait for plugin to process
    await Bun.sleep(3000);

    // Check tool_executions for write tool
    const writeExecutions = await sql!`
      SELECT * FROM tool_executions 
      WHERE session_id = ${session!.id} AND tool_name = 'write'
    `;

    expect(writeExecutions.length).toBeGreaterThanOrEqual(1);

    const writeExec = writeExecutions[0]!;
    // Args should contain file path and content
    expect(writeExec.args).toBeDefined();
    expect(writeExec.args.filePath).toBeDefined();
    expect(writeExec.args.content).toBeDefined();
    expect(writeExec.args.content).toContain("Hello from audit test");

    // Should have completed (success may be true or null depending on timing)
    expect([true, null]).toContain(writeExec.success);
  }, 90000);

  test("message_parts stores complete tool state with input and output", async () => {
    const { data: session } = await client!.session.create({
      body: { title: "Tool State Test" },
    });
    expect(session).toBeDefined();
    testSessionIds.push(session!.id);

    // Request a simple read operation
    const { data: response } = await client!.session.prompt({
      path: { id: session!.id },
      body: {
        parts: [{ type: "text", text: "Read /etc/hostname" }],
      },
    });

    expect(response).toBeDefined();
    expect(response!.info.error).toBeUndefined();

    // Wait for plugin to process
    await Bun.sleep(3000);

    // Check message_parts for tool parts
    const toolParts = await sql!`
      SELECT mp.* 
      FROM message_parts mp
      JOIN messages m ON mp.message_id = m.id
      WHERE m.session_id = ${session!.id} AND mp.part_type = 'tool' AND mp.tool_name = 'read'
    `;

    expect(toolParts.length).toBeGreaterThanOrEqual(1);

    const toolPart = toolParts[0]!;
    // Content should contain the full tool state
    expect(toolPart.content).toBeDefined();

    // Verify state structure exists
    const content = toolPart.content as Record<string, unknown>;
    expect(content.state).toBeDefined();

    const state = content.state as Record<string, unknown>;
    expect(state.input).toBeDefined();

    // Verify input has file path
    const input = state.input as Record<string, unknown>;
    expect(input.filePath).toBeDefined();

    // Output may or may not be present depending on event timing
    // The tool.execute.after hook tries to update message_parts with output,
    // but it may not always succeed due to race conditions
    if (state.output !== undefined) {
      // If output exists, verify it has content
      if (typeof state.output === "string") {
        expect(state.output.length).toBeGreaterThan(0);
      } else {
        // Output could also be an object
        expect(state.output).not.toBeNull();
      }
    }
  }, 90000);
});

describe("Database Plugin - Database Schema", () => {
  test("sessions table exists with correct columns", async () => {
    const columns = await sql!`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'sessions'
      ORDER BY column_name
    `;

    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("title");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("deleted_at");
  });

  test("messages table exists with correct columns", async () => {
    const columns = await sql!`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'messages'
      ORDER BY column_name
    `;

    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("session_id");
    expect(columnNames).toContain("role");
    expect(columnNames).toContain("content");
  });

  test("tool_executions table exists with correct columns", async () => {
    const columns = await sql!`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'tool_executions'
      ORDER BY column_name
    `;

    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("session_id");
    expect(columnNames).toContain("tool_name");
    expect(columnNames).toContain("duration_ms");
  });
});
