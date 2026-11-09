package line

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// MaxWebhookBodyBytes caps a webhook request body. LINE batches several
// events per request, but text events are small; 1 MiB leaves ample room.
const MaxWebhookBodyBytes = 1 << 20

// SignatureHeader is the header LINE signs every webhook request with.
const SignatureHeader = "X-Line-Signature"

// ErrBadSignature is returned when x-line-signature does not match the body.
var ErrBadSignature = errors.New("line: webhook signature mismatch")

// VerifySignature checks x-line-signature: Base64(HMAC-SHA256(channel
// secret, raw body)). It must run on the raw bytes before any parsing.
func VerifySignature(channelSecret string, body []byte, signature string) error {
	if channelSecret == "" || signature == "" {
		return ErrBadSignature
	}
	got, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return ErrBadSignature
	}
	mac := hmac.New(sha256.New, []byte(channelSecret))
	mac.Write(body)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return ErrBadSignature
	}
	return nil
}

// webhookBody is the top-level webhook payload.
type webhookBody struct {
	Destination string         `json:"destination"`
	Events      []webhookEvent `json:"events"`
}

// webhookEvent is one event. Only the fields phase 1 reads are modelled;
// LINE adds fields and event types without notice, so decoding is lenient.
type webhookEvent struct {
	Type            string          `json:"type"`
	Mode            string          `json:"mode"`
	Timestamp       int64           `json:"timestamp"`
	WebhookEventID  string          `json:"webhookEventId"`
	ReplyToken      string          `json:"replyToken"`
	Source          eventSource     `json:"source"`
	Message         *eventMessage   `json:"message,omitempty"`
	DeliveryContext deliveryContext `json:"deliveryContext"`
	Unsend          *struct {
		MessageID string `json:"messageId"`
	} `json:"unsend,omitempty"`
}

type deliveryContext struct {
	IsRedelivery bool `json:"isRedelivery"`
}

type eventSource struct {
	Type    string `json:"type"` // user, group, room
	UserID  string `json:"userId"`
	GroupID string `json:"groupId"`
	RoomID  string `json:"roomId"`
}

type eventMessage struct {
	ID              string   `json:"id"`
	Type            string   `json:"type"`
	Text            string   `json:"text"`
	QuoteToken      string   `json:"quoteToken"`
	QuotedMessageID string   `json:"quotedMessageId"`
	Mention         *mention `json:"mention,omitempty"`
}

type mention struct {
	Mentionees []mentionee `json:"mentionees"`
}

type mentionee struct {
	Index  int    `json:"index"`
	Length int    `json:"length"`
	Type   string `json:"type"` // user, all
	UserID string `json:"userId"`
	IsSelf bool   `json:"isSelf"`
}

// parseWebhook decodes a verified body and checks that it was sent to the
// installation's bot. An empty events array is the console's connection
// check and is valid.
func parseWebhook(body []byte, botUserID string) (webhookBody, error) {
	var wb webhookBody
	if err := json.Unmarshal(body, &wb); err != nil {
		return webhookBody{}, fmt.Errorf("line: decode webhook body: %w", err)
	}
	if wb.Destination != botUserID {
		return webhookBody{}, fmt.Errorf("line: webhook destination %q does not match the installation's bot", wb.Destination)
	}
	return wb, nil
}

// chatID returns the conversation ID for the event's source: the user for a
// 1:1 chat, otherwise the group or room.
func (s eventSource) chatID() string {
	switch s.Type {
	case "group":
		return s.GroupID
	case "room":
		return s.RoomID
	default:
		return s.UserID
	}
}

func (s eventSource) isGroup() bool { return s.Type == "group" || s.Type == "room" }
