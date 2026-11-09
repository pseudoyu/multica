package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/integrations/line"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestLineHandlersWhenNotConfigured(t *testing.T) {
	h := &Handler{}
	w := httptest.NewRecorder()
	h.ListLineInstallations(w, httptest.NewRequest(http.MethodGet, "/api/workspaces/x/line/installations", nil))
	var resp struct {
		Installations    []any `json:"installations"`
		Configured       bool  `json:"configured"`
		InstallSupported bool  `json:"install_supported"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &resp) != nil || resp.Configured || resp.InstallSupported || len(resp.Installations) != 0 {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	for name, run := range map[string]func(*Handler, http.ResponseWriter, *http.Request){
		"register": (*Handler).RegisterLineChannel,
		"revoke":   (*Handler).RevokeLineInstallation,
		"redeem":   (*Handler).RedeemLineBindingToken,
	} {
		w := httptest.NewRecorder()
		run(h, w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{}`)))
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s: want 403, got %d %s", name, w.Code, w.Body.String())
		}
	}
	w = httptest.NewRecorder()
	h.HandleLineWebhook(w, withURLParam(httptest.NewRequest(http.MethodPost, "/api/webhooks/line/x", strings.NewReader(`{}`)), "installationId", "11111111-1111-1111-1111-111111111111"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("webhook when disabled: want 404, got %d", w.Code)
	}
}

func TestLineInstallationResponseNeverExposesSecret(t *testing.T) {
	now := time.Date(2026, 11, 10, 1, 0, 0, 0, time.UTC)
	row := db.ChannelInstallation{
		ID: parseUUID("11111111-1111-1111-1111-111111111111"), WorkspaceID: parseUUID("22222222-2222-2222-2222-222222222222"),
		AgentID: parseUUID("33333333-3333-3333-3333-333333333333"), InstallerUserID: parseUUID("44444444-4444-4444-4444-444444444444"),
		Status:      "active",
		Config:      json.RawMessage(`{"app_id":"Ubot","channel_id":"1650000000","basic_id":"@abc","display_name":"Multica","channel_secret_encrypted":"ciphertext-sentinel","language":"ja"}`),
		InstalledAt: pgtype.Timestamptz{Time: now, Valid: true}, CreatedAt: pgtype.Timestamptz{Time: now, Valid: true}, UpdatedAt: pgtype.Timestamptz{Time: now, Valid: true},
	}
	got := (&Handler{}).lineInstallationToResponse(row)
	if got.BotUserID != "Ubot" || got.ChannelID != "1650000000" || got.BasicID != "@abc" || got.Language != "ja" {
		t.Fatalf("response = %+v", got)
	}
	payload, _ := json.Marshal(got)
	if strings.Contains(string(payload), "ciphertext-sentinel") || strings.Contains(string(payload), "channel_secret") {
		t.Fatalf("response exposed the secret: %s", payload)
	}
}

func signLine(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// lineMockAPI stands in for api.line.me: it mints tokens and records replies.
type lineMockAPI struct {
	mu      sync.Mutex
	replies []map[string]any
	pushes  []map[string]any
	srv     *httptest.Server
}

func newLineMockAPI(t *testing.T) *lineMockAPI {
	m := &lineMockAPI{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		var body map[string]any
		switch r.URL.Path {
		case "/oauth2/v3/token":
			_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":900,"token_type":"Bearer"}`))
			return
		case "/v2/bot/message/reply":
			_ = json.NewDecoder(r.Body).Decode(&body)
			m.replies = append(m.replies, body)
		case "/v2/bot/message/push":
			_ = json.NewDecoder(r.Body).Decode(&body)
			m.pushes = append(m.pushes, body)
		}
		_, _ = w.Write([]byte(`{"sentMessages":[{"id":"sent-1","quoteToken":"sq"}]}`))
	}))
	t.Cleanup(m.srv.Close)
	return m
}

