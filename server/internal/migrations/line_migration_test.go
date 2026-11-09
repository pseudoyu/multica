package migrations

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const lineMigrationTestSchema = "line_migration_test"

func TestLineOriginMigrationsUpDownAndCatalog(t *testing.T) {
	conn := lineMigrationConn(t)
	ctx := context.Background()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE issue (
			id UUID PRIMARY KEY,
			origin_type TEXT NULL
		);
		ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
			CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat', 'slack_chat', 'agent_create', 'dingtalk_chat', 'wecom_chat', 'telegram_chat'));
	`); err != nil {
		t.Fatalf("create pre-LINE issue table: %v", err)
	}

	assertLineOriginRejected(t, ctx, conn, "00000000-0000-4000-8000-000000000001")

	applyMigrationFile(t, ctx, conn, "630_issue_origin_line_chat.up.sql")
	assertLineOriginConstraint(t, ctx, conn, false, true)
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, origin_type) VALUES ($1, 'line_chat')`, "00000000-0000-4000-8000-000000000002"); err != nil {
		t.Fatalf("insert line_chat after widening constraint: %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, origin_type) VALUES ($1, 'telegram_chat')`, "00000000-0000-4000-8000-000000000004"); err != nil {
		t.Fatalf("telegram_chat must stay allowed: %v", err)
	}

	applyMigrationFile(t, ctx, conn, "631_issue_origin_line_chat_validate.up.sql")
	assertLineOriginConstraint(t, ctx, conn, true, true)

	applyMigrationFile(t, ctx, conn, "631_issue_origin_line_chat_validate.down.sql")
	assertLineOriginConstraint(t, ctx, conn, false, true)
	if _, err := conn.Exec(ctx, `DELETE FROM issue WHERE origin_type = 'line_chat'`); err != nil {
		t.Fatalf("remove LINE row before narrowing rollback: %v", err)
	}
	applyMigrationFile(t, ctx, conn, "630_issue_origin_line_chat.down.sql")
	assertLineOriginConstraint(t, ctx, conn, true, false)
	assertLineOriginRejected(t, ctx, conn, "00000000-0000-4000-8000-000000000003")
}

func TestLineReplyTokenMigrationsUpDown(t *testing.T) {
	conn := lineMigrationConn(t)
	ctx := context.Background()

	applyMigrationFile(t, ctx, conn, "632_line_reply_token.up.sql")
	applyMigrationFile(t, ctx, conn, "633_line_reply_token_chat_index.up.sql")

	inst := "00000000-0000-4000-8000-0000000000aa"
	if _, err := conn.Exec(ctx, `INSERT INTO line_reply_token (installation_id, chat_id, reply_token) VALUES ($1, 'C1', 'first')`, inst); err != nil {
		t.Fatalf("insert reply token: %v", err)
	}
	_, err := conn.Exec(ctx, `INSERT INTO line_reply_token (installation_id, chat_id, reply_token) VALUES ($1, 'C1', 'second')`, inst)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("second row for one chat: got %v, want unique violation", err)
	}

	applyMigrationFile(t, ctx, conn, "633_line_reply_token_chat_index.down.sql")
	applyMigrationFile(t, ctx, conn, "632_line_reply_token.down.sql")
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT to_regclass('line_reply_token') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatalf("inspect line_reply_token: %v", err)
	}
	if exists {
		t.Fatal("line_reply_token survived its down migration")
	}
}

// lineMigrationConn returns a connection whose search_path is a fresh schema,
// so the migrations under test never touch the real tables.
func lineMigrationConn(t *testing.T) *pgx.Conn {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to Postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire Postgres connection: %v", err)
	}
	t.Cleanup(conn.Release)

	cleanup := func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+lineMigrationTestSchema+" CASCADE")
	}
	cleanup()
	t.Cleanup(cleanup)
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+lineMigrationTestSchema); err != nil {
		t.Fatalf("create isolated migration schema: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('search_path', $1, false)`, lineMigrationTestSchema); err != nil {
		t.Fatalf("set isolated migration search path: %v", err)
	}
	return conn.Conn()
}

func assertLineOriginConstraint(t *testing.T, ctx context.Context, conn *pgx.Conn, wantValidated, wantLine bool) {
	t.Helper()
	var validated bool
	var definition string
	if err := conn.QueryRow(ctx, `
		SELECT convalidated, pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid = 'issue'::regclass AND conname = 'issue_origin_type_check'
	`).Scan(&validated, &definition); err != nil {
		t.Fatalf("inspect issue origin constraint: %v", err)
	}
	if validated != wantValidated {
		t.Fatalf("constraint validated = %t, want %t", validated, wantValidated)
	}
	if strings.Contains(definition, "'line_chat'") != wantLine {
		t.Fatalf("constraint LINE membership = %t, want %t: %s", strings.Contains(definition, "'line_chat'"), wantLine, definition)
	}
	if !strings.Contains(definition, "'telegram_chat'") {
		t.Fatalf("constraint lost telegram_chat: %s", definition)
	}
}

func assertLineOriginRejected(t *testing.T, ctx context.Context, conn *pgx.Conn, id string) {
	t.Helper()
	if _, err := conn.Exec(ctx, `INSERT INTO issue (id, origin_type) VALUES ($1, 'line_chat')`, id); !isCheckViolation(err) {
		t.Fatalf("insert line_chat under pre-LINE constraint: got %v, want check violation", err)
	}
}
