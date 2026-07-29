package session

// Degraded-discovery detection.
//
// WHY THIS EXISTS — the 2026-07-29 session loss:
//
// A client retry loop against a pruned session opened ~1 SSH channel/sec against
// a host whose sshd MaxSessions is the default 10. With the channels saturated,
// `tmux list-sessions` for that host started returning a PARTIAL list. Discovery
// itself did not error — it succeeded and reported almost nothing.
//
// The prune path trusted that result. Healthy sessions looked "missing", their
// miss counters climbed past the threshold, and their DB rows were deleted. Once
// the row is gone auto-resurrect has nothing to restore, so the loss is
// permanent. Seven named sessions were destroyed this way in 72 hours.
//
// The guards that already existed (tmux server down, tmux just came up,
// auto-resurrect in flight) all cover cases where we KNOW we cannot see straight.
// This covers the case where we cannot see straight and don't know it.
//
// The signal is a cliff. Sessions do get killed, but they get killed a few at a
// time by a person, not 30-at-once between two polls ten seconds apart. A count
// that collapses relative to the best we have ever seen on that host is far more
// likely to be a failed enumeration than a mass extinction.

const (
	// A host must have shown at least this many sessions at some point before the
	// cliff test means anything — on a host that normally holds one or two
	// sessions, "dropped to zero" is perfectly ordinary.
	degradedMinPeak = 4
	// Trust a discovery that sees at least this fraction of the host's peak.
	// 0.34 tolerates losing up to about two-thirds of the sessions in one cycle
	// before we get suspicious, which is well beyond normal human behaviour and
	// well inside the collapse an exhausted SSH channel pool produces.
	degradedFloorRatio = 0.34
)

// discoveryLooksDegraded reports whether a discovery result is too thin to be
// believed, and the peak it was compared against.
//
// seen is the number of live sessions this discovery enumerated; existing is the
// number of DB rows for the host. Also records the peak, so it must be called
// once per discovery cycle per host.
func (m *Manager) discoveryLooksDegraded(hostName string, seen, existing int) (bool, int) {
	m.missMu.Lock()
	defer m.missMu.Unlock()

	peak := m.peakSeen[hostName]
	if seen > peak {
		m.peakSeen[hostName] = seen
		peak = seen
	}

	// Nothing to prune means nothing to protect.
	if existing == 0 {
		return false, peak
	}
	// Not enough history on this host for a cliff to be meaningful.
	if peak < degradedMinPeak {
		return false, peak
	}
	// Seeing at least the floor fraction of peak is plausible attrition.
	if float64(seen) >= float64(peak)*degradedFloorRatio {
		return false, peak
	}
	return true, peak
}

// decayPeak lowers a host's remembered peak toward the current reading. Called
// when a discovery is believed, so that a host which has genuinely shrunk (the
// operator closed a lot of sessions, or an ephemeral flood was cleaned up) stops
// being measured against a peak it will never reach again — otherwise the guard
// would latch on and suppress pruning forever.
func (m *Manager) decayPeak(hostName string, seen int) {
	m.missMu.Lock()
	defer m.missMu.Unlock()
	peak := m.peakSeen[hostName]
	if seen >= peak {
		m.peakSeen[hostName] = seen
		return
	}
	// Move a third of the way down. Fast enough to follow a real shrink within a
	// handful of cycles, slow enough that one thin-but-believed reading doesn't
	// reset the reference the guard depends on.
	next := peak - (peak-seen)/3
	if next < seen {
		next = seen
	}
	if next == peak {
		next = peak - 1
	}
	m.peakSeen[hostName] = next
}
