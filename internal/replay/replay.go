// Package replay keeps a bounded, ordered, in-memory ring of PTY output per
// session so a (re)attaching client can be sent the buffered tail first, then
// live events — with a byte-offset cursor so reconnects resume without
// duplication (SIGIL-3).
//
// The buffer is deliberately memory-only: full durable history lives in the
// per-session pipe-pane log on the target host (SIGIL-1) and in the
// scrollback DB. This ring only has to bridge short client gaps (tab close,
// WS drop, mobile background) cheaply.
//
// Sequencing model: seq values are cumulative byte offsets in the session's
// output stream as observed by the current "feeder" channel. Each appended
// chunk is stamped with the offset AFTER its last byte, i.e. the cursor a
// client holds once it has consumed the chunk. Because sigild can hold
// several concurrent channels onto one tmux session (each channel is its own
// tmux attach with its own redraws), exactly one channel — the most recently
// attached — feeds the buffer; older channels' output is relayed to their own
// clients but not recorded, which keeps the ring a single coherent stream.
package replay

import "sync"

const (
	// DefaultCapacity bounds the retained bytes per session (~a few screens
	// of heavy TUI output). 20 sessions ≈ 5 MiB worst case.
	DefaultCapacity = 256 * 1024
	// DefaultFreshTail is how much history a client with no cursor receives
	// on attach. Kept modest: the attach redraw + scrollback sources cover
	// deeper history.
	DefaultFreshTail = 32 * 1024
)

type chunk struct {
	end  uint64 // byte offset after this chunk == cursor once consumed
	data []byte
}

type buffer struct {
	chunks []chunk
	size   int    // sum of len(data) currently retained
	next   uint64 // total bytes ever appended (cursor at stream head)
	feeder string // channel ID currently allowed to append
}

// Replay is the result of ReplayFrom: the buffered bytes a client is missing.
type Replay struct {
	Data []byte
	// FromSeq is the offset of Data[0]; NextSeq the cursor after Data. When
	// Data is empty both equal the stream head.
	FromSeq uint64
	NextSeq uint64
	// Truncated reports that the client's cursor fell behind the ring — some
	// bytes were evicted and are only recoverable from the durable log.
	Truncated bool
}

// Store holds per-session replay buffers.
type Store struct {
	mu       sync.Mutex
	bufs     map[string]*buffer
	capacity int
	tail     int
}

// NewStore creates a Store with default capacity.
func NewStore() *Store {
	return &Store{bufs: map[string]*buffer{}, capacity: DefaultCapacity, tail: DefaultFreshTail}
}

func (s *Store) buf(sessionID string) *buffer {
	b, ok := s.bufs[sessionID]
	if !ok {
		b = &buffer{}
		s.bufs[sessionID] = b
	}
	return b
}

// ClaimFeeder makes channelID the sole writer for the session, stealing from
// any previous feeder (newest attach wins — see package doc).
func (s *Store) ClaimFeeder(sessionID, channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf(sessionID).feeder = channelID
}

// IsFeeder reports whether channelID is the session's current sole writer.
func (s *Store) IsFeeder(sessionID, channelID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.bufs[sessionID]
	return ok && b.feeder == channelID
}

// ReleaseFeeder clears the feeder slot if channelID still holds it (a newer
// channel that already stole the slot is left alone).
func (s *Store) ReleaseFeeder(sessionID, channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b, ok := s.bufs[sessionID]; ok && b.feeder == channelID {
		b.feeder = ""
	}
}

// Append records data for the session if channelID is the current feeder and
// returns the cursor after the chunk. Non-feeder appends record nothing and
// return the current stream head (their bytes are per-channel redraw noise).
// The caller must not mutate data after the call — the ring retains the slice.
func (s *Store) Append(sessionID, channelID string, data []byte) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buf(sessionID)
	if b.feeder != channelID || len(data) == 0 {
		return b.next
	}
	b.next += uint64(len(data))
	b.chunks = append(b.chunks, chunk{end: b.next, data: data})
	b.size += len(data)
	for b.size > s.capacity && len(b.chunks) > 1 {
		b.size -= len(b.chunks[0].data)
		b.chunks = b.chunks[1:]
	}
	return b.next
}

// ReplayFrom returns the bytes a client is missing. cursor < 0 means "no
// cursor" (fresh attach) and yields at most DefaultFreshTail bytes of tail.
// Cursors are chunk-aligned by construction (clients only ever see chunk-end
// seqs); a mid-chunk cursor conservatively replays the whole containing chunk.
func (s *Store) ReplayFrom(sessionID string, cursor int64) Replay {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.bufs[sessionID]
	if !ok || len(b.chunks) == 0 {
		var head uint64
		if ok {
			head = b.next
		}
		return Replay{FromSeq: head, NextSeq: head}
	}

	oldestStart := b.chunks[0].end - uint64(len(b.chunks[0].data))
	var start uint64
	truncated := false
	if cursor < 0 {
		if b.next > uint64(s.tail) {
			start = b.next - uint64(s.tail)
		}
	} else {
		start = uint64(cursor)
		if start < oldestStart {
			truncated = true
		}
	}
	if start >= b.next {
		return Replay{FromSeq: b.next, NextSeq: b.next}
	}

	var out []byte
	var from uint64
	first := true
	for _, c := range b.chunks {
		if c.end <= start {
			continue
		}
		if first {
			from = c.end - uint64(len(c.data))
			first = false
		}
		out = append(out, c.data...)
	}
	if first {
		return Replay{FromSeq: b.next, NextSeq: b.next, Truncated: truncated}
	}
	return Replay{Data: out, FromSeq: from, NextSeq: b.next, Truncated: truncated}
}

// Drop discards the session's buffer (session destroyed/pruned).
func (s *Store) Drop(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bufs, sessionID)
}
