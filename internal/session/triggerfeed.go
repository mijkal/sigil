package session

import (
	"regexp"
	"sync"
)

// triggerFeed turns a session's feeder byte-stream into complete text lines for
// the event bus's trigger matcher. This is deliberately separate from the
// scrollback/replay path: it exists only to drive triggers, runs only when
// output triggers are configured (see Manager.triggerGate), and never persists.
//
// Lines are split on \n and \r (so \r-overwriting progress bars still yield
// segments), ANSI/control noise is stripped, and an over-long partial line is
// force-flushed so a stream that never emits a newline can't grow unbounded.
type triggerFeed struct {
	mu   sync.Mutex
	bufs map[string][]byte // sessionID -> bytes since the last line boundary
}

func newTriggerFeed() *triggerFeed {
	return &triggerFeed{bufs: make(map[string][]byte)}
}

// maxPartialLine caps an unterminated line; beyond it we flush what we have so
// a newline-free stream (e.g. a spinner) can't accumulate without bound.
const maxPartialLine = 8192

// feed appends data for one session and invokes emit once per complete line
// (already stripped and non-empty). The caller supplies only feeder-channel
// bytes; ordering across calls for a session must be preserved by the caller.
func (f *triggerFeed) feed(sessionID string, data []byte, emit func(line string)) {
	f.mu.Lock()
	buf := append(f.bufs[sessionID], data...)

	start := 0
	for i := 0; i < len(buf); i++ {
		if buf[i] == '\n' || buf[i] == '\r' {
			emitLine(buf[start:i], emit)
			start = i + 1
		}
	}
	rest := buf[start:]
	if len(rest) > maxPartialLine {
		emitLine(rest, emit)
		rest = nil
	}
	// Copy the remainder into a fresh slice so we don't retain the (larger)
	// backing array of data across calls.
	f.bufs[sessionID] = append([]byte(nil), rest...)
	f.mu.Unlock()
}

// forget drops a session's partial-line buffer (call on session/channel end).
func (f *triggerFeed) forget(sessionID string) {
	f.mu.Lock()
	delete(f.bufs, sessionID)
	f.mu.Unlock()
}

func emitLine(raw []byte, emit func(string)) {
	line := stripANSI(string(raw))
	if line != "" {
		emit(line)
	}
}

// ansiSeq matches CSI (ESC [ … final) and OSC (ESC ] … BEL/ST) escape sequences
// plus lone ESC-prefixed two-byte sequences — enough to reduce a terminal line
// to its human-readable text for pattern matching.
var ansiSeq = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// otherCtrl matches remaining C0 control bytes (except tab), which carry no
// text meaning for matching.
var otherCtrl = regexp.MustCompile("[\x00-\x08\x0b-\x1f\x7f]")

func stripANSI(s string) string {
	s = ansiSeq.ReplaceAllString(s, "")
	s = otherCtrl.ReplaceAllString(s, "")
	// Trim trailing spaces left by cleared cells; keep interior spacing.
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
