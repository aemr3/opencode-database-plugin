# opencode-database-plugin

An [OpenCode](https://github.com/anomalyco/opencode) plugin that logs sessions, messages, tool executions, and token usage to PostgreSQL.

## Features

- Session tracking (creation, updates, deletion, errors, compaction)
- Message and message part storage with full content
- Tool execution logging with timing and results
- Token usage tracking (input, output, cache, reasoning)
- Cost estimation
- Full-text search on session titles and message text

## Installation

Add the plugin to your `opencode.json` configuration:

```json
{
  "plugin": ["opencode-database-plugin"]
}
```

The plugin will be automatically installed at startup.

## Configuration

Set the `OPENCODE_DATABASE_URL` environment variable:

```bash
OPENCODE_DATABASE_URL=postgres://user:password@host:5432/database
```

Default: `postgres://opencode:opencode@postgres:5432/opencode`

## Database Setup

Run the schema file to create the required tables:

```bash
psql $OPENCODE_DATABASE_URL -f sql/schema.sql
```

## Database Schema

### Tables

| Table             | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `sessions`        | Chat sessions with token counts and cost                   |
| `messages`        | Messages within sessions                                   |
| `message_parts`   | Individual parts of messages (text, reasoning, tool calls) |
| `tool_executions` | Tool execution logs with timing                            |
| `session_errors`  | Session error records                                      |
| `commands`        | Executed slash commands                                    |
| `compactions`     | Context compaction history                                 |

### Views

- `conversation_view` - Aggregated view of messages with reasoning and tools used

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Run unit tests
bun run test

# Run integration tests
bun run test:integration

# Build
bun run build
```

## License

Apache 2.0
