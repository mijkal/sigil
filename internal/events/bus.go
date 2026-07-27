package events

import (
	"context"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"sigil.dev/sigil/internal/db"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// Handler is a function called for every event
type Handler func(e sigil.Event)

// UIAction is a trigger effect delivered to connected web clients (flash, bg
// tint, audio, toast). The hub broadcasts it over the WS control channel.
type UIAction struct {
	Action    string                 `json:"action"`  // flash | tint | audio | toast
	Trigger   string                 `json:"trigger"` // trigger name (for display)
	SessionID string                 `json:"sessionId,omitempty"`
	Match     string                 `json:"match,omitempty"` // the line that matched
	Config    map[string]interface{} `json:"config,omitempty"`
}

// uiActionKinds is the set of actions delivered to the frontend (vs. server-side
// actions like webhook). "notify" is the legacy name, delivered as a toast.
var uiActionKinds = map[string]bool{"flash": true, "tint": true, "audio": true, "toast": true, "notify": true}

// Bus is an in-process event bus with pattern-based trigger matching
type Bus struct {
	triggers         []sigil.Trigger
	compiledPatterns map[string]*regexp.Regexp // keyed by trigger ID
	handlers         []Handler
	mu               sync.RWMutex
	ch               chan sigil.Event
	log              zerolog.Logger
	db               *db.DB
	webhookCli       *Client
	uiAction         func(UIAction)
	hasOutputTrig    atomic.Bool   // fast gate for the PTY hot path
	lastFired        map[string]time.Time // trigger ID -> last fire (debounce)
}

// New creates a new event bus
func New(d *db.DB) *Bus {
	return &Bus{
		ch:               make(chan sigil.Event, 1024),
		db:               d,
		log:              zerolog.Nop(),
		webhookCli:       NewWebhookClient(),
		compiledPatterns: make(map[string]*regexp.Regexp),
		lastFired:        make(map[string]time.Time),
	}
}

// SetUIActionHook installs the callback used to deliver UI trigger effects to
// connected clients (wired to the WS broadcaster in main).
func (b *Bus) SetUIActionHook(fn func(UIAction)) {
	b.mu.Lock()
	b.uiAction = fn
	b.mu.Unlock()
}

// HasOutputTriggers reports whether any enabled trigger matches session output.
// It is a lock-free atomic read, safe to call from the PTY hot path as the gate
// that keeps the no-trigger default at zero overhead.
func (b *Bus) HasOutputTriggers() bool {
	return b.hasOutputTrig.Load()
}

// SetLogger sets the logger
func (b *Bus) SetLogger(log zerolog.Logger) {
	b.log = log
	b.webhookCli.SetLogger(log)
}

// Subscribe registers a handler called for every event
func (b *Bus) Subscribe(h Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers = append(b.handlers, h)
}

// Publish sends an event to the bus channel (non-blocking)
func (b *Bus) Publish(e sigil.Event) {
	select {
	case b.ch <- e:
	default:
		b.log.Warn().Str("type", e.Type).Msg("event bus full, dropping event")
	}
}

// Chan returns the channel for external publishing
func (b *Bus) Chan() chan<- sigil.Event {
	return b.ch
}

// LoadTriggers loads triggers from the database and pre-compiles their regex patterns.
func (b *Bus) LoadTriggers() {
	triggers, err := b.db.GetTriggers()
	if err != nil {
		b.log.Error().Err(err).Msg("load triggers failed")
		return
	}

	compiled := make(map[string]*regexp.Regexp, len(triggers))
	for _, t := range triggers {
		re, err := regexp.Compile(t.Pattern)
		if err != nil {
			b.log.Error().Err(err).Str("trigger", t.ID).Str("pattern", t.Pattern).Msg("invalid trigger pattern, skipping")
			continue
		}
		compiled[t.ID] = re
	}

	// Gate for the PTY hot path: any enabled trigger with a usable pattern means
	// output must be line-matched. When none exist, the manager skips all work.
	active := false
	for _, t := range triggers {
		if t.Enabled {
			if _, ok := compiled[t.ID]; ok {
				active = true
				break
			}
		}
	}

	b.mu.Lock()
	b.triggers = triggers
	b.compiledPatterns = compiled
	b.mu.Unlock()
	b.hasOutputTrig.Store(active)
	b.log.Info().Int("count", len(triggers)).Bool("output_matching", active).Msg("triggers loaded")
}

// Run processes events from the channel until ctx is cancelled
func (b *Bus) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-b.ch:
			if !ok {
				return
			}
			b.dispatch(e)
		}
	}
}

