package line

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// fakeClock advances only when the notifier waits, so the watch loop runs
// synchronously through 45 s notices and 50 s renewals.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }
func (c *fakeClock) after(d time.Duration) <-chan time.Time {
	if d > 0 {
		c.t = c.t.Add(d)
	}
	ch := make(chan time.Time, 1)
	ch <- c.t
	return ch
}

type fakePending struct{ remaining int }

func (f *fakePending) HasPendingChatTurnForSession(context.Context, pgtype.UUID) (bool, error) {
	if f.remaining <= 0 {
		return false, nil
	}
	f.remaining--
	return true, nil
}

func newTestNotifier(pending *fakePending, store *fakeTokenStore, clock *fakeClock) *typingNotifier {
	n := newTypingNotifier(context.Background(), pending, store, nil, newTokenSource(nil, ""), testLogger())
	n.now, n.after, n.sleepFor = clock.now, clock.after, func(time.Duration) {}
	return n
}

func TestTypingDirectRenewsLoadingAndSendsNoticeAt45s(t *testing.T) {
	start := time.Unix(1_000_000, 0)
	clock := &fakeClock{t: start}
	// Still pending at the 45 s, 95 s and 145 s checks; settled at 195 s.
	pending := &fakePending{remaining: 3}
	store := &fakeTokenStore{token: "rt"}
	n := newTestNotifier(pending, store, clock)
	api := &fakeMessenger{}
	n.watch(testUUID(9), testCreds, api, "U1", true, testUUID(4), start)

	if len(api.calls) != 1 || api.calls[0].kind != "reply" || api.calls[0].msgs[0].Text != textFor(LanguageEnglish).WorkingOnIt {
		t.Fatalf("want exactly one free notice, got %+v", api.calls)
	}
	// A restart after the notice (it clears the animation), then two renewals.
	if len(api.loading) != 3 {
		t.Fatalf("loading renewals = %d, want 3", len(api.loading))
	}
	if store.takes[0].FreshAfter.Time != start.Add(workingNoticeAge-replyTokenMaxAge) {
		t.Fatalf("notice spent a token from %v", store.takes[0].FreshAfter.Time)
	}
}

func TestTypingSkipsNoticeWhenTurnAlreadyAnswered(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_000_000, 0)}
	n := newTestNotifier(&fakePending{remaining: 0}, &fakeTokenStore{token: "rt"}, clock)
	api := &fakeMessenger{}
	n.watch(testUUID(9), testCreds, api, "C1", false, testUUID(4), clock.t)
	if len(api.calls) != 0 {
		t.Fatalf("a settled turn gets no notice: %+v", api.calls)
	}
}

func TestTypingGroupNoticeIsReplyOnly(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_000_000, 0)}
	// The answer path already spent the token: nothing may be pushed.
	n := newTestNotifier(&fakePending{remaining: 5}, &fakeTokenStore{}, clock)
	api := &fakeMessenger{}
	n.watch(testUUID(9), testCreds, api, "C1", false, testUUID(4), clock.t)
	if len(api.calls) != 0 || len(api.loading) != 0 {
		t.Fatalf("group: calls=%+v loading=%v", api.calls, api.loading)
	}
}

func TestTypingStopsAtCap(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_000_000, 0)}
	n := newTestNotifier(&fakePending{remaining: 1 << 20}, &fakeTokenStore{}, clock)
	api := &fakeMessenger{}
	n.watch(testUUID(9), testCreds, api, "U1", true, testUUID(4), clock.t)
	if clock.t.Sub(time.Unix(1_000_000, 0)) > loadingCap {
		t.Fatalf("watched past the cap: %v", clock.t.Sub(time.Unix(1_000_000, 0)))
	}
	if n := len(api.loading); n < 30 || n > 40 {
		t.Fatalf("renewals over 30 minutes = %d", n)
	}
}

