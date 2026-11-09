# LINE channel integration: research and design

Status: proposal, not implemented. Written 2026-11-09 against `upstream/main`
at `78dd3a2ae`. LINE facts were read from developers.line.biz on 2026-11-09;
LINE pages carry no "last updated" date, so each fact cites the page it came
from and the read date stands in for it.

## Summary

LINE fits the existing channel engine with one structural difference: every
current channel dials out (Telegram long polling, Slack Socket Mode, DingTalk
stream, Lark and WeCom WebSockets), while LINE only delivers webhooks. The
adapter therefore receives on an HTTP route, modelled on the VCS webhook
(`/api/webhooks/vcs/{connectionId}`), and calls the shared `Router.Handle`
directly; it registers no supervisor `Factory`.

Everything after inbound normalization is reused: installations, user binding,
chat-session routing, dedup, `/new` and `/issue`, the media pipeline and
`channel_reply_delivery` ownership. LINE-specific work is signature checks,
the reply-or-push choice, streaming degradation (LINE cannot edit a sent
message), plain-text rendering and cost control.

Recommended shape:

- An admin pastes the LINE channel ID and channel secret. Multica mints
  15-minute stateless access tokens from them, so no long-lived token is stored.
- One webhook URL per installation, set on LINE automatically at install time.
- No live streaming. 1:1 chats show LINE's loading animation until the answer
  is ready; the answer arrives as one request of at most five text bubbles.
- The answer uses the free reply API when a reply token from that chat is
  under 50 seconds old, otherwise a push with a deterministic
  `X-Line-Retry-Key`, which makes push retries safe across replicas.
- Groups are addressed by @mention only, the answer quotes the question, and
  in groups a run still going after 45 seconds spends the expiring reply token
  on a free "still working" notice.

## 1. How channels work today

Telegram (`server/internal/integrations/telegram`, upstream #6944, MUL-6166,
community-maintained) is the closest template and the one this design is
compared against.

| Concern | Today (Telegram, shared engine) | Where |
|---|---|---|
| Adapter contract | `channel.Channel` (Connect / Disconnect / Send / Capabilities) plus an `engine.ResolverSet` (installation, identity, dedup, session, media, audit, replier, typing) | `integrations/channel/channel.go`, `channel/engine/resolvers.go` |
| Transport | `getUpdates` long polling, one loop per installation, run by `engine.Supervisor` under a DB lease (one consumer across replicas) | `telegram/telegram_channel.go`, `channel/engine/supervisor.go` |
| Install | Admin pastes a BotFather token; the server verifies it live (`getMe`) and stores it encrypted | `telegram/install.go`, `handler/telegram.go` |
| Credentials at rest | `channel_installation.config` JSONB, token sealed with secretbox under `MULTICA_TELEGRAM_SECRET_KEY`; integration disabled when the key is unset | `cmd/server/router.go` (Telegram block) |
| Bot-to-agent mapping | One bot = one agent; unique `(channel_type, config->>'app_id')` and `(workspace_id, agent_id, channel_type)` | migration `124_channel_generalization` |
| Identity | An unbound sender gets a one-time 15-minute link to `/telegram/bind`; redeeming binds the Telegram user id to the logged-in member | `telegram/binding.go`, `channel_binding_token` |
| Groups | Addressed only by @mention or a reply to the bot; recent group messages are inlined from an in-memory buffer on mention | `telegram/inbound.go`, `telegram/recent_context.go` |
| Dedup | `(installation, message_id)` claim/mark/release | `telegram/resolvers.go` |
| Commands | `/new`, `/clear`, `/issue` parsed once in the Router for every platform | `channel/engine/router.go` |
| Streaming | Placeholder `…`, then throttled `editMessageText` every 2.5 s, final edit on `chat:done` | `telegram/outbound.go` |
| Delivery ownership | `channel_reply_delivery`: one row per user turn, a 30 s lease, `send_state` none / in_flight / known / unknown; an unknown send is never retried because Telegram has no idempotency key | `telegram/delivery.go`, migration `502` |
| Long replies | Markdown to Telegram HTML, chunks of 3,500 UTF-16 units | `telegram/sender.go`, `telegram/markdown.go` |
| Typing | `sendChatAction` on ingest | `telegram/resolvers.go` |
| Media | Inbound via `getFile` off the ACK path into object storage; outbound attachments uploaded as bytes | `telegram/media_ingest.go`, `telegram/outbound_media.go` |
| Copy | English, hard-coded; reasoning recorded in `sender.go` (MUL-6509) | `telegram/replier.go` |
| `/issue` origin | `issue.origin_type = 'telegram_chat'`, widened by a NOT VALID + VALIDATE migration pair | migrations `366`, `367` |
| UI | Agent integrations tab, settings tab, `/telegram/bind` page, core queries/types/zod schemas | `packages/views/settings/components/telegram-tab.tsx`, `packages/views/telegram/`, `packages/core/telegram/` |
| Docs | `telegram-bot-integration` in six locales, `channels`, `environment-variables`, `community-maintained` | `apps/docs/content/docs/` |

