package session

import "testing"

func TestClassifyGranularAcrossAgents(t *testing.T) {
	cases := []struct{ name, tail, want string }{
		// Claude Code — must not regress.
		{"claude waiting", "Do you want to proceed?\n1. Yes\n2. No", "waiting"},
		// VERBATIM from a real pipe log. A captured pane is the rendered grid, so the
		// footer's spaces are absent -- these strings are deliberately "wrong"-looking.
		// The previous fixtures were hand-typed WITH spaces, so they passed while the
		// identical check failed in production and working sessions showed amber.
		{"claude working (real capture)",
			"⏵⏵bypasspermissionson (shift+tabtocycle)·esctointerrupt·←foragents\n RunnWhirring…8", "working"},
		{"claude idle (real capture)",
			"⏵⏵bypasspermissionson (shift+tabtocycle)·←foragents\n?forshortcuts", "done"},
		{"claude working (spaced, e.g. narrow pane)", "✻ Doodling… (8s · esc to interrupt)", "working"},
		{"claude idle (spaced)", "⏵⏵ bypass permissions on (shift+tab to cycle)\n? for shortcuts", "done"},
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
