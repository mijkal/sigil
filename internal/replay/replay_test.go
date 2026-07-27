package replay

import (
	"bytes"
	"testing"
)

func newTestStore(capacity, tail int) *Store {
	s := NewStore()
	s.capacity = capacity
	s.tail = tail
	return s
}

func TestAppendAndCursorResume(t *testing.T) {
	s := NewStore()
	s.ClaimFeeder("h:a", "ch1")

	seq1 := s.Append("h:a", "ch1", []byte("hello "))
	if seq1 != 6 {
		t.Fatalf("seq1 = %d, want 6", seq1)
	}
	seq2 := s.Append("h:a", "ch1", []byte("world"))
	if seq2 != 11 {
		t.Fatalf("seq2 = %d, want 11", seq2)
	}

	// Client saw everything → replay from cursor is empty.
	r := s.ReplayFrom("h:a", int64(seq2))
	if len(r.Data) != 0 || r.NextSeq != 11 {
		t.Fatalf("expected empty replay at head, got %q next=%d", r.Data, r.NextSeq)
	}

	// Client saw only the first chunk → replay resumes without duplication.
	r = s.ReplayFrom("h:a", int64(seq1))
	if string(r.Data) != "world" || r.FromSeq != 6 || r.NextSeq != 11 || r.Truncated {
		t.Fatalf("resume replay wrong: %+v", r)
	}
}

func TestFreshAttachTail(t *testing.T) {
	s := newTestStore(1024, 8)
	s.ClaimFeeder("h:a", "ch1")
	s.Append("h:a", "ch1", []byte("0123456789")) // 10 bytes
	s.Append("h:a", "ch1", []byte("abcde"))      // 5 bytes

	r := s.ReplayFrom("h:a", -1)
	// tail=8 → start=15-8=7, which is mid-first-chunk → whole chunk replayed.
	if string(r.Data) != "0123456789abcde" && string(r.Data) != "89abcde" {
		t.Fatalf("unexpected tail replay %q", r.Data)
	}
	if r.NextSeq != 15 {
		t.Fatalf("NextSeq = %d, want 15", r.NextSeq)
	}
	// Whole-chunk semantics: chunk end 10 > start 7 → included from its start.
	if string(r.Data) == "0123456789abcde" && r.FromSeq != 0 {
		t.Fatalf("FromSeq = %d, want 0", r.FromSeq)
	}
}

func TestEvictionAndTruncated(t *testing.T) {
	s := newTestStore(10, 32)
	s.ClaimFeeder("h:a", "ch1")
	s.Append("h:a", "ch1", bytes.Repeat([]byte("A"), 6))
	s.Append("h:a", "ch1", bytes.Repeat([]byte("B"), 6)) // evicts the A chunk

	r := s.ReplayFrom("h:a", 0) // cursor before oldest retained byte
	if !r.Truncated {
		t.Fatal("expected Truncated for cursor behind ring")
	}
	if string(r.Data) != "BBBBBB" || r.FromSeq != 6 || r.NextSeq != 12 {
		t.Fatalf("post-eviction replay wrong: %+v (%q)", r, r.Data)
	}
}

func TestFeederStealAndRelease(t *testing.T) {
	s := NewStore()
	s.ClaimFeeder("h:a", "ch1")
	s.Append("h:a", "ch1", []byte("one"))

	// ch2 attaches and steals the feed; ch1's appends become no-ops.
	s.ClaimFeeder("h:a", "ch2")
	if seq := s.Append("h:a", "ch1", []byte("ignored")); seq != 3 {
		t.Fatalf("non-feeder append should return head 3, got %d", seq)
	}
	if seq := s.Append("h:a", "ch2", []byte("two")); seq != 6 {
		t.Fatalf("feeder append seq = %d, want 6", seq)
	}

	// ch1 closing must not clear ch2's slot.
	s.ReleaseFeeder("h:a", "ch1")
	if seq := s.Append("h:a", "ch2", []byte("!")); seq != 7 {
		t.Fatalf("ch2 should still feed after ch1 release, got %d", seq)
	}

	s.ReleaseFeeder("h:a", "ch2")
	if seq := s.Append("h:a", "ch2", []byte("x")); seq != 7 {
		t.Fatalf("released feeder should not append, got %d", seq)
	}

	r := s.ReplayFrom("h:a", 0)
	if string(r.Data) != "onetwo!" {
		t.Fatalf("stream = %q, want onetwo!", r.Data)
	}
}

func TestDropAndUnknownSession(t *testing.T) {
	s := NewStore()
	r := s.ReplayFrom("h:none", -1)
	if len(r.Data) != 0 || r.NextSeq != 0 || r.Truncated {
		t.Fatalf("unknown session replay wrong: %+v", r)
	}

	s.ClaimFeeder("h:a", "ch1")
	s.Append("h:a", "ch1", []byte("data"))
	s.Drop("h:a")
	r = s.ReplayFrom("h:a", -1)
	if len(r.Data) != 0 || r.NextSeq != 0 {
		t.Fatalf("dropped session replay wrong: %+v", r)
	}
}
