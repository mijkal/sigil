package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runUsageProbe(t *testing.T, provider, root string) map[string]any {
	t.Helper()
	cmd := exec.Command("python3", "-")
	cmd.Env = append(os.Environ(), "SIGIL_PROVIDER="+provider, "SIGIL_ROOT="+root)
	cmd.Stdin = strings.NewReader(agentUsagePy)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("probe failed: %v\n%s", err, out)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out)
	}
	return got
}

func TestAgentUsageCodexQuotaAndTokens(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "sessions", "run.jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"2099-08-02T05:00:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30}},"rate_limits":{"primary":{"used_percent":81.0,"window_minutes":10080,"resets_at":4078886400}}}}`
	if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := runUsageProbe(t, "codex", root)
	q := got["quota"].(map[string]any)
	if q["used_percent"] != float64(81) {
		t.Fatalf("quota = %#v", q)
	}
	b := got["last5h"].(map[string]any)
	if b["in"] != float64(120) || b["out"] != float64(30) {
		t.Fatalf("bucket = %#v", b)
	}
}

// Claude has no scriptable quota API, so the widget infers exhaustion by finding
// the CLI's own limit message in a transcript. That inference has two ways to
// lie, and both did on 2026-08-03: it read an agent's PROSE about a limit as a
// limit, and it never expired a window that had already reset — the widget sat
// at 100% for the twelve hours after the limit cleared.

func writeClaudeLine(t *testing.T, line string) string {
	t.Helper()
	root := t.TempDir()
	p := filepath.Join(root, "project", "run.jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestAgentUsageClaudeObservedReset(t *testing.T) {
	// A genuine limit notice: flagged by Claude Code itself, resetting in the
	// future. This is the only shape that may set the quota.
	line := `{"type":"assistant","isApiErrorMessage":true,"timestamp":"2099-08-02T05:00:00Z",` +
		`"message":{"content":[{"type":"text","text":"You've hit your weekly limit · resets Aug 3, 12am (America/Los_Angeles)"}]}}`
	got := runUsageProbe(t, "claude", writeClaudeLine(t, line))
	q, ok := got["quota"].(map[string]any)
	if !ok {
		t.Fatalf("expected a quota from a flagged error record, got %#v", got["quota"])
	}
	if q["reset_text"] != "Aug 3, 12am (America/Los_Angeles)" {
		t.Fatalf("reset_text = %#v", q["reset_text"])
	}
	if q["used_percent"] != float64(100) || q["status"] != "exhausted" {
		t.Fatalf("quota = %#v", q)
	}
	// The stated zone must be resolved to a real instant, not left nil — nil is
	// what made the exhausted state unexpirable.
	if s, _ := q["resets_at"].(string); !strings.HasPrefix(s, "2099-08-03T07:00") {
		t.Fatalf("resets_at = %#v, want 2099-08-03T07:00Z (12am America/Los_Angeles)", q["resets_at"])
	}
}

func TestAgentUsageClaudeIgnoresProseAboutALimit(t *testing.T) {
	// THE BUG. An assistant message quoting the limit text — here inside a
	// markdown table, exactly as it appeared in the report that triggered it.
	// Prose about a limit is byte-for-byte identical to a limit; only Claude
	// Code's own isApiErrorMessage flag distinguishes them.
	line := `{"type":"assistant","timestamp":"2099-08-02T05:00:00Z",` +
		`"message":{"content":[{"type":"text","text":"| **8** | ` + "`" +
		`You've hit your weekly limit · resets Aug 3 at 12am (America/Los_Angeles)` + "`" + ` |"}]}}`
	got := runUsageProbe(t, "claude", writeClaudeLine(t, line))
	if got["quota"] != nil {
		t.Fatalf("an agent describing a limit must not set the quota; got %#v", got["quota"])
	}
}

func TestAgentUsageClaudeUserProseIsAlsoIgnored(t *testing.T) {
	line := `{"type":"user","timestamp":"2099-08-02T05:00:00Z",` +
		`"message":{"content":[{"type":"text","text":"why did it say You've hit your weekly limit?"}]}}`
	got := runUsageProbe(t, "claude", writeClaudeLine(t, line))
	if got["quota"] != nil {
		t.Fatalf("user prose must not set the quota; got %#v", got["quota"])
	}
}

func TestAgentUsageClaudeExpiresAWindowThatAlreadyReset(t *testing.T) {
	// A real limit hit at 01:51 whose window reset at midnight PT the same day.
	// Twelve hours later it is history, not status.
	line := `{"type":"assistant","isApiErrorMessage":true,"timestamp":"2020-08-03T08:51:41Z",` +
		`"message":{"content":[{"type":"text","text":"You've hit your weekly limit · resets Aug 3 at 12am (America/Los_Angeles)"}]}}`
	got := runUsageProbe(t, "claude", writeClaudeLine(t, line))
	if got["quota"] != nil {
		t.Fatalf("a window that already reset must not report as exhausted; got %#v", got["quota"])
	}
}

func TestAgentUsageAgyChatTokens(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "project", "chats", "session.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := `{"messages":[{"type":"gemini","timestamp":"2099-08-02T05:00:00Z","model":"gemini-test","tokens":{"input":100,"output":20,"thoughts":5,"cached":40}}]}`
	if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	got := runUsageProbe(t, "agy", root)
	b := got["last5h"].(map[string]any)
	if b["in"] != float64(100) || b["out"] != float64(25) {
		t.Fatalf("bucket = %#v", b)
	}
}