func (b *Bus) dispatch(e sigil.Event) {
	// session.output is a high-volume, ephemeral stream that exists ONLY to feed
	// the trigger matcher. It must NOT be persisted (this grew the events table)
	// and must NOT reach the generic handlers — one of those rebroadcasts every
	// event to WS clients as event.fired, which would turn a busy session into a
	// toast storm. Match it and return; never let it touch the normal path.
	if e.Type == "session.output" {
		b.matchOutput(e)
		return
	}

	// Persist and fan out normal (low-volume) events.
	if err := b.db.LogEvent(e); err != nil {
		b.log.Error().Err(err).Str("event", e.Type).Msg("log event failed")
	}
	b.mu.RLock()
	handlers := make([]Handler, len(b.handlers))
	copy(handlers, b.handlers)
	b.mu.RUnlock()
	for _, h := range handlers {
		h(e)
	}
}

// matchOutput checks a session.output line against every enabled trigger.
func (b *Bus) matchOutput(e sigil.Event) {
	b.mu.RLock()
	triggers := make([]sigil.Trigger, len(b.triggers))
	copy(triggers, b.triggers)
	compiled := b.compiledPatterns
	b.mu.RUnlock()

	output, _ := e.Data["output"].(string)
	for _, t := range triggers {
		if !t.Enabled {
			continue
		}
		re, ok := compiled[t.ID]
		if !ok {
			// Pattern failed to compile at load time — skip silently
			continue
		}
		if re.MatchString(output) {
			b.fireTrigger(t, e)
		}
	}
}

// defaultDebounce throttles repeat fires of the same trigger; a matching pattern
// in a busy stream would otherwise fire hundreds of times a second. Overridable
// per trigger via Config["debounce_ms"].
const defaultDebounce = 3 * time.Second

// debounced reports whether trigger t fired too recently to fire again now.
func (b *Bus) debounced(t sigil.Trigger, now time.Time) bool {
	window := defaultDebounce
	if ms, ok := numField(t.Config["debounce_ms"]); ok && ms >= 0 {
		window = time.Duration(ms) * time.Millisecond
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if last, ok := b.lastFired[t.ID]; ok && now.Sub(last) < window {
		return true
	}
	b.lastFired[t.ID] = now
	return false
}

func (b *Bus) fireTrigger(t sigil.Trigger, e sigil.Event) {
	if b.debounced(t, time.Now()) {
		return
	}
	b.log.Info().Str("trigger", t.Name).Str("action", t.Action).Msg("trigger fired")

	switch t.Action {
	case "webhook":
		url, _ := t.Config["url"].(string)
		secret, _ := t.Config["secret"].(string)
		if url == "" {
			b.log.Warn().Str("trigger", t.Name).Msg("webhook trigger missing url")
			return
		}
		payload := map[string]interface{}{
			"trigger": t,
			"event":   e,
		}
		go func() {
			if err := b.webhookCli.Dispatch(url, secret, payload); err != nil {
				b.log.Error().Err(err).Str("trigger", t.Name).Msg("webhook dispatch failed")
			}
		}()
	default:
		if !uiActionKinds[t.Action] {
			b.log.Warn().Str("action", t.Action).Msg("unknown trigger action")
			return
		}
		b.mu.RLock()
		hook := b.uiAction
		b.mu.RUnlock()
		if hook == nil {
			return
		}
		sess, _ := e.Data["session"].(string)
		match, _ := e.Data["output"].(string)
		hook(UIAction{
			Action:    t.Action,
			Trigger:   t.Name,
			SessionID: sess,
			Match:     match,
			Config:    t.Config,
		})
	}
}

// numField coerces a JSON-decoded config value (float64, int, or numeric string)
// to a float64.
func numField(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
