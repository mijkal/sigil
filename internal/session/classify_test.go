package session

import "testing"

func TestClassifyGranularAcrossAgents(t *testing.T) {
	cases := []struct{ name, tail, want string }{
		// Claude Code — must not regress.
		{"claude waiting", "Do you want to proceed?\n1. Yes\n2. No", "waiting"},
		{"claude working", "✻ Doodling… (8s · esc to interrupt)", "working"},
		{"claude idle", "⏵⏵ bypass permissions on (shift+tab to cycle)\n? for shortcuts", "done"},
		// Codex — previously ALL of these returned "done".
		{"codex approval", "Allow Codex to run `npm test`?\n  Yes, proceed\n  No, provide feedback", "waiting"},
		{"codex approval yn", "Allow Codex to run `git push`? [y/N]", "waiting"},
		{"codex exited", "OK\n$ ", "done"},
		// Antigravity.
		{"agy accept", "Accept this change?", "waiting"},
		{"agy awaiting", "Awaiting approval", "waiting"},
		// Unknown agent, stopped mid-screen: must NOT claim done.
		{"unknown stopped", "some half-rendered TUI frame\nwith no recognisable prompt", "attention"},
		// Errors still win.
		{"error", "API error: 529 overloaded", "error"},
	}
	for _, c := range cases {
		if got := classifyGranular(c.tail); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
