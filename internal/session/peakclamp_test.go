package session

import (
	"sync"
	"testing"
)

// The scenario these lock down (utopia, 2026-08-04): peakSeen latched at 13
// while the host genuinely held 4–5 work sessions. decayPeak — the only thing
// that lowers a peak — runs solely on the believed branch, which a latched host
// never reaches, so the guard warned every 5 seconds indefinitely and pruning
// stayed suppressed. Measuring over work sessions (2026-07-31) reduced the
// magnitude but not the deadlock.
//
// The invariant now: the reference can never exceed the number of rows there is
// to protect.

func newPeakTestManager() *Manager {
	return &Manager{
		peakSeen:   make(map[string]int),
		missCounts: make(map[string]int),
		missMu:     sync.Mutex{},
	}
}

func TestPeakClamp_BreaksTheUtopiaLatch(t *testing.T) {
	m := newPeakTestManager()
	// Historic peak of 13 from a busier period.
	m.discoveryLooksDegraded("utopia", 13, 13)
	// Host genuinely settles at 5 rows / 4 live. Under the old code:
	// 4 < 13*0.34 = 4.42 → degraded, forever.
	degraded, peak := m.discoveryLooksDegraded("utopia", 4, 5)
	if degraded {
		t.Fatalf("4 live against 5 rows must be believed; got degraded with peak=%d", peak)
	}
	if peak != 5 {
		t.Fatalf("peak must clamp to the row count 5, got %d", peak)
	}
}

func TestPeakClamp_StillCatchesTheOriginalIncident(t *testing.T) {
	m := newPeakTestManager()
	// 2026-07-29: 30 sessions, 30 rows, then SSH exhaustion drops it to 1.
	m.discoveryLooksDegraded("h", 30, 30)
	degraded, peak := m.discoveryLooksDegraded("h", 1, 30)
	if !degraded {
		t.Fatal("a 30→1 collapse with 30 rows must still be caught — the clamp is a no-op here")
	}
	if peak != 30 {
		t.Fatalf("peak = %d, want 30 (rows == peak, nothing to clamp)", peak)
	}
}

func TestPeakClamp_HoldsReferenceDuringSustainedOutage(t *testing.T) {
	m := newPeakTestManager()
	m.discoveryLooksDegraded("h", 30, 30)
	// Guard suppresses pruning, so rows stay at 30 across a long outage. The
	// reference must not erode cycle over cycle.
	for i := 0; i < 50; i++ {
		degraded, peak := m.discoveryLooksDegraded("h", 0, 30)
		if !degraded {
			t.Fatalf("cycle %d: protection eroded — outage must stay guarded while rows persist", i)
		}
		if peak != 30 {
			t.Fatalf("cycle %d: peak drifted to %d, want a stable 30", i, peak)
		}
	}
}

func TestPeakClamp_FollowsAGenuineShrink(t *testing.T) {
	m := newPeakTestManager()
	m.discoveryLooksDegraded("h", 20, 20)
	// Operator deletes sessions outright: rows fall to 6. The reference must
	// follow so the host is not measured against a peak it will never reach.
	degraded, peak := m.discoveryLooksDegraded("h", 6, 6)
	if degraded {
		t.Fatal("a host that genuinely shrank must not be permanently suspect")
	}
	if peak != 6 {
		t.Fatalf("peak = %d, want 6", peak)
	}
}

func TestPeakClamp_LowTrafficHostsUnaffected(t *testing.T) {
	m := newPeakTestManager()
	// Below degradedMinPeak the cliff test is meaningless either way.
	if degraded, _ := m.discoveryLooksDegraded("h", 0, 2); degraded {
		t.Fatal("a two-session host dropping to zero is ordinary, not degraded")
	}
}
