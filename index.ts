import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { sql, ensureConnection, fireAndForget, safeQuery } from "./db";
import type postgres from "postgres";

type OpencodeClient = PluginInput["client"];

const STALE_ENTRY_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const pendingExecutions = new Map<
  string,
  {
    correlationId: string;
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    startedAt: Date;
    partId?: string;
  }
>();

const callIdToPartId = new Map<string, string>();

const pendingUserMessages = new Map<
  string,
  {
    parts: unknown[];
    systemPrompt?: string;
    timestamp: number;
  }
>();

const tokensCountedBySession = new Map<string, Map<string, number>>();
const callIdTimestamps = new Map<string, number>();

function cleanupStaleMaps(): void {
  const now = Date.now();

  for (const [key, value] of pendingExecutions) {
    if (now - value.startedAt.getTime() > STALE_ENTRY_TIMEOUT_MS) {
      pendingExecutions.delete(key);
    }
  }

  for (const [key, value] of pendingUserMessages) {
    if (now - value.timestamp > STALE_ENTRY_TIMEOUT_MS) {
      pendingUserMessages.delete(key);
    }
  }

  for (const [key, timestamp] of callIdTimestamps) {
    if (now - timestamp > STALE_ENTRY_TIMEOUT_MS) {
      callIdToPartId.delete(key);
      callIdTimestamps.delete(key);
    }
  }

  for (const [sessionId, messageTimestamps] of tokensCountedBySession) {
    for (const [messageId, timestamp] of messageTimestamps) {
      if (now - timestamp > STALE_ENTRY_TIMEOUT_MS) {
        messageTimestamps.delete(messageId);
      }
    }
    if (messageTimestamps.size === 0) {
      tokensCountedBySession.delete(sessionId);
    }
  }
}

