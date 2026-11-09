package line

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Webhook outcomes the HTTP handler maps to status codes.
var (
	// ErrWebhookNotFound covers an unknown, revoked or non-LINE installation.
	// All answer the same bare 404.
	ErrWebhookNotFound = errors.New("line: unknown webhook")
	// ErrWebhookMalformed is a verified body that does not decode or is
	// addressed to another bot.
	ErrWebhookMalformed = errors.New("line: malformed webhook body")
)

// inboundQueries is the slice of generated queries the webhook needs.
type inboundQueries interface {
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
	RecordLineReplyToken(ctx context.Context, arg db.RecordLineReplyTokenParams) error
	GetChannelUserBindingByUserID(ctx context.Context, arg db.GetChannelUserBindingByUserIDParams) (db.ChannelUserBinding, error)
}

// InboundHandler is the shared channel Router entry point.
type InboundHandler func(ctx context.Context, msg channel.InboundMessage) error

// Webhook verifies and processes LINE webhook requests.
type Webhook struct {
	q       inboundQueries
	decrypt Decrypter
	handle  InboundHandler
	replier *OutboundReplier
	logger  *slog.Logger
	now     func() time.Time
}

// NewWebhook builds the webhook processor.
func NewWebhook(q *db.Queries, decrypt Decrypter, handle InboundHandler, replier *OutboundReplier, logger *slog.Logger) *Webhook {
	return newWebhook(q, decrypt, handle, replier, logger)
}

func newWebhook(q inboundQueries, decrypt Decrypter, handle InboundHandler, replier *OutboundReplier, logger *slog.Logger) *Webhook {
	if logger == nil {
		logger = slog.Default()
	}
	return &Webhook{q: q, decrypt: decrypt, handle: handle, replier: replier, logger: logger, now: time.Now}
}

// Process verifies one webhook request and handles its events in order. It
// returns ErrWebhookNotFound, ErrBadSignature, ErrWebhookMalformed, or an
// infrastructure error (the handler answers 500 so LINE redelivers; dedup
// absorbs whatever was already committed).
func (w *Webhook) Process(ctx context.Context, installationID pgtype.UUID, body []byte, signature string) error {
	row, err := w.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{ID: installationID, ChannelType: string(TypeLine)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWebhookNotFound
		}
		return fmt.Errorf("load line installation: %w", err)
	}
	if row.Status != "active" {
		return ErrWebhookNotFound
	}
	creds, err := decodeCredentials(row.Config, w.decrypt)
	if err != nil {
		return fmt.Errorf("decode line credentials: %w", err)
	}
	if err := VerifySignature(creds.ChannelSecret, body, signature); err != nil {
		return err
	}
	wb, err := parseWebhook(body, creds.BotUserID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrWebhookMalformed, err)
	}
	inst := engine.ResolvedInstallation{
		ID: row.ID, WorkspaceID: row.WorkspaceID, AgentID: row.AgentID,
		InstallerUserID: row.InstallerUserID, Active: true, Platform: row,
	}
	for _, ev := range wb.Events {
		if err := w.handleEvent(ctx, inst, creds, ev); err != nil {
			return err
		}
	}
	return nil
}

func (w *Webhook) handleEvent(ctx context.Context, inst engine.ResolvedInstallation, creds credentials, ev webhookEvent) error {
	if ev.Mode == "standby" {
		return nil // LINE: a standby channel must not respond
	}
	received := w.now()
	switch ev.Type {
	case "message":
		msg, ok := normalizeMessage(ev, creds.BotUserID, received.UnixMilli())
		if !ok {
			return nil
		}
		direct := msg.Source.ChatType == channel.ChatTypeP2P
		addressed := direct || msg.AddressedToBot
		if err := w.recordReplyToken(ctx, inst.ID, ev, addressed, received); err != nil {
			return err
		}
		if msg.Type != channel.MsgTypeText {
			if direct {
				w.reply(ctx, inst, msg, textFor(creds.Language).Unsupported)
			}
			return nil
		}
		if !addressed {
			// LINE delivers every group message; unaddressed chatter never
			// reaches the Router (no dedup or audit write per message).
			return nil
		}
		if err := w.handle(ctx, msg); err != nil {
			return fmt.Errorf("route line message: %w", err)
		}
	case "follow":
		if err := w.recordReplyToken(ctx, inst.ID, ev, true, received); err != nil {
			return err
		}
		w.greet(ctx, inst, creds, ev)
	case "join":
		if err := w.recordReplyToken(ctx, inst.ID, ev, false, received); err != nil {
			return err
		}
		w.reply(ctx, inst, eventEnvelope(ev, creds), textFor(creds.Language).Joined)
	default:
		// unfollow, leave, member events, unsend, postback, unknown types:
		// LINE adds event types without notice, so none is an error.
		w.logger.DebugContext(ctx, "line webhook: event ignored", "type", ev.Type,
			"installation_id", util.UUIDToString(inst.ID))
	}
	return nil
}

