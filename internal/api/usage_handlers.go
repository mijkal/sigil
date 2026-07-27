package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	sshpool "sigil.dev/sigil/internal/ssh"
)

// Agent-usage widget backend.
//
// Reads a coding agent's LOCAL transcript logs on a host and returns a compact
// burndown: current 5-hour block, today, and last 7 days, split by model, plus a
// 24-hour hourly sparkline. The aggregation runs host-side (one python3 pass over
// recently-modified *.jsonl) and only the summary crosses the wire — the same
// runProbe-over-SSH pattern the metrics collector uses.
//
// Providers:
//   claude → ~/.claude/projects/**/*.jsonl   (Claude Code)
//   codex  → ~/.codex/**/*.jsonl             (OpenAI Codex CLI) — best-effort, same
//            token/usage shape; empty result if the host doesn't run codex.
//
// NOTE: there is no scriptable `claude usage` command and the official Max
// rate-limit percentages are fetched live by the CLI, not cached on disk — so this
// is a real token/message burndown, not the subscription %-remaining. The widget
// pairs it with an optional user-set soft target for a %-bar.

// providerRoots maps a provider to the directory scanned for *.jsonl transcripts.
var providerRoots = map[string]string{
	"claude": "$HOME/.claude/projects",
	"codex":  "$HOME/.codex",
}

type usageCacheEntry struct {
	expiry time.Time
	body   []byte
}

var (
	usageCacheMu sync.Mutex
	usageCache   = map[string]usageCacheEntry{}
)

// Usage scans can be heavy (thousands of transcript files) and run over SSH to a
// possibly-loaded host, so they get a generous timeout and a longer cache. Generic
// command monitors are cheap and may poll on a short interval, so their cache is
// brief — just enough to dedupe bursts without overriding the user's interval.
const (
	usageExecTimeout = 75 * time.Second
	usageCacheTTL    = 60 * time.Second
	execCacheTTL     = 8 * time.Second
)

func usageCacheGet(key string) ([]byte, bool) {
	usageCacheMu.Lock()
	defer usageCacheMu.Unlock()
	if e, ok := usageCache[key]; ok && time.Now().Before(e.expiry) {
		return e.body, true
	}
	return nil, false
}

func usageCachePut(key string, body []byte, ttl time.Duration) {
	usageCacheMu.Lock()
	usageCache[key] = usageCacheEntry{expiry: time.Now().Add(ttl), body: body}
	usageCacheMu.Unlock()
}

