CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_line_reply_token_chat ON line_reply_token (installation_id, chat_id);
