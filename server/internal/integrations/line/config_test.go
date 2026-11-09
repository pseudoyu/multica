package line

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDecodeCredentials(t *testing.T) {
	raw, _ := json.Marshal(installConfig{
		AppID:                  "Ubot",
		ChannelID:              "1650000000",
		ChannelSecretEncrypted: base64.StdEncoding.EncodeToString([]byte("cipher")),
		Language:               "zh-TW",
	})
	decrypt := func(c []byte) ([]byte, error) {
		if string(c) != "cipher" {
			return nil, errors.New("unexpected ciphertext")
		}
		return []byte("plain-secret"), nil
	}
	creds, err := decodeCredentials(raw, decrypt)
	if err != nil {
		t.Fatal(err)
	}
	if creds.BotUserID != "Ubot" || creds.ChannelID != "1650000000" || creds.ChannelSecret != "plain-secret" || creds.Language != LanguageTraditionalChinese {
		t.Fatalf("unexpected credentials: %+v", creds)
	}

	if _, err := decodeCredentials(json.RawMessage(`{"app_id":"Ubot"}`), nil); err == nil {
		t.Fatal("missing channel id and secret must fail")
	}
	if _, err := decodeCredentials(nil, nil); err == nil {
		t.Fatal("empty config must fail")
	}

	pub := DecodePublicConfig(raw)
	if pub.BotUserID != "Ubot" || pub.Language != LanguageTraditionalChinese {
		t.Fatalf("public config: %+v", pub)
	}
	if strings.Contains(string(mustJSON(t, pub)), "cipher") {
		t.Fatal("public config must not carry the secret")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestLanguage(t *testing.T) {
	for in, want := range map[string]Language{
		"": LanguageJapanese, "ja": LanguageJapanese, "EN": LanguageEnglish,
		"zh-Hant": LanguageTraditionalChinese, "zh-hk": LanguageTraditionalChinese, "th": LanguageJapanese,
	} {
		if got := ParseLanguage(in); got != want {
			t.Errorf("ParseLanguage(%q) = %q, want %q", in, got, want)
		}
	}
	if !ValidLanguage("zh-Hant") || ValidLanguage("zh-tw") || ValidLanguage("") {
		t.Fatal("ValidLanguage accepts only the three install choices")
	}
	for _, lang := range []Language{LanguageJapanese, LanguageEnglish, LanguageTraditionalChinese} {
		c := textFor(lang)
		if c.BindPrompt == "" || c.WorkingOnIt == "" || c.Continued == "" || c.IssueCreated == "" || c.TaskFailed == "" || c.AgentOffline == "" {
			t.Fatalf("copy for %s is incomplete", lang)
		}
	}
	if textFor("xx").BindPrompt != textFor(DefaultLanguage).BindPrompt {
		t.Fatal("unknown language falls back to the default")
	}
}

func TestTokenSourceMintsAndCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/oauth2/v3/token" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "123" {
			t.Errorf("unexpected form %v", r.Form)
		}
		if r.Form.Get("client_secret") != "sec" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
			return
		}
		_, _ = w.Write([]byte(`{"token_type":"Bearer","access_token":"tok","expires_in":900}`))
	}))
	defer srv.Close()

	ts := newTokenSource(srv.Client(), srv.URL)
	now := time.Unix(1_000_000, 0)
	ts.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		tok, err := ts.Token(context.Background(), "123", "sec")
		if err != nil || tok != "tok" {
			t.Fatalf("token = %q, %v", tok, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("want 1 mint while cached, got %d", calls.Load())
	}

	// 14 minutes later the cached token is within the refresh margin.
	now = now.Add(14*time.Minute + time.Second)
	if _, err := ts.Token(context.Background(), "123", "sec"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("want a re-mint near expiry, got %d calls", calls.Load())
	}

	ts.Forget("123")
	if _, err := ts.Token(context.Background(), "123", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
}
