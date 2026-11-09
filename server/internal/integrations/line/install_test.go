package line

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func testUUID(b byte) pgtype.UUID {
	var u pgtype.UUID
	for i := range u.Bytes {
		u.Bytes[i] = b
	}
	u.Valid = true
	return u
}

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func testBox(t *testing.T) *secretbox.Box {
	t.Helper()
	key := make([]byte, secretbox.KeySize)
	for i := range key {
		key[i] = byte(i + 1)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	return box
}

type fakeInstallQueries struct {
	upsert     db.UpsertChannelInstallationParams
	upserted   bool
	appIDTaken bool
	owner      db.GetChannelInstallationOwnerByAppIDRow
	statuses   []db.SetChannelInstallationStatusParams
}

func (f *fakeInstallQueries) WithTx(pgx.Tx) installQueries { return f }
func (f *fakeInstallQueries) ReclaimDeadChannelInstallationByAppID(context.Context, db.ReclaimDeadChannelInstallationByAppIDParams) (pgtype.UUID, error) {
	return pgtype.UUID{}, pgx.ErrNoRows
}
func (f *fakeInstallQueries) UpsertChannelInstallation(_ context.Context, p db.UpsertChannelInstallationParams) (db.ChannelInstallation, error) {
	f.upsert, f.upserted = p, true
	if f.appIDTaken {
		return db.ChannelInstallation{}, &pgconn.PgError{Code: pgUniqueViolation}
	}
	return db.ChannelInstallation{ID: testUUID(9), WorkspaceID: p.WorkspaceID, AgentID: p.AgentID, ChannelType: p.ChannelType, Config: p.Config, Status: "active"}, nil
}
func (f *fakeInstallQueries) GetChannelInstallationOwnerByAppID(context.Context, db.GetChannelInstallationOwnerByAppIDParams) (db.GetChannelInstallationOwnerByAppIDRow, error) {
	return f.owner, nil
}
func (f *fakeInstallQueries) ListChannelInstallationsByWorkspace(context.Context, db.ListChannelInstallationsByWorkspaceParams) ([]db.ChannelInstallation, error) {
	return nil, nil
}
func (f *fakeInstallQueries) GetChannelInstallationInWorkspace(context.Context, db.GetChannelInstallationInWorkspaceParams) (db.ChannelInstallation, error) {
	return db.ChannelInstallation{}, pgx.ErrNoRows
}
func (f *fakeInstallQueries) SetChannelInstallationStatus(_ context.Context, p db.SetChannelInstallationStatusParams) error {
	f.statuses = append(f.statuses, p)
	return nil
}

type fakeTx struct{ pgx.Tx }

func (fakeTx) Commit(context.Context) error   { return nil }
func (fakeTx) Rollback(context.Context) error { return nil }

type fakeTxStarter struct{}

func (fakeTxStarter) Begin(context.Context) (pgx.Tx, error) { return fakeTx{}, nil }

func newTestInstall(t *testing.T, m *mockLINE, q *fakeInstallQueries, publicURL string) *InstallService {
	t.Helper()
	svc, err := newInstallService(q, fakeTxStarter{}, testBox(t), m.tokens(), publicURL, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func lineInstallMock(t *testing.T, webhookOK bool) *mockLINE {
	m := newMockLINE(t)
	m.handlers["/v2/bot/info"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		_, _ = w.Write([]byte(`{"userId":"Ubot123","basicId":"@123abcde","displayName":"Multica"}`))
	}
	m.handlers["/v2/bot/channel/webhook/test"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		if webhookOK {
			_, _ = w.Write([]byte(`{"success":true,"statusCode":200,"reason":"OK"}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":false,"statusCode":404,"reason":"ERROR_STATUS_CODE","detail":"404 Not Found"}`))
	}
	return m
}

func validParams() RegisterParams {
	return RegisterParams{WorkspaceID: testUUID(1), AgentID: testUUID(2), InitiatorID: testUUID(3),
		ChannelID: " 1650000000 ", ChannelSecret: " secret ", Language: "zh-Hant"}
}

func TestRegisterVerifiesEncryptsAndSetsWebhook(t *testing.T) {
	m := lineInstallMock(t, true)
	q := &fakeInstallQueries{}
	svc := newTestInstall(t, m, q, "https://multica.example.com/")
	row, err := svc.Register(context.Background(), validParams())
	if err != nil {
		t.Fatal(err)
	}
	if !q.upserted || q.upsert.ChannelType != "line" || row.ID != testUUID(9) {
		t.Fatalf("upsert=%+v row=%+v", q.upsert, row)
	}
	var cfg installConfig
	if err := json.Unmarshal(q.upsert.Config, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.AppID != "Ubot123" || cfg.ChannelID != "1650000000" || cfg.BasicID != "@123abcde" || cfg.Language != "zh-Hant" {
		t.Fatalf("config = %+v", cfg)
	}
	if strings.Contains(string(q.upsert.Config), "secret\"") {
		t.Fatalf("plaintext secret stored: %s", q.upsert.Config)
	}
	plain, err := decryptSecret(cfg.ChannelSecretEncrypted, svc.box.Open)
	if err != nil || plain != "secret" {
		t.Fatalf("decrypted = %q, %v", plain, err)
	}
	want := "https://multica.example.com/api/webhooks/line/09090909-0909-0909-0909-090909090909"
	if c := m.callsTo("/v2/bot/channel/webhook/endpoint"); len(c) != 1 || c[0].Body["endpoint"] != want {
		t.Fatalf("set endpoint calls = %+v", c)
	}
	if c := m.callsTo("/v2/bot/channel/webhook/test"); len(c) != 1 || c[0].Body["endpoint"] != want {
		t.Fatalf("test endpoint calls = %+v", c)
	}
	if svc.WebhookURL(row.ID) != want || len(q.statuses) != 0 {
		t.Fatalf("webhook url / statuses: %q %+v", svc.WebhookURL(row.ID), q.statuses)
	}
}

func TestRegisterRejectsBadInputBeforeCallingLINE(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*RegisterParams)
		public string
		want   error
	}{
		{"non-numeric channel id", func(p *RegisterParams) { p.ChannelID = "abc" }, "https://x", ErrInvalidChannelID},
		{"empty secret", func(p *RegisterParams) { p.ChannelSecret = "  " }, "https://x", ErrMissingChannelSecret},
		{"bad language", func(p *RegisterParams) { p.Language = "th" }, "https://x", ErrInvalidLanguage},
		{"http public url", func(*RegisterParams) {}, "http://x", ErrPublicURLNotHTTPS},
		{"no public url", func(*RegisterParams) {}, "", ErrPublicURLNotHTTPS},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := lineInstallMock(t, true)
			q := &fakeInstallQueries{}
			p := validParams()
			tc.mutate(&p)
			if _, err := newTestInstall(t, m, q, tc.public).Register(context.Background(), p); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if q.upserted || m.mint != 0 {
				t.Fatal("nothing may be stored or minted for bad input")
			}
		})
	}
}

func TestRegisterDefaultsLanguageToJapanese(t *testing.T) {
	m := lineInstallMock(t, true)
	q := &fakeInstallQueries{}
	p := validParams()
	p.Language = ""
	if _, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if DecodePublicConfig(q.upsert.Config).Language != LanguageJapanese {
		t.Fatalf("config = %s", q.upsert.Config)
	}
}

func TestRegisterCredentialErrors(t *testing.T) {
	m := lineInstallMock(t, true)
	q := &fakeInstallQueries{}
	p := validParams()
	p.ChannelSecret = "wrong"
	if _, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), p); !errors.Is(err, ErrCredentialsRejected) {
		t.Fatalf("want ErrCredentialsRejected, got %v", err)
	}

	m = lineInstallMock(t, true)
	m.handlers["/v2/bot/info"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) { w.WriteHeader(http.StatusBadGateway) }
	if _, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), validParams()); !errors.Is(err, ErrCredentialsUnverifiable) {
		t.Fatalf("want ErrCredentialsUnverifiable, got %v", err)
	}
	if q.upserted {
		t.Fatal("nothing may be stored when verification fails")
	}
}