// AgentUsage: GET /api/v1/agent-usage?host={name}&provider=claude
func (s *Server) AgentUsage(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	provider := r.URL.Query().Get("provider")
	if provider == "" {
		provider = "claude"
	}
	root, ok := providerRoots[provider]
	if host == "" || !ok {
		http.Error(w, "host and a known provider (claude|codex) are required", http.StatusBadRequest)
		return
	}

	cacheKey := host + "|" + provider
	if body, ok := usageCacheGet(cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Sigil-Cache", "hit")
		_, _ = w.Write(body)
		return
	}

	sess, err := s.sshPool.NewSession(host)
	if err != nil {
		http.Error(w, "host not connected: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer sess.Close()

	// Ship the python via base64 so no quoting/heredoc ambiguity can corrupt it.
	// (Recommended host is the low-load hub, where ~/.claude is the same account —
	// so the scan runs locally and fast; no nice, which only starves it under load.)
	prog := base64.StdEncoding.EncodeToString([]byte(agentUsagePy))
	script := fmt.Sprintf("SIGIL_ROOT='%s' SIGIL_PROVIDER='%s'; export SIGIL_ROOT SIGIL_PROVIDER; echo %s | base64 -d | python3 -",
		root, provider, prog)
	sess.Stdin = strings.NewReader(script)
	out, err := sshpool.OutputWithTimeout(sess, "sh -s", usageExecTimeout)
	if err != nil {
		http.Error(w, "usage probe failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	// The script prints one JSON object; validate before caching so a partial read
	// never poisons the cache.
	var probe map[string]any
	if json.Unmarshal(out, &probe) != nil {
		http.Error(w, "usage probe returned invalid data", http.StatusBadGateway)
		return
	}

	usageCachePut(cacheKey, out, usageCacheTTL)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Sigil-Cache", "miss")
	_, _ = w.Write(out)
}

// Exec: GET /api/v1/exec?host={name}&cmd={base64}
//
// Runs an arbitrary shell command on a host and returns its output — the backend
// for generic "monitor" widgets (host + command + interval, parse/display). This
// is the same trust boundary sigil already has (it opens shells on these hosts);
// auth middleware still gates it, the command is time-bounded, and results are
// briefly cached so a fast poll interval doesn't hammer the host. Commands are
// base64 so shells/quotes/pipes survive transport intact.
func (s *Server) Exec(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	cmdB64 := r.URL.Query().Get("cmd")
	if host == "" || cmdB64 == "" {
		http.Error(w, "host and cmd (base64) are required", http.StatusBadRequest)
		return
	}
	cmdBytes, err := base64.StdEncoding.DecodeString(cmdB64)
	if err != nil {
		http.Error(w, "cmd must be valid base64", http.StatusBadRequest)
		return
	}
	command := strings.TrimSpace(string(cmdBytes))
	if command == "" {
		http.Error(w, "empty command", http.StatusBadRequest)
		return
	}

	cacheKey := "exec|" + host + "|" + cmdB64
	if body, ok := usageCacheGet(cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Sigil-Cache", "hit")
		_, _ = w.Write(body)
		return
	}

	sess, err := s.sshPool.NewSession(host)
	if err != nil {
		http.Error(w, "host not connected: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer sess.Close()

	start := time.Now()
	// CombinedOutput would merge stderr into stdout; we want stdout only, but a
	// failing command's stderr is useful context, so run via `sh -c` and capture
	// stdout, reporting the exit via the JSON envelope.
	sess.Stdin = strings.NewReader(command)
	out, runErr := sshpool.OutputWithTimeout(sess, "sh -s", sshpool.DefaultExecTimeout)
	ms := time.Since(start).Milliseconds()

	// Cap the returned output so a chatty command can't flood the widget.
	const maxOut = 64 * 1024
	stdout := string(out)
	truncated := false
	if len(stdout) > maxOut {
		stdout = stdout[len(stdout)-maxOut:]
		truncated = true
	}
	env := map[string]any{"host": host, "ms": ms, "stdout": stdout, "truncated": truncated}
	if runErr != nil {
		env["error"] = runErr.Error()
	}
	body, _ := json.Marshal(env)

	// Only cache successful runs — an error should be retried, not pinned.
	if runErr == nil {
		usageCachePut(cacheKey, body, execCacheTTL)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Sigil-Cache", "miss")
	_, _ = w.Write(body)
}

// agentUsagePy is the host-side aggregator. Reads $SIGIL_ROOT recursively for
// *.jsonl modified in the last 8 days, sums token/message usage into 5h / today /
// 7d buckets (per model), and builds a 24h hourly sparkline. It extracts the few
// fields it needs with regexes rather than json.loads()-ing every record — ~2x
// faster and far less CPU over a heavy transcript history. Tolerant of both the
// Claude Code and Codex usage shapes; never throws — prints zeros on any trouble.
const agentUsagePy = `
import os, glob, time, datetime, sys, re, json
root = os.path.expandvars(os.environ.get("SIGIL_ROOT",""))
now = time.time(); H = 3600
cutoff = now - 8*86400
def bucket(): return {"in":0,"out":0,"cache":0,"msgs":0,"models":{}}
b5, today, wk = bucket(), bucket(), bucket()
hourly = [0]*24
midnight = datetime.datetime.now().replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
re_ts  = re.compile(r'"timestamp":"([^"]+)"')
re_ts2 = re.compile(r'"(?:ts|created_at)":"?([^",}]+)"?')
re_model = re.compile(r'"model":"([^"]+)"')
re_in  = re.compile(r'"(?:input_tokens|prompt_tokens)":\s*(\d+)')
re_out = re.compile(r'"(?:output_tokens|completion_tokens)":\s*(\d+)')
re_cr  = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
re_cc  = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')
re_cd  = re.compile(r'"cached_tokens":\s*(\d+)')
scanned = 0; files = []
try:
    files = [f for f in glob.glob(root+"/**/*.jsonl", recursive=True) if os.path.getmtime(f) >= cutoff]
except Exception:
    files = []
def g(rx, line):
    x = rx.search(line); return int(x.group(1)) if x else 0
for fp in files:
    try: fh = open(fp, errors="ignore")
    except Exception: continue
    with fh:
        for line in fh:
            if '"usage"' not in line: continue
            m = re_ts.search(line) or re_ts2.search(line)
            if not m: continue
            raw = m.group(1)
            try:
                t = datetime.datetime.fromisoformat(raw.replace("Z","+00:00")).timestamp()
            except Exception:
                try:
                    t = float(raw); t = t/1000.0 if t > 1e12 else t
                except Exception:
                    continue
            if t < cutoff: continue
            mm = re_model.search(line)
            model = mm.group(1) if mm else "?"
            if model == "<synthetic>": continue
            it = g(re_in, line); ot = g(re_out, line)
            ca = g(re_cr, line) + g(re_cc, line) + g(re_cd, line)
            scanned += 1
            def add(bk):
                bk["in"] += it; bk["out"] += ot; bk["cache"] += ca; bk["msgs"] += 1
                bk["models"][model] = bk["models"].get(model,0) + it + ot
            if t >= now-5*H: add(b5)
            if t >= midnight: add(today)
            if t >= now-7*86400: add(wk)
            if t >= now-24*H:
                idx = int((t-(now-24*H))//H)
                if 0 <= idx < 24: hourly[idx] += it + ot
out = {"provider": os.environ.get("SIGIL_PROVIDER","claude"),
       "generated_at": int(now), "scanned": scanned, "files": len(files),
       "last5h": b5, "today": today, "week": wk, "hourly": hourly}
sys.stdout.write(json.dumps(out))
`