// This test keeps only LINE itself outside the process: a signed webhook goes
// through the production handler, the LINE resolvers, the shared Router,
// TaskService and the PostgreSQL queue, and the chat-done answer goes out
// through the LINE outbound to a mock Messaging API, spending the reply token
// the webhook recorded.
func TestLineWebhookE2EQueuesTaskAndAnswersWithReplyToken(t *testing.T) {
	if testHandler == nil {
		t.Fatal("database-backed handler test fixture is required")
	}
	ctx := context.Background()
	queries := db.New(testPool)
	agentID, _, _ := createRuntimeGuardAgent(t, ctx)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	botUserID := "Ue2ebot" + strings.ReplaceAll(t.Name(), "/", "")
	cfg, _ := json.Marshal(map[string]string{
		"app_id": botUserID, "channel_id": "1650000000", "language": "en",
		// The webhook runs with a nil decrypter here, so these are the bytes.
		"channel_secret_encrypted": base64.StdEncoding.EncodeToString([]byte("e2e-secret")),
	})
	var installationID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO channel_installation (workspace_id, agent_id, channel_type, config, status, installer_user_id)
		VALUES ($1, $2, 'line', $3, 'active', $4) RETURNING id
	`, testWorkspaceID, agentID, cfg, testUserID).Scan(&installationID); err != nil {
		t.Fatalf("create installation: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO channel_user_binding (workspace_id, multica_user_id, installation_id, channel_type, channel_user_id, config)
		VALUES ($1, $2, $3, 'line', 'Ue2euser', '{}'::jsonb)
	`, testWorkspaceID, testUserID, installationID); err != nil {
		t.Fatalf("bind user: %v", err)
	}
	t.Cleanup(func() {
		c := context.Background()
		testPool.Exec(c, `DELETE FROM chat_message WHERE chat_session_id IN (SELECT id FROM chat_session WHERE agent_id = $1)`, agentID)
		testPool.Exec(c, `DELETE FROM agent_task_queue WHERE agent_id = $1`, agentID)
		testPool.Exec(c, `DELETE FROM chat_session WHERE agent_id = $1`, agentID)
		for _, table := range []string{"channel_task_delivery", "channel_outbound_message", "channel_inbound_message_dedup",
			"channel_chat_session_binding", "channel_user_binding", "line_reply_token"} {
			testPool.Exec(c, `DELETE FROM `+table+` WHERE installation_id = $1`, installationID)
		}
		testPool.Exec(c, `DELETE FROM channel_installation WHERE id = $1`, installationID)
	})

	router := engine.NewRouter(nil, testHandler.TaskService, queries, engine.RouterConfig{Logger: logger})
	router.Register(line.TypeLine, line.NewLineResolverSet(queries, testPool, nil, nil))
	prev := testHandler.LineWebhook
	testHandler.LineWebhook = line.NewWebhook(queries, nil, router.Handle, nil, logger)
	t.Cleanup(func() { testHandler.LineWebhook = prev })

	post := func(body, sig string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/webhooks/line/"+installationID, strings.NewReader(body))
		req.Header.Set(line.SignatureHeader, sig)
		req.RemoteAddr = "203.0.113.9:443"
		req = withURLParam(req, "installationId", installationID)
		w := httptest.NewRecorder()
		testHandler.HandleLineWebhook(w, req)
		return w.Code
	}

	body := `{"destination":"` + botUserID + `","events":[{"type":"message","mode":"active","webhookEventId":"01E2E","replyToken":"rt-e2e",
		"timestamp":1,"source":{"type":"user","userId":"Ue2euser"},
		"message":{"id":"msg-e2e","type":"text","text":"summarize the repo","quoteToken":"q-e2e"}}]}`
	if code := post(body, signLine("wrong", []byte(body))); code != http.StatusUnauthorized {
		t.Fatalf("bad signature: want 401, got %d", code)
	}
	if code := post(body, signLine("e2e-secret", []byte(body))); code != http.StatusOK {
		t.Fatalf("webhook: want 200, got %d", code)
	}
	// LINE redelivers on timeouts: the same message must not queue twice.
	if code := post(body, signLine("e2e-secret", []byte(body))); code != http.StatusOK {
		t.Fatalf("redelivery: want 200, got %d", code)
	}
	if !router.Drain(ctx) {
		t.Fatal("router drain timed out")
	}

	var taskID, sessionID string
	var tasks int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) OVER (), task.id, task.chat_session_id
		FROM agent_task_queue AS task
		JOIN channel_task_delivery AS d ON d.task_id = task.id
		WHERE d.installation_id = $1 AND d.channel_type = 'line'
		LIMIT 1
	`, installationID).Scan(&tasks, &taskID, &sessionID); err != nil {
		t.Fatalf("load queued task: %v", err)
	}
	if tasks != 1 {
		t.Fatalf("queued %d tasks, want 1", tasks)
	}
	var stored string
	if err := testPool.QueryRow(ctx, `SELECT content FROM chat_message WHERE chat_session_id = $1 AND role = 'user'`, sessionID).Scan(&stored); err != nil || stored != "summarize the repo" {
		t.Fatalf("stored user message = %q, %v", stored, err)
	}

	mock := newLineMockAPI(t)
	outbound := line.NewOutbound(queries, nil, line.NewTokenSource(mock.srv.Client(), mock.srv.URL), "https://app.example", logger)
	bus := events.New()
	outbound.Register(bus)
	bus.Publish(events.Event{
		Type: protocol.EventChatDone, WorkspaceID: testWorkspaceID, ChatSessionID: sessionID, TaskID: taskID,
		Payload: protocol.ChatDonePayload{TaskID: taskID, ChatSessionID: sessionID, Content: "**Answer** from the agent"},
	})
	if !outbound.WaitWithTimeout(10 * time.Second) {
		t.Fatal("outbound did not finish")
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.pushes) != 0 || len(mock.replies) != 1 {
		t.Fatalf("want one free reply, got replies=%v pushes=%v", mock.replies, mock.pushes)
	}
	reply := mock.replies[0]
	msgs, _ := json.Marshal(reply["messages"])
	if reply["replyToken"] != "rt-e2e" || !strings.Contains(string(msgs), `"text":"Answer from the agent"`) || !strings.Contains(string(msgs), `"quoteToken":"q-e2e"`) {
		t.Fatalf("reply = %v", reply)
	}
}
