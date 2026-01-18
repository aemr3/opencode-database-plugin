import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Track SQL calls for assertions
let sqlCalls: Array<{ query: string; values: unknown[] }> = [];
let dbConnected = true;
// Mock response for SELECT queries (used by session.compacted)
let mockSelectResponse: unknown[] = [];

// Create mock SQL function
const mockSql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    sqlCalls.push({ query, values });
    // Return mock session data for SELECT queries when configured
    if (query.includes("SELECT") && mockSelectResponse.length > 0) {
      const response = mockSelectResponse;
      mockSelectResponse = []; // Reset after use
      return Promise.resolve(response);
    }
    return Promise.resolve([]);
  },
  {
    // Add any methods that might be called on sql
    end: () => Promise.resolve(),
    json: (value: unknown) => ({ toJSON: () => value }),
  },
);

const mockEnsureConnection = () => Promise.resolve(dbConnected);

// Mock database module before importing plugin
mock.module("../../db", () => ({
  sql: mockSql,
  ensureConnection: mockEnsureConnection,
  isDatabaseHealthy: () => dbConnected,
  fireAndForget: (fn: () => Promise<unknown>, onError?: (error: unknown) => void) => {
    if (!dbConnected) return;
    fn().catch((e) => onError?.(e));
  },
  safeQuery: async <T>(fn: () => Promise<T>) => {
    if (!dbConnected) return undefined;
    return fn();
  },
  jsonb: (value: unknown) => ({ toJSON: () => value }),
}));

// Import after mocking
import { DatabasePlugin, generateCorrelationId } from "../../index";

// Mock plugin context
const mockContext = {
  client: {
    app: {
      log: () => Promise.resolve(),
    },
  } as any,
  project: {
    id: "test-project",
    name: "Test Project",
    worktree: "/test",
    time: { created: Date.now(), updated: Date.now() },
  },
  directory: "/test",
  worktree: "/test",
  serverUrl: new URL("http://localhost:3000"),
  $: {} as any,
};

beforeEach(() => {
  sqlCalls = [];
  dbConnected = true;
  mockSelectResponse = [];
});

