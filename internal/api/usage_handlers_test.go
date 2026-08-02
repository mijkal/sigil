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

func TestAgentUsageClaudeObservedReset(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "project", "run.jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"2099-08-02T05:00:00Z","payload":{"result":"You've hit your weekly limit · resets Aug 3, 12am (America/Los_Angeles)"}}`
	if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := runUsageProbe(t, "claude", root)
	q := got["quota"].(map[string]any)
	if q["reset_text"] != "Aug 3, 12am (America/Los_Angeles)" {
		t.Fatalf("quota = %#v", q)
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
