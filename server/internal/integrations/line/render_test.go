package line

import (
	"strings"
	"testing"
)

func TestRenderPlainText(t *testing.T) {
	md := strings.Join([]string{
		"## Result",
		"**Bold** and *italic* and ~~gone~~ and `code_with_*stars*`",
		"See [the docs](https://example.com/docs) or https://example.com",
		"[https://a.example](https://a.example)",
		"- item one",
		"1. first",
		"snake_case_name stays",
		"```go",
		"func main() {",
		"\tfmt.Println(\"**not bold**\")",
		"}",
		"```",
		"| Name | Count |",
		"| --- | ---: |",
		"| alpha | 1 |",
		"| b | 22 |",
	}, "\n")
	want := strings.Join([]string{
		"Result",
		"Bold and italic and gone and code_with_*stars*",
		"See the docs https://example.com/docs or https://example.com",
		"https://a.example",
		"- item one",
		"1. first",
		"snake_case_name stays",
		"func main() {",
		"\tfmt.Println(\"**not bold**\")",
		"}",
		"Name   Count",
		"alpha  1",
		"b      22",
	}, "\n")
	if got := renderPlainText(md); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestSplitBubblesCountsUTF16(t *testing.T) {
	// Each emoji is 2 UTF-16 units: 3,000 of them is 6,000 units.
	text := strings.Repeat("😀", 3000)
	parts := splitBubbles(text, maxBubbleUnits)
	if len(parts) != 2 {
		t.Fatalf("want 2 parts, got %d", len(parts))
	}
	for _, p := range parts {
		if utf16Len(p) > maxBubbleUnits {
			t.Fatalf("part has %d units", utf16Len(p))
		}
	}
	if strings.Join(parts, "") != text {
		t.Fatal("splitting lost content")
	}
}

func TestSplitBubblesPrefersParagraphs(t *testing.T) {
	a := strings.Repeat("a", 3000)
	b := strings.Repeat("b", 3000)
	parts := splitBubbles(a+"\n\n"+b, maxBubbleUnits)
	if len(parts) != 2 || parts[0] != a || parts[1] != b {
		t.Fatalf("want split at the paragraph break, got %d parts", len(parts))
	}
}

func TestBuildBubblesCapsAtFive(t *testing.T) {
	short := buildBubbles("hello", "… continued in Multica:", "https://app/chat/1")
	if len(short) != 1 || short[0] != "hello" {
		t.Fatalf("short answer: %q", short)
	}

	var paras []string
	for i := 0; i < 8; i++ {
		paras = append(paras, strings.Repeat(string(rune('a'+i)), 4000))
	}
	got := buildBubbles(strings.Join(paras, "\n\n"), "… continued in Multica:", "https://app/chat/1")
	if len(got) != maxBubblesPerReply {
		t.Fatalf("want %d bubbles, got %d", maxBubblesPerReply, len(got))
	}
	last := got[len(got)-1]
	if !strings.HasSuffix(last, "\n\n… continued in Multica:\nhttps://app/chat/1") {
		t.Fatalf("last bubble should end with the continuation link, got suffix %q", last[len(last)-60:])
	}
	for i, b := range got {
		if utf16Len(b) > maxBubbleUnits {
			t.Fatalf("bubble %d has %d units", i, utf16Len(b))
		}
	}
}