describe("generateCorrelationId", () => {
  test("returns string in expected format (timestamp-random)", () => {
    const id = generateCorrelationId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^\d+-[a-z0-9]+$/);
  });

  test("generates unique values", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateCorrelationId()),
    );
    expect(ids.size).toBe(100);
  });

  test("timestamp part is recent", () => {
    const before = Date.now();
    const id = generateCorrelationId();
    const after = Date.now();

    const timestamp = parseInt(id.split("-")[0]!, 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe("Plugin Initialization", () => {
  test("returns empty hooks when database is unavailable", async () => {
    dbConnected = false;
    const hooks = await DatabasePlugin(mockContext);
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  test("returns all hooks when database is connected", async () => {
    dbConnected = true;
    const hooks = await DatabasePlugin(mockContext);

    expect(hooks.event).toBeDefined();
    expect(hooks["chat.message"]).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
  });
});

describe("Session Events", () => {
  test("session.created inserts session record", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "sess-123",
            title: "Test Session",
            parentID: "parent-456",
            projectID: "proj-789",
          },
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("INSERT INTO sessions");
    expect(sqlCalls[0]!.values).toContain("sess-123");
    expect(sqlCalls[0]!.values).toContain("Test Session");
    expect(sqlCalls[0]!.values).toContain("parent-456");
    expect(sqlCalls[0]!.values).toContain("proj-789");
  });

  test("session.created handles missing optional fields", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: {
          info: { id: "sess-minimal" },
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.values).toContain("sess-minimal");
    expect(sqlCalls[0]!.values).toContain(null); // title
  });

  test("session.updated updates title and share_url", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: {
          info: {
            id: "sess-123",
            title: "Updated Title",
            share: { url: "https://share.example.com/sess-123" },
          },
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("UPDATE sessions");
    expect(sqlCalls[0]!.values).toContain("Updated Title");
    expect(sqlCalls[0]!.values).toContain("https://share.example.com/sess-123");
  });

  test("session.deleted sets deleted_at and status", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: {
          info: { id: "sess-123" },
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("UPDATE sessions");
    expect(sqlCalls[0]!.query).toContain("deleted_at");
    expect(sqlCalls[0]!.query).toContain("deleted");
  });

  test("session.idle updates status to idle", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "sess-123" },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("UPDATE sessions");
    expect(sqlCalls[0]!.query).toContain("idle");
  });

  test("session.status is ignored (active status set via message events)", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "sess-123" },
      } as any,
    });

    // session.status events are ignored to prevent race conditions
    // Active status is set via message.updated events instead
    expect(sqlCalls.length).toBe(0);
  });

  test("session.error creates error record and updates session status", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "sess-123",
          error: {
            name: "TestError",
            data: { message: "Something went wrong" },
          },
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(2);
    // First: insert error record
    expect(sqlCalls[0]!.query).toContain("INSERT INTO session_errors");
    expect(sqlCalls[0]!.values).toContain("TestError");
    expect(sqlCalls[0]!.values).toContain("Something went wrong");
    // Second: update session status
    expect(sqlCalls[1]!.query).toContain("UPDATE sessions");
    expect(sqlCalls[1]!.query).toContain("error");
  });

  test("session.error handles missing sessionID gracefully", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {},
      } as any,
    });

    // Should not insert anything if sessionID is missing
    expect(sqlCalls.length).toBe(0);
  });

  test("session.compacted updates status and records compaction", async () => {
    // Set up mock to return session state for the SELECT query
    mockSelectResponse = [
      {
        context_tokens: 1000,
        input_tokens: 500,
        output_tokens: 200,
        cache_read_tokens: 100,
        cache_write_tokens: 50,
        reasoning_tokens: 25,
        estimated_cost: "0.01",
      },
    ];

    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "session.compacted",
        properties: { sessionID: "sess-123" },
      } as any,
    });

    // 3 calls: SELECT session state, INSERT compaction record, UPDATE session status
    expect(sqlCalls.length).toBe(3);
    expect(sqlCalls[0]!.query).toContain("SELECT");
    expect(sqlCalls[1]!.query).toContain("INSERT INTO compactions");
    expect(sqlCalls[2]!.query).toContain("UPDATE sessions");
    expect(sqlCalls[2]!.query).toContain("compacted");
  });
});

describe("Message Events", () => {
  test("message.updated inserts message record", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-123",
            sessionID: "sess-456",
            role: "assistant",
            providerID: "zai-coding-plan",
            modelID: "glm-4.7",
            summary: { title: "Test summary" },
          },
        },
      } as any,
    });

    // First ensures session exists, then inserts message
    expect(sqlCalls.length).toBe(2);
    expect(sqlCalls[1]!.query).toContain("INSERT INTO messages");
    expect(sqlCalls[1]!.values).toContain("msg-123");
    expect(sqlCalls[1]!.values).toContain("sess-456");
    expect(sqlCalls[1]!.values).toContain("assistant");
  });

  test("message.removed deletes message", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "message.removed",
        properties: { messageID: "msg-123" },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("DELETE FROM messages");
    expect(sqlCalls[0]!.values).toContain("msg-123");
  });
});

describe("Message Part Events", () => {
  test("message.part.updated inserts part record", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-123",
            sessionID: "sess-789",
            messageID: "msg-456",
            type: "text",
            text: "Hello world",
          },
        },
      } as any,
    });

    // 5 calls: ensure message, ensure session, insert part, update part (longer text check), update message text
    expect(sqlCalls.length).toBe(5);
    expect(sqlCalls[2]!.query).toContain("INSERT INTO message_parts");
    expect(sqlCalls[2]!.values).toContain("part-123");
    expect(sqlCalls[2]!.values).toContain("text");
  });

  test("message.part.updated extracts tool name for tool parts", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-123",
            sessionID: "sess-789",
            messageID: "msg-456",
            type: "tool",
            tool: "bash",
          },
        },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (status priority check)
    expect(sqlCalls.length).toBe(4);
    expect(sqlCalls[2]!.values).toContain("bash");
  });

  test("message.part.removed deletes part", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "message.part.removed",
        properties: { partID: "part-123" },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("DELETE FROM message_parts");
    expect(sqlCalls[0]!.values).toContain("part-123");
  });
});

