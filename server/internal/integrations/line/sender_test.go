package line

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeTokenStore struct {
	token     string
	takeErr   error
	takes     []db.TakeLineReplyTokenParams
	ctx       db.GetLineReplyContextRow
	ctxErr    error
	purged    []pgtype.Timestamptz
	recorded  []db.RecordLineReplyTokenParams
	recordErr error
}

func (f *fakeTokenStore) TakeLineReplyToken(_ context.Context, p db.TakeLineReplyTokenParams) (string, error) {
	f.takes = append(f.takes, p)
	if f.takeErr != nil {
		return "", f.takeErr
	}
	if f.token == "" {
		return "", pgx.ErrNoRows
	}
	t := f.token
	f.token = ""
	return t, nil
}

func (f *fakeTokenStore) GetLineReplyContext(context.Context, db.GetLineReplyContextParams) (db.GetLineReplyContextRow, error) {
	return f.ctx, f.ctxErr
}

func (f *fakeTokenStore) DeleteStaleLineReplyTokens(_ context.Context, t pgtype.Timestamptz) (int64, error) {
	f.purged = append(f.purged, t)
	return 0, nil
}

func (f *fakeTokenStore) RecordLineReplyToken(_ context.Context, p db.RecordLineReplyTokenParams) error {
	f.recorded = append(f.recorded, p)
	return f.recordErr
}

type sentCall struct {
	kind     string // reply or push
	token    string
	to       string
	retryKey string
	msgs     []message
}

type fakeMessenger struct {
	calls     []sentCall
	replyErr  error
	pushErrs  []error
	loading   []string
	loadErr   error
	replyResp sendResponse
	pushResp  sendResponse
}

func (f *fakeMessenger) Reply(_ context.Context, token string, msgs []message) (sendResponse, error) {
	f.calls = append(f.calls, sentCall{kind: "reply", token: token, msgs: msgs})
	if f.replyErr != nil {
		return sendResponse{}, f.replyErr
	}
	return f.replyResp, nil
}

func (f *fakeMessenger) Push(_ context.Context, to, key string, msgs []message) (sendResponse, error) {
	f.calls = append(f.calls, sentCall{kind: "push", to: to, retryKey: key, msgs: msgs})
	if len(f.pushErrs) > 0 {
		err := f.pushErrs[0]
		f.pushErrs = f.pushErrs[1:]
		if err != nil {
			return sendResponse{}, err
		}
	}
	return f.pushResp, nil
}

func (f *fakeMessenger) StartLoading(_ context.Context, chatID string, _ int) error {
	f.loading = append(f.loading, chatID)
	return f.loadErr
}

func newTestSender(store *fakeTokenStore, api *fakeMessenger) *sender {
	return &sender{store: store, api: api, now: func() time.Time { return time.Unix(1_000_000, 0) }, sleep: func(time.Duration) {}}
}

func TestSendRepliesWithFreshToken(t *testing.T) {
	store := &fakeTokenStore{token: "rt1"}
	api := &fakeMessenger{replyResp: sendResponse{SentMessages: []sentMessage{{ID: "m1"}}}}
	res, err := newTestSender(store, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"hi"}, RetryKeySeed: "task:1"})
	if err != nil || !res.Replied || res.Pushed || len(res.MessageIDs) != 1 || res.MessageIDs[0] != "m1" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(api.calls) != 1 || api.calls[0].kind != "reply" || api.calls[0].token != "rt1" {
		t.Fatalf("calls=%+v", api.calls)
	}
	want := time.Unix(1_000_000, 0).Add(-replyTokenMaxAge)
	if !store.takes[0].FreshAfter.Time.Equal(want) {
		t.Fatalf("fresh_after = %v, want %v", store.takes[0].FreshAfter.Time, want)
	}
}

func TestSendPushesWithStableRetryKeyWhenNoToken(t *testing.T) {
	var keys []string
	for i := 0; i < 2; i++ {
		api := &fakeMessenger{pushResp: sendResponse{SentMessages: []sentMessage{{ID: "p1"}}}}
		res, err := newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "C1", Bubbles: []string{"a", "b"}, RetryKeySeed: "task:abc"})
		if err != nil || !res.Pushed || res.Replied {
			t.Fatalf("res=%+v err=%v", res, err)
		}
		if len(api.calls) != 1 || api.calls[0].to != "C1" || len(api.calls[0].msgs) != 2 {
			t.Fatalf("calls=%+v", api.calls)
		}
		keys = append(keys, api.calls[0].retryKey)
	}
	if keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("retry keys must be deterministic per seed: %q", keys)
	}
	api := &fakeMessenger{}
	_, _ = newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "C1", Bubbles: []string{"a"}, RetryKeySeed: "task:other"})
	if api.calls[0].retryKey == keys[0] {
		t.Fatal("different seeds must give different keys")
	}
}

func TestSendReplyOnlyNoticeSkipsPush(t *testing.T) {
	api := &fakeMessenger{}
	res, err := newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "C1", Bubbles: []string{"working"}})
	if err != nil || res.Replied || res.Pushed || len(api.calls) != 0 {
		t.Fatalf("a reply-only notice without a token must not push: res=%+v calls=%+v err=%v", res, api.calls, err)
	}
}

