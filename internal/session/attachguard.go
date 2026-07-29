package session

import (
	"fmt"
	"sync"
	"time"
)

// Attach storm guard.
//
// WHY THIS EXISTS — the 2026-07-29 incident:
//
// A pane whose tmux session had been pruned re-attached in a tight loop for 45
// minutes at roughly one attempt per second. Every attempt opened an SSH channel
// that died instantly ("Process exited with status 1"), and the host's sshd
// MaxSessions is 10 by default. The loop starved discovery for every OTHER
// session on that host, which meant healthy sessions accumulated discovery
// misses, crossed the miss threshold, and were pruned from the DB too. Once a row
// is gone, auto-resurrect has nothing to restore, so the loss is permanent. Seven
// named sessions were destroyed this way.
//
// The clients DO implement exponential backoff with a retry ceiling
// (web/src/components/{TerminalTile,UnifiedTerminalTile}.tsx). It was defeated
// anyway — the budget is scoped to a React effect, so a remount resets it, and
// nothing stops a second tab, a stale tab, or the TUI from spending its own
// budget concurrently.
//
// So the ceiling cannot live only in the client. The hub is the only place that
// sees every attach for a target and is the thing whose SSH channels get
// exhausted, so the hub defends itself. A client-side retry loop is a
// denial-of-service you wrote yourself; this is the backstop that makes it
// survivable no matter which client misbehaves.
//
// Deliberately NOT a rate limit on healthy attaches: opening several panes on a
// live session in quick succession is normal and must stay fast. Only attaches
// that FAIL FAST — the signature of a session that isn't there — count against
// the budget, and any durable success clears it.

const (
	// A channel that dies within this window never really attached: the hub
	// emits channel.attached before `tmux attach` can fail, so a dead session
	// still yields a brief attached/closed pair. Mirrors DURABLE_MS in the
	// frontend tiles; keep the two in step.
	attachFailFastWindow = 10 * time.Second
	// Consecutive fail-fast attaches tolerated before a target is tripped.
	// Generous enough to ride out a genuine transient (tmux server restarting,
	// SSH blip) without tripping.
	attachFailBudget = 6
	// How long a tripped target refuses attaches. Long enough that a wedged
	// client cannot keep the host's SSH channels saturated, short enough that a
	// session which really does come back is reachable again quickly.
	attachCooldown = 60 * time.Second
)

type attachFailState struct {
	fails    int
	trippedAt time.Time
}

// attachGuard tracks fail-fast attaches per "host:session" target and trips a
// cooldown when a target looks dead. Safe for concurrent use.
type attachGuard struct {
	mu sync.Mutex
	m  map[string]*attachFailState
}

func newAttachGuard() *attachGuard {
	return &attachGuard{m: make(map[string]*attachFailState)}
}

// ErrAttachCoolingDown is returned to a client whose target is tripped. It is
// deliberately explicit so the UI can say something true instead of retrying
// into a wall.
type ErrAttachCoolingDown struct {
	Target string
	Retry  time.Duration
}

func (e *ErrAttachCoolingDown) Error() string {
	return fmt.Sprintf("%s: too many failed attaches — cooling down, retry in %s "+
		"(the tmux session probably no longer exists)", e.Target, e.Retry.Round(time.Second))
}

// allow reports whether an attach to target may proceed. When it returns false
// the caller must not open an SSH channel.
func (g *attachGuard) allow(target string, now time.Time) (bool, time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.m[target]
	if st == nil || st.trippedAt.IsZero() {
		return true, 0
	}
	if elapsed := now.Sub(st.trippedAt); elapsed < attachCooldown {
		return false, attachCooldown - elapsed
	}
	// Cooldown served. Clear it and let exactly one probe through; if that probe
	// also fails fast, recordFailure trips it again immediately (fails is still
	// at budget), so a dead target costs one attempt per cooldown, not a storm.
	st.trippedAt = time.Time{}
	return true, 0
}

// recordFailure notes an attach that died inside attachFailFastWindow. Returns
// true if this failure tripped the breaker.
func (g *attachGuard) recordFailure(target string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.m[target]
	if st == nil {
		st = &attachFailState{}
		g.m[target] = st
	}
	st.fails++
	if st.fails >= attachFailBudget && st.trippedAt.IsZero() {
		st.trippedAt = now
		return true
	}
	return false
}

// recordSuccess clears a target's failure history. Called when a channel has
// stayed up long enough to prove the session is real.
func (g *attachGuard) recordSuccess(target string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.m, target)
}

// forget drops all state for a target — used when a session is deliberately
// removed, so a later session reusing the name starts clean.
func (g *attachGuard) forget(target string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.m, target)
}