func TestRegisterRevokesWhenLINECannotReachWebhook(t *testing.T) {
	m := lineInstallMock(t, false)
	q := &fakeInstallQueries{}
	_, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), validParams())
	if !errors.Is(err, ErrWebhookTestFailed) || !strings.Contains(err.Error(), "404 Not Found") {
		t.Fatalf("want ErrWebhookTestFailed with detail, got %v", err)
	}
	if len(q.statuses) != 1 || q.statuses[0].Status != "revoked" || q.statuses[0].ID != testUUID(9) {
		t.Fatalf("installation must be revoked: %+v", q.statuses)
	}

	m = lineInstallMock(t, true)
	m.handlers["/v2/bot/channel/webhook/endpoint"] = func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"Invalid webhook endpoint URL"}`))
	}
	q = &fakeInstallQueries{}
	if _, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), validParams()); !errors.Is(err, ErrWebhookSetupFailed) {
		t.Fatalf("want ErrWebhookSetupFailed, got %v", err)
	}
	if len(q.statuses) != 1 {
		t.Fatalf("installation must be revoked: %+v", q.statuses)
	}
}

func TestRegisterOwnerConflicts(t *testing.T) {
	cases := []struct {
		name  string
		owner db.GetChannelInstallationOwnerByAppIDRow
		want  error
	}{
		{"other workspace", db.GetChannelInstallationOwnerByAppIDRow{WorkspaceID: testUUID(7)}, ErrBotOwnedByAnotherWorkspace},
		{"same workspace", db.GetChannelInstallationOwnerByAppIDRow{WorkspaceID: testUUID(1)}, ErrBotOwnedBySameWorkspace},
		{"archived agent", db.GetChannelInstallationOwnerByAppIDRow{WorkspaceID: testUUID(1), AgentArchivedAt: pgtype.Timestamptz{Valid: true}}, ErrBotOwnedByArchivedAgent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := lineInstallMock(t, true)
			q := &fakeInstallQueries{appIDTaken: true, owner: tc.owner}
			if _, err := newTestInstall(t, m, q, "https://x").Register(context.Background(), validParams()); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if len(m.callsTo("/v2/bot/channel/webhook/endpoint")) != 0 {
				t.Fatal("a conflicting install must not repoint the webhook")
			}
		})
	}
}
