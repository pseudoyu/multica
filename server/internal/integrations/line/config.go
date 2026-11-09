// Package line is the LINE Messaging API integration for the channel-agnostic
// engine. The workspace admin enables the Messaging API on a LINE Official
// Account and pastes the channel ID and channel secret into Multica; the
// installation is keyed by the bot's user ID from /v2/bot/info.
//
// Unlike every other channel, LINE only delivers webhooks, so inbound runs on
// a public HTTP route (POST /api/webhooks/line/{installationId}) that verifies
// the x-line-signature header and hands each normalized event to the shared
// Router. No supervisor Factory is registered: there is no connection to keep.
// Access tokens are minted on demand as 15-minute stateless tokens from the
// channel ID and secret, so no long-lived token is ever stored.
//
// Maintenance: this package is COMMUNITY-MAINTAINED. Its maintainers, the
// support boundary and the retirement rule are published at
// https://multica.ai/docs/community-maintained.
package line

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// TypeLine is the channel discriminator for the LINE adapter. Defined here
// (not in the channel core) so registering the platform never edits the core.
const TypeLine channel.Type = "line"

// Language is the bot copy language, chosen per installation at install time.
type Language string

const (
	LanguageJapanese           Language = "ja"
	LanguageEnglish            Language = "en"
	LanguageTraditionalChinese Language = "zh-Hant"
)

// DefaultLanguage is used when an installation has no language or an unknown
// one. LINE's largest markets are Japan, Taiwan and Thailand; Japanese is the
// default.
const DefaultLanguage = LanguageJapanese

// ParseLanguage normalizes a stored or requested language. Unknown values
// fall back to DefaultLanguage so a bad row never breaks replies.
func ParseLanguage(s string) Language {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "ja", "ja-jp":
		return LanguageJapanese
	case "en", "en-us", "en-gb":
		return LanguageEnglish
	case "zh-hant", "zh-tw", "zh-hk":
		return LanguageTraditionalChinese
	default:
		return DefaultLanguage
	}
}

// ValidLanguage reports whether s is one of the languages an admin may pick.
func ValidLanguage(s string) bool {
	switch Language(s) {
	case LanguageJapanese, LanguageEnglish, LanguageTraditionalChinese:
		return true
	}
	return false
}

// installConfig is the JSON shape stored in channel_installation.config for
// a LINE installation. app_id is the bot's user ID (the webhook destination);
// it fills the generic (channel_type, config->>'app_id') uniqueness slot.
type installConfig struct {
	AppID                  string `json:"app_id"`
	ChannelID              string `json:"channel_id"`
	BasicID                string `json:"basic_id,omitempty"`
	DisplayName            string `json:"display_name,omitempty"`
	ChannelSecretEncrypted string `json:"channel_secret_encrypted"`
	Language               string `json:"language,omitempty"`
}

// credentials is the decoded, decrypted form the transports run on.
type credentials struct {
	BotUserID     string
	ChannelID     string
	ChannelSecret string
	Language      Language
}

// Decrypter turns stored ciphertext into plaintext. The wiring injects a
// secretbox-backed implementation; tests inject nil (stored bytes are treated
// as plaintext).
type Decrypter func(ciphertext []byte) (plaintext []byte, err error)

// decodeCredentials parses the per-installation config blob and decrypts the
// channel secret. It is the single place the LINE config JSON is interpreted.
func decodeCredentials(raw json.RawMessage, decrypt Decrypter) (credentials, error) {
	if len(raw) == 0 {
		return credentials{}, errors.New("line: empty installation config")
	}
	var cfg installConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return credentials{}, fmt.Errorf("decode line installation config: %w", err)
	}
	if cfg.AppID == "" || cfg.ChannelID == "" || cfg.ChannelSecretEncrypted == "" {
		return credentials{}, errors.New("line: installation config is missing app_id, channel_id or channel secret")
	}
	secret, err := decryptSecret(cfg.ChannelSecretEncrypted, decrypt)
	if err != nil {
		return credentials{}, fmt.Errorf("decrypt channel secret: %w", err)
	}
	return credentials{
		BotUserID:     cfg.AppID,
		ChannelID:     cfg.ChannelID,
		ChannelSecret: secret,
		Language:      ParseLanguage(cfg.Language),
	}, nil
}

// PublicConfig is the non-secret subset of an installation config, safe to
// surface on the management API.
type PublicConfig struct {
	BotUserID   string
	ChannelID   string
	BasicID     string
	DisplayName string
	Language    Language
}

// DecodePublicConfig extracts the display-safe fields from a stored config
// blob. A decode miss yields a zero PublicConfig rather than an error so the
// management list still renders the row.
func DecodePublicConfig(raw json.RawMessage) PublicConfig {
	var cfg installConfig
	_ = json.Unmarshal(raw, &cfg)
	return PublicConfig{
		BotUserID:   cfg.AppID,
		ChannelID:   cfg.ChannelID,
		BasicID:     cfg.BasicID,
		DisplayName: cfg.DisplayName,
		Language:    ParseLanguage(cfg.Language),
	}
}

func decryptSecret(enc string, decrypt Decrypter) (string, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(stripWhitespace(enc))
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	if decrypt == nil {
		return string(ciphertext), nil
	}
	plaintext, err := decrypt(ciphertext)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func stripWhitespace(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r':
			return -1
		}
		return r
	}, s)
}
