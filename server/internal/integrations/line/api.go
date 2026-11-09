package line

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// apiError is a non-2xx answer from the Messaging API.
type apiError struct {
	Status  int
	Message string
	// Body is kept for the push 409 case, which carries the original
	// sentMessages.
	Body []byte
}

func (e *apiError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("line api: HTTP %d", e.Status)
	}
	return fmt.Sprintf("line api: HTTP %d: %s", e.Status, e.Message)
}

// isMonthlyLimit reports LINE's "You have reached your monthly limit." 429.
func (e *apiError) isMonthlyLimit() bool {
	return e.Status == http.StatusTooManyRequests && strings.Contains(strings.ToLower(e.Message), "monthly limit")
}

// botAPI calls the Messaging API for one channel. Access tokens come from the
// shared tokenSource; a 401 drops the cached token and retries once.
type botAPI struct {
	client *http.Client
	base   string
	tokens *tokenSource
	creds  credentials
}

func newBotAPI(tokens *tokenSource, creds credentials) *botAPI {
	return &botAPI{client: tokens.httpClient, base: tokens.apiBase, tokens: tokens, creds: creds}
}

// botInfo is GET /v2/bot/info.
type botInfo struct {
	UserID      string `json:"userId"`
	BasicID     string `json:"basicId"`
	DisplayName string `json:"displayName"`
}

// message is one outbound message object: text or textV2.
type message struct {
	Type         string                  `json:"type"`
	Text         string                  `json:"text"`
	QuoteToken   string                  `json:"quoteToken,omitempty"`
	Substitution map[string]substitution `json:"substitution,omitempty"`
}

type substitution struct {
	Type      string        `json:"type"` // mention
	Mentionee mentioneeSpec `json:"mentionee"`
}

type mentioneeSpec struct {
	Type   string `json:"type"` // user
	UserID string `json:"userId"`
}

type sentMessage struct {
	ID         string `json:"id"`
	QuoteToken string `json:"quoteToken"`
}

type sendResponse struct {
	SentMessages []sentMessage `json:"sentMessages"`
}

// webhookTestResult is POST /v2/bot/channel/webhook/test.
type webhookTestResult struct {
	Success    bool   `json:"success"`
	StatusCode int    `json:"statusCode"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
}

func (a *botAPI) GetBotInfo(ctx context.Context) (botInfo, error) {
	var out botInfo
	_, err := a.do(ctx, http.MethodGet, "/v2/bot/info", nil, nil, &out)
	return out, err
}

func (a *botAPI) SetWebhookEndpoint(ctx context.Context, endpoint string) error {
	_, err := a.do(ctx, http.MethodPut, "/v2/bot/channel/webhook/endpoint", map[string]string{"endpoint": endpoint}, nil, nil)
	return err
}

func (a *botAPI) TestWebhookEndpoint(ctx context.Context, endpoint string) (webhookTestResult, error) {
	var out webhookTestResult
	_, err := a.do(ctx, http.MethodPost, "/v2/bot/channel/webhook/test", map[string]string{"endpoint": endpoint}, nil, &out)
	return out, err
}

func (a *botAPI) Reply(ctx context.Context, replyToken string, msgs []message) (sendResponse, error) {
	var out sendResponse
	_, err := a.do(ctx, http.MethodPost, "/v2/bot/message/reply", map[string]any{"replyToken": replyToken, "messages": msgs}, nil, &out)
	return out, err
}

// Push sends to a user, group or room with a retry key. A repeat of the same
// key answers 409 with the original sentMessages, which counts as delivered.
func (a *botAPI) Push(ctx context.Context, to, retryKey string, msgs []message) (sendResponse, error) {
	var out sendResponse
	hdr := http.Header{}
	if retryKey != "" {
		hdr.Set("X-Line-Retry-Key", retryKey)
	}
	_, err := a.do(ctx, http.MethodPost, "/v2/bot/message/push", map[string]any{"to": to, "messages": msgs}, hdr, &out)
	var apiErr *apiError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict && retryKey != "" {
		_ = json.Unmarshal(apiErr.Body, &out)
		return out, nil
	}
	return out, err
}

// StartLoading shows the loading animation in a 1:1 chat. LINE rejects group
// IDs, so callers only use it for users.
func (a *botAPI) StartLoading(ctx context.Context, chatID string, seconds int) error {
	_, err := a.do(ctx, http.MethodPost, "/v2/bot/chat/loading/start", map[string]any{"chatId": chatID, "loadingSeconds": seconds}, nil, nil)
	return err
}

func (a *botAPI) do(ctx context.Context, method, path string, body any, hdr http.Header, out any) (int, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return 0, err
		}
	}
	for attempt := 0; ; attempt++ {
		token, err := a.tokens.Token(ctx, a.creds.ChannelID, a.creds.ChannelSecret)
		if err != nil {
			return 0, err
		}
		req, err := http.NewRequestWithContext(ctx, method, a.base+path, bytes.NewReader(payload))
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range hdr {
			req.Header[k] = v
		}
		resp, err := a.client.Do(req)
		if err != nil {
			return 0, fmt.Errorf("line api %s %s: %w", method, path, err)
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			a.tokens.Forget(a.creds.ChannelID)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			var e struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(data, &e)
			return resp.StatusCode, &apiError{Status: resp.StatusCode, Message: e.Message, Body: data}
		}
		if out != nil && len(data) > 0 {
			if err := json.Unmarshal(data, out); err != nil {
				return resp.StatusCode, fmt.Errorf("line api %s %s: decode response: %w", method, path, err)
			}
		}
		return resp.StatusCode, nil
	}
}

// apiTimeout bounds one Messaging API call made off the webhook path.
const apiTimeout = 10 * time.Second
