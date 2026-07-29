package session

import (
	"testing"

	"sigil.dev/sigil/internal/config"
)

// Cover for the zombie factory described in ephemeral.go: auto-resurrect
// recreating single-shot orchestrator sessions forever, which is what let jupiter
// reach 50 rows and exhaust its SSH channels.

func TestIsEphemeralName_Defaults(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns(config.DefaultEphemeralPatterns())

	ephemeral := []string{
		"hostsh-0bb72231", "hostsh-a", "hostsh-",
		"mctask-31ead29f", "mctask-",
	}
	for _, n := range ephemeral {
		if !m.IsEphemeralName(n) {
			t.Errorf("%q should be ephemeral", n)
		}
	}

	// Real sessions — every one of these was destroyed in the incident and must
	// never be classified as disposable.
	keep := []string{
		"nextstep", "mycellm", "kwanchai", "ensembl", "bridge-eng",
		"Dodecki", "dodecki-logs", "general", "utopia", "wg-metro",
		// Anchoring: filepath.Match must not match a prefix or a substring.
		"my-hostsh-thing", "not-hostsh-1", "xhostsh-1", "HOSTSH-1", "mctaskish",
	}
	for _, n := range keep {
		if m.IsEphemeralName(n) {
			t.Errorf("%q must NOT be treated as ephemeral", n)
		}
	}
}

func TestSetEphemeralPatterns_EmptyListIsAnOptOut(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns([]string{})
	if m.IsEphemeralName("hostsh-1") {
		t.Fatal("an explicitly empty list must restore resurrect-everything behaviour")
	}
	if got := m.EphemeralPatterns(); len(got) != 0 {
		t.Fatalf("expected no patterns, got %v", got)
	}
}

func TestSetEphemeralPatterns_MalformedGlobIsDroppedNotWidened(t *testing.T) {
	m := &Manager{}
	// `[` is an unterminated character class — filepath.Match returns ErrBadPattern.
	dropped := m.SetEphemeralPatterns([]string{"hostsh-*", "[", ""})
	if len(dropped) != 2 {
		t.Fatalf("expected 2 dropped patterns, got %v", dropped)
	}
	// The good pattern still works...
	if !m.IsEphemeralName("hostsh-9") {
		t.Fatal("valid pattern stopped working after a bad one was dropped")
	}
	// ...and the bad one did NOT become a match-everything.
	if m.IsEphemeralName("nextstep") {
		t.Fatal("a malformed glob must not widen the policy — this would silently disable auto-resurrect")
	}
}

func TestSetEphemeralPatterns_CustomPatterns(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns([]string{"tmp-*", "ci-??-run"})
	for _, n := range []string{"tmp-abc", "ci-42-run"} {
		if !m.IsEphemeralName(n) {
			t.Errorf("%q should match a custom pattern", n)
		}
	}
	for _, n := range []string{"hostsh-1", "ci-4-run", "ci-123-run", "tmp"} {
		if m.IsEphemeralName(n) {
			t.Errorf("%q should not match", n)
		}
	}
}

func TestManagerWithoutMatcher_IsInert(t *testing.T) {
	// A zero-value Manager (some tests construct one) must not panic or classify.
	m := &Manager{}
	if m.IsEphemeralName("hostsh-1") {
		t.Fatal("nil matcher should classify nothing")
	}
	if got := m.EphemeralPatterns(); got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}

func TestConfigDefaults_AbsentVsExplicitlyEmpty(t *testing.T) {
	// Absent key → defaults applied. This is what makes the policy on-by-default
	// for existing installs whose config predates it.
	if got := config.DefaultEphemeralPatterns(); len(got) != 2 {
		t.Fatalf("expected 2 default patterns, got %v", got)
	}
	// Defaults must be a fresh slice each call — a shared backing array would let
	// one caller's mutation leak into every other.
	a := config.DefaultEphemeralPatterns()
	a[0] = "mutated"
	if config.DefaultEphemeralPatterns()[0] == "mutated" {
		t.Fatal("DefaultEphemeralPatterns leaks a shared slice")
	}
}