func (w *Webhook) recordReplyToken(ctx context.Context, instID pgtype.UUID, ev webhookEvent, addressed bool, received time.Time) error {
	if ev.ReplyToken == "" {
		return nil
	}
	var quote, messageID string
	if ev.Message != nil {
		quote, messageID = ev.Message.QuoteToken, ev.Message.ID
	}
	if err := w.q.RecordLineReplyToken(ctx, db.RecordLineReplyTokenParams{
		InstallationID: instID,
		ChatID:         ev.Source.chatID(),
		ReplyToken:     pgtype.Text{String: ev.ReplyToken, Valid: true},
		ReceivedAt:     pgtype.Timestamptz{Time: received, Valid: true},
		Addressed:      addressed,
		QuoteToken:     quote,
		SenderUserID:   ev.Source.UserID,
		MessageID:      messageID,
	}); err != nil {
		return fmt.Errorf("record line reply token: %w", err)
	}
	return nil
}

// greet answers a follow (the user added the bot as a friend): the binding
// prompt when they are not linked yet, otherwise a one-line hello.
func (w *Webhook) greet(ctx context.Context, inst engine.ResolvedInstallation, creds credentials, ev webhookEvent) {
	if w.replier == nil || ev.Source.UserID == "" {
		return
	}
	msg := eventEnvelope(ev, creds)
	c := textFor(creds.Language)
	_, err := w.q.GetChannelUserBindingByUserID(ctx, db.GetChannelUserBindingByUserIDParams{
		InstallationID: inst.ID, ChannelUserID: ev.Source.UserID,
	})
	switch {
	case err == nil:
		w.reply(ctx, inst, msg, c.Hello)
	case errors.Is(err, pgx.ErrNoRows):
		text, perr := w.replier.bindingPrompt(ctx, inst, msg, ev.Source.UserID, c)
		if perr != nil {
			w.logger.WarnContext(ctx, "line webhook: binding prompt failed", "error", perr)
			return
		}
		w.reply(ctx, inst, msg, text)
	default:
		w.logger.WarnContext(ctx, "line webhook: binding lookup failed", "error", err)
	}
}

func (w *Webhook) reply(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, text string) {
	if w.replier == nil {
		return
	}
	if err := w.replier.post(ctx, inst, msg, text); err != nil {
		w.logger.WarnContext(ctx, "line webhook: notice failed", "type", decodeRaw(msg.Raw).EventType, "error", err)
	}
}

// eventEnvelope is the minimal message shape the replier needs for a
// non-message event.
func eventEnvelope(ev webhookEvent, creds credentials) channel.InboundMessage {
	chatType := channel.ChatTypeP2P
	if ev.Source.isGroup() {
		chatType = channel.ChatTypeGroup
	}
	return channel.InboundMessage{
		EventID:   ev.WebhookEventID,
		MessageID: ev.WebhookEventID,
		Source: channel.Source{
			ChannelType: TypeLine, ChatID: ev.Source.chatID(), ChatType: chatType, SenderID: ev.Source.UserID,
		},
		Raw: mustRaw(rawEvent{BotUserID: creds.BotUserID, EventType: ev.Type, ReplyToken: ev.ReplyToken}),
	}
}
