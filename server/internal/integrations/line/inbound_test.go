package line

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func testInstallRow(status, lang string) db.ChannelInstallation {
	cfg, _ := json.Marshal(installConfig{
		AppID: "Ubot", ChannelID: "1650000000", Language: lang,
		// decrypt is nil in tests, so the stored bytes are the secret itself.
		ChannelSecretEncrypted: base64.StdEncoding.EncodeToString([]byte("secret")),
	})
	return db.ChannelInstallation{ID: testUUID(9), WorkspaceID: testUUID(1), AgentID: testUUID(2), ChannelType: "line", Config: cfg, Status: status}
}

type fakeInboundQueries struct {
	*fakeTokenStore
	row     db.ChannelInstallation
	rowErr  error
	bound   bool
	bindErr error
}

func (f *fakeInboundQueries) GetChannelInstallation(context.Context, db.GetChannelInstallationParams) (db.ChannelInstallation, error) {
	return f.row, f.rowErr
}

func (f *fakeInboundQueries) GetChannelUserBindingByUserID(context.Context, db.GetChannelUserBindingByUserIDParams) (db.ChannelUserBinding, error) {
	if f.bindErr != nil {
		return db.ChannelUserBinding{}, f.bindErr
	}
	if f.bound {
		return db.ChannelUserBinding{}, nil
	}
	return db.ChannelUserBinding{}, pgx.ErrNoRows
}

type fakeMinter struct{ minted []string }

func (f *fakeMinter) Mint(_ context.Context, _, _ pgtype.UUID, userID string) (BindingToken, error) {
	f.minted = append(f.minted, userID)
	return BindingToken{Raw: "tok/1"}, nil
}

type webhookHarness struct {
	q       *fakeInboundQueries
	api     *fakeMessenger
	minter  *fakeMinter
	mu      sync.Mutex
	routed  []channel.InboundMessage
	handErr error
	w       *Webhook
}

func newWebhookHarness(t *testing.T, lang string) *webhookHarness {
	h := &webhookHarness{
		q:      &fakeInboundQueries{fakeTokenStore: &fakeTokenStore{}, row: testInstallRow("active", lang)},
		api:    &fakeMessenger{},
		minter: &fakeMinter{},
	}
	replier := newOutboundReplier(OutboundReplierConfig{Binding: h.minter, AppURL: "https://app.example/", Logger: testLogger()}, h.q)
	replier.tokens = newTokenSource(nil, "")
	replier.newAPI = func(credentials) messenger { return h.api }
	h.w = newWebhook(h.q, nil, func(_ context.Context, msg channel.InboundMessage) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.routed = append(h.routed, msg)
		return h.handErr
	}, replier, testLogger())
	h.w.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }
	return h
}

func (h *webhookHarness) process(t *testing.T, body string) error {
	t.Helper()
	return h.w.Process(context.Background(), testUUID(9), []byte(body), sign("secret", []byte(body)))
}

func TestWebhookRejectsBeforeParsing(t *testing.T) {
	h := newWebhookHarness(t, "en")
	body := `{"destination":"Ubot","events":[]}`
	if err := h.w.Process(context.Background(), testUUID(9), []byte(body), sign("other", []byte(body))); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
	if err := h.process(t, `{"destination":"Uother","events":[]}`); !errors.Is(err, ErrWebhookMalformed) {
		t.Fatalf("want ErrWebhookMalformed for another bot, got %v", err)
	}
	if err := h.process(t, body); err != nil {
		t.Fatalf("console connection check must pass: %v", err)
	}

	h.q.row = testInstallRow("revoked", "en")
	if err := h.process(t, body); !errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("revoked: want ErrWebhookNotFound, got %v", err)
	}
	h.q.rowErr = pgx.ErrNoRows
	if err := h.process(t, body); !errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("unknown: want ErrWebhookNotFound, got %v", err)
	}
	h.q.rowErr = errors.New("db down")
	if err := h.process(t, body); err == nil || errors.Is(err, ErrWebhookNotFound) {
		t.Fatalf("db failure must be an infrastructure error, got %v", err)
	}
	if len(h.routed) != 0 {
		t.Fatal("nothing may be routed")
	}
}

