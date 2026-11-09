package line

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultAPIBase is the Messaging API host.
const DefaultAPIBase = "https://api.line.me"

// tokenRefreshMargin makes a cached token count as expired this long before
// LINE would reject it, so a request never starts with a token about to die.
const tokenRefreshMargin = time.Minute

// ErrInvalidCredentials means LINE rejected the channel ID or secret.
var ErrInvalidCredentials = errors.New("line: channel ID or channel secret was rejected")

// tokenSource mints 15-minute stateless channel access tokens from the
// channel ID and secret and caches them in memory per channel. Nothing is
// stored: every replica mints its own, which LINE allows without limit.
type tokenSource struct {
	httpClient *http.Client
	apiBase    string
	now        func() time.Time

	mu    sync.Mutex
	cache map[string]cachedToken
}

type cachedToken struct {
	token   string
	expires time.Time
}

func newTokenSource(httpClient *http.Client, apiBase string) *tokenSource {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	if apiBase == "" {
		apiBase = DefaultAPIBase
	}
	return &tokenSource{
		httpClient: httpClient,
		apiBase:    strings.TrimRight(apiBase, "/"),
		now:        time.Now,
		cache:      map[string]cachedToken{},
	}
}

// Token returns a usable access token for the channel, minting one if the
// cached token is missing or near expiry.
func (s *tokenSource) Token(ctx context.Context, channelID, channelSecret string) (string, error) {
	s.mu.Lock()
	if c, ok := s.cache[channelID]; ok && s.now().Before(c.expires) {
		s.mu.Unlock()
		return c.token, nil
	}
	s.mu.Unlock()

	token, ttl, err := s.mint(ctx, channelID, channelSecret)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.cache[channelID] = cachedToken{token: token, expires: s.now().Add(ttl - tokenRefreshMargin)}
	s.mu.Unlock()
	return token, nil
}

// Forget drops a cached token, for when LINE answers 401 with it.
func (s *tokenSource) Forget(channelID string) {
	s.mu.Lock()
	delete(s.cache, channelID)
	s.mu.Unlock()
}

func (s *tokenSource) mint(ctx context.Context, channelID, channelSecret string) (string, time.Duration, error) {
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {channelID},
		"client_secret": {channelSecret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiBase+"/oauth2/v3/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("line: mint access token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized {
		return "", 0, ErrInvalidCredentials
	}
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("line: mint access token: HTTP %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", 0, errors.New("line: mint access token: malformed response")
	}
	ttl := time.Duration(out.ExpiresIn) * time.Second
	if ttl <= tokenRefreshMargin {
		// Stateless tokens last 15 minutes; never cache a shorter answer
		// into a negative lifetime.
		ttl = tokenRefreshMargin + time.Second
	}
	return out.AccessToken, ttl, nil
}

// TokenSource is the exported handle the server wiring shares between the
// LINE install service, webhook, replier, notifier and outbound, so one
// replica mints at most one token per channel at a time.
type TokenSource struct{ ts *tokenSource }

// NewTokenSource builds the shared token cache. apiBase "" means
// DefaultAPIBase; a nil client gets a 10 s timeout.
func NewTokenSource(httpClient *http.Client, apiBase string) *TokenSource {
	return &TokenSource{ts: newTokenSource(httpClient, apiBase)}
}
