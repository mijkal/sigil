package session

import (
	"sync"
	"testing"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// The scenario these lock down (jupiter, 2026-08-04): the host rebooted with a
// tmux LaunchDaemon anchoring the server, so tmux was already UP by the time SSH
// answered again. sigild never observed a down state, so the down→up edge that
// drives auto-resurrect never fired. The degraded-discovery guard then read
// seen=0 against a stale peak of 14, declared it implausible, and suppressed
// pruning — for 75 minutes, with zero resurrect attempts. Nine sessions sat in
// the DB, intact and unrestored, until a human intervened.
//
// The lesson encoded here: restore must reconcile desired-vs-observed every
// cycle, not wait for a transition it may never see.

func newReconcileTestManager() *Manager {
	return &Manager{
		peakSeen:   make(map[string]int),
		missCounts: make(map[string]int),
		missMu:     sync.Mutex{},
		ephemeral:  newEphemeralMatcher([]string{"hostsh-*"}),
	}
}

func rows(names ...string) []sigil.Session {
	out := make([]sigil.Session, 0, len(names))
	for _, n := range names {
		out = append(out, sigil.Session{ID: "jupiter:" + n, Name: n})
	}
	return out
}

func live(names ...string) map[string]sigil.Session {
	out := map[string]sigil.Session{}
	for _, n := range names {
		out[n] = sigil.Session{ID: "jupiter:" + n, Name: n}
	}
	return out
}

// reconcileWanted mirrors the branch condition in DiscoverHost: tmux is up, no
// work sessions are live, and we still hold work rows for the host.
func (m *Manager) reconcileWanted(tmuxUp bool, seen map[string]sigil.Session, existing []sigil.Session) bool {
	return tmuxUp && m.countWorkLive(seen) == 0 && m.countWorkRows(existing) > 0
}

func TestReconcile_FiresOnEmptyServerWithRows(t *testing.T) {
	m := newReconcileTestManager()
	// Exactly the jupiter post-reboot state: server answering, nothing in it.
	if !m.reconcileWanted(true, live(), rows("Dodecki", "mycellm", "nextstep")) {
		t.Fatal("tmux up + 0 live + rows present must trigger reconcile; this is the reboot stall")
	}
}

func TestReconcile_DoesNotFightSingleSessionKill(t *testing.T) {
	m := newReconcileTestManager()
	// User ran `tmux kill-session -t nextstep`. Others still live, so the
	// miss-threshold prune owns this — resurrect must NOT undo a deliberate kill.
	if m.reconcileWanted(true, live("Dodecki", "mycellm"), rows("Dodecki", "mycellm", "nextstep")) {
		t.Fatal("reconcile must not fire while other sessions are live — it would fight legitimate destruction")
	}
}

func TestReconcile_SilentWhenServerDown(t *testing.T) {
	m := newReconcileTestManager()
	// tmux down is already handled by the down-state retry path; the reconcile
	// branch must not double-fire there.
	if m.reconcileWanted(false, live(), rows("Dodecki")) {
		t.Fatal("reconcile must not fire when the tmux probe says down")
	}
}

func TestReconcile_SilentWhenNoRows(t *testing.T) {
	m := newReconcileTestManager()
	// A genuinely empty host with nothing desired: nothing to restore.
	if m.reconcileWanted(true, live(), rows()) {
		t.Fatal("reconcile must not fire with no rows to restore")
	}
}

func TestReconcile_IgnoresEphemeralsBothSides(t *testing.T) {
	m := newReconcileTestManager()
	// Orchestrator ephemerals must not mask an empty work server: a host whose
	// only live session is a hostsh-* is still empty as far as the user's work
	// is concerned, and ephemeral rows are never worth resurrecting.
	if !m.reconcileWanted(true, live("hostsh-abc123"), rows("Dodecki", "hostsh-abc123")) {
		t.Fatal("an ephemeral-only live set must still count as an empty work server")
	}
	if m.reconcileWanted(true, live(), rows("hostsh-abc123")) {
		t.Fatal("ephemeral-only rows must not trigger a reconcile")
	}
}
