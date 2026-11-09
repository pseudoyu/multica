package line

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// LINE cannot edit a sent message, so there is no streaming. While a turn
// runs, a 1:1 chat shows LINE's loading animation (renewed every 50 s, capped
// at 30 minutes; it shows only while the user has the chat open). In every
// chat, a turn still running 45 s after its message spends the reply token
// that would otherwise expire unused on a free "working on it" notice; the
// answer then goes by push.
const (
	loadingSeconds   = 60
	loadingRenew     = 50 * time.Second
	loadingCap       = 30 * time.Minute
	workingNoticeAge = 45 * time.Second
)

// pendingChecker reports whether a chat session still has a turn in flight.
// It reads the database, so it is right whichever replica runs the task.
type pendingChecker interface {
	HasPendingChatTurnForSession(ctx context.Context, chatSessionID pgtype.UUID) (bool, error)
}

type typingNotifier struct {
	pending  pendingChecker
	decrypt  Decrypter
	tokens   *tokenSource
	store    replyTokenStore
	logger   *slog.Logger
	now      func() time.Time
	after    func(time.Duration) <-chan time.Time
	newAPI   func(creds credentials) typingAPI
	base     context.Context
	sleepFor func(time.Duration)
}

// typingAPI is the part of botAPI the notifier uses.
type typingAPI interface {
	messenger
	StartLoading(ctx context.Context, chatID string, seconds int) error
}

var _ engine.TypingNotifier = (*typingNotifier)(nil)

// NewTypingNotifier builds the loading-animation and working-notice
// notifier. base bounds the background timers (the server's lifetime).
func NewTypingNotifier(base context.Context, q *db.Queries, decrypt Decrypter, tokens *TokenSource, logger *slog.Logger) engine.TypingNotifier {
	return newTypingNotifier(base, q, q, decrypt, tokens.ts, logger)
}

func newTypingNotifier(base context.Context, pending pendingChecker, store replyTokenStore, decrypt Decrypter, tokens *tokenSource, logger *slog.Logger) *typingNotifier {
	if logger == nil {
		logger = slog.Default()
	}
	n := &typingNotifier{
		pending: pending, decrypt: decrypt, tokens: tokens, store: store, logger: logger,
		now: time.Now, after: time.After, base: base, sleepFor: time.Sleep,
	}
	n.newAPI = func(c credentials) typingAPI { return newBotAPI(n.tokens, c) }
	return n
}

func (n *typingNotifier) OnIngested(ctx context.Context, inst engine.ResolvedInstallation, msg channel.InboundMessage, sessionID pgtype.UUID, _ pgtype.UUID) {
	row, ok := inst.Platform.(db.ChannelInstallation)
	if !ok {
		return
	}
	creds, err := decodeCredentials(row.Config, n.decrypt)
	if err != nil {
		n.logger.WarnContext(ctx, "line typing: decode credentials failed", "error", err)
		return
	}
	api := n.newAPI(creds)
	direct := msg.Source.ChatType == channel.ChatTypeP2P
	if direct {
		if err := api.StartLoading(ctx, msg.Source.ChatID, loadingSeconds); err != nil {
			n.logger.WarnContext(ctx, "line typing: loading animation failed", "error", err)
		}
	}
	received := time.UnixMilli(decodeRaw(msg.Raw).ReceivedAtMs)
	if decodeRaw(msg.Raw).ReceivedAtMs == 0 {
		received = n.now()
	}
	go n.watch(inst.ID, creds, api, msg.Source.ChatID, direct, sessionID, received)
}

// watch runs the 45 s notice and the loading renewals until the turn
// settles or the cap is reached.
func (n *typingNotifier) watch(installationID pgtype.UUID, creds credentials, api typingAPI, chatID string, direct bool, sessionID pgtype.UUID, received time.Time) {
	deadline := received.Add(loadingCap)
	noticeAt := received.Add(workingNoticeAge)
	nextLoading := n.now().Add(loadingRenew)
	noticeSent := false
	text := textFor(creds.Language)
	for {
		next := nextLoading
		if !noticeSent && noticeAt.Before(next) {
			next = noticeAt
		}
		if !direct && noticeSent {
			return // groups have no loading animation to renew
		}
		if next.After(deadline) {
			return
		}
		select {
		case <-n.base.Done():
			return
		case <-n.after(next.Sub(n.now())):
		}
		ctx, cancel := context.WithTimeout(n.base, apiTimeout)
		pending, err := n.pending.HasPendingChatTurnForSession(ctx, sessionID)
		if err != nil || !pending {
			cancel()
			return
		}
		if !noticeSent && !n.now().Before(noticeAt) {
			noticeSent = true
			s := &sender{store: n.store, api: api, now: n.now, sleep: n.sleepFor}
			// Reply-only: if the answer already spent the token, say nothing.
			if _, err := s.send(ctx, sendRequest{
				InstallationID: installationID, ChatID: chatID, Group: !direct,
				Bubbles: []string{text.WorkingOnIt},
			}); err != nil {
				n.logger.WarnContext(ctx, "line typing: working notice failed",
					"installation_id", util.UUIDToString(installationID), "error", err)
			}
			if direct {
				// The notice cleared the animation; start it again.
				_ = api.StartLoading(ctx, chatID, loadingSeconds)
				nextLoading = n.now().Add(loadingRenew)
			}
			cancel()
			continue
		}
		if direct {
			if err := api.StartLoading(ctx, chatID, loadingSeconds); err != nil {
				n.logger.WarnContext(ctx, "line typing: loading renewal failed", "error", err)
			}
			nextLoading = n.now().Add(loadingRenew)
		}
		cancel()
	}
}

// OnSettled is a no-op: the watcher stops by itself once the session has no
// pending turn, and the bot's next message clears the animation.
func (n *typingNotifier) OnSettled(context.Context, pgtype.UUID, engine.TypingSettlement) {}
