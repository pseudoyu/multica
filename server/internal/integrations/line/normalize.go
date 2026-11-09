package line

import (
	"encoding/json"
	"strings"
	"unicode/utf16"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

// rawEvent is what the adapter stashes in InboundMessage.Raw: the fields the
// outbound path needs later and the core never reads.
type rawEvent struct {
	EventType       string `json:"event_type"`
	MessageType     string `json:"message_type,omitempty"`
	ReplyToken      string `json:"reply_token,omitempty"`
	QuoteToken      string `json:"quote_token,omitempty"`
	QuotedMessageID string `json:"quoted_message_id,omitempty"`
	ReceivedAtMs    int64  `json:"received_at_ms"`
}

// normalizeMessage maps a LINE message event onto the engine envelope. It
// returns ok=false for events that are not messages. Non-text messages map to
// MsgTypeUnknown in phase 1 (media arrives in phase 2).
func normalizeMessage(ev webhookEvent, receivedAtMs int64) (channel.InboundMessage, bool) {
	if ev.Type != "message" || ev.Message == nil {
		return channel.InboundMessage{}, false
	}
	m := ev.Message
	chatType := channel.ChatTypeP2P
	if ev.Source.isGroup() {
		chatType = channel.ChatTypeGroup
	}

	msgType := channel.MsgTypeUnknown
	text := ""
	addressed := false
	if m.Type == "text" {
		msgType = channel.MsgTypeText
		text, addressed = stripSelfMention(m.Text, m.Mention)
	}

	raw, _ := json.Marshal(rawEvent{
		EventType:       ev.Type,
		MessageType:     m.Type,
		ReplyToken:      ev.ReplyToken,
		QuoteToken:      m.QuoteToken,
		QuotedMessageID: m.QuotedMessageID,
		ReceivedAtMs:    receivedAtMs,
	})

	msg := channel.InboundMessage{
		EventID:   ev.WebhookEventID,
		MessageID: m.ID,
		Source: channel.Source{
			ChannelType: TypeLine,
			ChatID:      ev.Source.chatID(),
			ChatType:    chatType,
			SenderID:    ev.Source.UserID,
		},
		Type:           msgType,
		Text:           text,
		CommandText:    text,
		AddressedToBot: addressed,
		Raw:            raw,
	}
	return msg, true
}

// stripSelfMention removes every mention of the bot (isSelf) from text and
// reports whether there was one. Offsets are UTF-16 code units, as LINE
// sends them. Mentions of other users and @All stay as text; @All never
// addresses the bot.
func stripSelfMention(text string, mn *mention) (string, bool) {
	if mn == nil {
		return strings.TrimSpace(text), false
	}
	units := utf16.Encode([]rune(text))
	drop := make([]bool, len(units))
	addressed := false
	for _, me := range mn.Mentionees {
		if !me.IsSelf || me.Type == "all" {
			continue
		}
		start, end := me.Index, me.Index+me.Length
		if start < 0 || me.Length <= 0 || end > len(units) {
			continue
		}
		addressed = true
		for i := start; i < end; i++ {
			drop[i] = true
		}
		// Drop the space after the mention when it would otherwise double
		// up with the space (or line start) before it.
		if end < len(units) && units[end] == ' ' && (start == 0 || units[start-1] == ' ' || units[start-1] == '\n') {
			drop[end] = true
		}
	}
	if !addressed {
		return strings.TrimSpace(text), false
	}
	kept := make([]uint16, 0, len(units))
	for i, u := range units {
		if !drop[i] {
			kept = append(kept, u)
		}
	}
	return strings.TrimSpace(string(utf16.Decode(kept))), true
}

// decodeRaw reads back the adapter fields stored in InboundMessage.Raw.
func decodeRaw(raw json.RawMessage) rawEvent {
	var r rawEvent
	_ = json.Unmarshal(raw, &r)
	return r
}
