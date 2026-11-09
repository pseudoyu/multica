package line

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var (
	ErrInstallationNotFound       = errors.New("line installation not found")
	ErrInvalidChannelID           = errors.New("line: channel ID must be the numeric ID from the LINE Developers Console")
	ErrMissingChannelSecret       = errors.New("line: channel secret is required")
	ErrInvalidLanguage            = errors.New("line: language must be ja, en or zh-Hant")
	ErrPublicURLNotHTTPS          = errors.New("line: MULTICA_PUBLIC_URL must be an https URL, because LINE only delivers webhooks over HTTPS")
	ErrCredentialsRejected        = errors.New("line: LINE rejected this channel ID and channel secret")
	ErrCredentialsUnverifiable    = errors.New("line: could not reach LINE to verify this channel")
	ErrWebhookSetupFailed         = errors.New("line: could not set the webhook URL on LINE")
	ErrWebhookTestFailed          = errors.New("line: LINE could not reach this server's webhook URL")
	ErrBotOwnedByAnotherWorkspace = errors.New("line: this LINE channel is already connected to a different Multica workspace")
	ErrBotOwnedBySameWorkspace    = errors.New("line: this LINE channel is already connected to another agent in this workspace")
	ErrBotOwnedByArchivedAgent    = errors.New("line: this LINE channel is connected to an archived agent in this workspace")
)

// installQueries is the slice of generated queries the install service uses.
type installQueries interface {
	WithTx(tx pgx.Tx) installQueries
	UpsertChannelInstallation(ctx context.Context, arg db.UpsertChannelInstallationParams) (db.ChannelInstallation, error)
	ReclaimDeadChannelInstallationByAppID(ctx context.Context, arg db.ReclaimDeadChannelInstallationByAppIDParams) (pgtype.UUID, error)
	GetChannelInstallationOwnerByAppID(ctx context.Context, arg db.GetChannelInstallationOwnerByAppIDParams) (db.GetChannelInstallationOwnerByAppIDRow, error)
	ListChannelInstallationsByWorkspace(ctx context.Context, arg db.ListChannelInstallationsByWorkspaceParams) ([]db.ChannelInstallation, error)
	GetChannelInstallationInWorkspace(ctx context.Context, arg db.GetChannelInstallationInWorkspaceParams) (db.ChannelInstallation, error)
	SetChannelInstallationStatus(ctx context.Context, arg db.SetChannelInstallationStatusParams) error
}

type dbInstallQueries struct{ *db.Queries }

func (q dbInstallQueries) WithTx(tx pgx.Tx) installQueries {
	return dbInstallQueries{q.Queries.WithTx(tx)}
}

// installAPI is the part of botAPI install uses; tests fake it.
type installAPI interface {
	GetBotInfo(ctx context.Context) (botInfo, error)
	SetWebhookEndpoint(ctx context.Context, endpoint string) error
	TestWebhookEndpoint(ctx context.Context, endpoint string) (webhookTestResult, error)
}

// InstallService owns the LINE install lifecycle: verify the channel ID and
// secret, store the encrypted secret, then point the channel's webhook at
// this server and ask LINE to test it.
type InstallService struct {
	box       *secretbox.Box
	q         installQueries
	tx        engine.TxStarter
	tokens    *tokenSource
	publicURL string
	logger    *slog.Logger
	newAPI    func(creds credentials) installAPI
}

// NewInstallService builds the service. publicURL is MULTICA_PUBLIC_URL, the
// base of the webhook URL set on LINE.
func NewInstallService(q *db.Queries, tx engine.TxStarter, box *secretbox.Box, tokens *TokenSource, publicURL string, logger *slog.Logger) (*InstallService, error) {
	if q == nil {
		return nil, errors.New("line: InstallService requires queries")
	}
	return newInstallService(dbInstallQueries{q}, tx, box, tokens.ts, publicURL, logger)
}

