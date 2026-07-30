package session

import (
	"path/filepath"
	"sync"
)

// Ephemeral session policy.
//
// An orchestrator that spawns one tmux session per command (Drydock: `hostsh-<id>`
// for shell commands, `mctask-<id>` for task workers) creates, reads and deletes
// them. Both of its paths delete correctly.
//
// The zombie factory was auto-resurrect. When a tmux server restarts, sigild
// recreates EVERY detached DB row — including ephemerals whose owning run ended
// long ago. The replacement is owned by nobody and deleted by nobody, so it lives
// forever and is resurrected again on the next restart. One tmux restart
// resurrected 42 at once; the giveaway is a cluster of rows sharing an identical
// idle time. one host reached 50 rows this way, which exhausted the host's SSH
// MaxSessions (default 10) and got seven real sessions pruned as collateral — see
// attachguard.go for that half of the story.
//
// The fix is narrow on purpose: DO NOT RESURRECT them. There is deliberately no
// delete path — sigild does not own these sessions and must not race their owner.
// Not resurrecting is sufficient, because the existing miss-threshold prune
// reclaims the abandoned row on its own.

// ephemeralMatcher holds the compiled-ish glob set. Patterns are validated once
// at construction so a malformed glob can never silently match everything.
type ephemeralMatcher struct {
	mu       sync.RWMutex
	patterns []string
}

func newEphemeralMatcher(patterns []string) *ephemeralMatcher {
	em := &ephemeralMatcher{}
	em.set(patterns)
	return em
}

// set replaces the pattern list, dropping any pattern filepath.Match rejects.
// A bad glob is discarded rather than kept, because a pattern that errors would
// otherwise have to be treated as either "matches nothing" (silently disabling
// policy) or "matches everything" (silently disabling auto-resurrect entirely).
// Dropping it is the only choice that fails in a direction the operator can see.
func (em *ephemeralMatcher) set(patterns []string) []string {
	var good, bad []string
	for _, p := range patterns {
		if p == "" {
			bad = append(bad, p)
			continue
		}
		if _, err := filepath.Match(p, "probe"); err != nil {
			bad = append(bad, p)
			continue
		}
		good = append(good, p)
	}
	em.mu.Lock()
	em.patterns = good
	em.mu.Unlock()
	return bad
}

// matches reports whether name is an ephemeral session name. The whole name must
// match — filepath.Match is inherently anchored, so "hostsh-*" does not match
// "my-hostsh-thing".
func (em *ephemeralMatcher) matches(name string) bool {
	em.mu.RLock()
	pats := em.patterns
	em.mu.RUnlock()
	for _, p := range pats {
		if ok, err := filepath.Match(p, name); err == nil && ok {
			return true
		}
	}
	return false
}

func (em *ephemeralMatcher) list() []string {
	em.mu.RLock()
	defer em.mu.RUnlock()
	out := make([]string, len(em.patterns))
	copy(out, em.patterns)
	return out
}

// SetEphemeralPatterns installs the ephemeral-session glob set. Any pattern that
// is not a valid glob is dropped and returned so the caller can log it.
func (m *Manager) SetEphemeralPatterns(patterns []string) (dropped []string) {
	if m.ephemeral == nil {
		m.ephemeral = newEphemeralMatcher(nil)
	}
	return m.ephemeral.set(patterns)
}

// IsEphemeralName reports whether a session name is single-shot by policy and so
// must not be auto-resurrected.
func (m *Manager) IsEphemeralName(name string) bool {
	if m.ephemeral == nil {
		return false
	}
	return m.ephemeral.matches(name)
}

// EphemeralPatterns returns the active glob set (for diagnostics).
func (m *Manager) EphemeralPatterns() []string {
	if m.ephemeral == nil {
		return nil
	}
	return m.ephemeral.list()
}

// --- Ephemeral socket isolation (2026-07-30) ---
//
// Ephemeral sessions live on their OWN tmux server, reached with `tmux -L`.
//
// Why: an orchestrator spawns ~70 hostsh-* sessions/day on the same tmux server
// as the operator's long-lived work sessions. Sharing one server means sharing
// one fd budget, one crash, and one lifecycle — on 2026-07-30 a burst of that
// churn coincided with the server dying repeatedly and taking every named
// session with it. Two servers means orchestrator churn cannot reach the work
// sessions no matter how badly it misbehaves.
//
// The socket NAME (not a path) is used so it resolves under whatever TMUX_TMPDIR
// the host exports — on jupiter that is ~/.local/state/tmux, deliberately out of
// /tmp so macOS's periodic cleaner cannot delete a live socket.
const ephemeralSocket = "sigil-ephemeral"

// tmuxFor returns the tmux invocation prefix for a session, routing ephemeral
// names to the isolated server and everything else to the default one.
//
// Every session-scoped tmux call must go through this. A call that hardcodes
// "tmux" will silently operate on the wrong server: for an ephemeral session it
// targets the default server, where that session does not exist, so the command
// is a no-op rather than a visible error.
func (m *Manager) tmuxFor(name string) string {
	if m.IsEphemeralName(name) {
		return "tmux -L " + ephemeralSocket
	}
	return "tmux"
}
