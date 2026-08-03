package session

import (
	"fmt"
	"sync"
	"testing"

	sigil "sigil.dev/sigil/pkg/sigil"
)

func newDegradedTestManager() *Manager {
	return &Manager{
		peakSeen:   make(map[string]int),
		missCounts: make(map[string]int),
		missMu:     sync.Mutex{},
	}
}

// The scenario these lock down: on 2026-07-29 a client retry loop exhausted
// a host's SSH channels, `tmux list-sessions` returned a partial list, the prune
// path believed it, and seven healthy sessions were deleted from the DB — after
// which auto-resurrect had nothing to restore.

func TestDegraded_TrustsNormalDiscovery(t *testing.T) {
	m := newDegradedTestManager()
	// Establish a peak, then keep seeing the same count.
	for i := 0; i < 3; i++ {
		if degraded, _ := m.discoveryLooksDegraded("h", 30, 30); degraded {
			t.Fatalf("steady 30/30 flagged as degraded on cycle %d", i)
		}
	}
}

func TestDegraded_FlagsTheCliff(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("h", 30, 30) // set peak
	// This is the incident's shape: 30 sessions, then 1, ten seconds later.
	degraded, peak := m.discoveryLooksDegraded("h", 1, 30)
	if !degraded {
		t.Fatal("a collapse from 30 to 1 must be treated as a failed enumeration")
	}
	if peak != 30 {
		t.Fatalf("peak = %d, want 30", peak)
	}
}

func TestDegraded_ClearsMissCountsIsCallerSide(t *testing.T) {
	// The guard itself only reports; the prune path is responsible for clearing
	// counters. Verify the guard does not mutate them, so the two concerns stay
	// separable.
	m := newDegradedTestManager()
	m.missCounts["h:api-dev"] = 2
	m.discoveryLooksDegraded("h", 30, 30)
	m.discoveryLooksDegraded("h", 0, 30)
	if m.missCounts["h:api-dev"] != 2 {
		t.Fatal("guard should not touch miss counters")
	}
}

func TestDegraded_IgnoresLowTrafficHosts(t *testing.T) {
	m := newDegradedTestManager()
	// A host that never held more than 2 sessions: dropping to 0 is ordinary.
	m.discoveryLooksDegraded("h", 2, 2)
	if degraded, _ := m.discoveryLooksDegraded("h", 0, 2); degraded {
		t.Fatal("a host below the minimum peak must never trip the guard")
	}
}

func TestDegraded_NothingToProtect(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("h", 30, 30)
	if degraded, _ := m.discoveryLooksDegraded("h", 0, 0); degraded {
		t.Fatal("with zero DB rows there is nothing to prune, so nothing to guard")
	}
}

func TestDegraded_PlausibleAttritionIsBelieved(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("h", 10, 10)
	// Losing a few sessions at once is normal operator behaviour.
	if degraded, _ := m.discoveryLooksDegraded("h", 7, 10); degraded {
		t.Fatal("10 -> 7 should be believed")
	}
	if degraded, _ := m.discoveryLooksDegraded("h", 4, 10); degraded {
		t.Fatal("10 -> 4 is at the floor and should be believed")
	}
	if degraded, _ := m.discoveryLooksDegraded("h", 2, 10); !degraded {
		t.Fatal("10 -> 2 is below the floor and should be suspected")
	}
}

func TestDegraded_PeakDecaysSoTheGuardCannotLatch(t *testing.T) {
	m := newDegradedTestManager()
	// A host inflated to 50 by an ephemeral flood.
	m.discoveryLooksDegraded("h", 50, 50)
	// The flood is cleaned up; the host legitimately holds 7 now. Without decay
	// the guard would suppress pruning on this host forever, because 7 is below
	// 34% of 50.
	if degraded, _ := m.discoveryLooksDegraded("h", 7, 7); !degraded {
		t.Fatal("expected the first post-cleanup reading to look degraded")
	}
	// Believed cycles pull the peak down; within a handful the host is trusted.
	for i := 0; i < 12; i++ {
		m.decayPeak("h", 7)
	}
	if degraded, peak := m.discoveryLooksDegraded("h", 7, 7); degraded {
		t.Fatalf("guard latched: still degraded at seen=7 peak=%d", peak)
	}
}

func TestDegraded_PeakDecayAlwaysMakesProgress(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("h", 5, 5)
	// Integer division could stall at a small gap; assert it always moves.
	prev := m.peakSeen["h"]
	for i := 0; i < 10; i++ {
		m.decayPeak("h", 4)
		got := m.peakSeen["h"]
		if got > prev {
			t.Fatalf("peak grew during decay: %d -> %d", prev, got)
		}
		prev = got
	}
	if prev != 4 {
		t.Fatalf("decay stalled at %d, want 4", prev)
	}
}

func TestDegraded_PeakRisesImmediately(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("h", 5, 5)
	if _, peak := m.discoveryLooksDegraded("h", 40, 5); peak != 40 {
		t.Fatalf("peak should track a new high immediately, got %d", peak)
	}
}

func TestDegraded_HostsAreIndependent(t *testing.T) {
	m := newDegradedTestManager()
	m.discoveryLooksDegraded("a", 30, 30)
	if degraded, _ := m.discoveryLooksDegraded("b", 1, 1); degraded {
		t.Fatal("one host's peak must not affect another")
	}
}