describe("Command Events", () => {
  test("command.executed logs command", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks.event?.({
      event: {
        type: "command.executed",
        properties: {
          name: "/help",
          sessionID: "sess-123",
          arguments: "some args",
        },
      } as any,
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("INSERT INTO commands");
    expect(sqlCalls[0]!.values).toContain("/help");
    expect(sqlCalls[0]!.values).toContain("sess-123");
    expect(sqlCalls[0]!.values).toContain("some args");
  });
});

describe("Chat Message Hook", () => {
  test("chat.message updates session status and stores pending user message parts", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks["chat.message"]?.(
      { sessionID: "sess-123" },
      {
        message: {} as any,
        parts: [
          {
            type: "text",
            text: "Hello",
            id: "p1",
            sessionID: "sess-123",
            messageID: "msg-1",
          },
          {
            type: "text",
            text: "World",
            id: "p2",
            sessionID: "sess-123",
            messageID: "msg-1",
          },
        ] as any,
      },
    );

    // Should make 1 SQL call to set session status to 'active'
    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("UPDATE sessions SET status");
    expect(sqlCalls[0]!.values).toContain("sess-123");
  });
});

describe("Tool Execution Hooks", () => {
  test("tool.execute.before records execution start with full args", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "sess-123", callID: "call-456" },
      { args: { command: "ls -la", description: "List files" } },
    );

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("INSERT INTO tool_executions");
    expect(sqlCalls[0]!.values).toContain("sess-123");
    expect(sqlCalls[0]!.values).toContain("bash");
    // Verify args are stored as full object
    const argsValue = sqlCalls[0]!.values.find(
      (v) => typeof v === "object" && v !== null && "command" in v,
    );
    expect(argsValue).toBeDefined();
    expect((argsValue as Record<string, unknown>).command).toBe("ls -la");
  });

  test("tool.execute.after updates completion with duration and full result", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // Start execution
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "sess-123", callID: "call-456" },
      { args: { command: "ls" } },
    );

    // Wait a bit to ensure duration > 0
    await Bun.sleep(50);

    // Complete execution with full output
    const fullOutput = "file1.txt\nfile2.txt\nfile3.txt";
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "sess-123", callID: "call-456" },
      { title: "Bash", output: fullOutput, metadata: { exitCode: 0 } },
    );

    expect(sqlCalls.length).toBe(2);
    // First: INSERT (before)
    expect(sqlCalls[0]!.query).toContain("INSERT INTO tool_executions");
    // Second: UPDATE (after)
    expect(sqlCalls[1]!.query).toContain("UPDATE tool_executions");
    expect(sqlCalls[1]!.query).toContain("duration_ms");
    // Verify output is stored
    expect(sqlCalls[1]!.values).toContain(fullOutput);
  });

  test("tool.execute.after records read tool with file contents", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // Simulate read tool execution
    await hooks["tool.execute.before"]?.(
      { tool: "read", sessionID: "sess-123", callID: "call-read" },
      { args: { filePath: "/etc/passwd" } },
    );

    await Bun.sleep(10);

    const fileContent =
      "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin";
    await hooks["tool.execute.after"]?.(
      { tool: "read", sessionID: "sess-123", callID: "call-read" },
      { title: "Read", output: fileContent, metadata: {} },
    );

    expect(sqlCalls.length).toBe(2);
    // Verify file content is stored in result
    expect(sqlCalls[1]!.values).toContain(fileContent);
  });

  test("tool.execute.after records write tool with written content", async () => {
    const hooks = await DatabasePlugin(mockContext);

    await hooks["tool.execute.before"]?.(
      { tool: "write", sessionID: "sess-123", callID: "call-write" },
      { args: { filePath: "/tmp/test.txt", content: "test content" } },
    );

    await Bun.sleep(10);

    await hooks["tool.execute.after"]?.(
      { tool: "write", sessionID: "sess-123", callID: "call-write" },
      { title: "Write", output: "File written successfully", metadata: {} },
    );

    expect(sqlCalls.length).toBe(2);
    // Verify args contain the content being written
    const argsValue = sqlCalls[0]!.values.find(
      (v) => typeof v === "object" && v !== null && "content" in v,
    );
    expect(argsValue).toBeDefined();
    expect((argsValue as Record<string, unknown>).content).toBe("test content");
  });

  test("tool.execute.after handles missing pending execution", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // Call after without before
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "sess-123", callID: "call-unknown" },
      { title: "Bash", output: "output", metadata: {} },
    );

    // Should still insert a record
    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]!.query).toContain("INSERT INTO tool_executions");
  });
});

