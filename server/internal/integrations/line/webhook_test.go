package line

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
)

func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature(t *testing.T) {
	body := []byte(`{"destination":"Ubot","events":[]}`)
	good := sign("s3cret", body)
	cases := []struct {
		name, secret, sig string
		body              []byte
		ok                bool
	}{
		{"valid", "s3cret", good, body, true},
		{"wrong secret", "other", good, body, false},
		{"tampered body", "s3cret", good, []byte(`{"destination":"Ubot","events":[{}]}`), false},
		{"empty signature", "s3cret", "", body, false},
		{"not base64", "s3cret", "%%%", body, false},
		{"empty secret", "", good, body, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifySignature(tc.secret, tc.body, tc.sig)
			if tc.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tc.ok && !errors.Is(err, ErrBadSignature) {
				t.Fatalf("want ErrBadSignature, got %v", err)
			}
		})
	}
}

func TestParseWebhookChecksDestination(t *testing.T) {
	if _, err := parseWebhook([]byte(`{"destination":"Ubot","events":[]}`), "Ubot"); err != nil {
		t.Fatalf("empty connection check should parse: %v", err)
	}
	if _, err := parseWebhook([]byte(`{"destination":"Uother","events":[]}`), "Ubot"); err == nil {
		t.Fatal("a webhook for another bot must be rejected")
	}
	if _, err := parseWebhook([]byte(`not json`), "Ubot"); err == nil {
		t.Fatal("malformed body must be rejected")
	}
}

func TestParseWebhookToleratesUnknownEventsAndFields(t *testing.T) {
	body := []byte(`{"destination":"Ubot","events":[
		{"type":"somethingNew","mode":"active","webhookEventId":"01A","source":{"type":"user","userId":"U1"},"extra":{"a":1}},
		{"type":"message","mode":"active","webhookEventId":"01B","replyToken":"rt","source":{"type":"group","groupId":"C1","userId":"U1"},
		 "message":{"id":"m1","type":"text","text":"hi","quoteToken":"q1","newField":true}}
	]}`)
	wb, err := parseWebhook(body, "Ubot")
	if err != nil {
		t.Fatal(err)
	}
	if len(wb.Events) != 2 || wb.Events[1].Message == nil || wb.Events[1].Message.QuoteToken != "q1" {
		t.Fatalf("unexpected events: %+v", wb.Events)
	}
	if got := wb.Events[1].Source.chatID(); got != "C1" {
		t.Fatalf("group chat id = %q", got)
	}
}

func TestNormalizeMessage(t *testing.T) {
	ev := webhookEvent{
		Type: "message", WebhookEventID: "01X", ReplyToken: "rt",
		Source:  eventSource{Type: "user", UserID: "U1"},
		Message: &eventMessage{ID: "m1", Type: "text", Text: "  hello  ", QuoteToken: "q"},
	}
	msg, ok := normalizeMessage(ev, 1234)
	if !ok {
		t.Fatal("text message should normalize")
	}
	if msg.Source.ChannelType != TypeLine || msg.Source.ChatID != "U1" || msg.Source.ChatType != channel.ChatTypeP2P || msg.Source.SenderID != "U1" {
		t.Fatalf("bad source: %+v", msg.Source)
	}
	if msg.Type != channel.MsgTypeText || msg.Text != "hello" || msg.CommandText != "hello" || msg.MessageID != "m1" || msg.EventID != "01X" {
		t.Fatalf("bad message: %+v", msg)
	}
	raw := decodeRaw(msg.Raw)
	if raw.ReplyToken != "rt" || raw.QuoteToken != "q" || raw.ReceivedAtMs != 1234 {
		t.Fatalf("bad raw: %+v", raw)
	}

	room := ev
	room.Source = eventSource{Type: "room", RoomID: "R1"}
	room.Message = &eventMessage{ID: "m2", Type: "sticker"}
	msg, ok = normalizeMessage(room, 0)
	if !ok || msg.Source.ChatType != channel.ChatTypeGroup || msg.Source.ChatID != "R1" || msg.Source.SenderID != "" {
		t.Fatalf("room sticker without consented user: %+v", msg.Source)
	}
	if msg.Type != channel.MsgTypeUnknown || msg.AddressedToBot {
		t.Fatalf("sticker should be unknown and unaddressed: %+v", msg)
	}

	if _, ok := normalizeMessage(webhookEvent{Type: "follow"}, 0); ok {
		t.Fatal("follow is not a message")
	}
	if !json.Valid(msg.Raw) {
		t.Fatal("raw must be valid JSON")
	}
}

func TestStripSelfMention(t *testing.T) {
	cases := []struct {
		name      string
		text      string
		mention   *mention
		want      string
		addressed bool
	}{
		{"no mention", "hello", nil, "hello", false},
		{"bot at start", "@Multica summarize this", &mention{Mentionees: []mentionee{{Index: 0, Length: 8, Type: "user", IsSelf: true}}}, "summarize this", true},
		{"bot in middle", "hey @Multica look", &mention{Mentionees: []mentionee{{Index: 4, Length: 8, Type: "user", IsSelf: true}}}, "hey look", true},
		{"other user kept", "@Ken can you check", &mention{Mentionees: []mentionee{{Index: 0, Length: 4, Type: "user", UserID: "U2"}}}, "@Ken can you check", false},
		{"all does not address", "@All meeting", &mention{Mentionees: []mentionee{{Index: 0, Length: 4, Type: "all"}}}, "@All meeting", false},
		// "😀" is two UTF-16 units, so the bot mention starts at unit 3.
		{"utf16 offsets", "😀 @ボット 翻訳して", &mention{Mentionees: []mentionee{{Index: 3, Length: 4, Type: "user", IsSelf: true}}}, "😀 翻訳して", true},
		{"out of range ignored", "hi", &mention{Mentionees: []mentionee{{Index: 5, Length: 3, IsSelf: true}}}, "hi", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, addressed := stripSelfMention(tc.text, tc.mention)
			if got != tc.want || addressed != tc.addressed {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, addressed, tc.want, tc.addressed)
			}
		})
	}
}