func TestWebhookRoutesDirectTextAndRecordsReplyToken(t *testing.T) {
	h := newWebhookHarness(t, "en")
	err := h.process(t, `{"destination":"Ubot","events":[{"type":"message","mode":"active","webhookEventId":"01E","replyToken":"rt1",
		"source":{"type":"user","userId":"U1"},"message":{"id":"m1","type":"text","text":"hello","quoteToken":"q1"}}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.routed) != 1 || h.routed[0].Text != "hello" || h.routed[0].Source.ChatType != channel.ChatTypeP2P {
		t.Fatalf("routed = %+v", h.routed)
	}
	if raw := decodeRaw(h.routed[0].Raw); raw.BotUserID != "Ubot" || raw.ReceivedAtMs != 1_700_000_000_000 {
		t.Fatalf("raw = %+v", raw)
	}
	rec := h.q.recorded
	if len(rec) != 1 || rec[0].ReplyToken.String != "rt1" || !rec[0].Addressed || rec[0].QuoteToken != "q1" || rec[0].SenderUserID != "U1" || rec[0].ChatID != "U1" {
		t.Fatalf("recorded = %+v", rec)
	}
}

func TestWebhookGroupRoutingAndTokenRefresh(t *testing.T) {
	h := newWebhookHarness(t, "en")
	err := h.process(t, `{"destination":"Ubot","events":[
		{"type":"message","webhookEventId":"01A","replyToken":"rtA","source":{"type":"group","groupId":"C1","userId":"U1"},
		 "message":{"id":"mA","type":"text","text":"lunch?"}},
		{"type":"message","webhookEventId":"01B","replyToken":"rtB","source":{"type":"group","groupId":"C1","userId":"U2"},
		 "message":{"id":"mB","type":"text","text":"@Multica summarize","quoteToken":"qB",
		  "mention":{"mentionees":[{"index":0,"length":8,"type":"user","userId":"Ubot","isSelf":true}]}}}
	]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.routed) != 1 || h.routed[0].Text != "summarize" || !h.routed[0].AddressedToBot || h.routed[0].Source.ChatID != "C1" {
		t.Fatalf("only the mention reaches the Router: %+v", h.routed)
	}
	rec := h.q.recorded
	if len(rec) != 2 || rec[0].Addressed || !rec[1].Addressed || rec[1].QuoteToken != "qB" {
		t.Fatalf("every group message refreshes the token, only the mention sets quote context: %+v", rec)
	}
}

func TestWebhookIgnoresStandbyAndUnknownEvents(t *testing.T) {
	h := newWebhookHarness(t, "en")
	err := h.process(t, `{"destination":"Ubot","events":[
		{"type":"message","mode":"standby","replyToken":"rt","source":{"type":"user","userId":"U1"},"message":{"id":"m1","type":"text","text":"x"}},
		{"type":"brandNewEvent","replyToken":"rt2","source":{"type":"user","userId":"U1"}},
		{"type":"unfollow","source":{"type":"user","userId":"U1"}}
	]}`)
	if err != nil || len(h.routed) != 0 || len(h.api.calls) != 0 || len(h.q.recorded) != 0 {
		t.Fatalf("err=%v routed=%d calls=%d recorded=%d", err, len(h.routed), len(h.api.calls), len(h.q.recorded))
	}
}

func TestWebhookUnsupportedTypeNoticeOnlyInDirect(t *testing.T) {
	h := newWebhookHarness(t, "ja")
	h.q.token = "rt1"
	err := h.process(t, `{"destination":"Ubot","events":[
		{"type":"message","replyToken":"rt1","source":{"type":"user","userId":"U1"},"message":{"id":"m1","type":"sticker"}},
		{"type":"message","replyToken":"rt2","source":{"type":"group","groupId":"C1","userId":"U1"},"message":{"id":"m2","type":"image"}}
	]}`)
	if err != nil || len(h.routed) != 0 {
		t.Fatalf("err=%v routed=%d", err, len(h.routed))
	}
	if len(h.api.calls) != 1 || h.api.calls[0].kind != "reply" || h.api.calls[0].msgs[0].Text != textFor(LanguageJapanese).Unsupported {
		t.Fatalf("calls = %+v", h.api.calls)
	}
}

func TestWebhookFollowSendsBindingPromptOrHello(t *testing.T) {
	h := newWebhookHarness(t, "en")
	h.q.token = "rtF"
	body := `{"destination":"Ubot","events":[{"type":"follow","webhookEventId":"01F","replyToken":"rtF","source":{"type":"user","userId":"U1"}}]}`
	if err := h.process(t, body); err != nil {
		t.Fatal(err)
	}
	if len(h.minter.minted) != 1 || h.minter.minted[0] != "U1" {
		t.Fatalf("minted = %v", h.minter.minted)
	}
	text := h.api.calls[0].msgs[0].Text
	if !strings.Contains(text, "https://app.example/line/bind?token=tok%2F1") || !strings.HasPrefix(text, textFor(LanguageEnglish).BindPrompt) {
		t.Fatalf("prompt = %q", text)
	}

	h = newWebhookHarness(t, "en")
	h.q.bound = true
	h.q.token = "rtF"
	if err := h.process(t, body); err != nil {
		t.Fatal(err)
	}
	if len(h.minter.minted) != 0 || h.api.calls[0].msgs[0].Text != textFor(LanguageEnglish).Hello {
		t.Fatalf("bound user gets hello: minted=%v calls=%+v", h.minter.minted, h.api.calls)
	}
}

func TestWebhookJoinRepliesFreeAndNeverPushes(t *testing.T) {
	h := newWebhookHarness(t, "zh-Hant")
	h.q.token = "rtJ"
	if err := h.process(t, `{"destination":"Ubot","events":[{"type":"join","webhookEventId":"01J","replyToken":"rtJ","source":{"type":"group","groupId":"C1"}}]}`); err != nil {
		t.Fatal(err)
	}
	if len(h.api.calls) != 1 || h.api.calls[0].kind != "reply" || h.api.calls[0].msgs[0].Text != textFor(LanguageTraditionalChinese).Joined {
		t.Fatalf("calls = %+v", h.api.calls)
	}
	// No token left: a group notice is dropped instead of billed per member.
	h.api.calls = nil
	if err := h.process(t, `{"destination":"Ubot","events":[{"type":"join","webhookEventId":"01K","source":{"type":"group","groupId":"C1"}}]}`); err != nil {
		t.Fatal(err)
	}
	if len(h.api.calls) != 0 {
		t.Fatalf("group notice must not push: %+v", h.api.calls)
	}
}

func TestWebhookRouterErrorIsInfrastructure(t *testing.T) {
	h := newWebhookHarness(t, "en")
	h.handErr = errors.New("db down")
	err := h.process(t, `{"destination":"Ubot","events":[{"type":"message","replyToken":"rt","source":{"type":"user","userId":"U1"},"message":{"id":"m1","type":"text","text":"x"}}]}`)
	if err == nil || errors.Is(err, ErrWebhookNotFound) || errors.Is(err, ErrWebhookMalformed) {
		t.Fatalf("want an infrastructure error, got %v", err)
	}
}

func TestReplierVerdicts(t *testing.T) {
	inst := engine.ResolvedInstallation{ID: testUUID(9), WorkspaceID: testUUID(1), Platform: testInstallRow("active", "en")}
	direct := channel.InboundMessage{MessageID: "m1", Source: channel.Source{ChannelType: TypeLine, ChatID: "U1", ChatType: channel.ChatTypeP2P, SenderID: "U1"}}
	group := channel.InboundMessage{MessageID: "m2", AddressedToBot: true, Source: channel.Source{ChannelType: TypeLine, ChatID: "C1", ChatType: channel.ChatTypeGroup, SenderID: "U1"}}
	c := textFor(LanguageEnglish)

	cases := []struct {
		name string
		msg  channel.InboundMessage
		res  engine.Result
		want string
	}{
		{"offline", direct, engine.Result{Outcome: engine.OutcomeAgentOffline}, c.AgentOffline},
		{"archived", direct, engine.Result{Outcome: engine.OutcomeAgentArchived}, c.AgentArchived},
		{"fresh", direct, engine.Result{Outcome: engine.OutcomeFreshPending}, c.FreshPending},
		{"new chat", direct, engine.Result{Outcome: engine.OutcomeChatStarted}, c.ChatStarted},
		{"issue usage", direct, engine.Result{Outcome: engine.OutcomeIssueUsage}, c.IssueUsage},
		{"issue created", direct, engine.Result{Outcome: engine.OutcomeIngested, IssueID: testUUID(5), IssueIdentifier: "MUL-1", IssueTitle: "Fix login"}, "Created MUL-1: Fix login"},
		{"issue duplicate", direct, engine.Result{Outcome: engine.OutcomeIngested, IssueID: testUUID(5), IssueIdentifier: "MUL-1", IssueDuplicate: true}, "Not created: active issue MUL-1 already exists"},
		{"plain ingest says nothing", direct, engine.Result{Outcome: engine.OutcomeIngested}, ""},
		{"binding in group is a hint", group, engine.Result{Outcome: engine.OutcomeNeedsBinding}, c.BindInGroup},
		{"issue refusal non-member", channel.InboundMessage{Text: "/issue x", Source: direct.Source}, engine.Result{Outcome: engine.OutcomeDropped, DropReason: engine.DropReasonNonWorkspaceMember}, c.IssueNotMember},
		{"other drop says nothing", direct, engine.Result{Outcome: engine.OutcomeDropped, DropReason: engine.DropReasonNonWorkspaceMember}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeTokenStore{token: "rt"}
			api := &fakeMessenger{}
			minter := &fakeMinter{}
			r := newOutboundReplier(OutboundReplierConfig{Binding: minter, AppURL: "https://app", Logger: testLogger()}, store)
			r.tokens = newTokenSource(nil, "")
			r.newAPI = func(credentials) messenger { return api }
			r.Reply(context.Background(), inst, tc.msg, tc.res)
			if tc.want == "" {
				if len(api.calls) != 0 {
					t.Fatalf("want silence, got %+v", api.calls)
				}
				return
			}
			if len(api.calls) != 1 || api.calls[0].msgs[0].Text != tc.want {
				t.Fatalf("calls = %+v", api.calls)
			}
			if len(minter.minted) != 0 {
				t.Fatal("a group binding hint must not mint a bearer link")
			}
		})
	}
}

func TestReplierPushesDirectVerdictWithoutToken(t *testing.T) {
	inst := engine.ResolvedInstallation{ID: testUUID(9), Platform: testInstallRow("active", "en")}
	api := &fakeMessenger{}
	r := newOutboundReplier(OutboundReplierConfig{Logger: testLogger()}, &fakeTokenStore{})
	r.tokens = newTokenSource(nil, "")
	r.newAPI = func(credentials) messenger { return api }
	msg := channel.InboundMessage{MessageID: "m1", Source: channel.Source{ChatID: "U1", ChatType: channel.ChatTypeP2P}}
	r.Reply(context.Background(), inst, msg, engine.Result{Outcome: engine.OutcomeAgentOffline})
	if len(api.calls) != 1 || api.calls[0].kind != "push" || api.calls[0].retryKey == "" {
		t.Fatalf("calls = %+v", api.calls)
	}
}
