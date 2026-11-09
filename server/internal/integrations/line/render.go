package line

import (
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// LINE text messages hold at most 5,000 UTF-16 code units and one request
// carries at most five messages. Bubbles stay under 4,500 units so a quote
// token or mention prefix never pushes one over the limit.
const (
	maxBubbleUnits     = 4500
	maxBubblesPerReply = 5
)

var (
	reMDBold       = regexp.MustCompile(`\*\*(.+?)\*\*`)
	reMDBoldUnder  = regexp.MustCompile(`__(.+?)__`)
	reMDItalic     = regexp.MustCompile(`(^|[^*\w])\*([^*\s][^*]*?)\*`)
	reMDStrike     = regexp.MustCompile(`~~(.+?)~~`)
	reMDInlineCode = regexp.MustCompile("`([^`]+)`")
	reMDImage      = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)
	reMDLink       = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
	reMDHeading    = regexp.MustCompile(`^#{1,6}\s+(.*)$`)
	reMDTableSep   = regexp.MustCompile(`^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$`)
)

// renderPlainText turns the agent's Markdown into LINE plain text: emphasis
// markers are dropped, links become "text url", list markers stay, code
// fences keep their content without the backticks, and tables become aligned
// lines.
func renderPlainText(md string) string {
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	inCode := false
	var table []string
	flushTable := func() {
		if len(table) > 0 {
			out = append(out, renderTable(table)...)
			table = nil
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			flushTable()
			inCode = !inCode
			continue
		}
		if inCode {
			out = append(out, line)
			continue
		}
		if strings.HasPrefix(trimmed, "|") && strings.Count(trimmed, "|") >= 2 {
			table = append(table, trimmed)
			continue
		}
		flushTable()
		out = append(out, renderInline(line))
	}
	flushTable()
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func renderInline(line string) string {
	if m := reMDHeading.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
		line = m[1]
	}
	// Inline code first so markers inside it survive.
	var codes []string
	line = reMDInlineCode.ReplaceAllStringFunc(line, func(s string) string {
		codes = append(codes, s[1:len(s)-1])
		return "\x00" + string(rune('0'+len(codes)-1)) + "\x00"
	})
	line = reMDImage.ReplaceAllString(line, "$1 $2")
	line = reMDLink.ReplaceAllStringFunc(line, func(s string) string {
		m := reMDLink.FindStringSubmatch(s)
		if m[1] == m[2] {
			return m[2]
		}
		return m[1] + " " + m[2]
	})
	line = reMDBold.ReplaceAllString(line, "$1")
	line = reMDBoldUnder.ReplaceAllString(line, "$1")
	line = reMDStrike.ReplaceAllString(line, "$1")
	line = reMDItalic.ReplaceAllString(line, "$1$2")
	for i, c := range codes {
		line = strings.Replace(line, "\x00"+string(rune('0'+i))+"\x00", c, 1)
	}
	return line
}

// renderTable aligns a Markdown table into padded columns. Widths count
// runes, which is exact for Latin text and close enough for CJK in LINE's
// proportional font.
func renderTable(rows []string) []string {
	var cells [][]string
	for _, r := range rows {
		if reMDTableSep.MatchString(r) {
			continue
		}
		r = strings.TrimSpace(r)
		r = strings.TrimPrefix(r, "|")
		r = strings.TrimSuffix(r, "|")
		parts := strings.Split(r, "|")
		for i := range parts {
			parts[i] = renderInline(strings.TrimSpace(parts[i]))
		}
		cells = append(cells, parts)
	}
	var widths []int
	for _, row := range cells {
		for i, c := range row {
			if i >= len(widths) {
				widths = append(widths, 0)
			}
			if n := utf8.RuneCountInString(c); n > widths[i] {
				widths[i] = n
			}
		}
	}
	out := make([]string, 0, len(cells))
	for _, row := range cells {
		var b strings.Builder
		for i, c := range row {
			if i > 0 {
				b.WriteString("  ")
			}
			b.WriteString(c)
			if i < len(row)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-utf8.RuneCountInString(c)))
			}
		}
		out = append(out, b.String())
	}
	return out
}

// utf16Len counts UTF-16 code units, LINE's unit for text limits.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// splitBubbles splits text into pieces of at most limit UTF-16 units,
// preferring paragraph, then line, then rune boundaries.
func splitBubbles(text string, limit int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	var out []string
	for utf16Len(text) > limit {
		cut := cutPoint(text, limit)
		out = append(out, strings.TrimRight(text[:cut], " \n"))
		text = strings.TrimLeft(text[cut:], " \n")
	}
	if text != "" {
		out = append(out, text)
	}
	return out
}

// cutPoint returns the byte offset of the best split at or before limit
// UTF-16 units.
func cutPoint(text string, limit int) int {
	units, maxByte := 0, 0
	for i, r := range text {
		if units+utf16.RuneLen(r) > limit {
			break
		}
		units += utf16.RuneLen(r)
		maxByte = i + utf8.RuneLen(r)
	}
	head := text[:maxByte]
	// Only accept a boundary in the back half so bubbles stay full.
	min := maxByte / 2
	if i := strings.LastIndex(head, "\n\n"); i > min {
		return i
	}
	if i := strings.LastIndex(head, "\n"); i > min {
		return i
	}
	if i := strings.LastIndex(head, " "); i > min {
		return i
	}
	return maxByte
}

// buildBubbles renders an agent answer into at most five LINE text bubbles.
// When the answer needs more, the fifth bubble is cut short and ends with
// the continuation line and a link to the Multica chat, so every answer is
// exactly one request (one billed message per recipient when pushed).
func buildBubbles(md string, continuation, chatURL string) []string {
	bubbles := splitBubbles(renderPlainText(md), maxBubbleUnits)
	if len(bubbles) <= maxBubblesPerReply {
		return bubbles
	}
	tail := "\n\n" + continuation
	if chatURL != "" {
		tail += "\n" + chatURL
	}
	room := maxBubbleUnits - utf16Len(tail)
	last := bubbles[maxBubblesPerReply-1]
	if utf16Len(last) > room {
		last = strings.TrimRight(last[:cutPoint(last, room)], " \n")
	}
	out := append([]string(nil), bubbles[:maxBubblesPerReply-1]...)
	return append(out, last+tail)
}