describe("Reasoning/Thinking Parts", () => {
  test("message.part.updated records reasoning text", async () => {
    const hooks = await DatabasePlugin(mockContext);

    const reasoningText =
      "The user is asking me to read a file. I should use the read tool to access the file contents.";
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-reasoning-1",
            sessionID: "sess-789",
            messageID: "msg-123",
            type: "reasoning",
            text: reasoningText,
          },
        },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (longer text check)
    expect(sqlCalls.length).toBe(4);
    expect(sqlCalls[2]!.query).toContain("INSERT INTO message_parts");
    expect(sqlCalls[2]!.values).toContain("reasoning");
    expect(sqlCalls[2]!.values).toContain(reasoningText);
  });

  test("message.part.updated handles partial reasoning (streaming)", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // First partial update
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-reasoning-stream",
            sessionID: "sess-789",
            messageID: "msg-123",
            type: "reasoning",
            text: "The user",
          },
        },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (longer text check)
    expect(sqlCalls.length).toBe(4);
    expect(sqlCalls[2]!.values).toContain("The user");
  });
});

describe("Tool Part Content", () => {
  test("message.part.updated stores full tool state in content", async () => {
    const hooks = await DatabasePlugin(mockContext);

    const toolPart = {
      id: "part-tool-1",
      messageID: "msg-123",
      sessionID: "sess-456",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        title: "Read",
        input: { filePath: "/etc/passwd" },
        output: "root:x:0:0:root:/root:/bin/bash",
      },
    };

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (status priority)
    expect(sqlCalls.length).toBe(4);
    expect(sqlCalls[2]!.query).toContain("INSERT INTO message_parts");
    // Verify the full part object is stored in content via jsonb helper
    const contentValue = sqlCalls[2]!.values.find(
      (v) => typeof v === "object" && v !== null && "toJSON" in v,
    );
    expect(contentValue).toBeDefined();
    const parsed = (contentValue as { toJSON: () => unknown }).toJSON();
    expect((parsed as { state: { output: string } }).state.output).toBe(
      "root:x:0:0:root:/root:/bin/bash",
    );
  });

  test("message.part.updated handles tool part with running status", async () => {
    const hooks = await DatabasePlugin(mockContext);

    const toolPart = {
      id: "part-tool-running",
      sessionID: "sess-456",
      messageID: "msg-123",
      type: "tool",
      tool: "bash",
      state: {
        status: "running",
        title: "Bash",
        input: { command: "sleep 10" },
      },
    };

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (status priority)
    expect(sqlCalls.length).toBe(4);
    const contentValue = sqlCalls[2]!.values.find(
      (v) => typeof v === "object" && v !== null && "toJSON" in v,
    );
    expect(contentValue).toBeDefined();
    const parsed = (contentValue as { toJSON: () => unknown }).toJSON();
    expect((parsed as { state: { status: string } }).state.status).toBe(
      "running",
    );
  });

  test("message.part.updated updates tool part when state changes", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // First: running state
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-update",
            sessionID: "sess-456",
            messageID: "msg-123",
            type: "tool",
            tool: "read",
            state: { status: "running", input: { filePath: "/etc/passwd" } },
          },
        },
      } as any,
    });

    sqlCalls = []; // Reset for second call

    // Second: completed state with output
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-update",
            sessionID: "sess-456",
            messageID: "msg-123",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/etc/passwd" },
              output: "file contents here",
            },
          },
        },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (status priority)
    expect(sqlCalls.length).toBe(4);
    // Should use INSERT ... ON CONFLICT DO NOTHING followed by UPDATE
    expect(sqlCalls[2]!.query).toContain("ON CONFLICT");
    const contentValue = sqlCalls[2]!.values.find(
      (v) => typeof v === "object" && v !== null && "toJSON" in v,
    );
    const parsed = (contentValue as { toJSON: () => unknown }).toJSON();
    expect((parsed as { state: { output: string } }).state.output).toBe(
      "file contents here",
    );
  });
});

