package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/integrations/line"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// LineInstallationResponse is the wire shape for a LINE installation row.
// The encrypted channel secret in config is intentionally absent.
type LineInstallationResponse struct {
	ID              string `json:"id"`
	WorkspaceID     string `json:"workspace_id"`
	AgentID         string `json:"agent_id"`
	BotUserID       string `json:"bot_user_id"`
	ChannelID       string `json:"channel_id"`
	BasicID         string `json:"basic_id"`
	DisplayName     string `json:"display_name"`
	Language        string `json:"language"`
	WebhookURL      string `json:"webhook_url"`
	InstallerUserID string `json:"installer_user_id"`
	Status          string `json:"status"`
	InstalledAt     string `json:"installed_at"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
}

func (h *Handler) lineInstallationToResponse(row db.ChannelInstallation) LineInstallationResponse {
	info := line.DecodePublicConfig(row.Config)
	webhookURL := ""
	if h.LineInstall != nil {
		webhookURL = h.LineInstall.WebhookURL(row.ID)
	}
	return LineInstallationResponse{
		ID:              uuidToString(row.ID),
		WorkspaceID:     uuidToString(row.WorkspaceID),
		AgentID:         uuidToString(row.AgentID),
		BotUserID:       info.BotUserID,
		ChannelID:       info.ChannelID,
		BasicID:         info.BasicID,
		DisplayName:     info.DisplayName,
		Language:        string(info.Language),
		WebhookURL:      webhookURL,
		InstallerUserID: uuidToString(row.InstallerUserID),
		Status:          row.Status,
		InstalledAt:     row.InstalledAt.Time.UTC().Format(time.RFC3339),
		CreatedAt:       row.CreatedAt.Time.UTC().Format(time.RFC3339),
		UpdatedAt:       row.UpdatedAt.Time.UTC().Format(time.RFC3339),
	}
}

// ListLineInstallations (GET /api/workspaces/{id}/line/installations) is
// member-visible so the Integrations tab renders for non-admins.
func (h *Handler) ListLineInstallations(w http.ResponseWriter, r *http.Request) {
	if h.LineInstall == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"installations":     []LineInstallationResponse{},
			"configured":        false,
			"install_supported": false,
		})
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	rows, err := h.LineInstall.ListByWorkspace(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list LINE installations")
		return
	}
	out := make([]LineInstallationResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, h.lineInstallationToResponse(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"installations":     out,
		"configured":        true,
		"install_supported": true,
	})
}

// RegisterLineRequest is the body for a LINE install.
type RegisterLineRequest struct {
	ChannelID     string `json:"channel_id"`
	ChannelSecret string `json:"channel_secret"`
	Language      string `json:"language"`
}

// RegisterLineChannel (POST /api/workspaces/{id}/line/install?agent_id=…)
// connects a LINE Messaging API channel to an agent. Admin-only at the
// router.
func (h *Handler) RegisterLineChannel(w http.ResponseWriter, r *http.Request) {
	if h.LineInstall == nil {
		writeFeatureDisabled(w, "line_not_configured", "LINE integration not enabled")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	agentIDStr := strings.TrimSpace(r.URL.Query().Get("agent_id"))
	if agentIDStr == "" {
		writeError(w, http.StatusBadRequest, "agent_id is required")
		return
	}
	agentUUID, ok := parseUUIDOrBadRequest(w, agentIDStr, "agent_id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{
		ID:          agentUUID,
		WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "agent not found in this workspace")
		return
	}
	initiatorUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}
	var body RegisterLineRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	row, err := h.LineInstall.Register(r.Context(), line.RegisterParams{
		WorkspaceID:   wsUUID,
		AgentID:       agentUUID,
		InitiatorID:   initiatorUUID,
		ChannelID:     body.ChannelID,
		ChannelSecret: body.ChannelSecret,
		Language:      body.Language,
	})
	if err != nil {
		switch {
		case errors.Is(err, line.ErrInvalidChannelID), errors.Is(err, line.ErrMissingChannelSecret), errors.Is(err, line.ErrInvalidLanguage):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, line.ErrPublicURLNotHTTPS):
			writeError(w, http.StatusServiceUnavailable, "LINE only delivers webhooks over HTTPS: set MULTICA_PUBLIC_URL to this server's https URL, then try again")
		case errors.Is(err, line.ErrCredentialsRejected):
			writeError(w, http.StatusBadRequest, "LINE rejected this channel ID and channel secret: copy both again from the channel's Basic settings in the LINE Developers Console")
		case errors.Is(err, line.ErrCredentialsUnverifiable):
			writeError(w, http.StatusServiceUnavailable, "could not reach LINE to verify this channel: check the server network or proxy and try again; nothing was saved")
		case errors.Is(err, line.ErrWebhookSetupFailed):
			writeError(w, http.StatusBadGateway, "LINE accepted the channel but refused the webhook URL; the channel was not connected")
		case errors.Is(err, line.ErrWebhookTestFailed):
			writeError(w, http.StatusBadRequest, "LINE could not reach this server's webhook URL, so the channel was not connected: check that MULTICA_PUBLIC_URL is reachable from the internet over HTTPS "+strings.TrimPrefix(err.Error(), line.ErrWebhookTestFailed.Error()+" "))
		case errors.Is(err, line.ErrBotOwnedBySameWorkspace):
			writeError(w, http.StatusConflict, "this LINE channel is already connected to another agent in this workspace: disconnect it there first, then connect it here")
		case errors.Is(err, line.ErrBotOwnedByArchivedAgent):
			writeError(w, http.StatusConflict, "this LINE channel is connected to an archived agent in this workspace: restore that agent, or disconnect its channel, before connecting it here")
		case errors.Is(err, line.ErrBotOwnedByAnotherWorkspace):
			writeError(w, http.StatusConflict, "this LINE channel is already connected to a different Multica workspace: disconnect it there before connecting it here")
		default:
			slog.Error("line: install failed", "error", err)
			writeError(w, http.StatusInternalServerError, "could not save this LINE channel: something went wrong on the server")
		}
		return
	}
	h.publish(protocol.EventLineInstallationCreated, uuidToString(row.WorkspaceID), "user", userID, map[string]any{
		"id": uuidToString(row.ID),
	})
	writeJSON(w, http.StatusOK, h.lineInstallationToResponse(row))
}

// RevokeLineInstallation (DELETE /api/workspaces/{id}/line/installations/{installationId})
// flips status to revoked. Admin-only at the router. The webhook then answers
// 404 for this installation; reconnecting the same channel reactivates it.
func (h *Handler) RevokeLineInstallation(w http.ResponseWriter, r *http.Request) {
	if h.LineInstall == nil {
		writeFeatureDisabled(w, "line_not_configured", "LINE integration not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	instUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "installationId"), "installation id")
	if !ok {
		return
	}
	if _, err := h.LineInstall.GetInWorkspace(r.Context(), instUUID, wsUUID); err != nil {
		if errors.Is(err, line.ErrInstallationNotFound) {
			writeError(w, http.StatusNotFound, "LINE installation not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load installation")
		return
	}
	if err := h.LineInstall.Revoke(r.Context(), instUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to revoke installation")
		return
	}
	h.publish(protocol.EventLineInstallationRevoked, uuidToString(wsUUID), "user", userID, map[string]any{
		"id": uuidToString(instUUID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// lineWebhookProcessTimeout bounds one webhook's processing. It runs detached
// from the request context: LINE gives up after 2 s, and a dropped connection
// must not abort a commit halfway (redelivery plus dedup cover the rest).
const lineWebhookProcessTimeout = 15 * time.Second

// HandleLineWebhook (POST /api/webhooks/line/{installationId}) is LINE's
// public webhook. Unknown, revoked and disabled installations get the same
// bare 404.
func (h *Handler) HandleLineWebhook(w http.ResponseWriter, r *http.Request) {
	if h.LineWebhook == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Bad signatures and unknown installations count against the caller's
	// IP, as the autopilot webhook does for bad credentials.
	ip := h.clientIPForRateLimit(r)
	if ip != "" && h.WebhookIPRateLimiter != nil && !slidingWindowLimiterCheck(r.Context(), h.WebhookIPRateLimiter, ip) {
		writeWebhookRateLimit(w, r, h.WebhookIPRateLimiter, ip, "line_bad_request_ip", h.Metrics)
		return
	}
	countBad := func() {
		if ip != "" && h.WebhookIPRateLimiter != nil {
			h.WebhookIPRateLimiter.Allow(r.Context(), ip)
		}
	}
	instUUID, err := util.ParseUUID(chi.URLParam(r, "installationId"))
	if err != nil || !instUUID.Valid {
		countBad()
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, line.MaxWebhookBodyBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "read body failed")
		return
	}
	if len(body) > line.MaxWebhookBodyBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "body too large")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), lineWebhookProcessTimeout)
	defer cancel()
	err = h.LineWebhook.Process(ctx, instUUID, body, r.Header.Get(line.SignatureHeader))
	switch {
	case err == nil:
		w.WriteHeader(http.StatusOK)
	case errors.Is(err, line.ErrWebhookNotFound):
		countBad()
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, line.ErrBadSignature):
		countBad()
		writeError(w, http.StatusUnauthorized, "invalid signature")
	case errors.Is(err, line.ErrWebhookMalformed):
		writeError(w, http.StatusBadRequest, "malformed body")
	default:
		slog.Error("line webhook: processing failed", "installation_id", uuidToString(instUUID), "error", err)
		writeError(w, http.StatusInternalServerError, "processing failed")
	}
}

// RedeemLineBindingTokenRequest carries the raw token from the bot's
// "link your account" prompt.
type RedeemLineBindingTokenRequest struct {
	Token string `json:"token"`
}

// RedeemLineBindingTokenResponse echoes the bound identifiers so the
// frontend can confirm without a second fetch.
type RedeemLineBindingTokenResponse struct {
	WorkspaceID    string `json:"workspace_id"`
	InstallationID string `json:"installation_id"`
	LineUserID     string `json:"line_user_id"`
}

// RedeemLineBindingToken (POST /api/line/binding/redeem) binds the
// Line user id carried by the token to the logged-in Multica user. The
// redeemer's identity comes from the session, not the token. Status codes
// mirror the Slack redeem handler.
func (h *Handler) RedeemLineBindingToken(w http.ResponseWriter, r *http.Request) {
	if h.LineBindingTokens == nil {
		writeFeatureDisabled(w, "line_not_configured", "LINE integration not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req RedeemLineBindingTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Token == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}
	redeemed, err := h.LineBindingTokens.RedeemAndBind(r.Context(), req.Token, userUUID)
	if err != nil {
		switch {
		case errors.Is(err, line.ErrBindingTokenInvalid):
			writeError(w, http.StatusGone, "binding token invalid or expired")
		case errors.Is(err, line.ErrBindingAlreadyAssigned):
			writeError(w, http.StatusConflict, "this LINE account is already bound to a different Multica user")
		case errors.Is(err, line.ErrBindingNotWorkspaceMember):
			writeError(w, http.StatusForbidden, "binding refused (are you a workspace member?)")
		default:
			writeError(w, http.StatusInternalServerError, "failed to redeem token")
		}
		return
	}
	writeJSON(w, http.StatusOK, RedeemLineBindingTokenResponse{
		WorkspaceID:    uuidToString(redeemed.WorkspaceID),
		InstallationID: uuidToString(redeemed.InstallationID),
		LineUserID:     redeemed.LineUserID,
	})
}