type fakeOutboundQueries struct {
	*fakeTokenStore
	delivery    db.ChannelTaskDelivery
	deliveryErr error
	task        db.AgentTaskQueue
	ingested    bool
	inst        db.ChannelInstallation
	ws          db.Workspace
	provenance  []db.SetChatMessageChannelOutboundProvenanceByTaskParams
	recordedOut []db.RecordChannelOutboundMessageParams
}

func (f *fakeOutboundQueries) GetAgentTask(context.Context, pgtype.UUID) (db.AgentTaskQueue, error) {
	return f.task, nil
}
func (f *fakeOutboundQueries) TaskHasChannelIngestedMessages(context.Context, pgtype.UUID) (bool, error) {
	return f.ingested, nil
}
func (f *fakeOutboundQueries) GetChannelTaskDelivery(context.Context, pgtype.UUID) (db.ChannelTaskDelivery, error) {
	return f.delivery, f.deliveryErr
}
func (f *fakeOutboundQueries) GetChannelInstallation(context.Context, db.GetChannelInstallationParams) (db.ChannelInstallation, error) {
	return f.inst, nil
}
func (f *fakeOutboundQueries) GetWorkspace(context.Context, pgtype.UUID) (db.Workspace, error) {
	return f.ws, nil
}
func (f *fakeOutboundQueries) SetChatMessageChannelOutboundProvenanceByTask(_ context.Context, p db.SetChatMessageChannelOutboundProvenanceByTaskParams) (int64, error) {
	f.provenance = append(f.provenance, p)
	return 1, nil
}
func (f *fakeOutboundQueries) RecordChannelOutboundMessage(_ context.Context, p db.RecordChannelOutboundMessageParams) error {
	f.recordedOut = append(f.recordedOut, p)
	return nil
}

const testTaskID = "0193c2d4-5b6a-7e8f-9a0b-1c2d3e4f5a6b"
const testSessionID = "11111111-2222-3333-4444-555555555555"

func newOutboundHarness(chatType string) (*Outbound, *fakeOutboundQueries, *fakeMessenger) {
	cfg, _ := json.Marshal(lineBindingConfig{ChatID: "C1"})
	q := &fakeOutboundQueries{
		fakeTokenStore: &fakeTokenStore{ctx: db.GetLineReplyContextRow{QuoteToken: "q1", SenderUserID: "U1"}},
		delivery:       db.ChannelTaskDelivery{InstallationID: testUUID(9), BindingID: testUUID(8), ChannelType: "line", ChannelChatID: "C1", ChatType: chatType, Config: cfg},
		// The task's input batch came in from LINE.
		task:     db.AgentTaskQueue{ID: util.MustParseUUID(testTaskID), ChatInputTaskID: testUUID(6)},
		ingested: true,
		inst:     testInstallRow("active", "en"),
		ws:       db.Workspace{Slug: "acme"},
	}
	api := &fakeMessenger{pushResp: sendResponse{SentMessages: []sentMessage{{ID: "p1"}, {ID: "p2"}}}}
	o := newOutbound(q, nil, newTokenSource(nil, ""), "https://app.example", testLogger())
	o.newAPI = func(credentials) messenger { return api }
	o.sleep = func(time.Duration) {}
	return o, q, api
}

func doneEvent(content string) events.Event {
	return events.Event{
		Type: protocol.EventChatDone, ChatSessionID: testSessionID, TaskID: testTaskID,
		Payload: protocol.ChatDonePayload{TaskID: testTaskID, Content: content},
	}
}

