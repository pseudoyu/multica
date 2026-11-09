package line

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// mockLINE is an in-process stand-in for api.line.me. It mints tokens and
// records every Messaging API call.
type mockLINE struct {
	t    *testing.T
	mu   sync.Mutex
	srv  *httptest.Server
	mint int
	// rejectToken makes the next call with this bearer answer 401.
	rejectToken string
	calls       []mockCall
	// handlers override the default 200 {} per path.
	handlers map[string]func(w http.ResponseWriter, r *http.Request, body map[string]any)
}

type mockCall struct {
	Method, Path, Auth, RetryKey string
	Body                         map[string]any
}

func newMockLINE(t *testing.T) *mockLINE {
	m := &mockLINE{t: t, handlers: map[string]func(http.ResponseWriter, *http.Request, map[string]any){}}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockLINE) serve(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r.URL.Path == "/oauth2/v3/token" {
		_ = r.ParseForm()
		if r.Form.Get("client_secret") != "secret" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		m.mint++
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok" + string(rune('0'+m.mint)), "expires_in": 900, "token_type": "Bearer"})
		return
	}
	auth := r.Header.Get("Authorization")
	if m.rejectToken != "" && auth == "Bearer "+m.rejectToken {
		m.rejectToken = ""
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Authentication failed"}`))
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	m.calls = append(m.calls, mockCall{Method: r.Method, Path: r.URL.Path, Auth: auth, RetryKey: r.Header.Get("X-Line-Retry-Key"), Body: body})
	if h, ok := m.handlers[r.URL.Path]; ok {
		h(w, r, body)
		return
	}
	_, _ = w.Write([]byte(`{}`))
}

func (m *mockLINE) tokens() *tokenSource { return newTokenSource(m.srv.Client(), m.srv.URL) }

func (m *mockLINE) callsTo(path string) []mockCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []mockCall
	for _, c := range m.calls {
		if c.Path == path {
			out = append(out, c)
		}
	}
	return out
}

var testCreds = credentials{BotUserID: "Ubot", ChannelID: "1650000000", ChannelSecret: "secret", Language: LanguageEnglish}

func TestBotAPIRetriesOnceAfter401WithFreshToken(t *testing.T) {
	m := newMockLINE(t)
	m.rejectToken = "tok1"
	m.handlers["/v2/bot/info"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		_, _ = w.Write([]byte(`{"userId":"Ubot","basicId":"@abc","displayName":"Multica"}`))
	}
	info, err := newBotAPI(m.tokens(), testCreds).GetBotInfo(context.Background())
	if err != nil || info.UserID != "Ubot" || info.BasicID != "@abc" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	calls := m.callsTo("/v2/bot/info")
	if m.mint != 2 || len(calls) != 1 || calls[0].Auth != "Bearer tok2" {
		t.Fatalf("mint=%d calls=%+v", m.mint, calls)
	}
}

func TestBotAPIPushCarriesRetryKeyAndTreats409AsDelivered(t *testing.T) {
	m := newMockLINE(t)
	m.handlers["/v2/bot/message/push"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"The retry key is already accepted","sentMessages":[{"id":"orig1","quoteToken":"q"}]}`))
	}
	resp, err := newBotAPI(m.tokens(), testCreds).Push(context.Background(), "U1", "key-1", []message{{Type: "text", Text: "hi"}})
	if err != nil || len(resp.SentMessages) != 1 || resp.SentMessages[0].ID != "orig1" {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	c := m.callsTo("/v2/bot/message/push")[0]
	if c.RetryKey != "key-1" || c.Body["to"] != "U1" {
		t.Fatalf("push call = %+v", c)
	}
}

func TestBotAPIReturnsTypedErrors(t *testing.T) {
	m := newMockLINE(t)
	m.handlers["/v2/bot/message/push"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"message":"You have reached your monthly limit."}`))
	}
	_, err := newBotAPI(m.tokens(), testCreds).Push(context.Background(), "U1", "k", []message{{Type: "text", Text: "x"}})
	var apiErr *apiError
	if !errors.As(err, &apiErr) || !apiErr.isMonthlyLimit() {
		t.Fatalf("want monthly-limit apiError, got %v", err)
	}

	bad := testCreds
	bad.ChannelSecret = "wrong"
	if _, err := newBotAPI(m.tokens(), bad).GetBotInfo(context.Background()); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
}

func TestBotAPIRequestShapes(t *testing.T) {
	m := newMockLINE(t)
	m.handlers["/v2/bot/channel/webhook/test"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		_, _ = w.Write([]byte(`{"success":true,"statusCode":200,"reason":"OK"}`))
	}
	api := newBotAPI(m.tokens(), testCreds)
	ctx := context.Background()
	if err := api.SetWebhookEndpoint(ctx, "https://x/api/webhooks/line/1"); err != nil {
		t.Fatal(err)
	}
	res, err := api.TestWebhookEndpoint(ctx, "https://x/api/webhooks/line/1")
	if err != nil || !res.Success {
		t.Fatalf("test=%+v err=%v", res, err)
	}
	if err := api.StartLoading(ctx, "U1", 60); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Reply(ctx, "rt", []message{{Type: "text", Text: "hi", QuoteToken: "q"}}); err != nil {
		t.Fatal(err)
	}
	if c := m.callsTo("/v2/bot/channel/webhook/endpoint")[0]; c.Method != http.MethodPut || c.Body["endpoint"] != "https://x/api/webhooks/line/1" {
		t.Fatalf("set endpoint = %+v", c)
	}
	if c := m.callsTo("/v2/bot/chat/loading/start")[0]; c.Body["chatId"] != "U1" || c.Body["loadingSeconds"] != float64(60) {
		t.Fatalf("loading = %+v", c)
	}
	c := m.callsTo("/v2/bot/message/reply")[0]
	msgs, _ := json.Marshal(c.Body["messages"])
	if c.Body["replyToken"] != "rt" || !strings.Contains(string(msgs), `"quoteToken":"q"`) {
		t.Fatalf("reply = %+v", c)
	}
}
