package session

import (
	"reflect"
	"testing"
)

func collect(f *triggerFeed, sessionID string, chunks ...string) []string {
	var got []string
	for _, c := range chunks {
		f.feed(sessionID, []byte(c), func(line string) { got = append(got, line) })
	}
	return got
}

func TestTriggerFeedSplitsLines(t *testing.T) {
	f := newTriggerFeed()
	got := collect(f, "s1", "hello\nworld\n")
	want := []string{"hello", "world"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTriggerFeedBuffersAcrossChunks(t *testing.T) {
	f := newTriggerFeed()
	got := collect(f, "s1", "par", "tial ", "line\ndone\n")
	want := []string{"partial line", "done"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTriggerFeedStripsANSI(t *testing.T) {
	f := newTriggerFeed()
	// SGR colour codes + an OSC title sequence should be removed.
	got := collect(f, "s1", "\x1b[31mERROR\x1b[0m: boom\n\x1b]0;title\x07ok\n")
	want := []string{"ERROR: boom", "ok"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTriggerFeedCarriageReturnSplits(t *testing.T) {
	f := newTriggerFeed()
	got := collect(f, "s1", "50%\r100%\rdone\n")
	want := []string{"50%", "100%", "done"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTriggerFeedDropsEmptyLines(t *testing.T) {
	f := newTriggerFeed()
	got := collect(f, "s1", "\n\n\x1b[0m\ntext  \n")
	want := []string{"text"} // blank + pure-escape lines dropped; trailing padding trimmed
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTriggerFeedForcesFlushOnOverlongLine(t *testing.T) {
	f := newTriggerFeed()
	long := make([]byte, maxPartialLine+10)
	for i := range long {
		long[i] = 'x'
	}
	var got []string
	f.feed("s1", long, func(line string) { got = append(got, line) })
	if len(got) != 1 || len(got[0]) != maxPartialLine+10 {
		t.Fatalf("expected one forced-flush line of len %d, got %d lines (first len %d)",
			maxPartialLine+10, len(got), func() int { if len(got) > 0 { return len(got[0]) }; return 0 }())
	}
}

func TestTriggerFeedSessionsIndependent(t *testing.T) {
	f := newTriggerFeed()
	var a, b []string
	f.feed("a", []byte("aa"), func(l string) { a = append(a, l) })
	f.feed("b", []byte("bb\n"), func(l string) { b = append(b, l) })
	f.feed("a", []byte("aa\n"), func(l string) { a = append(a, l) })
	if !reflect.DeepEqual(a, []string{"aaaa"}) {
		t.Fatalf("session a: got %v", a)
	}
	if !reflect.DeepEqual(b, []string{"bb"}) {
		t.Fatalf("session b: got %v", b)
	}
}