func TestOutboundPushesAnswerAndRecordsProvenance(t *testing.T) {
	o, q, api := newOutboundHarness("group")
	if err := o.processEvent(context.Background(), doneEvent("**Done.** See [docs](https://d.example).")); err != nil {
		t.Fatal(err)
	}
	if len(api.calls) != 1 || api.calls[0].kind != "push" || api.calls[0].to != "C1" {
		t.Fatalf("calls = %+v", api.calls)
	}
	first := api.calls[0].msgs[0]
	if first.Type != "textV2" || first.Text != "{asker} Done. See docs https://d.example." || first.QuoteToken != "q1" {
		t.Fatalf("first bubble = %+v", first)
	}
	if len(q.provenance) != 1 || len(q.provenance[0].MessageIds) != 2 || len(q.recordedOut) != 2 {
		t.Fatalf("provenance=%+v outbound=%+v", q.provenance, q.recordedOut)
	}

	// The same task retried derives the same retry key.
	o2, _, api2 := newOutboundHarness("group")
	_ = o2.processEvent(context.Background(), doneEvent("**Done.**"))
	if api2.calls[0].retryKey != api.calls[0].retryKey {
		t.Fatal("retry key must depend only on the task")
	}
}

func TestOutboundRepliesFreeWhenTokenFresh(t *testing.T) {
	o, q, api := newOutboundHarness("p2p")
	q.token = "rt"
	if err := o.processEvent(context.Background(), doneEvent("hi")); err != nil {
		t.Fatal(err)
	}
	if api.calls[0].kind != "reply" || api.calls[0].msgs[0].Type != "text" {
		t.Fatalf("calls = %+v", api.calls)
	}
}

func TestOutboundLongAnswerEndsWithChatLink(t *testing.T) {
	o, _, api := newOutboundHarness("p2p")
	var paras []string
	for i := 0; i < 7; i++ {
		paras = append(paras, strings.Repeat("x", 4000))
	}
	if err := o.processEvent(context.Background(), doneEvent(strings.Join(paras, "\n\n"))); err != nil {
		t.Fatal(err)
	}
	msgs := api.calls[0].msgs
	want := "https://app.example/acme/chat?session=" + testSessionID
	if len(msgs) != 5 || !strings.HasSuffix(msgs[4].Text, want) {
		t.Fatalf("bubbles=%d last suffix=%q", len(msgs), msgs[len(msgs)-1].Text[max(0, len(msgs[len(msgs)-1].Text)-80):])
	}
}

func TestOutboundSkipsWhatIsNotItsToSend(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*fakeOutboundQueries)
		event events.Event
	}{
		{"no session", nil, events.Event{Type: protocol.EventChatDone, TaskID: testTaskID, Payload: protocol.ChatDonePayload{Content: "x"}}},
		{"empty content", nil, doneEvent("  ")},
		{"no delivery row", func(q *fakeOutboundQueries) { q.deliveryErr = pgx.ErrNoRows }, doneEvent("x")},
		{"another channel", func(q *fakeOutboundQueries) { q.delivery.ChannelType = "telegram" }, doneEvent("x")},
		{"revoked installation", func(q *fakeOutboundQueries) { q.inst.Status = "revoked" }, doneEvent("x")},
		{"web turn in a LINE session", func(q *fakeOutboundQueries) { q.ingested = false }, doneEvent("x")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o, q, api := newOutboundHarness("p2p")
			if tc.setup != nil {
				tc.setup(q)
			}
			if err := o.processEvent(context.Background(), tc.event); err != nil {
				t.Fatal(err)
			}
			if len(api.calls) != 0 {
				t.Fatalf("must not send: %+v", api.calls)
			}
		})
	}
}

func TestOutboundQuotaExhaustedIsReported(t *testing.T) {
	o, _, api := newOutboundHarness("p2p")
	api.pushErrs = []error{&apiError{Status: 429, Message: "You have reached your monthly limit."}}
	if err := o.processEvent(context.Background(), doneEvent("x")); !errors.Is(err, ErrQuotaExhausted) {
		t.Fatalf("want ErrQuotaExhausted, got %v", err)
	}
}

func TestOutboundPurgesStaleTokens(t *testing.T) {
	o, q, _ := newOutboundHarness("p2p")
	now := time.Unix(2_000_000, 0)
	o.now = func() time.Time { return now }
	o.purge(context.Background())
	if len(q.purged) != 1 || !q.purged[0].Time.Equal(now.Add(-time.Hour)) {
		t.Fatalf("purged = %+v", q.purged)
	}
}