// --- ephemerals must not move the guard's reference ------------------------
//
// The 2026-08-03 latch: Drydock's `hostsh-*` sessions are created in bursts and
// exit within seconds, so the population genuinely collapses between two polls.
// Counting them made every burst look like SSH exhaustion, and because
// `decayPeak` only runs on the believed branch — which a shrunken host can never
// reach — the guard latched permanently. utopia sat at peak_seen=42 against a
// true count of 3 and stopped pruning entirely: 223 orphan rows, unreclaimable.

func ephemeralTestManager() *Manager {
	m := newDegradedTestManager()
	m.ephemeral = newEphemeralMatcher([]string{"hostsh-*", "mctask-*", "mcclean-*"})
	return m
}

// mkLive builds a discovery result: `work` real sessions + `eph` ephemeral ones.
func mkLive(work, eph int) map[string]sigil.Session {
	out := map[string]sigil.Session{}
	for i := 0; i < work; i++ {
		n := fmt.Sprintf("project-%d", i)
		out[n] = sigil.Session{Name: n}
	}
	for i := 0; i < eph; i++ {
		n := fmt.Sprintf("hostsh-%08x", i)
		out[n] = sigil.Session{Name: n}
	}
	return out
}

// mkRows builds the DB-row equivalent.
func mkRows(work, eph int) []sigil.Session {
	var out []sigil.Session
	for i := 0; i < work; i++ {
		out = append(out, sigil.Session{Name: fmt.Sprintf("project-%d", i)})
	}
	for i := 0; i < eph; i++ {
		out = append(out, sigil.Session{Name: fmt.Sprintf("hostsh-%08x", i)})
	}
	return out
}

func TestDegraded_EphemeralsAreNotCounted(t *testing.T) {
	m := ephemeralTestManager()
	if got := m.countWorkLive(mkLive(3, 39)); got != 3 {
		t.Fatalf("countWorkLive = %d, want 3 (ephemerals must not count)", got)
	}
	if got := m.countWorkRows(mkRows(3, 220)); got != 3 {
		t.Fatalf("countWorkRows = %d, want 3 (ephemerals must not count)", got)
	}
}

func TestDegraded_EphemeralCollapseIsNotACliff(t *testing.T) {
	m := ephemeralTestManager()
	// Burst: the guard only ever sees the 3 work sessions, so the peak stays 3.
	if degraded, _ := m.discoveryLooksDegraded("h",
		m.countWorkLive(mkLive(3, 39)), m.countWorkRows(mkRows(3, 220))); degraded {
		t.Fatal("a burst of ephemerals must not register as a cliff")
	}
	// Every ephemeral exits. Work sessions are untouched, so this must stay
	// BELIEVED — that is the only path on which the miss-threshold can reclaim
	// the 220 orphaned ephemeral rows.
	degraded, peak := m.discoveryLooksDegraded("h",
		m.countWorkLive(mkLive(3, 0)), m.countWorkRows(mkRows(3, 220)))
	if degraded {
		t.Fatalf("ephemerals vanishing must not suppress pruning (peak=%d)", peak)
	}
}

// The defect itself, pinned: passing RAW counts (what the call site used to do)
// latches the guard, and it never recovers because decayPeak is unreachable from
// the degraded branch. If someone reverts to raw counts, this fails.
func TestDegraded_RawCountsLatchForeverOnAnEphemeralBurst(t *testing.T) {
	m := ephemeralTestManager()
	live, rows := mkLive(3, 39), mkRows(3, 220)

	// Old shape: every live session counts, so the burst sets peak=42.
	if degraded, _ := m.discoveryLooksDegraded("h", len(live), len(rows)); degraded {
		t.Fatal("precondition: the burst itself should look fine")
	}
	// The ephemerals exit. Truth is 3 live, 223 rows.
	after := mkLive(3, 0)
	for i := 0; i < 5; i++ {
		degraded, peak := m.discoveryLooksDegraded("h", len(after), len(rows))
		if !degraded {
			t.Fatalf("cycle %d unexpectedly believed — the latch is what we are pinning", i)
		}
		if peak != 42 {
			t.Fatalf("cycle %d: peak drifted to %d; the latch holds it at 42", i, peak)
		}
	}

	// Same reality on a host that never had a raw-counted burst: believed, so
	// pruning proceeds. NOTE the peak is in-memory and per-host, so the fix
	// prevents future latching rather than retroactively clearing one already
	// stuck — an already-latched host clears on the next sigild restart.
	if degraded, _ := m.discoveryLooksDegraded("fresh",
		m.countWorkLive(after), m.countWorkRows(rows)); degraded {
		t.Fatal("work-only counting must not latch")
	}
}

func TestDegraded_RealSSHExhaustionIsStillCaught(t *testing.T) {
	// The counterpart: the guard must still do its original job. WORK sessions
	// collapsing is the 2026-07-29 signal and must be disbelieved.
	m := ephemeralTestManager()
	m.discoveryLooksDegraded("h", m.countWorkLive(mkLive(30, 12)), 30)
	if degraded, _ := m.discoveryLooksDegraded("h",
		m.countWorkLive(mkLive(1, 12)), 30); !degraded {
		t.Fatal("a collapse of WORK sessions must still be treated as a failed enumeration")
	}
}
