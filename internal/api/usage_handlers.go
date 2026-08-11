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
//   codex  → ~/.codex/**/*.jsonl             (OpenAI Codex CLI)
//   agy    → ~/.gemini/antigravity-cli/conversations/*.db  (Antigravity CLI)
//
// agy moved store: the old Gemini CLI wrote JSON chats to ~/.gemini/tmp/**/chats,
// and this widget still scanned there long after agy switched to one SQLite DB per
// conversation under ~/.gemini/antigravity-cli. On a live host the old path held a
// single chat from 2025-11-19, so the preset rendered permanently empty.
//
// agy reports MESSAGES, NOT TOKENS, and that is deliberate. Its per-generation
// token counts live only inside protobuf blobs in `gen_metadata` with no published
// schema; a field-scan turns up plausible candidates that fail an internal
// consistency check (the apparent per-step values do not cumsum to the apparent
// running total), so any number derived from them would be a guess wearing the
// authority of a metric. Generation timestamps ARE unambiguous, so the message
// burndown is real and the token figures are reported as unavailable.
//
// NOTE: there is no scriptable `claude usage` command and the official Max
// rate-limit percentages are fetched live by the CLI, not cached on disk — so this
// is a real token/message burndown, not the subscription %-remaining. The widget
// pairs it with an optional user-set soft target for a %-bar.

