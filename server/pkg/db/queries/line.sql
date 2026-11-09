-- name: RecordLineReplyToken :exec
-- Stores the newest reply token for a LINE chat. Every inbound event with a
-- reply token refreshes it, so a busy group keeps answers free. Only a
-- message addressed to the bot (every 1:1 message, a mention in a group)
-- replaces the quote token, asker and message id that the answer quotes.
-- An older event (redelivery, out-of-order delivery) never overwrites a newer
-- token.
INSERT INTO line_reply_token (
    installation_id, chat_id, reply_token, received_at, quote_token, sender_user_id, message_id
) VALUES (
    @installation_id, @chat_id, @reply_token, @received_at,
    CASE WHEN @addressed::bool THEN @quote_token::text ELSE '' END,
    CASE WHEN @addressed::bool THEN @sender_user_id::text ELSE '' END,
    CASE WHEN @addressed::bool THEN @message_id::text ELSE '' END
)
ON CONFLICT (installation_id, chat_id) DO UPDATE SET
    reply_token    = EXCLUDED.reply_token,
    received_at    = EXCLUDED.received_at,
    quote_token    = CASE WHEN @addressed::bool THEN EXCLUDED.quote_token ELSE line_reply_token.quote_token END,
    sender_user_id = CASE WHEN @addressed::bool THEN EXCLUDED.sender_user_id ELSE line_reply_token.sender_user_id END,
    message_id     = CASE WHEN @addressed::bool THEN EXCLUDED.message_id ELSE line_reply_token.message_id END
WHERE line_reply_token.received_at <= EXCLUDED.received_at;

-- name: TakeLineReplyToken :one
-- Atomically takes the chat's reply token if it was received after
-- @fresh_after, leaving the row (and its quote context) in place. Only one
-- caller across all replicas can take a given token.
UPDATE line_reply_token AS l
SET reply_token = NULL
FROM (
    SELECT t.installation_id, t.chat_id, t.reply_token AS taken
    FROM line_reply_token AS t
    WHERE t.installation_id = @installation_id
      AND t.chat_id = @chat_id
      AND t.reply_token IS NOT NULL
      AND t.received_at > @fresh_after
    FOR UPDATE
) AS old
WHERE l.installation_id = old.installation_id AND l.chat_id = old.chat_id
RETURNING old.taken::text AS reply_token;

-- name: GetLineReplyContext :one
-- The newest addressed message's quote token, asker and message id.
SELECT quote_token, sender_user_id, message_id
FROM line_reply_token
WHERE installation_id = @installation_id AND chat_id = @chat_id;

-- name: DeleteStaleLineReplyTokens :execrows
DELETE FROM line_reply_token WHERE received_at < @older_than;
