package session

import (
	"sync"
	"testing"
)

func newDegradedTestManager() *Manager {
	return &Manager{
		peakSeen:   make(map[string]int),
		missCounts: make(map[string]int),
		missMu:     sync.Mutex{},
	}
}

// The scenario these lock down: on 2026-07-29 a client retry loop exhausted
// jupiter's SSH channels, `tmux list-sessions` returned a partial list, the prune
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
	m.missCounts["h:nextstep"] = 2
	m.discoveryLooksDegraded("h", 30, 30)
	m.discoveryLooksDegraded("h", 0, 30)
	if m.missCounts["h:nextstep"] != 2 {
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
