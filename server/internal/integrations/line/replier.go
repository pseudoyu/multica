package line

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// This file is the LINE OutboundReplier: the engine seam that answers a
// verdict (binding prompt, offline notice, command confirmations). Verdicts
// spend the reply token of the message they answer, so they cost nothing.
// When no fresh token is left, a 1:1 verdict is pushed (one message); a group
// verdict is dropped rather than billed once per member.

// bindingMinter is the binding-token surface the replier needs.
type bindingMinter interface {
	Mint(ctx context.Context, workspaceID, installationID pgtype.UUID, lineUserID string) (BindingToken, error)
}

// OutboundReplier implements engine.OutboundReplier for LINE.
type OutboundReplier struct {
	binding     bindingMinter
	decrypt     Decrypter
	tokens      *tokenSource
	store       replyTokenStore
	appURL      string
	bindingPath string
	logger      *slog.Logger
	newAPI      func(creds credentials) messenger
	now         func() time.Time
}

// OutboundReplierConfig configures the replier. Binding and AppURL are
// required for the binding prompt; without them the prompt is skipped.
type OutboundReplierConfig struct {
	Binding     bindingMinter
	Queries     *db.Queries
	Decrypt     Decrypter
	Tokens      *TokenSource
	AppURL      string
	BindingPath string // default "/line/bind"
	Logger      *slog.Logger
}

var _ engine.OutboundReplier = (*OutboundReplier)(nil)

// NewOutboundReplier builds the replier.
func NewOutboundReplier(cfg OutboundReplierConfig) *OutboundReplier {
	var store replyTokenStore
	if cfg.Queries != nil {
		store = cfg.Queries
	}
	return newOutboundReplier(cfg, store)
}

func newOutboundReplier(cfg OutboundReplierConfig, store replyTokenStore) *OutboundReplier {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	path := cfg.BindingPath
	if path == "" {
		path = "/line/bind"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	r := &OutboundReplier{
		binding: cfg.Binding, decrypt: cfg.Decrypt, store: store,
		appURL: strings.TrimRight(cfg.AppURL, "/"), bindingPath: path,
		logger: logger, now: time.Now,
	}
	if cfg.Tokens != nil {
		r.tokens = cfg.Tokens.ts
	}
	r.newAPI = func(c credentials) messenger { return newBotAPI(r.tokens, c) }
	return r
}

// Reply routes each outcome to its user-visible message. Errors are logged:
// the replier runs detached from the webhook request.
func (r *OutboundReplier) Reply(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, res engine.Result) {
	text, err := r.verdictText(ctx, inst, msg, res)
	if err != nil {
		r.logger.WarnContext(ctx, "line replier: build verdict failed",
			"installation_id", util.UUIDToString(inst.ID), "outcome", string(res.Outcome), "error", err)
		return
	}
	if text == "" {
		return
	}
	if err := r.post(ctx, inst, msg, text); err != nil {
		r.logger.WarnContext(ctx, "line replier: verdict reply failed",
			"installation_id", util.UUIDToString(inst.ID), "outcome", string(res.Outcome), "error", err)
	}
}

func (r *OutboundReplier) verdictText(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, res engine.Result) (string, error) {
	c := textFor(installationLanguage(inst))
	switch res.Outcome {
	case engine.OutcomeNeedsBinding:
		return r.bindingPrompt(ctx, inst, msg, res.Sender, c)
	case engine.OutcomeAgentOffline:
		return c.AgentOffline, nil
	case engine.OutcomeAgentArchived:
		return c.AgentArchived, nil
	case engine.OutcomeFreshPending:
		return c.FreshPending, nil
	case engine.OutcomeChatStarted:
		return c.ChatStarted, nil
	case engine.OutcomeIssueUsage:
		return c.IssueUsage, nil
	case engine.OutcomeIngested:
		if !res.IssueID.Valid {
			return "", nil
		}
		return issueResultText(c, res), nil
	case engine.OutcomeDropped:
		if !isAddressedIssueCommand(msg) {
			return "", nil
		}
		switch res.DropReason {
		case engine.DropReasonNonWorkspaceMember:
			return c.IssueNotMember, nil
		case engine.DropReasonRevokedInstallation:
			return c.IssueDisabled, nil
		}
	}
	return "", nil
}

// bindingPrompt returns the link prompt for a 1:1 chat. In a group a
// bearer link could be redeemed by another member and bind the wrong
// person, so the group gets a hint to message the bot 1:1 instead.
func (r *OutboundReplier) bindingPrompt(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, sender string, c copyText) (string, error) {
	if msg.Source.ChatType == channel.ChatTypeGroup {
		return c.BindInGroup, nil
	}
	if sender == "" {
		sender = msg.Source.SenderID
	}
	if sender == "" {
		return "", errors.New("missing sender id")
	}
	if r.binding == nil || r.appURL == "" {
		return "", errors.New("binding service or app url not configured")
	}
	token, err := r.binding.Mint(ctx, inst.WorkspaceID, inst.ID, sender)
	if err != nil {
		return "", fmt.Errorf("mint binding token: %w", err)
	}
	bindURL := r.appURL + r.bindingPath + "?token=" + url.QueryEscape(token.Raw)
	return c.BindPrompt + "\n" + bindURL + "\n" + c.BindExpiry, nil
}

// post sends one verdict into the chat the message came from.
func (r *OutboundReplier) post(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, text string) error {
	row, ok := inst.Platform.(db.ChannelInstallation)
	if !ok {
		return errors.New("installation platform row unavailable")
	}
	if r.store == nil || r.tokens == nil {
		return errors.New("replier not configured")
	}
	creds, err := decodeCredentials(row.Config, r.decrypt)
	if err != nil {
		return fmt.Errorf("decode credentials: %w", err)
	}
	group := msg.Source.ChatType == channel.ChatTypeGroup
	req := sendRequest{
		InstallationID: inst.ID, ChatID: msg.Source.ChatID, Group: group,
		Bubbles: splitBubbles(text, maxBubbleUnits),
	}
	if !group {
		req.RetryKeySeed = "verdict:" + util.UUIDToString(inst.ID) + ":" + msg.MessageID
	}
	s := &sender{store: r.store, api: r.newAPI(creds), now: r.now, sleep: time.Sleep}
	_, err = s.send(ctx, req)
	return err
}

func installationLanguage(inst engine.ResolvedInstallation) Language {
	if row, ok := inst.Platform.(db.ChannelInstallation); ok {
		return DecodePublicConfig(row.Config).Language
	}
	return DefaultLanguage
}

func issueResultText(c copyText, res engine.Result) string {
	id := res.IssueIdentifier
	if id == "" && res.IssueNumber > 0 {
		id = fmt.Sprintf("#%d", res.IssueNumber)
	}
	if id == "" {
		id = util.UUIDToString(res.IssueID)
	}
	title := strings.TrimSpace(res.IssueTitle)
	suffix := ""
	if title != "" {
		suffix = ": " + title
	}
	if res.IssueDuplicate {
		return fmt.Sprintf(c.IssueDuplicate, id, suffix)
	}
	return fmt.Sprintf(c.IssueCreated, id, suffix)
}

func isAddressedIssueCommand(msg channel.InboundMessage) bool {
	if !msg.AddressedToBot && msg.Source.ChatType == channel.ChatTypeGroup {
		return false
	}
	source := msg.CommandText
	if source == "" {
		source = msg.Text
	}
	_, ok := engine.ParseIssueCommand(source)
	return ok
}
