package line

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// outboundQueries is the slice of generated queries the outbound needs.
type outboundQueries interface {
	replyTokenStore
	GetAgentTask(ctx context.Context, id pgtype.UUID) (db.AgentTaskQueue, error)
	TaskHasChannelIngestedMessages(ctx context.Context, taskID pgtype.UUID) (bool, error)
	GetChannelTaskDelivery(ctx context.Context, taskID pgtype.UUID) (db.ChannelTaskDelivery, error)
	GetChannelInstallation(ctx context.Context, arg db.GetChannelInstallationParams) (db.ChannelInstallation, error)
	GetWorkspace(ctx context.Context, id pgtype.UUID) (db.Workspace, error)
	SetChatMessageChannelOutboundProvenanceByTask(ctx context.Context, arg db.SetChatMessageChannelOutboundProvenanceByTaskParams) (int64, error)
	RecordChannelOutboundMessage(ctx context.Context, arg db.RecordChannelOutboundMessageParams) error
	DeleteStaleLineReplyTokens(ctx context.Context, olderThan pgtype.Timestamptz) (int64, error)
}

// Outbound delivers an agent's answer back to LINE on chat-done: one request
// of at most five plain-text bubbles, by free reply when the chat has a fresh
// reply token, otherwise by push with a deterministic retry key. Sessions
// with no LINE delivery row are ignored, so it coexists with the other
// channels on the shared bus.
type Outbound struct {
	q       outboundQueries
	decrypt Decrypter
	tokens  *tokenSource
	appURL  string
	logger  *slog.Logger
	now     func() time.Time
	sleep   func(time.Duration)
	newAPI  func(creds credentials) messenger
	wg      sync.WaitGroup
}

// NewOutbound builds the LINE outbound. appURL is the web app base used for
// the "continued in Multica" link.
func NewOutbound(q *db.Queries, decrypt Decrypter, tokens *TokenSource, appURL string, logger *slog.Logger) *Outbound {
	return newOutbound(q, decrypt, tokens.ts, appURL, logger)
}

func newOutbound(q outboundQueries, decrypt Decrypter, tokens *tokenSource, appURL string, logger *slog.Logger) *Outbound {
	if logger == nil {
		logger = slog.Default()
	}
	o := &Outbound{
		q: q, decrypt: decrypt, tokens: tokens, appURL: strings.TrimRight(appURL, "/"),
		logger: logger, now: time.Now, sleep: time.Sleep,
	}
	o.newAPI = func(c credentials) messenger { return newBotAPI(o.tokens, c) }
	return o
}

// Register subscribes to chat-done and task-failed on the bus. A failed run
// gets a short notice so the chat is not left waiting; a cancelled run says
// nothing, because whoever cancelled it already knows.
func (o *Outbound) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventChatDone, o.handleEvent)
	bus.Subscribe(protocol.EventTaskFailed, o.handleEvent)
}

