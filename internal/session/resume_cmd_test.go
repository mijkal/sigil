package session

import "testing"

func TestResumeCmdForPaneCommand(t *testing.T) {
	want := "claude --continue --dangerously-skip-permissions"
	for _, c := range []string{"claude", "/usr/local/bin/claude", "2.1.220", "2.1.220-beta", "10.0.3"} {
		if got := resumeCmdForPaneCommand(c); got != want {
			t.Errorf("resumeCmdForPaneCommand(%q) = %q, want %q", c, got, want)
		}
	}
	for _, c := range []string{"zsh", "bash", "node", "vim", "", "2.1", "v2.1.220"} {
		if got := resumeCmdForPaneCommand(c); got != "" {
			t.Errorf("resumeCmdForPaneCommand(%q) = %q, want empty", c, got)
		}
	}
}
