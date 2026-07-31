package session

import (
	"strings"
	"testing"
)

// A session name reaches this from the API, so the generated path must be inert
// when embedded in a single-quoted shell word — panePreamble does exactly that.
// A name that escapes the quoting would execute attacker-chosen shell as the
// pane's process, which is strictly worse than the bug this file replaced.
func TestStartScriptPathIsShellInert(t *testing.T) {
	for _, name := range []string{
		"mctask-abc123", "normal", "with space", "quote'inject", `dq"inject`,
		"semi;rm -rf /", "$(whoami)", "`id`", "back\\slash", "nl\ninject", "../../etc/passwd",
	} {
		got := startScriptPath(name)
		for _, bad := range []string{"'", `"`, "`", "$", ";", " ", "\n", "\\", "/../"} {
			if strings.Contains(strings.TrimPrefix(got, "/tmp/sigil-start-"), bad) {
				t.Errorf("startScriptPath(%q) = %q — contains %q, not safe to embed", name, got, bad)
			}
		}
		if !strings.HasPrefix(got, "/tmp/sigil-start-") || !strings.HasSuffix(got, ".sh") {
			t.Errorf("startScriptPath(%q) = %q — unexpected shape", name, got)
		}
	}
}

// Distinct sessions must not share a staging file: concurrent dispatches would
// otherwise overwrite each other's command between the write and the exec, and
// two workers would run the same body.
func TestStartScriptPathDistinguishesSessions(t *testing.T) {
	if a, b := startScriptPath("mctask-aaa"), startScriptPath("mctask-bbb"); a == b {
		t.Fatalf("distinct sessions collided on %q", a)
	}
}

// The pane command carries the whole contract: run the staged body, then leave a
// usable interactive shell behind.
func TestPanePreamble(t *testing.T) {
	got := panePreamble("/tmp/sigil-start-x.sh")

	// Sourced by name — never inlined. Inlining the body back into the pane
	// command would reintroduce a length limit on the exec path.
	if !strings.Contains(got, ". /tmp/sigil-start-x.sh") {
		t.Errorf("start script is not sourced by path: %q", got)
	}
	// -i -l, because the payload used to be typed at an interactive prompt and
	// depends on PATH exported from rc files. Plain `sh` finds no toolchain.
	if !strings.Contains(got, "-i -l -c") {
		t.Errorf("payload must run under an interactive login shell: %q", got)
	}
	// The session must outlive the command, or every finished worker's pane
	// dies and the session disappears before anyone can inspect it.
	if !strings.Contains(got, "exec ${SHELL:-/bin/sh} -l") {
		t.Errorf("pane must fall back to an interactive shell: %q", got)
	}
	// No send-keys, at any size. That is the entire point.
	if strings.Contains(got, "send-keys") {
		t.Errorf("pane command must not route through send-keys: %q", got)
	}
}