// Start runs the maintenance loop that purges stale reply tokens. It returns
// when ctx is done.
func (o *Outbound) Start(ctx context.Context) {
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			o.purge(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// WaitWithTimeout waits for in-flight deliveries and the maintenance loop.
func (o *Outbound) WaitWithTimeout(d time.Duration) bool {
	done := make(chan struct{})
	go func() { o.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

func (o *Outbound) purge(ctx context.Context) {
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := o.q.DeleteStaleLineReplyTokens(pctx, pgtype.Timestamptz{Time: o.now().Add(-time.Hour), Valid: true}); err != nil && ctx.Err() == nil {
		o.logger.Warn("line outbound: purge stale reply tokens failed", "error", err)
	}
}

func (o *Outbound) handleEvent(e events.Event) {
	// Bus delivery is synchronous; push retries can take a while, so the
	// delivery runs on its own goroutine with its own deadline.
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := o.processEvent(ctx, e); err != nil {
			// ErrQuotaExhausted lands here too: the answer stays in the
			// Multica chat, and retrying cannot help until the quota resets.
			o.logger.WarnContext(ctx, "line outbound: answer delivery failed",
				"error", err, "chat_session_id", e.ChatSessionID,
				"quota_exhausted", errors.Is(err, ErrQuotaExhausted))
		}
	}()
}

func (o *Outbound) processEvent(ctx context.Context, e events.Event) error {
	sessionID, err := util.ParseUUID(e.ChatSessionID)
	if err != nil || !sessionID.Valid {
		return nil
	}
	failed := e.Type == protocol.EventTaskFailed
	if failed && taskFailureRetryPending(e.Payload) {
		return nil // the retry answers the same turn
	}
	content := chatDoneContent(e.Payload)
	if !failed && strings.TrimSpace(content) == "" {
		return nil
	}
	taskID, ok := chatDoneTaskID(e)
	if !ok {
		return nil
	}
	delivery, err := o.q.GetChannelTaskDelivery(ctx, taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("lookup line task delivery: %w", err)
	}
	if delivery.ChannelType != string(TypeLine) {
		return nil
	}
	task, err := o.q.GetAgentTask(ctx, taskID)
	if err != nil {
		return fmt.Errorf("load agent task: %w", err)
	}
	// A web or mobile turn in a session that started in LINE stays in Multica.
	deliver, err := engine.TaskInputIsChannelIngested(ctx, o.q, task)
	if err != nil {
		return fmt.Errorf("classify task input origin: %w", err)
	}
	if !deliver {
		return nil
	}
	inst, err := o.q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{
		ID: delivery.InstallationID, ChannelType: string(TypeLine),
	})
	if err != nil {
		return fmt.Errorf("load line installation: %w", err)
	}
	if inst.Status != "active" {
		return nil
	}
	creds, err := decodeCredentials(inst.Config, o.decrypt)
	if err != nil {
		return fmt.Errorf("decode line credentials: %w", err)
	}
	chatID := deliveryChatID(delivery)
	seed := "task:" + util.UUIDToString(taskID)
	var bubbles []string
	if failed {
		bubbles = []string{textFor(creds.Language).TaskFailed}
		seed = "task-failed:" + util.UUIDToString(taskID)
	} else {
		bubbles = buildBubbles(content, textFor(creds.Language).Continued, o.chatURL(ctx, inst.WorkspaceID, sessionID))
	}
	s := &sender{store: o.q, api: o.newAPI(creds), now: o.now, sleep: o.sleep}
	result, err := s.send(ctx, sendRequest{
		InstallationID: delivery.InstallationID,
		ChatID:         chatID,
		Group:          delivery.ChatType == "group",
		Bubbles:        bubbles,
		RetryKeySeed:   seed,
		Quote:          true,
	})
	if err != nil {
		return err
	}
	if failed || len(result.MessageIDs) == 0 {
		// A failure notice is not the turn's answer: no assistant row to tag.
		return nil
	}
	rows, err := o.q.SetChatMessageChannelOutboundProvenanceByTask(ctx, db.SetChatMessageChannelOutboundProvenanceByTaskParams{
		ChannelType:    pgtype.Text{String: string(TypeLine), Valid: true},
		InstallationID: delivery.InstallationID,
		ChannelChatID:  pgtype.Text{String: chatID, Valid: true},
		MessageIds:     result.MessageIDs,
		TaskID:         taskID,
	})
	if err != nil {
		return fmt.Errorf("record line reply provenance: %w", err)
	}
	if rows != 1 {
		o.logger.WarnContext(ctx, "line outbound: provenance updated an unexpected number of rows", "rows", rows)
	}
	for _, id := range result.MessageIDs {
		if err := o.q.RecordChannelOutboundMessage(ctx, db.RecordChannelOutboundMessageParams{
			OutboundInstallationID: delivery.InstallationID,
			OutboundChannelType:    delivery.ChannelType,
			OutboundMessageID:      id,
			OutboundBindingID:      delivery.BindingID,
			OutboundRouteRevision:  delivery.RouteRevision,
			OutboundTaskID:         taskID,
			OutboundKind:           "task_reply",
		}); err != nil {
			return fmt.Errorf("record line outbound message: %w", err)
		}
	}
	return nil
}

// chatURL links the continuation line to the session in the web app.
func (o *Outbound) chatURL(ctx context.Context, workspaceID, sessionID pgtype.UUID) string {
	if o.appURL == "" {
		return ""
	}
	ws, err := o.q.GetWorkspace(ctx, workspaceID)
	if err != nil || ws.Slug == "" {
		return o.appURL
	}
	return o.appURL + "/" + url.PathEscape(ws.Slug) + "/chat?session=" + url.QueryEscape(util.UUIDToString(sessionID))
}

// deliveryChatID reads the LINE user, group or room ID from the binding
// config, falling back to the binding key (they are equal for LINE).
func deliveryChatID(d db.ChannelTaskDelivery) string {
	if len(d.Config) > 0 {
		var cfg lineBindingConfig
		if err := json.Unmarshal(d.Config, &cfg); err == nil && cfg.ChatID != "" {
			return cfg.ChatID
		}
	}
	return d.ChannelChatID
}

func chatDoneTaskID(e events.Event) (pgtype.UUID, bool) {
	raw := e.TaskID
	if raw == "" {
		switch p := e.Payload.(type) {
		case protocol.ChatDonePayload:
			raw = p.TaskID
		case map[string]any:
			raw, _ = p["task_id"].(string)
		}
	}
	id, err := util.ParseUUID(raw)
	return id, err == nil && id.Valid
}

func taskFailureRetryPending(payload any) bool {
	fields, ok := payload.(map[string]any)
	if !ok {
		return false
	}
	pending, _ := fields["retry_pending"].(bool)
	return pending
}

func chatDoneContent(payload any) string {
	switch p := payload.(type) {
	case protocol.ChatDonePayload:
		return p.Content
	case map[string]any:
		if s, ok := p["content"].(string); ok {
			return s
		}
	}
	return ""
}
