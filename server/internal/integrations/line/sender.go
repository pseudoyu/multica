package line

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// replyTokenMaxAge is how old a reply token may be when a send starts. LINE
// keeps a token usable for about a minute (not guaranteed); 50 s leaves time
// for the call itself.
const replyTokenMaxAge = 50 * time.Second

// retryKeyNamespace scopes the deterministic push retry keys. Any replica
// retrying the same turn derives the same key, so LINE delivers it once.
var retryKeyNamespace = uuid.MustParse("6f0b1c52-3d55-4b8e-9a4f-6c1e0a7d9b21")

// ErrQuotaExhausted is LINE's monthly message limit. The answer stays in the
// Multica chat; retrying cannot help until the quota resets.
var ErrQuotaExhausted = errors.New("line: monthly message limit reached")

// ErrDeliveryUnknown means a reply may or may not have been delivered (a
// timeout, network error or 5xx). Reply takes no retry key, so it is not
// resent: a second copy is worse than a lost notice, and the answer is still
// in Multica.
var ErrDeliveryUnknown = errors.New("line: reply outcome unknown")

// replyTokenStore is the slice of queries the sender needs.
type replyTokenStore interface {
	TakeLineReplyToken(ctx context.Context, arg db.TakeLineReplyTokenParams) (string, error)
	GetLineReplyContext(ctx context.Context, arg db.GetLineReplyContextParams) (db.GetLineReplyContextRow, error)
}

// messenger is the part of botAPI the sender uses; tests fake it.
type messenger interface {
	Reply(ctx context.Context, replyToken string, msgs []message) (sendResponse, error)
	Push(ctx context.Context, to, retryKey string, msgs []message) (sendResponse, error)
}

// sendRequest is one logical answer or notice for one LINE chat.
type sendRequest struct {
	InstallationID pgtype.UUID
	ChatID         string
	Group          bool
	Bubbles        []string
	// RetryKeySeed identifies the logical send ("task:<id>" for an answer).
	// Empty means reply-only: a notice that is not worth a paid push.
	RetryKeySeed string
	// Quote marks the first bubble with the asker's quote token and, in
	// groups, a mention of the asker.
	Quote bool
}

// sendResult records how the send went out.
type sendResult struct {
	Replied    bool
	Pushed     bool
	MessageIDs []string
}

type sender struct {
	store replyTokenStore
	api   messenger
	now   func() time.Time
	sleep func(time.Duration)
}

// pushBackoff is the in-process retry schedule for retryable push failures.
// The retry key makes every attempt safe.
var pushBackoff = []time.Duration{time.Second, 4 * time.Second, 15 * time.Second}

// send spends the chat's fresh reply token when there is one, otherwise
// pushes (unless the request is reply-only).
func (s *sender) send(ctx context.Context, req sendRequest) (sendResult, error) {
	if len(req.Bubbles) == 0 {
		return sendResult{}, nil
	}
	msgs := s.buildMessages(ctx, req)

	token, err := s.store.TakeLineReplyToken(ctx, db.TakeLineReplyTokenParams{
		InstallationID: req.InstallationID,
		ChatID:         req.ChatID,
		FreshAfter:     pgtype.Timestamptz{Time: s.now().Add(-replyTokenMaxAge), Valid: true},
	})
	switch {
	case err == nil && token != "":
		resp, rerr := s.api.Reply(ctx, token, msgs)
		if rerr == nil {
			return sendResult{Replied: true, MessageIDs: messageIDs(resp)}, nil
		}
		if !replyFailedDefinitely(rerr) {
			return sendResult{}, fmt.Errorf("%w: %v", ErrDeliveryUnknown, rerr)
		}
		// LINE did not deliver it (expired or used token): fall through to push.
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return sendResult{}, fmt.Errorf("take reply token: %w", err)
	}

	if req.RetryKeySeed == "" {
		return sendResult{}, nil
	}
	key := uuid.NewSHA1(retryKeyNamespace, []byte(req.RetryKeySeed)).String()
	var lastErr error
	for attempt := 0; attempt <= len(pushBackoff); attempt++ {
		if attempt > 0 {
			s.sleep(pushBackoff[attempt-1])
		}
		resp, perr := s.api.Push(ctx, req.ChatID, key, msgs)
		if perr == nil {
			return sendResult{Pushed: true, MessageIDs: messageIDs(resp)}, nil
		}
		var apiErr *apiError
		if errors.As(perr, &apiErr) && apiErr.isMonthlyLimit() {
			return sendResult{}, ErrQuotaExhausted
		}
		if !pushRetryable(perr) || ctx.Err() != nil {
			return sendResult{}, fmt.Errorf("push: %w", perr)
		}
		lastErr = perr
	}
	return sendResult{}, fmt.Errorf("push: gave up after %d attempts: %w", len(pushBackoff)+1, lastErr)
}

// buildMessages turns bubbles into message objects. The first bubble quotes
// the asker's message; in a group it also opens with a mention of the asker,
// when LINE gave us their user ID.
func (s *sender) buildMessages(ctx context.Context, req sendRequest) []message {
	msgs := make([]message, len(req.Bubbles))
	for i, b := range req.Bubbles {
		msgs[i] = message{Type: "text", Text: b}
	}
	if !req.Quote {
		return msgs
	}
	rc, err := s.store.GetLineReplyContext(ctx, db.GetLineReplyContextParams{
		InstallationID: req.InstallationID,
		ChatID:         req.ChatID,
	})
	if err != nil {
		return msgs
	}
	msgs[0].QuoteToken = rc.QuoteToken
	// textV2 reads {name} as a placeholder, so only use it when the answer
	// itself has no braces; otherwise keep plain text and just quote.
	if req.Group && rc.SenderUserID != "" && !strings.ContainsAny(msgs[0].Text, "{}") {
		msgs[0] = message{
			Type:       "textV2",
			Text:       "{asker} " + msgs[0].Text,
			QuoteToken: rc.QuoteToken,
			Substitution: map[string]substitution{
				"asker": {Type: "mention", Mentionee: mentioneeSpec{Type: "user", UserID: rc.SenderUserID}},
			},
		}
	}
	return msgs
}

func messageIDs(resp sendResponse) []string {
	ids := make([]string, 0, len(resp.SentMessages))
	for _, m := range resp.SentMessages {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	return ids
}

// replyFailedDefinitely is true for a 4xx other than 408: LINE answered and
// did not deliver, so pushing instead cannot duplicate.
func replyFailedDefinitely(err error) bool {
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != http.StatusRequestTimeout
}

// pushRetryable covers 429 (other than the monthly limit), 5xx and network
// errors. The retry key makes the repeat safe.
func pushRetryable(err error) bool {
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		return apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500 || apiErr.Status == http.StatusRequestTimeout
	}
	return true
}