// providerRoots maps a provider to the directory scanned for *.jsonl transcripts.
var providerRoots = map[string]string{
	"claude": "$HOME/.claude/projects",
	"codex":  "$HOME/.codex",
	"agy":    "$HOME/.gemini/antigravity-cli/conversations",
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
		http.Error(w, "host and a known provider (claude|codex|agy) are required", http.StatusBadRequest)
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
// Claude Code, Codex, and Antigravity usage shapes; never throws — prints zeros
// on any trouble. Codex's official rate-limit telemetry and Claude's observed
// quota errors are returned separately from locally counted token usage.
const agentUsagePy = `
import os, glob, time, datetime, sys, re, json, sqlite3
root = os.path.expandvars(os.environ.get("SIGIL_ROOT",""))
provider = os.environ.get("SIGIL_PROVIDER","claude")
now = time.time(); H = 3600
cutoff = now - 8*86400
def bucket(): return {"in":0,"out":0,"cache":0,"msgs":0,"models":{}}
b5, today, wk = bucket(), bucket(), bucket()
hourly = [0]*24
quota = None
midnight = datetime.datetime.now().replace(hour=0,minute=0,second=0,microsecond=0).timestamp()

_RE_TZ = re.compile(r'\(\s*([A-Za-z]+/[A-Za-z_+\-0-9]+)\s*\)')
_RE_CLOCK = re.compile(r'(\d{1,2})(?::(\d{2}))?\s*(am|pm)', re.I)
_RE_DATE = re.compile(r'([A-Z][a-z]{2})\s+(\d{1,2})')
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"])}

def parse_reset(text, observed):
    """"resets Aug 3 at 12am (America/Los_Angeles)" -> epoch seconds, or None.

    The zone is stated IN the message and must be honoured. Reading that clock as
    UTC is not a rounding error: the same mistake in Drydock's own governor turned
    a limit that had already reset into one seven hours in the future and held
    every dispatch until then. Returns None when the text names no usable time,
    because a guessed reset is worse than no reset — None leaves the caller
    showing the raw text instead of a confident wrong instant.
    """
    if not text: return None
    try:
        tz = None
        mtz = _RE_TZ.search(text)
        if mtz:
            try:
                import zoneinfo
                tz = zoneinfo.ZoneInfo(mtz.group(1))
            except Exception:
                tz = None
        if tz is None:
            tz = datetime.datetime.now().astimezone().tzinfo
        mc = _RE_CLOCK.search(text)
        if not mc: return None
        hour = int(mc.group(1)) % 12
        if (mc.group(3) or "").lower() == "pm": hour += 12
        minute = int(mc.group(2) or 0)
        base = datetime.datetime.fromtimestamp(observed, tz)
        md = _RE_DATE.search(text)
        if md and md.group(1) in _MONTHS:
            cand = base.replace(month=_MONTHS[md.group(1)], day=int(md.group(2)),
                                hour=hour, minute=minute, second=0, microsecond=0)
        else:
            cand = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if cand <= base: cand += datetime.timedelta(days=1)
        return cand.timestamp()
    except Exception:
        return None
def _pb_first(buf, path):
    """First varint at the given field path in a protobuf message, or None.

    A deliberately tiny reader: agy publishes no schema, so this walks the wire
    format by field number only and never guesses at semantics. Used for exactly
    one field — the generation timestamp.
    """
    def walk(b, want):
        i = 0
        while i < len(b):
            key = 0; shift = 0
            while True:
                if i >= len(b): return None
                c = b[i]; key |= (c & 0x7f) << shift; i += 1; shift += 7
                if not c & 0x80: break
            fn, wt = key >> 3, key & 7
            if wt == 0:
                v = 0; shift = 0
                while True:
                    if i >= len(b): return None
                    c = b[i]; v |= (c & 0x7f) << shift; i += 1; shift += 7
                    if not c & 0x80: break
                if fn == want[0] and len(want) == 1: return v
            elif wt == 2:
                ln = 0; shift = 0
                while True:
                    if i >= len(b): return None
                    c = b[i]; ln |= (c & 0x7f) << shift; i += 1; shift += 7
                    if not c & 0x80: break
                sub = b[i:i+ln]; i += ln
                if fn == want[0] and len(want) > 1:
                    got = walk(sub, want[1:])
                    if got is not None: return got
            elif wt == 5: i += 4
            elif wt == 1: i += 8
            else: return None
        return None
    try: return walk(buf, path)
    except Exception: return None

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
    pattern = "/*.db" if provider == "agy" else "/**/*.jsonl"
    files = [f for f in glob.glob(root+pattern, recursive=True) if os.path.getmtime(f) >= cutoff]
except Exception:
    files = []
def g(rx, line):
    x = rx.search(line); return int(x.group(1)) if x else 0
def add(t, model, it, ot, ca=0):
    global scanned
    scanned += 1
    def put(bk):
        bk["in"] += it; bk["out"] += ot; bk["cache"] += ca; bk["msgs"] += 1
        bk["models"][model] = bk["models"].get(model,0) + it + ot
    if t >= now-5*H: put(b5)
    if t >= midnight: put(today)
    if t >= now-7*86400: put(wk)
    if t >= now-24*H:
        idx = int((t-(now-24*H))//H)
        # agy reports no tokens, so its sparkline counts MESSAGES — a token
        # histogram would render as a flat line and read as "nothing happened".
        if 0 <= idx < 24: hourly[idx] += 1 if provider == "agy" else it + ot
for fp in files:
    if provider == "agy":
        # One SQLite DB per conversation. Each gen_metadata row is one model
        # generation, and its protobuf blob carries a unix-seconds timestamp at
        # field path 1.9.4.1 — the one field in there that is unambiguous (it
        # tracks the file mtime and the row count matches the generation count).
        # Tokens are NOT read: see the note at the top of this file.
        try:
            conn = sqlite3.connect("file:%s?mode=ro" % fp, uri=True, timeout=2.0)
        except Exception:
            continue
        try:
            for (blob,) in conn.execute("select data from gen_metadata"):
                ts = _pb_first(bytes(blob or b""), (1, 9, 4, 1))
                if ts is None or not (1600000000 <= ts <= 1900000000): continue
                if ts < cutoff: continue
                add(ts, "agy", 0, 0, 0)
        except Exception:
            pass
        finally:
            try: conn.close()
            except Exception: pass
        continue
    try: fh = open(fp, errors="ignore")
    except Exception: continue
    with fh:
        for line in fh:
            if provider == "codex" and '"rate_limits"' in line and '"token_count"' in line:
                try:
                    obj = json.loads(line); payload = obj.get("payload") or {}
                    info = payload.get("info") or {}; last = info.get("last_token_usage") or {}
                    raw = obj.get("timestamp")
                    t = datetime.datetime.fromisoformat(str(raw).replace("Z","+00:00")).timestamp()
                    add(t, str(info.get("model") or "codex"), int(last.get("input_tokens") or 0),
                        int(last.get("output_tokens") or 0), int(last.get("cached_input_tokens") or 0))
                    rl = payload.get("rate_limits") or {}; primary = rl.get("primary") or {}
                    if primary and (quota is None or t >= quota.get("observed_at",0)):
                        quota = {"used_percent": primary.get("used_percent"),
                                 "window_minutes": primary.get("window_minutes"),
                                 "resets_at": primary.get("resets_at"),
                                 "limit_name": rl.get("limit_name") or "Codex plan",
                                 "status": "limited" if rl.get("rate_limit_reached_type") else "ok",
                                 "source": "provider", "observed_at": t}
                except Exception: pass
                continue
            if provider == "claude" and ('hit your weekly limit' in line.lower() or 'hit your limit' in line.lower()):
                try:
                    obj = json.loads(line)
                    # ONLY a record Claude Code itself flagged as an API error.
                    # Without this gate the scan matched an ASSISTANT MESSAGE in
                    # which an agent quoted the limit text while describing it —
                    # on 2026-08-03 the widget read 100% exhausted off a markdown
                    # table in a status report (the captured reset even carried
                    # the trailing "| " of the table cell). Prose about a limit is
                    # byte-for-byte identical to a limit; the flag is the only
                    # thing that tells them apart. 422 real error records carry
                    # it, and all 37 prose mentions do not.
                    if not obj.get("isApiErrorMessage"): continue
                    stack = [obj]; texts = []
                    while stack:
                        value = stack.pop()
                        if isinstance(value, dict): stack.extend(value.values())
                        elif isinstance(value, list): stack.extend(value)
                        elif isinstance(value, str): texts.append(value)
                    message = next((x for x in texts if 'hit your' in x.lower() and 'limit' in x.lower()), '')
                    # Stop at the sentence, not the end of the line: the old
                    # greedy (.+) swallowed whatever followed in the same string.
                    reset = re.search(r'resets? ([^\n\r|]+)', message, re.I)
                    # strip() also drops a trailing markdown backtick (chr(96)) —
                    # written this way because this whole script lives inside a
                    # Go RAW STRING, which a literal backtick would terminate.
                    reset_text = reset.group(1).strip(' ' + chr(96) + '.').strip() if reset else None
                    rawts = obj.get("timestamp")
                    try: observed = datetime.datetime.fromisoformat(str(rawts).replace("Z","+00:00")).timestamp()
                    except Exception: observed = os.path.getmtime(fp)
                    resets_at = parse_reset(reset_text, observed)
                    # An exhausted window that has already reset is history, not
                    # status. Reporting it as current is how the widget sat at
                    # 100% for the twelve hours AFTER the limit cleared.
                    if resets_at is not None and resets_at <= now: continue
                    if quota is None or observed >= quota.get("observed_at",0):
                        quota = {"used_percent":100,
                                 "resets_at": (datetime.datetime.fromtimestamp(
                                     resets_at, datetime.timezone.utc).isoformat().replace("+00:00","Z")
                                     if resets_at else None),
                                 "reset_text": reset_text,
                                 "limit_name":"Claude plan", "status":"exhausted",
                                 "source":"observed_error", "observed_at":observed}
                except Exception: pass
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
            add(t, model, it, ot, ca)
out = {"provider": provider,
       "generated_at": int(now), "scanned": scanned, "files": len(files),
       "last5h": b5, "today": today, "week": wk, "hourly": hourly, "quota":quota}
sys.stdout.write(json.dumps(out))
`