func newInstallService(q installQueries, tx engine.TxStarter, box *secretbox.Box, tokens *tokenSource, publicURL string, logger *slog.Logger) (*InstallService, error) {
	if box == nil || q == nil || tx == nil || tokens == nil {
		return nil, errors.New("line: InstallService requires a secretbox, queries, a tx starter and a token source")
	}
	if logger == nil {
		logger = slog.Default()
	}
	s := &InstallService{
		box: box, q: q, tx: tx, tokens: tokens,
		publicURL: strings.TrimRight(strings.TrimSpace(publicURL), "/"), logger: logger,
	}
	s.newAPI = func(c credentials) installAPI { return newBotAPI(s.tokens, c) }
	return s, nil
}

// RegisterParams carries one install request.
type RegisterParams struct {
	WorkspaceID   pgtype.UUID
	AgentID       pgtype.UUID
	InitiatorID   pgtype.UUID
	ChannelID     string
	ChannelSecret string
	Language      string
}

// WebhookURL is the URL set on LINE for an installation.
func (s *InstallService) WebhookURL(installationID pgtype.UUID) string {
	if s.publicURL == "" {
		return ""
	}
	return s.publicURL + "/api/webhooks/line/" + util.UUIDToString(installationID)
}

// Register installs a LINE channel for an agent.
func (s *InstallService) Register(ctx context.Context, p RegisterParams) (db.ChannelInstallation, error) {
	channelID := strings.TrimSpace(p.ChannelID)
	secret := strings.TrimSpace(p.ChannelSecret)
	if !isDigits(channelID) {
		return db.ChannelInstallation{}, ErrInvalidChannelID
	}
	if secret == "" {
		return db.ChannelInstallation{}, ErrMissingChannelSecret
	}
	lang := strings.TrimSpace(p.Language)
	if lang == "" {
		lang = string(DefaultLanguage)
	}
	if !ValidLanguage(lang) {
		return db.ChannelInstallation{}, ErrInvalidLanguage
	}
	if u, err := url.Parse(s.publicURL); err != nil || u.Scheme != "https" || u.Host == "" {
		return db.ChannelInstallation{}, ErrPublicURLNotHTTPS
	}

	creds := credentials{ChannelID: channelID, ChannelSecret: secret, Language: Language(lang)}
	api := s.newAPI(creds)
	info, err := api.GetBotInfo(ctx)
	if err != nil {
		return db.ChannelInstallation{}, classifyVerifyError(err)
	}
	if info.UserID == "" {
		return db.ChannelInstallation{}, fmt.Errorf("%w: /v2/bot/info returned no bot user ID", ErrCredentialsRejected)
	}

	sealed, err := s.box.Seal([]byte(secret))
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encrypt line channel secret: %w", err)
	}
	cfgJSON, err := json.Marshal(installConfig{
		AppID:                  info.UserID,
		ChannelID:              channelID,
		BasicID:                info.BasicID,
		DisplayName:            info.DisplayName,
		ChannelSecretEncrypted: base64.StdEncoding.EncodeToString(sealed),
		Language:               lang,
	})
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encode line installation config: %w", err)
	}
	inst, err := s.persistInstall(ctx, p.WorkspaceID, p.AgentID, p.InitiatorID, info.UserID, cfgJSON)
	if err != nil {
		return db.ChannelInstallation{}, err
	}

	// The webhook URL carries the installation ID, so it is set only after
	// the row exists. A failure here revokes the row: an installation LINE
	// cannot deliver to must not look connected.
	endpoint := s.WebhookURL(inst.ID)
	if err := api.SetWebhookEndpoint(ctx, endpoint); err != nil {
		s.revokeAfterFailedSetup(ctx, inst.ID)
		return db.ChannelInstallation{}, fmt.Errorf("%w: %v", ErrWebhookSetupFailed, err)
	}
	res, err := api.TestWebhookEndpoint(ctx, endpoint)
	if err != nil || !res.Success {
		s.revokeAfterFailedSetup(ctx, inst.ID)
		detail := res.Reason
		if res.Detail != "" {
			detail += ": " + res.Detail
		}
		if err != nil {
			detail = err.Error()
		}
		return db.ChannelInstallation{}, fmt.Errorf("%w (%s)", ErrWebhookTestFailed, detail)
	}
	return inst, nil
}