func TestSendFallsBackToPushOnDefiniteReplyFailure(t *testing.T) {
	api := &fakeMessenger{replyErr: &apiError{Status: http.StatusBadRequest, Message: "Invalid reply token"}}
	res, err := newTestSender(&fakeTokenStore{token: "old"}, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"x"}, RetryKeySeed: "task:1"})
	if err != nil || !res.Pushed {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(api.calls) != 2 || api.calls[0].kind != "reply" || api.calls[1].kind != "push" {
		t.Fatalf("calls=%+v", api.calls)
	}
}

func TestSendDoesNotDuplicateAfterUnknownReplyOutcome(t *testing.T) {
	for _, rerr := range []error{
		errors.New("connection reset"),
		&apiError{Status: http.StatusInternalServerError},
		&apiError{Status: http.StatusRequestTimeout},
	} {
		api := &fakeMessenger{replyErr: rerr}
		_, err := newTestSender(&fakeTokenStore{token: "rt"}, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"x"}, RetryKeySeed: "task:1"})
		if !errors.Is(err, ErrDeliveryUnknown) {
			t.Fatalf("%v: want ErrDeliveryUnknown, got %v", rerr, err)
		}
		if len(api.calls) != 1 {
			t.Fatalf("%v: must not push after an unknown reply, calls=%+v", rerr, api.calls)
		}
	}
}

func TestSendRetriesPushAndStopsOnQuota(t *testing.T) {
	api := &fakeMessenger{pushErrs: []error{&apiError{Status: 500}, &apiError{Status: 429, Message: "Too many requests"}, nil}}
	res, err := newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"x"}, RetryKeySeed: "task:1"})
	if err != nil || !res.Pushed || len(api.calls) != 3 {
		t.Fatalf("res=%+v calls=%d err=%v", res, len(api.calls), err)
	}
	if api.calls[0].retryKey != api.calls[2].retryKey {
		t.Fatal("every attempt must reuse the retry key")
	}

	api = &fakeMessenger{pushErrs: []error{&apiError{Status: 429, Message: "You have reached your monthly limit."}}}
	_, err = newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"x"}, RetryKeySeed: "task:1"})
	if !errors.Is(err, ErrQuotaExhausted) || len(api.calls) != 1 {
		t.Fatalf("quota: err=%v calls=%d", err, len(api.calls))
	}

	api = &fakeMessenger{pushErrs: []error{&apiError{Status: 400, Message: "bad"}}}
	_, err = newTestSender(&fakeTokenStore{}, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"x"}, RetryKeySeed: "task:1"})
	if err == nil || len(api.calls) != 1 {
		t.Fatalf("400 must not be retried: err=%v calls=%d", err, len(api.calls))
	}
}

func TestSendQuotesAndMentionsAskerInGroups(t *testing.T) {
	store := &fakeTokenStore{token: "rt", ctx: db.GetLineReplyContextRow{QuoteToken: "q1", SenderUserID: "Uasker"}}
	api := &fakeMessenger{}
	_, err := newTestSender(store, api).send(context.Background(), sendRequest{ChatID: "C1", Group: true, Bubbles: []string{"answer", "more"}, RetryKeySeed: "task:1", Quote: true})
	if err != nil {
		t.Fatal(err)
	}
	first := api.calls[0].msgs[0]
	if first.Type != "textV2" || first.QuoteToken != "q1" || !strings.HasPrefix(first.Text, "{asker} answer") {
		t.Fatalf("first bubble = %+v", first)
	}
	if first.Substitution["asker"].Mentionee.UserID != "Uasker" {
		t.Fatalf("substitution = %+v", first.Substitution)
	}
	if second := api.calls[0].msgs[1]; second.Type != "text" || second.QuoteToken != "" {
		t.Fatalf("only the first bubble quotes: %+v", second)
	}

	// Braces in the answer would be read as placeholders: stay plain text.
	store = &fakeTokenStore{token: "rt", ctx: db.GetLineReplyContextRow{QuoteToken: "q1", SenderUserID: "Uasker"}}
	api = &fakeMessenger{}
	_, _ = newTestSender(store, api).send(context.Background(), sendRequest{ChatID: "C1", Group: true, Bubbles: []string{"use {x}"}, Quote: true})
	if m := api.calls[0].msgs[0]; m.Type != "text" || m.QuoteToken != "q1" || m.Text != "use {x}" {
		t.Fatalf("brace answer = %+v", m)
	}

	// 1:1 quotes but never mentions.
	store = &fakeTokenStore{token: "rt", ctx: db.GetLineReplyContextRow{QuoteToken: "q1", SenderUserID: "U1"}}
	api = &fakeMessenger{}
	_, _ = newTestSender(store, api).send(context.Background(), sendRequest{ChatID: "U1", Bubbles: []string{"hi"}, Quote: true})
	if m := api.calls[0].msgs[0]; m.Type != "text" || m.QuoteToken != "q1" {
		t.Fatalf("direct answer = %+v", m)
	}
}