describe("Tool Execution and Message Part Linking", () => {
  test("tool part with callID is tracked for linking", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // Create a tool part with callID
    const toolPart = {
      id: "part-tool-link",
      messageID: "msg-123",
      sessionID: "sess-456",
      type: "tool",
      tool: "read",
      callID: "call-789",
      state: {
        status: "running",
        input: { filePath: "/etc/passwd" },
      },
    };

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart },
      } as any,
    });

    // 4 calls: ensure message, ensure session, insert part, update part (status priority)
    expect(sqlCalls.length).toBe(4);
    expect(sqlCalls[2]!.query).toContain("INSERT INTO message_parts");
  });

  test("tool.execute.after with callID updates message part", async () => {
    const hooks = await DatabasePlugin(mockContext);

    // First, create the message part with callID
    const toolPart = {
      id: "part-tool-update",
      messageID: "msg-123",
      sessionID: "sess-456",
      type: "tool",
      tool: "read",
      callID: "call-update-test",
      state: {
        status: "running",
        input: { filePath: "/etc/passwd" },
      },
    };

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: toolPart },
      } as any,
    });

    // Then start tool execution
    await hooks["tool.execute.before"]?.(
      { tool: "read", sessionID: "sess-456", callID: "call-update-test" },
      { args: { filePath: "/etc/passwd" } },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    sqlCalls = [];

    const fileContent = "root:x:0:0:root:/root:/bin/bash";
    await hooks["tool.execute.after"]?.(
      { tool: "read", sessionID: "sess-456", callID: "call-update-test" },
      { title: "Read", output: fileContent, metadata: {} },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sqlCalls.length).toBe(2);
    expect(sqlCalls[0]!.query).toContain("UPDATE tool_executions");
    expect(sqlCalls[1]!.query).toContain("UPDATE message_parts");
    expect(sqlCalls[1]!.query).toContain("jsonb_set");
  });
});

describe("Error Handling", () => {
  test("event handler catches and logs errors without throwing", async () => {
    // Make SQL throw an error
    const errorSql = Object.assign(
      () => {
        throw new Error("Database error");
      },
      { end: () => Promise.resolve() },
    );

    mock.module("../../db", () => ({
      sql: errorSql,
      ensureConnection: () => Promise.resolve(true),
    }));

    // Re-import to get new mock
    const { DatabasePlugin: ErrorPlugin } = await import("../../index");

    const hooks = await ErrorPlugin(mockContext);

    // Should not throw
    await expect(
      hooks.event?.({
        event: {
          type: "session.created",
          properties: { info: { id: "test" } },
        } as any,
      }),
    ).resolves.toBeUndefined();
  });
});