func (s *InstallService) revokeAfterFailedSetup(ctx context.Context, id pgtype.UUID) {
	if err := s.Revoke(ctx, id); err != nil {
		s.logger.WarnContext(ctx, "line install: revoke after failed webhook setup failed", "error", err)
	}
}

func classifyVerifyError(err error) error {
	var apiErr *apiError
	if errors.Is(err, ErrInvalidCredentials) || (errors.As(err, &apiErr) && (apiErr.Status == 400 || apiErr.Status == 401 || apiErr.Status == 403)) {
		return fmt.Errorf("%w: %v", ErrCredentialsRejected, err)
	}
	return fmt.Errorf("%w: %v", ErrCredentialsUnverifiable, err)
}

const pgUniqueViolation = "23505"

func (s *InstallService) persistInstall(ctx context.Context, wsID, agentID, installerID pgtype.UUID, appID string, cfgJSON []byte) (db.ChannelInstallation, error) {
	tx, err := s.tx.Begin(ctx)
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("begin install tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)

	// A channel left on a deleted or archived agent in this workspace is
	// reclaimed instead of blocking the new install.
	if _, err := qtx.ReclaimDeadChannelInstallationByAppID(ctx, db.ReclaimDeadChannelInstallationByAppIDParams{
		ChannelType: string(TypeLine), AppID: appID, WorkspaceID: wsID, AgentID: agentID,
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.ChannelInstallation{}, fmt.Errorf("reclaim dead line installation: %w", err)
	}
	inst, err := qtx.UpsertChannelInstallation(ctx, db.UpsertChannelInstallationParams{
		WorkspaceID: wsID, AgentID: agentID, ChannelType: string(TypeLine),
		Config: cfgJSON, InstallerUserID: installerID,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			return db.ChannelInstallation{}, s.liveOwnerConflictErr(ctx, wsID, appID)
		}
		return db.ChannelInstallation{}, fmt.Errorf("upsert line installation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("commit line install: %w", err)
	}
	return inst, nil
}

func (s *InstallService) liveOwnerConflictErr(ctx context.Context, wsID pgtype.UUID, appID string) error {
	owner, err := s.q.GetChannelInstallationOwnerByAppID(ctx, db.GetChannelInstallationOwnerByAppIDParams{
		ChannelType: string(TypeLine), AppID: appID,
	})
	if err != nil {
		return ErrBotOwnedByAnotherWorkspace
	}
	switch {
	case owner.WorkspaceID != wsID:
		return ErrBotOwnedByAnotherWorkspace
	case owner.AgentArchivedAt.Valid:
		return ErrBotOwnedByArchivedAgent
	default:
		return ErrBotOwnedBySameWorkspace
	}
}

// ListByWorkspace returns the workspace's LINE installations.
func (s *InstallService) ListByWorkspace(ctx context.Context, wsID pgtype.UUID) ([]db.ChannelInstallation, error) {
	return s.q.ListChannelInstallationsByWorkspace(ctx, db.ListChannelInstallationsByWorkspaceParams{
		WorkspaceID: wsID, ChannelType: string(TypeLine),
	})
}

// GetInWorkspace loads one installation, scoped to the workspace.
func (s *InstallService) GetInWorkspace(ctx context.Context, id, wsID pgtype.UUID) (db.ChannelInstallation, error) {
	inst, err := s.q.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID: id, WorkspaceID: wsID, ChannelType: string(TypeLine),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ChannelInstallation{}, ErrInstallationNotFound
		}
		return db.ChannelInstallation{}, err
	}
	return inst, nil
}

// Revoke flips status to revoked. The row stays for audit; the webhook then
// answers 404 for it, and reinstalling the same channel reactivates it.
func (s *InstallService) Revoke(ctx context.Context, id pgtype.UUID) error {
	return s.q.SetChannelInstallationStatus(ctx, db.SetChannelInstallationStatusParams{ID: id, Status: "revoked"})
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
