package session

import (
	"errors"
	"testing"
)

func TestParseCaptureOutputHealthy(t *testing.T) {
	tests := []struct {
		name  string
		out   string
		text  string
		altOn bool
	}{
		{"shell (alternate off)", "0\n$ ls\nfile.txt\n", "$ ls\nfile.txt\n", false},
		{"TUI (alternate on)", "1\nvim buffer\n", "vim buffer\n", true},
		{"empty pane", "0\n", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			text, altOn, err := parseCaptureOutput(tt.out)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if text != tt.text {
				t.Errorf("text = %q, want %q", text, tt.text)
			}
			if altOn != tt.altOn {
				t.Errorf("altOn = %v, want %v", altOn, tt.altOn)
			}
		})
	}
}

func TestParseCaptureOutputSessionGone(t *testing.T) {
	// Whatever tmux prints when the session — or the whole server — is missing.
	for _, out := range []string{
		"can't find session: dev\n",
		"no server running on /tmp/tmux-1000/default\n",
		"session not found: dev\n",
		"no such session: dev\n",
		"lost server\n",
	} {
		_, _, err := parseCaptureOutput(out)
		if !errors.Is(err, ErrSessionGone) {
			t.Errorf("parseCaptureOutput(%q) err = %v, want ErrSessionGone", out, err)
		}
	}
}

func TestParseCaptureOutputUnavailable(t *testing.T) {
	// The session may well be alive; we just got nothing readable back.
	for _, out := range []string{
		"",                              // wedged: no output at all
		"tmux: command not found\n",     // remote shell blew up before tmux ran
		"failed to connect to client\n", // tmux control-path hiccup
	} {
		_, _, err := parseCaptureOutput(out)
		if !errors.Is(err, ErrCaptureUnavailable) {
			t.Errorf("parseCaptureOutput(%q) err = %v, want ErrCaptureUnavailable", out, err)
		}
		if errors.Is(err, ErrSessionGone) {
			t.Errorf("parseCaptureOutput(%q) must not report the session gone", out)
		}
	}
}

func TestParseCaptureOutputAltOnDefaultsTrueOnFailure(t *testing.T) {
	// Never reflow on ambiguity — a mangled TUI is worse than a wide line.
	if _, altOn, _ := parseCaptureOutput("can't find session: dev\n"); !altOn {
		t.Error("altOn = false on failure, want true (TUI-safe default)")
	}
}
