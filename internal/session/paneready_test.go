package session

import "testing"

// The readiness gate keys on the pane's foreground command. Getting this list
// wrong reintroduces the race it exists to close: a shell not in the set means
// we wait the full timeout and then send anyway (slow but correct), while a
// NON-shell wrongly in the set means we send into a still-initialising pane and
// the keystrokes vanish — which is the failure that cost one host every dispatch
// it was given for three days.
func TestPaneReadyShellSet(t *testing.T) {
	ready := map[string]bool{
		"zsh": true, "bash": true, "sh": true, "fish": true, "dash": true, "ksh": true,
	}
	for _, sh := range []string{"zsh", "bash", "sh", "fish", "dash", "ksh"} {
		if !ready[sh] {
			t.Errorf("%q must count as a ready shell", sh)
		}
	}
	// Things a pane can legitimately be running that are NOT a ready prompt.
	for _, other := range []string{"", "login", "claude", "2.1.220", "node", "ssh", "tmux"} {
		if ready[other] {
			t.Errorf("%q must NOT count as a ready shell", other)
		}
	}
}

func TestPaneReadyTimeoutIsGenerous(t *testing.T) {
	// Measured shell-ready latency was 0.15s (bash/Linux) and 0.56s (zsh/macOS).
	// The bound must clear a host an order of magnitude slower than the worst
	// observed, or the gate degrades back into the race on a loaded box.
	if paneReadyTimeout.Seconds() < 5 {
		t.Fatalf("paneReadyTimeout %s is too tight for a slow/loaded host", paneReadyTimeout)
	}
}
