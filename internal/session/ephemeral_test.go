package session

import "testing"

func TestIsEphemeralName(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns([]string{"hostsh-*", "mctask-*"})

	tests := []struct {
		name string
		want bool
	}{
		// Drydock's single-shot workers — the sessions that must never come back.
		{"hostsh-0bb72231", true},
		{"mctask-45cce877", true},
		// A user's real work must never be classified as disposable, even when
		// the name merely contains or prefixes an ephemeral token.
		{"utopia", false},
		{"Dodecki", false},
		{"mycellm", false},
		{"my-hostsh-notes", false},
		{"hostsh", false}, // prefix without the separator is not a worker
		{"mctask", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := m.IsEphemeralName(tt.name); got != tt.want {
			t.Errorf("IsEphemeralName(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// An explicitly empty list disables the policy entirely — every session is then
// eligible for auto-resurrect, which is the pre-2026-07-27 behaviour.
func TestIsEphemeralNameDisabled(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns([]string{})
	if m.IsEphemeralName("hostsh-0bb72231") {
		t.Error("empty pattern list should classify nothing as ephemeral")
	}
}

// A malformed glob must be ignored, not treated as a wildcard that would
// silently make every session ephemeral (and so un-resurrectable).
func TestIsEphemeralNameMalformedPattern(t *testing.T) {
	m := &Manager{}
	m.SetEphemeralPatterns([]string{"[", "hostsh-*"})
	if m.IsEphemeralName("utopia") {
		t.Error("malformed pattern must not match a real session")
	}
	if !m.IsEphemeralName("hostsh-abc") {
		t.Error("a valid pattern alongside a malformed one must still match")
	}
}
