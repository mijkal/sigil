package session

import (
	"strings"
	"testing"
)

// 2026-08-23 regression. All 12 sessions on a target host went SIX DAYS with no
// scrollback capture, which surfaces to the operator as "sigil lost my
// sessions" — the session list is intact but every pane renders blank or
// stale.
//
// The cause was that pipedSessions is keyed host:session and is only ever
// cleared on an error path. Nothing invalidated it when the TARGET rebooted.
// sigild armed the pipes, the target's tmux server died and took every
// pipe-pane sink with it, sigild reconnected, rediscovered the same session
// NAMES, saw isPiped()==true and skipped re-arming — permanently. The comment
// on the discovery arm loop reasoned only about sigild restarting ("after a
// restart the pipedSessions set is empty"); the other direction was missed.
//
// The fix makes tmux's own #{pane_pipe} the authority and demotes the
// in-memory set to a cache. These tests pin that inversion.

func TestShouldArmPipe_RearmsAfterTargetReboot(t *testing.T) {
	// The exact 2026-08-23 state: we believe we armed it (cached), tmux says
	// the pane carries no pipe. Trusting the cache here is the bug.
	if !shouldArmPipe(true, pipeAbsent) {
		t.Fatal("cached=piped + tmux reports pane_pipe=0 must RE-ARM: this is the " +
			"target-reboot regression — a stale cache entry silently disabled " +
			"capture for the life of the process")
	}
}

func TestShouldArmPipe_SkipsWhenTmuxConfirmsPiped(t *testing.T) {
	// Steady state. Discovery runs on every tick, so re-arming a healthy
	// session would mean an SSH exec per session per tick, forever.
	if shouldArmPipe(true, pipePresent) {
		t.Fatal("cached=piped + tmux reports pane_pipe=1 must SKIP (no per-tick churn)")
	}
}

func TestShouldArmPipe_ArmsWhenCacheIsColdAndTmuxAgrees(t *testing.T) {
	// sigild itself restarted: the set is empty and nothing is piped yet.
	if !shouldArmPipe(false, pipeAbsent) {
		t.Fatal("cold cache + not piped must arm")
	}
}

func TestShouldArmPipe_ArmsOnRestartEvenIfAPipeSurvives(t *testing.T) {
	// A pipe left behind by a PREVIOUS sigild process writes to a sink we no
	// longer own. StartPipeCapture is stop+start, so re-arming reclaims it.
	// Preserves pre-fix behaviour for this case.
	if !shouldArmPipe(false, pipePresent) {
		t.Fatal("cold cache must arm even when a stale pipe is present, so the " +
			"sink is reclaimed by this process")
	}
}

// An old tmux that does not know #{pane_pipe} expands it to "". Treating that
// as "not piped" would re-arm every session on every discovery tick forever.
// Unknown must fall back to the pre-fix cache semantics.
func TestShouldArmPipe_UnknownFallsBackToCache(t *testing.T) {
	if shouldArmPipe(true, pipeUnknown) {
		t.Fatal("unsupported #{pane_pipe} + cached must SKIP, not churn every tick")
	}
	if !shouldArmPipe(false, pipeUnknown) {
		t.Fatal("unsupported #{pane_pipe} + cold cache must arm")
	}
}

func TestParsePipeField(t *testing.T) {
	for in, want := range map[string]pipeState{
		"1": pipePresent,
		"0": pipeAbsent,
		"":  pipeUnknown,
		"x": pipeUnknown,
	} {
		if got := parsePipeField(in); got != want {
			t.Errorf("parsePipeField(%q) = %v, want %v", in, got, want)
		}
	}
}

// The discovery format string is the other half of the fix: without
// #{pane_pipe} on the wire, shouldArmPipe only ever sees pipeUnknown and the
// regression returns silently.
func TestDiscoveryPaneFormatCarriesPipeState(t *testing.T) {
	if !strings.Contains(paneListFormat, "#{pane_pipe}") {
		t.Fatal("pane discovery format dropped #{pane_pipe} — capture can no " +
			"longer self-heal after a target reboot")
	}
	// pane_current_path must stay the trailing field: it can contain a literal
	// '|', and the parser relies on SplitN letting the last field absorb it.
	if !strings.HasSuffix(paneListFormat, "#{pane_current_path}") {
		t.Fatalf("#{pane_current_path} must remain the LAST field (it may contain '|'); got %q",
			paneListFormat)
	}
}

func TestParsePaneRecord(t *testing.T) {
	rec, ok := parsePaneRecord("work|1|1|2.1.233|1|/data/projects/thing")
	if !ok {
		t.Fatal("well-formed pane line failed to parse")
	}
	if rec.session != "work" || !rec.windowActive || !rec.paneActive ||
		rec.cmd != "2.1.233" || rec.pipe != pipePresent || rec.path != "/data/projects/thing" {
		t.Fatalf("bad parse: %+v", rec)
	}
}

// Guards the SplitN contract: a path containing '|' must not shift the pipe
// field. If it did, a healthy pane could read as unpiped and re-arm forever.
func TestParsePaneRecordAbsorbsPipeInPath(t *testing.T) {
	rec, ok := parsePaneRecord("work|1|1|zsh|0|/tmp/we|ird|path")
	if !ok {
		t.Fatal("failed to parse")
	}
	if rec.pipe != pipeAbsent {
		t.Fatalf("pipe field shifted by '|' in path: got %v", rec.pipe)
	}
	if rec.path != "/tmp/we|ird|path" {
		t.Fatalf("path truncated: %q", rec.path)
	}
}

func TestParsePaneRecordRejectsShortLine(t *testing.T) {
	if _, ok := parsePaneRecord("work|1|1|zsh"); ok {
		t.Fatal("a line missing fields must be rejected, not parsed into zero values")
	}
}
