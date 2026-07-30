package session

import "testing"

// tmuxFor decides which tmux SERVER a session-scoped command talks to. Getting
// it wrong is silent: an ephemeral command sent to the default server targets a
// session that does not exist there, so it no-ops instead of erroring.
func TestTmuxFor_RoutesEphemeralsToIsolatedSocket(t *testing.T) {
	m := &Manager{ephemeral: newEphemeralMatcher([]string{"hostsh-*", "mctask-*"})}

	for _, name := range []string{"hostsh-abc123", "mctask-7d37a052"} {
		if got, want := m.tmuxFor(name), "tmux -L "+ephemeralSocket; got != want {
			t.Errorf("tmuxFor(%q) = %q, want %q", name, got, want)
		}
	}
	// Real work sessions must stay on the default server.
	for _, name := range []string{"mycellm", "bridge-eng", "nextstep", "my-hostsh-thing"} {
		if got := m.tmuxFor(name); got != "tmux" {
			t.Errorf("tmuxFor(%q) = %q, want %q", name, got, "tmux")
		}
	}
}

// With no matcher configured nothing is ephemeral, so every session must keep
// using the default server rather than being silently routed elsewhere.
func TestTmuxFor_NoMatcherKeepsDefault(t *testing.T) {
	m := &Manager{}
	if got := m.tmuxFor("hostsh-abc123"); got != "tmux" {
		t.Errorf("tmuxFor with nil matcher = %q, want %q", got, "tmux")
	}
}