How Telegram work reached upstream: maintainers merged the adapter; later
changes (recent group context, media, quoted files, Codex streaming #10100)
were each built in a worktree off `upstream/main`, pushed to the
`pseudoyu/multica` fork and opened against `multica-ai/multica`. This design
sits on branch `docs/line-integration-design` cut the same way, and LINE
implementation PRs would follow the same route.

## 2. LINE platform facts

Read 2026-11-09. REF is `https://developers.line.biz/en/reference/messaging-api/`,
DOCS is `https://developers.line.biz/en/docs/messaging-api/`.

| Topic | Fact | Source |
|---|---|---|
| Channel | Created by enabling the Messaging API on a LINE Official Account; user IDs differ per provider; new accounts must connect to Business Manager (since 2025-06-25) | DOCS getting-started/, news 2025-06-25 |
| Tokens | Long-lived (1 per channel, no expiry), short-lived (30 days), v2.1 JWT (up to 30 days, RSA key registration), stateless (15 min, `POST /oauth2/v3/token` with channel ID + secret, unlimited, not revocable) | `/en/docs/basics/channel-access-token/` |
| Webhook body | `destination` (bot user ID), `events[]` (several users per request), each with `webhookEventId` (ULID), `deliveryContext.isRedelivery`, `mode` active/standby, `source` user/group/room | REF#webhooks |
| Empty check | Console "Verify" and connection checks send `events: []`; answer 200 | DOCS verify-webhook-signature/ |
| Deadline | No response within 2 s counts as `request_timeout`; process asynchronously | DOCS check-webhook-error-statistics/ |
| Redelivery | Off by default; on non-2xx it retries an undisclosed number of times; dedup by `webhookEventId`; order not guaranteed | DOCS receiving-messages/ |
| IP allowlist | None published; LINE says verify signatures instead | DOCS receiving-messages/ |
| Webhook URL | HTTPS with a public CA certificate, at most 500 chars; settable by API `PUT /v2/bot/channel/webhook/endpoint`, testable by `POST /v2/bot/channel/webhook/test` (60/h) | REF#set-webhook-endpoint-url |
| Signature | `x-line-signature` = Base64(HMAC-SHA256(channel secret, raw body)); verify before parsing; the Go sample uses `hmac.Equal` | DOCS verify-webhook-signature/ |
| Reply | Token single-use, use within one minute (not guaranteed); redelivered events carry the same token, usable one minute after redelivery and never after 20 minutes; at most 5 messages; free | REF#send-reply-message |
| Push | To a user, group or room; also to non-friends who messaged 1:1 in the last 7 days; at most 5 messages; blocked users return 200 but receive nothing | REF#send-push-message |
| Retry key | `X-Line-Retry-Key` (UUID) on push/multicast/narrowcast/broadcast only; kept 24 h; a repeat returns 409 with `X-Line-Accepted-Request-Id` and, for push, the original `sentMessages` | DOCS retrying-api-request/ |
| Billing unit | One message per recipient per request, regardless of how many bubbles. A push of 4 bubbles to a 5-person group counts 5. Reply does not count. Over quota: 429 "You have reached your monthly limit." | DOCS pricing/ |
| Japan plans | Communication ¥0 / 200 free, no overage; Light ¥5,000 / 5,000, no overage; Standard ¥15,000 / 30,000, overage ¥3.0 then ¥2.5 (since 2026-10-01) | lycbiz.com/jp/service/line-official-account/plan/ |
| Taiwan plans (2026-11-01) | 200 free / 3,000 (NT$1,000) / 6,000 (NT$1,400, overage NT$0.2 then 0.15) | tw.linebiz.com/column/LINEOA-2026-Price-Plan/ |
| Thailand plans | 300 free / 15,000 (฿1,280) / 35,000 (฿1,780) | lineforbusiness.com/th/service/line-oa-features/broadcast-message |
| Quota | `GET /v2/bot/message/quota`, `GET /v2/bot/message/quota/consumption` (approximate) | REF#get-quota |
| Loading animation | `POST /v2/bot/chat/loading/start {chatId, loadingSeconds 5..60 step 5}`; 1:1 only (group IDs return 400); shown only while the chat is open; cleared by the bot's next message; a new call resets the timer | DOCS use-loading-indicator/ |
| Text | 5,000 UTF-16 code units per text message; no Markdown (styling needs Flex) | REF#text-message, DOCS text-character-count/ |
| textV2 | `{key}` placeholders with `mention` substitutions (max 20), reply or push into groups and rooms only | REF#text-message-v2 |
| Quote | `quoteToken` on received text/sticker/image/video and on `sentMessages`; never expires; same chat only; text, textV2, sticker | DOCS get-quote-tokens/ |
| Flex | `altText` up to 1,500 chars; bubble 30 KB; carousel 50 KB and 12 bubbles; request 2 MB | REF#flex-message |
| Quick reply | Up to 13 buttons on the last message; iOS and Android only | DOCS using-quick-reply/ |
| Groups | Joining needs "Allow bot to join group chats" (off by default); the bot receives every group message; a mention of the bot has `mention.mentionees[].isSelf = true` with UTF-16 `index`/`length`; `userId` is present only for consenting users; member ID listing needs a verified or premium account | DOCS group-chats/ |
| Edited messages | `messageEdited` event, groups only, new reply and quote token, same message ID (2026-08-12) | REF#webhook-event-objects, news 2026-08-12 |
| Content | `GET https://api-data.line.me/v2/bot/message/{id}/content` when `contentProvider.type = line`; video/audio may return 202 until `…/content/transcoding` succeeds; retention unspecified, download immediately | REF#get-content |
| Sending media | Image: HTTPS URL ≤ 2,000 chars, JPEG/PNG, original ≤ 10 MB, preview ≤ 1 MB; video mp4 ≤ 200 MB; audio mp3/m4a ≤ 200 MB. Bots cannot send files | REF#image-message, DOCS message-types/ |
| Editing | No API edits or unsends a sent message (none in the reference) | REF (endpoint list) |
| Account link | `POST /v2/bot/user/{userId}/linkToken` (single use, 10 min) + nonce + `accountLink` event | DOCS linking-accounts/ |
| Rate limits | Reply, push, content and most others 2,000 req/s; loading 100 req/s; webhook test 60/h; token bucket per channel, 429 | REF#rate-limits |
| Auto replies | Greeting and auto-reply messages are on by default in LINE Official Account Manager; turn them off for API bots | DOCS building-bot/ |

## 3. Reference implementations

Read from source on 2026-11-09 (shallow clones, nothing built or run).
Multica is Apache-2.0 plus the Part I conditions in `LICENSE`, so MIT and
Apache-2.0 code may be adapted with attribution; AGPL, BSL and
community-license code is read for patterns only.

| Project | License | LINE code (commit) | Reply / push | Long replies | Groups | Verdict |
|---|---|---|---|---|---|---|
| openclaw/openclaw | MIT | `extensions/line/src/` @ `3e4e201e` | Reply first; push only after a definite 4xx; one retry key per push, 409 = success | Markdown to text + Flex for tables/code; split at 5,000 UTF-16; batches of 5; loading 20 s refreshed every 18 s | `isSelf` or `type: all`; mention span removed by UTF-16 offsets; mention required by default; separate DM and group allowlists | Main reference |
| NousResearch/hermes-agent | MIT | `plugins/platforms/line/adapter.py` @ `6cff782b` | Token stored per chat with a 50 s TTL; push on any reply error | Strip Markdown, 4,500 code points, 5 messages, "…"; 60 s loading; at 45 s a postback "get answer" button | Allowlists only, no mention gate | Ideas worth taking, details not |
| earendil-works/pi (formerly badlogic/pi-mono) | MIT | none @ `bd0d815c` | | | | No LINE support (grep; only Discord plugin; the Slack "mom" bot was removed 2026-04-30; pi-chat has Telegram and Discord only) |
| line/line-bot-sdk-go v8.23.0 | Apache-2.0 | `linebot/webhook`, `linebot/messaging_api` @ `4ceb06bf` | Building blocks | | `IsSelf` modelled | See below |
| infiniflow/ragflow | Apache-2.0 | `internal/channels/line.go` @ `ed5a84fe` | Token kept 2 min (too long), else push | Text only, no split | None | Go shape reference |
| langbot-app/LangBot | Apache-2.0 | `src/langbot/pkg/platform/adapters/line/` @ `219b1af7` | Reply for the first batch, push after | Batches of 5 | `is_self` | Small, clean |
| chatwoot/chatwoot | MIT (non-enterprise) | `app/services/line/*` @ `d262508b` | Push only | No split | Answers group messages in the sender's 1:1 chat | Mostly what to avoid |
| nyaruka/courier | BSL-1.1 | `handlers/line/handler.go` @ `6e15ac73` | Reply, push on "Invalid reply token" | 2,000 chars, batches of 5 | | Patterns only |
| AstrBotDevs/AstrBot | AGPL-3.0 | `astrbot/core/platform/sources/line/` @ `6b10af75` | Reply, push on failure | Drops messages past 5; one push per sentence when streaming | Mentions read | Patterns only |
| lobehub/lobehub | Community License | `apps/server/src/services/bot/platforms/line/` @ `336a71ad` | Push only, on purpose | Final reply only | | Patterns only |

**OpenClaw** is the most complete:

- **Inbound:**
  - It reads the raw body with a 64 KiB limit and a 5 s timeout, then compares
    the HMAC in constant time.
  - It drops `standby` events.
  - It returns 200 only after the events are durably spooled.
  - Its dedup key is `message:<id>`, falling back to `event:<webhookEventId>`.
  - It processes in order, one lane per group, room or user.
- **Its reply rule is the important one:** the answer goes by reply first, and
  falls back to push only on a definite 4xx that is not 408. A timeout or
  network error never falls back, because the reply may already have been
  accepted.
- **Its issue tracker records the failures this design is built around:**
  - #86012: answers lost when the token expired under slow agents.
  - #94626: the race between a reply and the token's expiry.
  - #133576: standby events that were answered.
  - #81628: LINE IDs lowercased on retry; they are case-sensitive.

**Hermes:**

- **Its best idea:** at 45 s it spends the expiring reply token on a postback
  button. Tapping the button yields a fresh, free reply token for the finished
  answer.
- **Its mistakes:**
  - It falls back to push on any reply exception, so a timeout can duplicate.
  - It counts code points rather than UTF-16 units, so emoji-heavy text can
    pass LINE's limit.
  - It has no mention gate. Its open issue #43384 says bots cannot be
    @mentioned, which LINE's `isSelf` field contradicts.

**line-bot-sdk-go** (module `github.com/line/line-bot-sdk-go/v8`, go 1.26, no
third-party dependencies, about 48k generated lines):

- `webhook.ValidateSignature` is correct (`hmac.Equal`).
- Its traps:
  - `ParseRequest` reads an unbounded body and puts the whole body in its
    errors.
  - The default `http.DefaultClient` has no timeout.
  - `WithContext` mutates a shared client.
  - The plain `PushMessage` error hides the difference between 409 and 429.

Telegram and DingTalk hand-roll their small clients. LINE needs about ten
endpoints, so this design follows them: a thin `api.go` and a ten-line
signature check on the standard library. The SDK is not added as a dependency.

**Taken into this design:**

- The reply-first rule and its definite-4xx-only fallback (OpenClaw).
- A deterministic push retry key, with 409 counted as delivered.
- The dedup key `message.id`, else `webhookEventId`.
- Dropping `standby` events.
- Gating groups on `isSelf`, and removing the mention by UTF-16 offsets.
- Plain-text rendering measured in UTF-16 units.
- A per-installation URL with a `destination` check (ragflow, chatwoot,
  lobehub).
- The bot ID taken from `/v2/bot/info`, because the console's "Your user ID"
  is the operator's own ID (lobehub).
- The idea of a slow-answer button (Hermes), offered as decision
  `line-slow-answer`.

**Rejected:**

- Pushing for every answer (lobehub, chatwoot): it loses free fast replies.
- One push per sentence (AstrBot).
- Silently dropping output past five messages.
- Counting `@All` as addressing the bot (OpenClaw does): in Multica it would
  run a billed agent turn on every all-hands ping.

## 4. Design

### 4.1 Architecture

```
LINE Platform                         Multica backend (any replica)
─────────────                         ─────────────────────────────
                POST /api/webhooks/line/{installationId}
 webhook  ────────────────────────▶  line webhook handler
 (signed)                              1. load installation, decrypt secret
                                       2. verify x-line-signature (raw body)
                                       3. parse events, store reply token
                                       4. per event: normalize → Router.Handle
                                       5. 200 (or 500 on infra error)
                                                  │
                                                  ▼
                                      channel engine (shared, unchanged)
                                      dedup · binding · session · /new /issue
                                      media resolver (api-data.line.me)
                                                  │ task queued
                                                  ▼
                                      agent run (daemon) ──▶ event bus
                                                  │ chat:done / task failed
                                                  ▼
 reply / push ◀────────────────────── line outbound
 loading anim                          channel_reply_delivery lease
                                       reply token if fresh, else push + retry key
```

No cycles: inbound ends at the task queue; outbound starts from the event bus.

The webhook handler lives in `server/internal/handler/line_webhook.go`, the
adapter in `server/internal/integrations/line/`. `TypeLine channel.Type =
"line"` is declared in the adapter, as Telegram declares its own type.

No supervisor `Factory` is registered: there is nothing to connect, and the
supervisor already skips installation types without one. Any replica can take a
webhook because `Router.Handle` and every resolver work from the database.

### 4.2 Inbound

**Route.** `POST /api/webhooks/line/{installationId}`, public, beside the other
`/api/webhooks/*` routes. A per-installation URL matches the VCS webhook, finds
the secret without parsing the body first, and returns the same bare 404 for an
unknown ID, a revoked installation or a disabled integration.

**Order of work.**

1. Cap the body at 1 MiB and read it raw.
2. Load the installation, decrypt the channel secret and verify the signature
   with `hmac.Equal` over the raw bytes. On a mismatch, return 401 and count
   the caller's IP in the existing `WebhookIPRateLimiter`, as the autopilot
   webhook does for bad credentials.
3. Check that `destination` equals the installation's stored bot user ID.
4. Answer `events: []` with 200.
5. Handle events in order. Each one gets a deadline of 1.5 s for the whole
   request, because LINE gives up after 2 s.

`Router.Handle` is designed to run on an adapter's ACK path: binding prompts,
media fetches and replies are already detached from it. That is what the
Telegram, Lark and DingTalk adapters do, so LINE can handle events
synchronously and return 200. A `Handle` infrastructure error returns 500, so
LINE redelivers when redelivery is on. The docs tell admins to turn
redelivery on.

`Handle` commits the message durably before returning, which gives the same
guarantee as OpenClaw's spool-then-200 without a second queue. A separate spool
table was rejected because it would duplicate the dedup and session
persistence the engine already does.

**Dedup key.** Message events use `message.id`. This also absorbs the
redelivery of an event whose first attempt timed out after it was committed.
Other events use `webhookEventId`.

**Events in phase 1.**

| LINE event | Handling |
|---|---|
| `message` text | Normalize to `InboundMessage`. In a group, strip the bot's own mention span (UTF-16 `index`/`length`) and keep other mentions as text. |
| `message` image/video/audio/file | Phase 2 (media); phase 1 replies with the unsupported-type notice, as Telegram did before media. |
| `message` sticker, location | Phase 1: unsupported notice in 1:1; ignored in groups unless addressed. |
| `follow` | Reply with the binding prompt if the user is unbound, else a one-line hello. Free (reply token). |
| `join` (group/room) | Reply once with how to address the bot (@mention). Free. |
| `unfollow`, `leave`, `memberJoined`, `memberLeft`, `unsend`, `messageEdited`, `postback`, `membership`, unknown types | Audit at debug level and ignore. LINE adds event types without notice, so an unknown type is never an error. |
| `mode: standby` | Ignore; LINE says a standby channel must not send. |

**Normalization.** Map onto the existing envelope:

- `Source.ChatID` is the `userId`, `groupId` or `roomId`.
- `ChatType` is `p2p` for a user and `group` for both group and room.
- `SenderID` is the `userId`. In groups it is only present for users who
  consented; a missing one becomes an unbound sender and gets the
  "message me 1:1 first" hint.
- `MessageID` is `message.id`.
- `Raw` holds `quoteToken`, `markAsReadToken`, the event type and the reply
  token's receipt time.
- `CommandText` is the cleaned text before any enrichment, as the Router's
  invariant requires.

LINE IDs are case-sensitive and are stored exactly as received.

**Groups.** A message is addressed only when a mention has `isSelf: true`; an
`@All` mention does not count. LINE
delivers all group chatter to the webhook, so unaddressed messages are dropped
before the Router with `not_addressed_in_group`.

A reply-to-bot trigger (Telegram's second rule) needs `quotedMessageId`
matched against IDs the bot sent. It is left for later, as is Telegram's
recent-context buffer: an in-memory buffer only sees the share of a group's
webhooks that land on its own replica, and a database buffer would store every
group message, which is a privacy choice in its own right.

### 4.3 Identity binding

Reuse the shared binding-token flow, with `channel_type = 'line'` and
`channel_user_id` set to the LINE `userId`. An unbound sender gets a reply
holding a one-time 15-minute link to `/line/bind`. The page redeems it through
`POST /api/line/binding/redeem`, which is session-authenticated and not
workspace-scoped, like Telegram's.

LINE's own account-link flow (link token, nonce, `accountLink` event) is not
used. It would add a LINE-only state machine to get the same result: the bind
link is minted for the `userId` that messaged the bot, and redeeming it
requires a logged-in workspace member. LINE user IDs are per provider, but the
binding is per installation anyway.

### 4.4 Outbound

**Choosing reply or push.** Reply is free but its token lasts about a minute;
push costs one message per recipient.

- Inbound stores the newest reply token for each chat binding, with its
  receipt time, in `line_reply_token` (section 5).
- To send, the outbound atomically takes the token:
  `DELETE … WHERE binding_id = $1 AND received_at > now() - interval '50 seconds' RETURNING reply_token`.
  On success it replies; otherwise it pushes. The 50 s margin leaves time for
  the call inside LINE's one-minute window. Taking the token in the database
  means only one replica can use it.
- Any later token from the same chat works too: in a busy group, the next
  message refreshes the token and makes the answer free again.
- Verdict replies (binding prompt, offline notice, `/new` and `/issue`
  confirmations, unsupported type) are sent within the webhook request, so they
  always reply and cost nothing.

**Push idempotency.** Every push carries
`X-Line-Retry-Key = UUIDv5(namespace, turn_id + ":" + part)`. Any replica
retrying the same turn sends the same key. LINE answers a repeat with 409 and
the original `sentMessages`, so the outbound records it as known.

This changes one Telegram rule: a LINE push whose result was lost
(`send_state = unknown`) is retried with backoff for up to 24 hours (LINE keeps
the key that long) instead of being abandoned.

A reply falls back to push only on a definite 4xx other than 408 (expired or
used token), which means LINE did not deliver it. A timeout, network error or
5xx on a reply leaves the outcome unknown. The reply may have been accepted,
and reply takes no retry key, so the turn settles as unknown with the evidence
kept (the existing Telegram rule, and OpenClaw's).

**Streaming fallback.** LINE has no edits, so the channel declares no
`CapMessageEdit` and the outbound ignores `EventTaskMessage` text frames.

- **1:1:** on ingest the typing notifier starts the loading animation
  (`loadingSeconds: 60`) and renews it every 50 s while the turn is unsettled.
  It stops on `OnSettled`, and the bot's own answer clears it. The renewals are
  capped at 30 minutes. They are free and show only while the user has the chat
  open.
- **Groups:** there is no loading animation. If the turn is still running 45 s
  after the triggering message and its reply token is unused, a short
  "Working on it…" reply is sent with it. The token would expire unused
  anyway, so this costs nothing; the answer then goes by push.
- **Streaming chunks are rejected:** sending finished paragraphs as separate
  pushes would cost one billed message per chunk per recipient.

**Rendering.**

- Markdown becomes plain text: emphasis markers are dropped, `[text](url)`
  becomes `text url`, list markers stay, code fences keep their content without
  the backticks, and tables become aligned lines.
- The result is split into bubbles of at most 4,500 UTF-16 units on paragraph,
  then line, then rune boundaries, reusing Telegram's chunker shape.
- One request carries at most 5 bubbles. If the answer needs more, the fifth
  bubble ends with "… continued in Multica:" and a link to the chat. Every
  answer is then exactly one billed message per recipient, which keeps cost
  predictable.
- In groups the first bubble carries the triggering message's `quoteToken`
  and is a `textV2` that opens with a mention of the asker, when their `userId`
  is known. This matches the Lark change that mentions the asker (MUL-7209).

**Failures.**

| Response | Handling |
|---|---|
| 429 with "monthly limit" | Settle the turn with reason `quota_exhausted`, don't retry, log at warn. The answer remains in the Multica chat, and the installations list shows the state (phase 3). |
| Any other 429, or a 5xx | Back off and retry. |
| 400 or 403 | Settle and log. |
| Push to a user who blocked the bot | LINE returns 200, so it counts as delivered. That is acceptable. |

### 4.5 Media (phase 2)

**Inbound.** The existing `MediaResolver` seam runs off the ACK path:

- Fetch `api-data.line.me/v2/bot/message/{id}/content` with the installation's
  token.
- On a 202, poll `…/content/transcoding` for up to 60 s.
- Store the bytes through `storage`.
- When `contentProvider.type = external`, fetch the given URL instead.
- File events carry `fileName` and `fileSize`. Apply the same size ceiling as
  Telegram and send the "couldn't fetch" notice above it.

**Outbound.**

- Images need public HTTPS URLs, so the outbound sends
  `PresignGet(key, 7 days)` as both the original and the preview when the
  image is at most 1 MB. Larger images, and storage without presigning, fall
  back to a text link.
- Bots cannot send files, so other attachments become a link line in the last
  bubble.
- Video and audio are sent as links too in this phase. Native video needs a
  preview image and native audio needs a duration, both of which require
  generating.

### 4.6 Cost control

| Lever | Effect |
|---|---|
| Free reply whenever a token is fresh (≤ 50 s) | Fast answers and all verdict replies cost nothing |
| One request per answer, ≤ 5 bubbles | Each answer costs exactly one message per recipient |
| No chunked streaming, no progress pushes | No hidden multipliers |
| Groups only on @mention | Unaddressed chatter never runs the agent |
| Group ack reuses the expiring token | Feedback at no cost |
| `quota_exhausted` settles without retries | No retry storm against a hard limit |
| Docs warn: a group push costs one message per member; the free Japan plan gives 200 per month | Admins choose a plan knowingly |
| Phase 3: show `quota` and `quota/consumption` on the installation card | Admins see usage without opening LINE Official Account Manager |

### 4.7 LINE compared with Telegram

| Area | Telegram | LINE | Reuse? |
|---|---|---|---|
| Transport | Long polling, supervisor lease | Webhook on any replica, no lease | New: handler + signature |
| Public URL needed | No | Yes, HTTPS with a public CA (`MULTICA_PUBLIC_URL`) | New requirement |
| Credentials | Bot token | Channel ID + channel secret (stateless tokens) | Same secretbox pattern, new key |
| Install check | `getMe` | `GET /v2/bot/info`, then set the webhook endpoint, then `webhook/test` | Same InstallService shape |
| Bot identity / `app_id` | Numeric bot ID | Bot `userId` (= webhook `destination`) | Same unique index |
| User binding | `/telegram/bind` token | `/line/bind` token | Reused flow |
| Dedup | `message_id` | `message.id`, else `webhookEventId` | Reused |
| Group addressing | @mention or reply to bot | `mentionees[].isSelf` (reply-to-bot later) | Same policy, new parser |
| Recent group context | In-memory buffer | Not in v1 | Deferred |
| Typing | `sendChatAction` | Loading animation, 1:1 only, renewed every 50 s | Same `TypingNotifier` seam |
| Streaming | Placeholder + edits every 2.5 s | None; final answer only | Outbound simplified |
| Reply path | `sendMessage` | Reply (free, ≤ 1 min) or push (billed) | New choice logic |
| Idempotency | None; unknown sends abandoned | Push retry key; unknown pushes retried | Delivery row reused, one rule relaxed |
| Message size | 4,096 UTF-16; chunks unbounded | 5,000 UTF-16; ≤ 5 bubbles per request | Chunker reused, new cap |
| Formatting | Markdown to HTML | Markdown to plain text | New renderer |
| Quote | `reply_to_message_id` | `quoteToken` | Same capability bit |
| Mention asker | No | `textV2` mention | New |
| Media in | `getFile` | Content API (+ transcoding poll) | Same resolver seam |
| Media out | Upload bytes | Image by presigned URL; files as links | New |
| Cost | Free | Per recipient per push | New controls |
| `/issue` origin | `telegram_chat` | `line_chat` | Same migration pattern |
| Copy language | English | See decision `line-copy-language` | |

## 5. Configuration, data model and migrations

**Environment.**

| Variable | Purpose |
|---|---|
| `MULTICA_LINE_SECRET_KEY` | 32-byte secretbox key for channel secrets. Integration disabled when unset (install returns 503), like `MULTICA_TELEGRAM_SECRET_KEY`. Must stay fixed; losing it means reconnecting every bot. |
| `MULTICA_PUBLIC_URL` | Existing. Base of the webhook URL. LINE requires HTTPS; install refuses a non-HTTPS base. |

Self-host compose and Helm pass-through follow the Telegram and DingTalk fixes
(#8611, MUL-7533), plus `environment-variables` docs in every locale.

**`channel_installation` row.** `channel_type = 'line'`, with this `config`:

```jsonc
{
  "app_id": "U0123…",            // bot userId from /v2/bot/info; routing + uniqueness
  "channel_id": "1650000000",
  "basic_id": "@123abcde",
  "display_name": "Multica",
  "channel_secret_encrypted": "base64 secretbox",
  "language": "ja"               // see decision line-copy-language
}
```

The stateless access token is minted from `channel_id` and the secret, and
cached in memory per replica until a minute before its 15-minute expiry. It is
never stored.

**Other tables.**

- **Reused unchanged:** `channel_user_binding`, `channel_binding_token`,
  `channel_chat_session_binding`, `channel_reply_delivery`, dedup and audit
  tables (all keyed by `channel_type`).
- **`channel_reply_delivery` fields:** `send_state` keeps its meaning, and the
  only LINE-specific behaviour is retrying `unknown` for push.
  `message_id` stores the last `sentMessages[].id`.

**New migrations.** No foreign keys, and each concurrent index is its own
file.

1. `NNN_issue_origin_line_chat.up.sql`: recreate `issue_origin_type_check`
   with `'line_chat'` added, `NOT VALID`.
2. `NNN+1_issue_origin_line_chat_validate.up.sql`: `VALIDATE CONSTRAINT`.
3. `NNN+2_line_reply_token.up.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS line_reply_token (
       binding_id   UUID NOT NULL,          -- channel_chat_session_binding.id
       reply_token  TEXT NOT NULL,
       received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```
4. `NNN+3_line_reply_token_binding_index.up.sql`:
   `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_line_reply_token_binding ON line_reply_token (binding_id);`

Inbound upserts the newest token (`ON CONFLICT (binding_id) DO UPDATE`). The
outbound deletes it on use. A token older than 50 s is useless, so a periodic
`DELETE … WHERE received_at < now() - interval '1 hour'` in the existing
maintenance jobs keeps the table small. Chat-binding cleanup deletes the row in
application code, as the no-cascade rule requires.

Rollback is the down migrations plus disabling the key. No existing data
changes shape.

## 6. API, UI and docs

**Backend routes**, mirroring Telegram:

| Route | Who |
|---|---|
| `GET /api/workspaces/{id}/line/installations` | members |
| `POST /api/workspaces/{id}/line/install` | admins |
| `DELETE /api/workspaces/{id}/line/installations/{installationId}` | admins |
| `POST /api/line/binding/redeem` | logged-in user |
| `POST /api/webhooks/line/{installationId}` | public, signature-checked |

**Install request.** `{agent_id, channel_id, channel_secret}`. The server:

1. Mints a stateless token. A rejection means a bad credential (400). A
   network failure means unverifiable (502), never "rotate your secret".
2. Calls `GET /v2/bot/info`.
3. Applies the cross-workspace and same-workspace ownership checks Telegram has.
4. Persists the encrypted config.
5. Calls `PUT /v2/bot/channel/webhook/endpoint` with the installation's URL.
6. Calls `POST /v2/bot/channel/webhook/test`.

The response returns the webhook URL and the test result, so the dialog can say
"turn on Use webhook in the LINE Developers Console" when the test reports it
off. Whether the API can switch "Use webhook" on is not documented. Revoke
clears the endpoint best-effort.

**Frontend**, following the Telegram change set:

- `packages/core/line/` (queries), `types/line.ts`, zod schemas with malformed-response tests.
- `packages/views/settings/components/line-tab.tsx` and `line-mark.tsx`.
- The agent integrations tab.
- `packages/views/line/bind-page.tsx`, `apps/web/app/line/bind/page.tsx`.
- Locale strings in every supported locale.

The install dialog lists the LINE Official Account Manager settings to change:
turn auto-reply and greeting off, turn webhooks on, and allow group chats if
wanted. Use LINE's brand icon only as its brand guidelines allow.

**Reserved slug.** `/line/bind` is a new global pre-workspace route, so
`line` goes into `reserved_slugs.json` and `pnpm generate:reserved-slugs`
runs (AGENTS.md rule). The other channels' bind routes are not reserved
today (only `dingtalk` is), so the rule is applied unevenly; that is reported,
not fixed here. A deployment that already has a workspace with slug `line`
needs checking before release.

**Docs.**

- `apps/docs/content/docs/line-bot-integration.{mdx,zh,ja,ko,fr,zh-Hant}.mdx`:
  setup, cost warning, groups, limits.
- Rows in `channels`, `environment-variables` and `meta*.json`.
- A `community-maintained` row if upstream treats LINE like Telegram (decision
  `line-upstream`).

## 7. Security

- **Webhook trust.** The signature is checked over raw bytes with `hmac.Equal`
  before any parsing or database write besides the installation lookup.
  `destination` must match the stored bot ID. LINE publishes no IP ranges, so
  none are allowlisted. Bad signatures feed the per-IP webhook limiter.
- **Revealing nothing.** Unknown, revoked and disabled all return the same 404.
  The handler never echoes request content.
- **Secrets.** The channel secret is sealed with secretbox under
  `MULTICA_LINE_SECRET_KEY`. Access tokens live only in memory for up to
  15 minutes; stateless tokens cannot be revoked, so revoking an installation
  relies on the admin reissuing the channel secret when it may have leaked (the
  docs say so). The secret never goes to the frontend; list responses return
  `channel_id`, `basic_id` and `display_name` only.
- **Rotation.** If the secret is reissued in the console, the old one stops at
  once. Signatures then fail, so the installation card shows "reconnect", and
  reconnecting replaces the config.
- **Binding.** Binding is unchanged: a single-use 15-minute token, hashed at
  rest, redeemable only by a logged-in member of the token's workspace.
- **Group data.** Unaddressed group messages are dropped before persistence;
  only addressed messages become chat input.

## 8. Testing

**Unit and DB tests.** These use `server/internal/testutil` fixtures and a
fake LINE API served by `httptest`; no test calls LINE.

| Area | Cases |
|---|---|
| Signature | valid; wrong secret; missing header; body re-encoded (whitespace changed) fails; empty `events` returns 200 |
| Handler | unknown, revoked or disabled installation gives the same 404; `destination` mismatch; 1 MiB cap; Handle infra error gives 500; redelivered event deduped |
| Normalization | Fixtures in `testdata/` for p2p text; group with self mention (span stripped, UTF-16 offsets with emoji); group without mention (dropped); room becomes group; missing `userId` in group; sticker; `follow`; `join`; unknown event type; `mode: standby` |
| Reply/push choice | fresh token gives reply; 51 s token gives push; two replicas racing for one token, exactly one replies (DB test) |
| Push idempotency | same turn gives the same retry key; 409 with `sentMessages` is recorded as known; unknown push retried, unknown reply not |
| Rendering | Markdown to plain text table; 4,500-unit chunking; more than 5 bubbles truncates with the link; `textV2` mention and `quoteToken` on the first bubble only |
| Failures | 429 monthly limit settles `quota_exhausted` without retry; 429 rate retries; 5xx retries |
| Typing | animation renewed while unsettled, stopped on settle, capped at 30 min; never called for groups |
| Group ack | sent at 45 s when the token is unused; not sent when the answer already went out |
| Install | bad credentials vs unreachable; ownership conflicts; webhook endpoint set and tested; secret never in responses |
| Binding | mint, redeem, expired, already bound, non-member |
| Migrations | `line_chat` origin accepted after 1+2; down migrations restore the old CHECK |
| Frontend | zod schemas with malformed payloads; `line-tab` install/revoke/list; bind page states |

**End to end with a real LINE test channel.** This is manual, recorded in the
PR. Optionally it becomes a test tagged `lineintegration`, gated by
`MULTICA_RUN_REAL_LINE_SMOKE=1` like the real-agent smoke tests.

1. Create a test provider and a Messaging API channel on a free Communication
   plan Official Account. Turn auto-reply and greeting off, and allow group
   chats.
2. Run a staging backend reachable over public HTTPS with object storage.
3. Install from the UI and check that the webhook URL is set and the test
   passes; also try the console's Verify button.
4. 1:1: follow, then the binding prompt, then bind, then a short question (one
   reply; delivery stats show reply, not push), then a slow task over 60 s
   (loading animation, then one push), then a long answer (≤ 5 bubbles plus a
   link).
5. Run `/new` and `/issue` (the issue shows the `line_chat` origin).
6. Group: invite the bot (join notice), post unaddressed chatter (no run), then
   an @mention (the answer quotes the question and mentions the asker), then a
   slow run (45 s ack, then push).
7. Block the bot and push (200, no delivery); revoke and reconnect; rotate the
   secret (signatures fail, then reconnect fixes it).
8. Phase 2: an image, a video (transcoding) and a file in; an image and a file
   link out.
9. Check `GET /v2/bot/message/quota/consumption` before and after: only pushes
   count.

## 9. Delivery

Each phase merges on its own and leaves LINE usable.

| Phase | Scope | Usable result |
|---|---|---|
| 1 | Adapter, webhook, install, binding, text in 1:1 and groups (mention, quote, asker mention, 45 s ack), loading animation, reply/push with retry key, plain-text rendering, `/new` and `/issue`, `line_chat` origin, `line_reply_token`, UI, bind page, docs, env pass-through | Text chat with an agent over LINE |
| 2 | Inbound media through the media resolver, outbound images by presigned URL, other attachments as links | Agents see and return images |
| 3 | Quota and consumption on the installation card; Flex card for `/issue` results; quick-reply buttons for `/new` | Cost visible; richer replies |

Rough size of phase 1, based on Telegram's first PR (83 files, about 9,200
lines with tests): the LINE adapter drops the streaming and delivery state
machine (about 2,100 lines in Telegram today) and adds the webhook handler. That is more than 8 files and a new
public route, but no new service.

## 10. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Public HTTPS required | Self-hosted instances behind NAT cannot receive LINE webhooks (Telegram avoided this on purpose) | Install refuses non-HTTPS `MULTICA_PUBLIC_URL`; docs name a tunnel option |
| Group push cost | An N-member group costs N per slow answer; the free Japan plan allows 200 per month | Reply-first, one request per answer, the docs warning, quota on the card |
| The reply window is "not guaranteed" | Shrinking it turns some replies into failed calls | Reply failure with an invalid token falls back to push only when the first call's outcome is known; the 50 s margin is a constant |
| 2 s webhook deadline under database load | LINE logs timeouts; without redelivery those messages are lost | Handle per event in order with a 1.5 s budget; docs require redelivery; dedup absorbs replays |
| Presigned image URLs expire | Old images may stop rendering in LINE | 7-day TTL; links for everything else |
| Event types appear without notice | A strict parser would 4xx and LINE would mark errors | Unknown types are ignored with a debug audit |
| Upstream acceptance and maintenance | A new integration becomes community-maintained with a named maintainer | Decision `line-upstream` |
| `line` slug collision | A workspace named `line` would shadow or be shadowed | Check before release |

## 11. Not in scope

- Streaming by repeated pushes.
- Rich menus.
- LINE Login.
- LINE's account-link flow.
- Multicast or broadcast.
- Recent group context.
- Reply-to-bot without a mention.
- Edited messages (`messageEdited`).
- Postback actions beyond phase 3 quick replies.
- Native video and audio out.
- Sending files (LINE has no API for it).

## 12. Open decisions

Each has a recommendation. Nothing here blocks writing phase 1 except
`line-upstream` (it decides where the code lands) and `line-test-channel` (it
gates the end-to-end check).

| Key | Question | Options (recommended first) |
|---|---|---|
| `line-upstream` | Where does LINE land? | (a) Upstream: open a proposal issue on `multica-ai/multica` with this design, then PRs from the fork. The area becomes community-maintained with Yu as maintainer. (b) The private mirror `oaku-ai/multica` only. (c) Build in the mirror first, upstream later. |
| `line-credentials` | What does the admin paste? | (a) Channel ID + channel secret; Multica mints 15-minute stateless tokens. (b) Channel secret + long-lived access token, as most other projects do. |
| `line-slow-answer` | What does a group see while a run takes over a minute? | (a) At 45 s a free "Working on it…" reply; the answer by push. (b) Hermes-style: at 45 s a "Get the answer" postback button; a tap gives a fresh free reply token for the answer, at the cost of a tap. (c) Nothing until the push. |
| `line-copy-language` | Bot copy language (binding prompt, notices)? | (a) Chosen per installation at install: `ja`, `en` or `zh-Hant`, default `ja`. (b) English only, like Telegram. (c) Japanese only. |
| `line-phase1-scope` | Do groups ship in phase 1? | (a) Yes, 1:1 and groups (Telegram shipped both). (b) 1:1 first, groups in a later phase. |
| `line-test-channel` | Who creates the LINE test Official Account and channel (needs a LINE Business ID), and where does the public-HTTPS staging backend run? | (a) Yu creates a test provider and channel and passes channel ID and secret privately; staging runs on ovh behind its existing HTTPS proxy. (b) Use an existing branded instance as staging. |
