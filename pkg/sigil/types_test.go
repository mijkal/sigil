package sigil

import "testing"

func TestSafeFileName(t *testing.T) {
	cases := map[string]string{
		"dodecki":          "dodecki",
		"my session":       "my_session",
		"a/b../c":          "a_b___c",
		"weird'; rm -rf $": "weird___rm_-rf__",
		"UPPER_lower-09":   "UPPER_lower-09",
		"":                 "",
	}
	for in, want := range cases {
		if got := SafeFileName(in); got != want {
			t.Errorf("SafeFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSessionLogPath(t *testing.T) {
	got := SessionLogPath("mc/agent 1")
	want := "~/.local/share/sigil/logs/mc_agent_1.log"
	if got != want {
		t.Errorf("SessionLogPath = %q, want %q", got, want)
	}
}
