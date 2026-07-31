package session

import (
	"strings"
	"testing"
	"time"
)

func ephem(name string) bool {
	return strings.HasPrefix(name, "hostsh-") || strings.HasPrefix(name, "mctask-")
}

func findCand(t *testing.T, cands []reapCandidate, name string) reapCandidate {
	t.Helper()
	for _, c := range cands {
		if c.name == name {
			return c
		}
	}
	t.Fatalf("candidate %q not found in %+v", name, cands)
	return reapCandidate{}
}

// The whole policy in one table. This code KILLS sessions, so every guard needs
// a case that fails loudly if someone relaxes it.
func TestShouldReapPolicy(t *testing.T) {
	ttl := 60 * time.Minute
	for _, tc := range []struct {
		what string
		c    reapCandidate
		want bool
	}{
		{"finished and long idle", reapCandidate{panePID: "100", idle: 90 * time.Minute}, true},
		{"exactly at the TTL", reapCandidate{panePID: "100", idle: ttl}, true},

		// A worker can run for hours in silence. Idle time is NOT evidence that
		// the work is over; a live process tree means hands off, at any age.
		{"still running, ancient", reapCandidate{panePID: "100", idle: 24 * time.Hour, hasKids: true}, false},
		{"still running, idle", reapCandidate{panePID: "100", idle: 90 * time.Minute, hasKids: true}, false},

		// A human watching a pane outranks a timer.
		{"attached", reapCandidate{panePID: "100", idle: 90 * time.Minute, attached: true}, false},

		{"finished but recent", reapCandidate{panePID: "100", idle: 5 * time.Minute}, false},
		{"no pane pid — unknown state", reapCandidate{panePID: "", idle: 24 * time.Hour}, false},
	} {
		if got := tc.c.shouldReap(ttl); got != tc.want {
			t.Errorf("%s: shouldReap=%v, want %v (%+v)", tc.what, got, tc.want, tc.c)
		}
	}
}

// Only ephemeral names are ever considered. A human's work session must never
// appear as a candidate, whatever its idle time.
func TestParseReapListingIgnoresNonEphemeral(t *testing.T) {
	out := strings.Join([]string{
		"__E__|hostsh-abc|1000|500|0",
		"__E__|mctask-def|1000|501|0",
		"__E__|dodecki|1000|502|0", // a real work session, idle for ages
		"__E__|bridge-eng|1000|503|0",
		"__NOW__|9000",
		"__P__|1",
	}, "\n")
	cands := parseReapListing(out, ephem)
	if len(cands) != 2 {
		t.Fatalf("expected only the 2 ephemeral sessions, got %+v", cands)
	}
	for _, c := range cands {
		if !ephem(c.name) {
			t.Errorf("non-ephemeral %q became a candidate", c.name)
		}
	}
}

// Child detection comes from a single `ps` dump: a pane pid that appears as some
// process's parent still has work under it.
func TestParseReapListingDetectsChildren(t *testing.T) {
	out := strings.Join([]string{
		"__E__|hostsh-busy|1000|500|0",
		"__E__|hostsh-idle|1000|600|0",
		"__NOW__|9000",
		"__P__|500", // something is parented to the busy pane
		"__P__|1",
	}, "\n")
	cands := parseReapListing(out, ephem)
	if busy := findCand(t, cands, "hostsh-busy"); !busy.hasKids {
		t.Error("pane 500 has a child in the ps dump but hasKids is false")
	}
	if idle := findCand(t, cands, "hostsh-idle"); idle.hasKids {
		t.Error("pane 600 has no child but hasKids is true")
	}
	if idle := findCand(t, cands, "hostsh-idle"); idle.idle != 8000*time.Second {
		t.Errorf("idle = %v, want 8000s (now 9000 - activity 1000)", idle.idle)
	}
}

// A session with several panes is protected if ANY pane is still working.
func TestParseReapListingMultiPaneProtection(t *testing.T) {
	out := strings.Join([]string{
		"__E__|hostsh-multi|1000|500|0",
		"__E__|hostsh-multi|1000|501|0",
		"__NOW__|9000",
		"__P__|501",
	}, "\n")
	c := findCand(t, parseReapListing(out, ephem), "hostsh-multi")
	if c.shouldReap(time.Minute) {
		t.Error("a session with a busy second pane must not be reaped")
	}
}

// Attached sessions are surfaced as attached even when tmux reports it on only
// one of the session's pane lines.
func TestParseReapListingAttached(t *testing.T) {
	out := "__E__|hostsh-att|1000|500|1\n__NOW__|9000\n__P__|1"
	if c := findCand(t, parseReapListing(out, ephem), "hostsh-att"); !c.attached {
		t.Error("session reported attached=1 but candidate says otherwise")
	}
}

// If the clock line is missing or garbled we cannot compute idle time. Treating
// a missing clock as "idle since the epoch" would reap the entire server, so the
// listing must yield nothing at all.
func TestParseReapListingWithoutClockReapsNothing(t *testing.T) {
	for _, out := range []string{
		"__E__|hostsh-abc|1000|500|0\n__P__|1",
		"__E__|hostsh-abc|1000|500|0\n__NOW__|\n__P__|1",
		"__E__|hostsh-abc|1000|500|0\n__NOW__|garbage\n__P__|1",
	} {
		if got := parseReapListing(out, ephem); len(got) != 0 {
			t.Errorf("no usable clock must yield no candidates, got %+v", got)
		}
	}
}

// Malformed lines are skipped, never guessed at — a bad parse here is a kill.
func TestParseReapListingSkipsMalformed(t *testing.T) {
	out := strings.Join([]string{
		"__E__|hostsh-short|1000",        // too few fields
		"__E__||1000|500|0",              // no name
		"__E__|hostsh-bad|notanum|500|0", // unparseable activity
		"__E__|hostsh-ok|1000|500|0",
		"__NOW__|9000",
		"__P__|1",
	}, "\n")
	cands := parseReapListing(out, ephem)
	if len(cands) != 1 || cands[0].name != "hostsh-ok" {
		t.Fatalf("expected only hostsh-ok to survive parsing, got %+v", cands)
	}
}

// Clock skew between the tmux activity stamp and `date` must not produce a
// negative duration that trivially satisfies (or defeats) the TTL comparison.
func TestParseReapListingClampsNegativeIdle(t *testing.T) {
	out := "__E__|hostsh-future|9999|500|0\n__NOW__|9000\n__P__|1"
	c := findCand(t, parseReapListing(out, ephem), "hostsh-future")
	if c.idle < 0 {
		t.Errorf("idle %v must be clamped to >= 0", c.idle)
	}
	if c.shouldReap(time.Hour) {
		t.Error("a session with a future activity stamp must not be reaped")
	}
}

// The listing must stay one process for the ps dump, not one per session — the
// per-file fan-out in discovery is exactly the mistake this avoids repeating.
func TestReapListCmdShape(t *testing.T) {
	if strings.Contains(reapListCmd, "pgrep -P") {
		t.Error("reapListCmd forks per session; dump all ppids once instead")
	}
	if !strings.Contains(reapListCmd, "ps -eo ppid=") {
		t.Error("reapListCmd must dump parent pids in a single ps call")
	}
	// Must target the isolated ephemeral server; the default socket holds the
	// operator's real work.
	if !strings.Contains(reapListCmd, "-L "+ephemeralSocket) {
		t.Errorf("reapListCmd must target the ephemeral socket: %s", reapListCmd)
	}
}
