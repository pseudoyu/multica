package line

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// testPool backs the tests that run the real line_reply_token and binding
// queries. Without a database they skip, the same contract as the other
// DB-backed packages.
var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://multica:multica@localhost:5432/multica?sslmode=disable"
	}
	if pool, err := pgxpool.New(ctx, dbURL); err == nil {
		if err := pool.Ping(ctx); err == nil {
			testPool = pool
		} else {
			fmt.Printf("Skipping LINE database tests: database not reachable: %v\n", err)
			pool.Close()
		}
	} else {
		fmt.Printf("Skipping LINE database tests: could not connect: %v\n", err)
	}
	code := m.Run()
	if testPool != nil {
		testPool.Close()
	}
	os.Exit(code)
}

func requireDB(t *testing.T) *db.Queries {
	t.Helper()
	if testPool == nil {
		t.Skip("no database")
	}
	return db.New(testPool)
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func TestReplyTokenQueries(t *testing.T) {
	q := requireDB(t)
	ctx := context.Background()
	inst := dbid.NewV7()
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM line_reply_token WHERE installation_id = $1`, inst)
	})
	now := time.Now().UTC().Truncate(time.Millisecond)

	record := func(token string, at time.Time, addressed bool, quote, sender, msgID string) {
		t.Helper()
		if err := q.RecordLineReplyToken(ctx, db.RecordLineReplyTokenParams{
			InstallationID: inst, ChatID: "C1", ReplyToken: pgtype.Text{String: token, Valid: true}, ReceivedAt: ts(at),
			Addressed: addressed, QuoteToken: quote, SenderUserID: sender, MessageID: msgID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	record("rt-mention", now.Add(-10*time.Second), true, "q1", "Uasker", "m1")
	// Group chatter after the mention refreshes the token, keeps the quote.
	record("rt-chatter", now.Add(-5*time.Second), false, "q2", "Uother", "m2")
	// A redelivered older event must not overwrite the newer token.
	record("rt-old", now.Add(-30*time.Second), true, "q0", "U0", "m0")

	rc, err := q.GetLineReplyContext(ctx, db.GetLineReplyContextParams{InstallationID: inst, ChatID: "C1"})
	if err != nil || rc.QuoteToken != "q1" || rc.SenderUserID != "Uasker" || rc.MessageID != "m1" {
		t.Fatalf("context = %+v, %v", rc, err)
	}
	// Too old for the requested freshness: not taken.
	if _, err := q.TakeLineReplyToken(ctx, db.TakeLineReplyTokenParams{InstallationID: inst, ChatID: "C1", FreshAfter: ts(now.Add(-time.Second))}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("stale take: %v", err)
	}
	tok, err := q.TakeLineReplyToken(ctx, db.TakeLineReplyTokenParams{InstallationID: inst, ChatID: "C1", FreshAfter: ts(now.Add(-50 * time.Second))})
	if err != nil || tok != "rt-chatter" {
		t.Fatalf("take = %q, %v", tok, err)
	}
	if _, err := q.TakeLineReplyToken(ctx, db.TakeLineReplyTokenParams{InstallationID: inst, ChatID: "C1", FreshAfter: ts(now.Add(-50 * time.Second))}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a token can be taken once: %v", err)
	}
	// Quote context survives the take.
	if rc, _ := q.GetLineReplyContext(ctx, db.GetLineReplyContextParams{InstallationID: inst, ChatID: "C1"}); rc.QuoteToken != "q1" {
		t.Fatalf("quote lost after take: %+v", rc)
	}

	if n, err := q.DeleteStaleLineReplyTokens(ctx, ts(now.Add(time.Second))); err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
}

func TestReplyTokenTakenByOnlyOneConcurrentSender(t *testing.T) {
	q := requireDB(t)
	ctx := context.Background()
	inst := dbid.NewV7()
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM line_reply_token WHERE installation_id = $1`, inst)
	})
	now := time.Now().UTC()
	if err := q.RecordLineReplyToken(ctx, db.RecordLineReplyTokenParams{
		InstallationID: inst, ChatID: "U1", ReplyToken: pgtype.Text{String: "rt", Valid: true}, ReceivedAt: ts(now), Addressed: true,
	}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tok, err := q.TakeLineReplyToken(ctx, db.TakeLineReplyTokenParams{InstallationID: inst, ChatID: "U1", FreshAfter: ts(now.Add(-time.Minute))}); err == nil && tok == "rt" {
				mu.Lock()
				got++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if got != 1 {
		t.Fatalf("token taken %d times, want 1", got)
	}
}

func TestBindingRedeemBindsLineUser(t *testing.T) {
	q := requireDB(t)
	ctx := context.Background()
	var userID, wsID, agentID, runtimeID, instID pgtype.UUID
	suffix := dbid.NewV7()
	slug := "line-bind-" + fmt.Sprintf("%x", suffix.Bytes[10:])
	if err := testPool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ('LINE Tester', $1) RETURNING id`, slug+"@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO workspace (name, slug, issue_prefix) VALUES ('LINE WS', $1, 'LIN') RETURNING id`, slug).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata)
		VALUES ($1, 'line-rt', 'cloud', 'line_test', 'offline', '', '{}'::jsonb) RETURNING id`, wsID).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO agent (workspace_id, name, runtime_mode, runtime_config, runtime_id, visibility, max_concurrent_tasks, owner_id)
		VALUES ($1, 'LINE Agent', 'cloud', '{}'::jsonb, $2, 'workspace', 1, $3) RETURNING id`, wsID, runtimeID, userID).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(ctx, `INSERT INTO channel_installation (workspace_id, agent_id, channel_type, config, status, installer_user_id)
		VALUES ($1, $2, 'line', '{"app_id":"Ubind"}'::jsonb, 'active', $3) RETURNING id`, wsID, agentID, userID).Scan(&instID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		testPool.Exec(c, `DELETE FROM channel_user_binding WHERE installation_id = $1`, instID)
		testPool.Exec(c, `DELETE FROM channel_binding_token WHERE installation_id = $1`, instID)
		testPool.Exec(c, `DELETE FROM channel_installation WHERE id = $1`, instID)
		testPool.Exec(c, `DELETE FROM agent WHERE id = $1`, agentID)
		testPool.Exec(c, `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
		testPool.Exec(c, `DELETE FROM member WHERE workspace_id = $1`, wsID)
		testPool.Exec(c, `DELETE FROM workspace WHERE id = $1`, wsID)
		testPool.Exec(c, `DELETE FROM "user" WHERE id = $1`, userID)
	})

	svc := NewBindingTokenService(q, testPool)
	tok, err := svc.Mint(ctx, wsID, instID, "Uline1")
	if err != nil {
		t.Fatal(err)
	}
	got, err := svc.RedeemAndBind(ctx, tok.Raw, userID)
	if err != nil || got.LineUserID != "Uline1" || got.InstallationID != instID {
		t.Fatalf("redeem = %+v, %v", got, err)
	}
	if _, err := svc.RedeemAndBind(ctx, tok.Raw, userID); !errors.Is(err, ErrBindingTokenInvalid) {
		t.Fatalf("a token redeems once: %v", err)
	}
	b, err := q.GetChannelUserBindingByUserID(ctx, db.GetChannelUserBindingByUserIDParams{InstallationID: instID, ChannelUserID: "Uline1"})
	if err != nil || b.MulticaUserID != userID || b.ChannelType != "line" {
		t.Fatalf("binding = %+v, %v", b, err)
	}

	// A Telegram token in the shared table cannot be redeemed through LINE.
	var tgToken = "tg-raw-" + slug
	if _, err := q.CreateChannelBindingToken(ctx, db.CreateChannelBindingTokenParams{
		TokenHash: hashBindingToken(tgToken), WorkspaceID: wsID, InstallationID: instID, ChannelType: "telegram",
		ChannelUserID: "999", ExpiresAt: ts(time.Now().Add(time.Minute)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RedeemAndBind(ctx, tgToken, userID); !errors.Is(err, ErrBindingTokenInvalid) {
		t.Fatalf("cross-channel token: %v", err)
	}
}