const cleanupInterval = setInterval(cleanupStaleMaps, CLEANUP_INTERVAL_MS);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export interface SessionInfo {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  directory?: string;
  share?: { url?: string };
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: string;
  model?: { providerID?: string; modelID?: string };
  providerID?: string;
  modelID?: string;
  parts?: Array<{ type: string; text?: string }>;
  summary?: { title?: string };
  system?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface PartInfo {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  tool?: string;
  text?: string;
  callID?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    metadata?: Record<string, unknown>;
    error?: string;
    time?: {
      start?: number;
      end?: number;
    };
  };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

function logError(
  client: OpencodeClient,
  message: string,
  extra: Record<string, unknown>
): void {
  Promise.resolve(
    client.app.log({
      body: {
        service: "database",
        level: "error",
        message,
        extra,
      },
    })
  ).catch(() => {});
}

export const DatabasePlugin: Plugin = async ({ client }) => {
  const connected = await ensureConnection();

  if (!connected) {
    await client.app.log({
      body: {
        service: "database",
        level: "warn",
        message: "Plugin disabled - no database connection",
      },
    });
    return {};
  }

  return {
    event: async ({ event }) => {
      const props = event.properties as Record<string, unknown>;

      try {
        switch (event.type) {
          case "session.created": {
            const info = props.info as SessionInfo;

            fireAndForget(
              () => sql`
              INSERT INTO sessions (id, title, parent_id, project_id, directory, status, created_at)
              VALUES (
                ${info.id},
                ${info.title || null},
                ${info.parentID || null},
                ${info.projectID || null},
                ${info.directory || null},
                'created',
                NOW()
              )
              ON CONFLICT (id) DO UPDATE SET
                title = COALESCE(${info.title || null}, sessions.title),
                parent_id = COALESCE(${info.parentID || null}, sessions.parent_id),
                project_id = COALESCE(${info.projectID || null}, sessions.project_id),
                directory = COALESCE(${info.directory || null}, sessions.directory)
            `,
              (error) =>
                logError(client, "Error in session.created", {
                  error: String(error),
                })
            );
            break;
          }

          case "session.updated": {
            const info = props.info as SessionInfo;
            fireAndForget(
              () => sql`
              UPDATE sessions
              SET title = COALESCE(${info.title || null}, title),
                  share_url = COALESCE(${info.share?.url || null}, share_url)
              WHERE id = ${info.id}
            `,
              (error) =>
                logError(client, "Error in session.updated", {
                  error: String(error),
                })
            );
            break;
          }

          case "session.deleted": {
            const info = props.info as SessionInfo;
            fireAndForget(
              () => sql`
              UPDATE sessions
              SET deleted_at = NOW(), status = 'deleted'
              WHERE id = ${info.id}
            `,
              (error) =>
                logError(client, "Error in session.deleted", {
                  error: String(error),
                })
            );
            tokensCountedBySession.delete(info.id);
            break;
          }

          case "session.idle": {
            const sessionID = props.sessionID as string;
            fireAndForget(
              () => sql`
              UPDATE sessions
              SET status = 'idle', updated_at = NOW()
              WHERE id = ${sessionID}
            `,
              (error) =>
                logError(client, "Error in session.idle", {
                  error: String(error),
                })
            );
            break;
          }

          case "session.error": {
            const sessionID = props.sessionID as string | undefined;
            const error = props.error as
              | { name?: string; data?: { message?: string } }
              | undefined;
            if (sessionID) {
              fireAndForget(async () => {
                await sql`
                INSERT INTO session_errors (session_id, error_type, error_message, error_data)
                VALUES (
                  ${sessionID},
                  ${error?.name || "unknown"},
                  ${error?.data?.message || null},
                  ${error ? sql.json(error as postgres.JSONValue) : null}
                )
              `;
                await sql`
                UPDATE sessions SET status = 'error' WHERE id = ${sessionID}
              `;
              });
            }
            break;
          }

          case "session.compacted": {
            const sessionID = props.sessionID as string;

            try {
              const result = await safeQuery(
                () => sql<
                  Array<{
                    context_tokens: number | null;
                    input_tokens: number | null;
                    output_tokens: number | null;
                    cache_read_tokens: number | null;
                    cache_write_tokens: number | null;
                    reasoning_tokens: number | null;
                    estimated_cost: string | null;
                  }>
                >`
                SELECT context_tokens, input_tokens, output_tokens,
                       cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost
                FROM sessions WHERE id = ${sessionID}
              `
              );

              const sessionState = result?.[0];

              if (sessionState) {
                fireAndForget(
                  () => sql`
                  INSERT INTO compactions (
                    session_id,
                    context_tokens_before,
                    cumulative_input_tokens,
                    cumulative_output_tokens,
                    cumulative_cache_read,
                    cumulative_cache_write,
                    cumulative_reasoning,
                    cumulative_cost
                  )
                  VALUES (
                    ${sessionID},
                    ${sessionState.context_tokens || 0},
                    ${sessionState.input_tokens || 0},
                    ${sessionState.output_tokens || 0},
                    ${sessionState.cache_read_tokens || 0},
                    ${sessionState.cache_write_tokens || 0},
                    ${sessionState.reasoning_tokens || 0},
                    ${parseFloat(sessionState.estimated_cost || "0")}
                  )
                `
                );
              }

              fireAndForget(
                () => sql`
                UPDATE sessions
                SET
                  status = 'compacted',
                  peak_context_tokens = GREATEST(peak_context_tokens, context_tokens),
                  context_tokens = 0,
                  compaction_count = compaction_count + 1
                WHERE id = ${sessionID}
              `
              );
            } catch {}

            tokensCountedBySession.delete(sessionID);
            break;
          }

          case "message.updated": {
            const info = props.info as MessageInfo;

            fireAndForget(
              () => sql`
              INSERT INTO sessions (id, status, created_at, updated_at)
              VALUES (${info.sessionID}, 'active', NOW(), NOW())
              ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
            `
            );

            let messageContent:
              | Array<{ type: string; text?: string }>
              | undefined = info.parts;
            let textContent: string | null = null;
            let systemPrompt: string | null = info.system || null;

            if (info.role === "user") {
              const pending = pendingUserMessages.get(info.sessionID);
              if (pending) {
                if (!messageContent) {
                  messageContent = pending.parts as Array<{
                    type: string;
                    text?: string;
                  }>;
                  textContent =
                    messageContent
                      .filter((p) => p.type === "text" && p.text)
                      .map((p) => p.text)
                      .join("\n") || null;
                }
                if (!systemPrompt && pending.systemPrompt) {
                  systemPrompt = pending.systemPrompt;
                }
                pendingUserMessages.delete(info.sessionID);
              }
            }

            const modelProvider =
              info.providerID || info.model?.providerID || null;
            const modelId = info.modelID || info.model?.modelID || null;

            fireAndForget(
              () => sql`
              INSERT INTO messages (id, session_id, role, model_provider, model_id, text, summary, content, system_prompt, created_at)
              VALUES (
                ${info.id},
                ${info.sessionID},
                ${info.role},
                ${modelProvider},
                ${modelId},
                ${textContent},
                ${info.summary?.title || null},
                ${messageContent ? sql.json(messageContent as postgres.JSONValue) : null},
                ${systemPrompt},
                NOW()
              )
              ON CONFLICT (id) DO UPDATE SET
                role = ${info.role},
                model_provider = COALESCE(EXCLUDED.model_provider, messages.model_provider),
                model_id = COALESCE(EXCLUDED.model_id, messages.model_id),
                text = COALESCE(${textContent}, messages.text),
                summary = COALESCE(${info.summary?.title || null}, messages.summary),
                content = COALESCE(${messageContent ? sql.json(messageContent as postgres.JSONValue) : null}, messages.content),
                system_prompt = COALESCE(${systemPrompt}, messages.system_prompt)
            `,
              (error) =>
                logError(client, "Error in message.updated", {
                  error: String(error),
                })
            );

            const sessionTokens =
              tokensCountedBySession.get(info.sessionID) || new Map<string, number>();
            if (
              info.role === "assistant" &&
              info.tokens &&
              !sessionTokens.has(info.id)
            ) {
              const inputTokens = info.tokens.input ?? 0;
              const outputTokens = info.tokens.output ?? 0;
              const reasoningTokens = info.tokens.reasoning ?? 0;
              const cacheRead = info.tokens.cache?.read ?? 0;
              const cacheWrite = info.tokens.cache?.write ?? 0;

              if (inputTokens > 0 || outputTokens > 0) {
                sessionTokens.set(info.id, Date.now());
                tokensCountedBySession.set(info.sessionID, sessionTokens);

                const contextSize = inputTokens + cacheRead;

                fireAndForget(
                  () => sql`
                  UPDATE sessions
                  SET
                    input_tokens = input_tokens + ${inputTokens},
                    output_tokens = output_tokens + ${outputTokens},
                    reasoning_tokens = reasoning_tokens + ${reasoningTokens},
                    cache_read_tokens = cache_read_tokens + ${cacheRead},
                    cache_write_tokens = cache_write_tokens + ${cacheWrite},
                    context_tokens = ${contextSize},
                    peak_context_tokens = GREATEST(peak_context_tokens, ${contextSize}),
                    model_provider = COALESCE(${modelProvider}, model_provider),
                    model_id = COALESCE(${modelId}, model_id)
                  WHERE id = ${info.sessionID}
                `,
                  (error) =>
                    logError(client, "Error updating session tokens", {
                      error: String(error),
                    })
                );
              }
            }
            break;
          }

          case "message.removed": {
            const messageID = props.messageID as string;
            fireAndForget(
              () => sql`
              DELETE FROM messages WHERE id = ${messageID}
            `
            );
            break;
          }

          case "message.part.updated": {
            const part = props.part as PartInfo;
            const toolName = part.type === "tool" ? part.tool || null : null;
            const textContent = part.text || null;

            if (part.type === "tool" && part.callID) {
              callIdToPartId.set(part.callID, part.id);
              callIdTimestamps.set(part.callID, Date.now());
              const pending = pendingExecutions.get(part.callID);
              if (pending) {
                pending.partId = part.id;
              }
            }

            if (part.type === "step-finish" && part.cost !== undefined) {
              const cost = part.cost;
              fireAndForget(
                () => sql`
                UPDATE sessions
                SET estimated_cost = estimated_cost + ${cost}
                WHERE id = ${part.sessionID}
              `
              );
            }

            fireAndForget(
              () => sql`
              INSERT INTO messages (id, session_id, role, created_at)
              VALUES (${part.messageID}, ${part.sessionID}, 'assistant', NOW())
              ON CONFLICT (id) DO UPDATE SET
                role = COALESCE(messages.role, 'assistant')
            `
            );

            fireAndForget(
              () => sql`
              INSERT INTO sessions (id, status, created_at)
              VALUES (${part.sessionID}, 'active', NOW())
              ON CONFLICT (id) DO NOTHING
            `
            );

            const isStreamingTextPart =
              part.type === "text" || part.type === "reasoning";
            const partAsJson = { ...part };

            if (isStreamingTextPart) {
              fireAndForget(async () => {
                await sql`
                  INSERT INTO message_parts (id, message_id, part_type, tool_name, text, content, created_at)
                  VALUES (
                    ${part.id},
                    ${part.messageID},
                    ${part.type},
                    ${toolName},
                    ${textContent},
                    ${sql.json(partAsJson as postgres.JSONValue)},
                    NOW()
                  )
                  ON CONFLICT (id) DO NOTHING
                `;

                if (textContent) {
                  await sql`
                    UPDATE message_parts
                    SET
                      tool_name = COALESCE(${toolName}, tool_name),
                      text = ${textContent},
                      content = ${sql.json(partAsJson as postgres.JSONValue)}
                    WHERE id = ${part.id}
                      AND (text IS NULL OR LENGTH(text) < LENGTH(${textContent}))
                  `;
                }
              });
            } else {
              const statusPriority: Record<string, number> = {
                pending: 1,
                running: 2,
                completed: 3,
                error: 3,
              };
              const currentStatus = part.state?.status || "pending";
              const currentPriority = statusPriority[currentStatus] || 0;

              fireAndForget(async () => {
                await sql`
                  INSERT INTO message_parts (id, message_id, part_type, tool_name, text, content, created_at)
                  VALUES (
                    ${part.id},
                    ${part.messageID},
                    ${part.type},
                    ${toolName},
                    ${textContent},
                    ${sql.json(partAsJson as postgres.JSONValue)},
                    NOW()
                  )
                  ON CONFLICT (id) DO NOTHING
                `;

                await sql`
                  UPDATE message_parts
                  SET
                    tool_name = COALESCE(${toolName}, tool_name),
                    text = COALESCE(${textContent}, text),
                    content = ${sql.json(partAsJson as postgres.JSONValue)}
                  WHERE id = ${part.id}
                    AND ${currentPriority} >= COALESCE(
                      CASE (content->'state'->>'status')
                        WHEN 'pending' THEN 1
                        WHEN 'running' THEN 2
                        WHEN 'completed' THEN 3
                        WHEN 'error' THEN 3
                        ELSE 0
                      END, 0
                    )
                `;
              });
            }

            if (part.type === "text" && textContent) {
              fireAndForget(
                () => sql`
                UPDATE messages
                SET text = ${textContent}
                WHERE id = ${part.messageID}
                  AND (text IS NULL OR LENGTH(text) < LENGTH(${textContent}))
              `
              );
            }
            break;
          }

          case "message.part.removed": {
            const partID = props.partID as string;
            fireAndForget(
              () => sql`
              DELETE FROM message_parts WHERE id = ${partID}
            `
            );
            break;
          }

          case "command.executed": {
            const name = props.name as string;
            const sessionID = props.sessionID as string;
            const args = props.arguments as string | undefined;
            fireAndForget(
              () => sql`
              INSERT INTO commands (session_id, command_name, command_args, created_at)
              VALUES (
                ${sessionID},
                ${name},
                ${args || null},
                NOW()
              )
            `
            );
            break;
          }
        }
      } catch (error) {
        logError(client, "Error recording event", {
          eventType: event.type,
          error: String(error),
        });
      }
    },

    "chat.message": async (input, output) => {
      try {
        fireAndForget(
          () => sql`
          UPDATE sessions SET status = 'active', updated_at = NOW()
          WHERE id = ${input.sessionID}
        `
        );

        const systemPrompt = (output.message as { system?: string })?.system;
        if (output.parts && output.parts.length > 0) {
          pendingUserMessages.set(input.sessionID, {
            parts: output.parts,
            systemPrompt,
            timestamp: Date.now(),
          });
        } else if (systemPrompt) {
          pendingUserMessages.set(input.sessionID, {
            parts: [],
            systemPrompt,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        logError(client, "Error in chat.message", { error: String(error) });
      }
    },

    "tool.execute.before": async (input, output) => {
      try {
        const correlationId = generateCorrelationId();
        const startedAt = new Date();

        pendingExecutions.set(input.callID, {
          correlationId,
          sessionId: input.sessionID,
          toolName: input.tool,
          args: output.args || {},
          startedAt,
        });

        fireAndForget(
          () => sql`
          INSERT INTO tool_executions (
            correlation_id,
            session_id,
            tool_name,
            args,
            started_at,
            created_at
          )
          VALUES (
            ${correlationId},
            ${input.sessionID},
            ${input.tool},
            ${output.args ?? null},
            ${startedAt},
            NOW()
          )
        `,
          (error) =>
            logError(client, "Error recording tool start", {
              error: String(error),
            })
        );
      } catch (error) {
        logError(client, "Error in tool.execute.before", {
          error: String(error),
        });
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const completedAt = new Date();
        const pending = pendingExecutions.get(input.callID);
        const partId =
          pending?.partId || callIdToPartId.get(input.callID) || null;

        if (pending) {
          const durationMs =
            completedAt.getTime() - pending.startedAt.getTime();

          fireAndForget(async () => {
            await sql`
              UPDATE tool_executions
              SET
                result = ${output.output ?? null},
                completed_at = ${completedAt},
                duration_ms = ${durationMs},
                success = true
              WHERE correlation_id = ${pending.correlationId}
            `;

            if (partId && output.output) {
              const outputJson = JSON.stringify(output.output);
              await sql`
                UPDATE message_parts
                SET content = jsonb_set(
                  COALESCE(content, '{"state":{}}'::jsonb),
                  '{state,output}',
                  ${outputJson}::jsonb
                )
                WHERE id = ${partId}
                  AND (content->'state'->>'output') IS NULL
              `;
            }
          });

          pendingExecutions.delete(input.callID);
        } else {
          fireAndForget(async () => {
            await sql`
              INSERT INTO tool_executions (
                correlation_id,
                session_id,
                tool_name,
                args,
                result,
                completed_at,
                success,
                created_at
              )
              VALUES (
                ${generateCorrelationId()},
                ${input.sessionID},
                ${input.tool},
                ${output.metadata ?? null},
                ${output.output ?? null},
                ${completedAt},
                true,
                NOW()
              )
            `;

            if (partId && output.output) {
              const outputJson = JSON.stringify(output.output);
              await sql`
                UPDATE message_parts
                SET content = jsonb_set(
                  COALESCE(content, '{"state":{}}'::jsonb),
                  '{state,output}',
                  ${outputJson}::jsonb
                )
                WHERE id = ${partId}
                  AND (content->'state'->>'output') IS NULL
              `;
            }
          });
        }

        callIdToPartId.delete(input.callID);
        callIdTimestamps.delete(input.callID);
      } catch (error) {
        pendingExecutions.delete(input.callID);
        callIdToPartId.delete(input.callID);
        callIdTimestamps.delete(input.callID);

        logError(client, "Error recording tool completion", {
          error: String(error),
        });
      }
    },
  };
};
