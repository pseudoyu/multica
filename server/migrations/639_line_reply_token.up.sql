-- LINE's reply API is free but needs the reply token of a recent inbound
-- event (usable for about a minute, once). Push costs one message per
-- recipient. Inbound records the newest token per LINE chat here so whichever
-- replica answers can spend it: taking it is one atomic UPDATE, so only one
-- sender ever uses a token. quote_token, sender_user_id and message_id belong
-- to the newest message addressed to the bot (every 1:1 message, mentions in
-- groups) and let the answer quote the question and mention the asker.
--
-- No foreign keys (repository rule). Rows older than an hour are useless and
-- are purged by the LINE outbound's maintenance loop.
CREATE TABLE IF NOT EXISTS line_reply_token (
    installation_id UUID NOT NULL,
    chat_id         TEXT NOT NULL,
    reply_token     TEXT,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    quote_token     TEXT NOT NULL DEFAULT '',
    sender_user_id  TEXT NOT NULL DEFAULT '',
    message_id      TEXT NOT NULL DEFAULT ''
);
