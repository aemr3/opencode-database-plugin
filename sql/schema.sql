CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    project_id TEXT,
    parent_id TEXT,
    directory TEXT,
    title TEXT,
    status TEXT,
    model_provider TEXT,
    model_id TEXT,
    share_url TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    context_tokens INTEGER DEFAULT 0,
    peak_context_tokens INTEGER DEFAULT 0,
    estimated_cost NUMERIC(10, 6) DEFAULT 0,
    compaction_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    model_provider TEXT,
    model_id TEXT,
    text TEXT,
    summary TEXT,
    content JSONB,
    system_prompt TEXT
);

CREATE TABLE IF NOT EXISTS message_parts (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    part_type TEXT NOT NULL,
    tool_name TEXT,
    text TEXT,
    content JSONB
);

CREATE TABLE IF NOT EXISTS tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    correlation_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args JSONB,
    result JSONB,
    duration_ms INTEGER,
    success BOOLEAN,
    error TEXT
);

CREATE TABLE IF NOT EXISTS session_errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    error_type TEXT,
    error_message TEXT,
    error_data JSONB
);

CREATE TABLE IF NOT EXISTS commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    command_name TEXT NOT NULL,
    command_args TEXT
);

CREATE TABLE IF NOT EXISTS compactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    context_tokens_before INTEGER NOT NULL DEFAULT 0,
    cumulative_input_tokens INTEGER NOT NULL DEFAULT 0,
    cumulative_output_tokens INTEGER NOT NULL DEFAULT 0,
    cumulative_cache_read INTEGER NOT NULL DEFAULT 0,
    cumulative_cache_write INTEGER NOT NULL DEFAULT 0,
    cumulative_reasoning INTEGER NOT NULL DEFAULT 0,
    cumulative_cost NUMERIC(10, 6) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_parts_message_id ON message_parts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_parts_part_type ON message_parts(part_type);
CREATE INDEX IF NOT EXISTS idx_message_parts_tool_name ON message_parts(tool_name);

CREATE INDEX IF NOT EXISTS idx_tool_executions_session_id ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_correlation_id ON tool_executions(correlation_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool_name ON tool_executions(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_executions_started_at ON tool_executions(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_errors_session_id ON session_errors(session_id);

CREATE INDEX IF NOT EXISTS idx_commands_session_id ON commands(session_id);
CREATE INDEX IF NOT EXISTS idx_commands_command_name ON commands(command_name);

CREATE INDEX IF NOT EXISTS idx_compactions_session_id ON compactions(session_id);
CREATE INDEX IF NOT EXISTS idx_compactions_created_at ON compactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_title_fts
  ON sessions USING GIN (to_tsvector('english', COALESCE(title, '')));
CREATE INDEX IF NOT EXISTS idx_messages_text_fts
  ON messages USING GIN (to_tsvector('english', COALESCE(text, '')));

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_message_parts_updated_at ON message_parts;
CREATE TRIGGER update_message_parts_updated_at
    BEFORE UPDATE ON message_parts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tool_executions_updated_at ON tool_executions;
CREATE TRIGGER update_tool_executions_updated_at
    BEFORE UPDATE ON tool_executions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_session_errors_updated_at ON session_errors;
CREATE TRIGGER update_session_errors_updated_at
    BEFORE UPDATE ON session_errors
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_commands_updated_at ON commands;
CREATE TRIGGER update_commands_updated_at
    BEFORE UPDATE ON commands
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE VIEW conversation_view AS
SELECT
    m.id as message_id,
    m.session_id,
    m.role,
    m.model_provider,
    m.model_id,
    m.created_at,
    m.text,
    m.summary,
    COALESCE(
        string_agg(
            CASE WHEN mp.part_type = 'reasoning' THEN mp.text END,
            E'\n'
        ),
        ''
    ) as reasoning,
    array_agg(DISTINCT mp.tool_name) FILTER (WHERE mp.tool_name IS NOT NULL) as tools_used
FROM messages m
LEFT JOIN message_parts mp ON m.id = mp.message_id
GROUP BY m.id, m.session_id, m.role, m.model_provider, m.model_id, m.created_at, m.text, m.summary
ORDER BY m.created_at;
