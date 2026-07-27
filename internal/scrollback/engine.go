package scrollback

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"sigil.dev/sigil/internal/db"
	sigil "sigil.dev/sigil/pkg/sigil"
)

const maxBufferBytes = 512 * 1024 // 512KB per session before forced flush

type sessionBuffer struct {
	sessionID string
	chunks    [][]byte
	size      int
	sequence  int64
	mu        sync.Mutex
}

// Engine captures PTY output and persists it to the database
type Engine struct {
	db          *db.DB
	buffers     map[string]*sessionBuffer
	mu          sync.Mutex
	flushTicker *time.Ticker
	log         zerolog.Logger
	throughput  int64 // bytes processed, atomic
}

// New creates a new scrollback engine
func New(d *db.DB, flushIntervalMs int) *Engine {
	if flushIntervalMs <= 0 {
		flushIntervalMs = 500
	}
	return &Engine{
		db:          d,
		buffers:     make(map[string]*sessionBuffer),
		flushTicker: time.NewTicker(time.Duration(flushIntervalMs) * time.Millisecond),
		log:         zerolog.Nop(),
	}
}

// SetLogger sets the logger
func (e *Engine) SetLogger(log zerolog.Logger) {
	e.log = log
}

// Write appends data to the session's buffer (non-blocking)
func (e *Engine) Write(sessionID string, data []byte) {
	if len(data) == 0 {
		return
	}

	atomic.AddInt64(&e.throughput, int64(len(data)))

	e.mu.Lock()
	buf, ok := e.buffers[sessionID]
	if !ok {
		buf = &sessionBuffer{sessionID: sessionID}
		e.buffers[sessionID] = buf
	}
	e.mu.Unlock()

	chunk := make([]byte, len(data))
	copy(chunk, data)

	buf.mu.Lock()
	buf.chunks = append(buf.chunks, chunk)
	buf.size += len(data)
	shouldFlush := buf.size >= maxBufferBytes
	buf.mu.Unlock()

	if shouldFlush {
		go e.Flush(sessionID)
	}
}

// Flush writes buffered data for a session to the database
func (e *Engine) Flush(sessionID string) {
	e.mu.Lock()
	buf, ok := e.buffers[sessionID]
	e.mu.Unlock()

	if !ok {
		return
	}

	buf.mu.Lock()
	if len(buf.chunks) == 0 {
		buf.mu.Unlock()
		return
	}

	// Grab and reset
	chunks := buf.chunks
	buf.chunks = nil
	buf.size = 0
	seq := buf.sequence
	buf.sequence++
	buf.mu.Unlock()

	raw := bytes.Join(chunks, nil)
	plainText := StripANSI(raw)
	lineCount := strings.Count(plainText, "\n")

	chunk := sigil.ScrollbackChunk{
		SessionID: sessionID,
		Sequence:  seq,
		Timestamp: time.Now(),
		Data:      raw,
		PlainText: plainText,
		LineCount: lineCount,
	}

	if err := e.db.InsertScrollback(chunk); err != nil {
		e.log.Error().Err(err).Str("session", sessionID).Msg("insert scrollback failed")
	}
}

// FlushAll flushes all session buffers
func (e *Engine) FlushAll() {
	e.mu.Lock()
	sessionIDs := make([]string, 0, len(e.buffers))
	for id := range e.buffers {
		sessionIDs = append(sessionIDs, id)
	}
	e.mu.Unlock()

	for _, id := range sessionIDs {
		e.Flush(id)
	}
}

// StartFlushLoop starts the periodic flush goroutine
func (e *Engine) StartFlushLoop(ctx context.Context) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				e.FlushAll()
				return
			case <-e.flushTicker.C:
				e.FlushAll()
			}
		}
	}()
}

// RetentionParams are the live retention limits read each pass, so changes made
// via the settings API take effect on the next tick without a restart.
type RetentionParams struct {
	MaxBytesPerSession int64
	RetentionDays      int
	EventKeep          int
}

// StartRetentionLoop periodically enforces scrollback retention so the DB stays
// bounded (capture has no inline cap — every PTY flush is a row). It runs once
// shortly after start to tackle any pre-existing backlog, then every
// intervalSec. Params are pulled from `provider` each pass. Disk is reclaimed
// lazily (freed pages are reused by new inserts); a VACUUM is only needed for a
// one-off shrink after a large purge.
func (e *Engine) StartRetentionLoop(ctx context.Context, intervalSec int, provider func() RetentionParams) {
	if intervalSec <= 0 {
		intervalSec = 3600
	}
	go func() {
		trim := func() {
			p := provider()
			eventKeep := p.EventKeep
			if eventKeep <= 0 {
				eventKeep = 10000
			}
			n, err := e.db.TrimScrollback(p.MaxBytesPerSession, p.RetentionDays)
			if err != nil {
				e.log.Error().Err(err).Msg("scrollback retention trim failed")
			} else if n > 0 {
				e.log.Info().Int64("rows_deleted", n).
					Int64("max_bytes_per_session", p.MaxBytesPerSession).
					Int("retention_days", p.RetentionDays).
					Msg("scrollback retention trim")
			}
			// Bound the events table (previously unbounded) and reclaim freed
			// pages incrementally (no-op on legacy non-incremental DBs).
			if ev, err := e.db.PruneEvents(eventKeep); err != nil {
				e.log.Error().Err(err).Msg("events prune failed")
			} else if ev > 0 {
				e.log.Info().Int64("events_deleted", ev).Msg("events prune")
			}
			if err := e.db.IncrementalVacuum(0); err != nil {
				e.log.Debug().Err(err).Msg("incremental vacuum failed")
			}
		}
		// Initial pass after a short delay so startup discovery/connect settle first.
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
			trim()
		}
		ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				trim()
			}
		}
	}()
}

// Throughput returns bytes processed since startup
func (e *Engine) Throughput() int64 {
	return atomic.LoadInt64(&e.throughput)
}
