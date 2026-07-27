package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/mux"

	"sigil.dev/sigil/internal/config"
	"sigil.dev/sigil/internal/session"
	sigil "sigil.dev/sigil/pkg/sigil"
)

var startTime = time.Now()

// GetStatus returns daemon status and stats
func (s *Server) GetStatus(w http.ResponseWriter, r *http.Request) {
	stats, err := s.db.GetStats()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	data := map[string]interface{}{
		"version":        sigil.Version,
		"git_commit":     sigil.GitCommit,
		"build_date":     sigil.BuildDate,
		"uptime_seconds": time.Since(startTime).Seconds(),
		"stats":          stats,
		"listen_addr":    s.cfg.Hub.ListenAddr,
	}
	writeJSON(w, 200, sigil.APIResponse{Data: data})
}

// GetHosts returns all configured hosts
func (s *Server) GetHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.db.GetHosts()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: hosts, Meta: &sigil.APIMeta{Total: len(hosts)}})
}

// GetHostMetrics returns the current resource-metrics snapshot for one host,
// used by the web UI to backfill graphs when a stats popover opens.
func (s *Server) GetHostMetrics(w http.ResponseWriter, r *http.Request) {
	name := mux.Vars(r)["name"]
	if s.metrics == nil {
		writeError(w, 503, "metrics_disabled", "metrics collection is disabled")
		return
	}
	m, ok := s.metrics.GetMetrics(name)
	if !ok {
		writeError(w, 404, "not_found", "no metrics for host "+name)
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: m})
}

// GetAllMetrics returns the latest metrics snapshot for every probed host, used
// for the initial sidebar badge fill on page load.
func (s *Server) GetAllMetrics(w http.ResponseWriter, r *http.Request) {
	if s.metrics == nil {
		writeJSON(w, 200, sigil.APIResponse{Data: []sigil.HostMetrics{}})
		return
	}
	all := s.metrics.GetAll()
	writeJSON(w, 200, sigil.APIResponse{Data: all, Meta: &sigil.APIMeta{Total: len(all)}})
}

// AddHost adds a new host dynamically, persists it to the DB, and connects it
func (s *Server) AddHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name           string   `json:"name"`
		Hostname       string   `json:"hostname"`
		Port           int      `json:"port"`
		User           string   `json:"user"`
		AuthMethod     string   `json:"auth_method"`
		PrivateKeyPath string   `json:"private_key_path"`
		Password       string   `json:"password"`
		Tags           []string `json:"tags"`
		AutoConnect    bool     `json:"auto_connect"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	if req.Name == "" || req.Hostname == "" || req.User == "" {
		writeError(w, 400, "bad_request", "name, hostname, and user are required")
		return
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.AuthMethod == "" {
		req.AuthMethod = "key"
	}
	if req.PrivateKeyPath == "" && req.AuthMethod == "key" {
		req.PrivateKeyPath = "~/.ssh/id_ed25519"
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}

	h := sigil.Host{
		Name:           req.Name,
		Hostname:       req.Hostname,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		PrivateKeyPath: req.PrivateKeyPath,
		Password:       req.Password,
		Tags:           req.Tags,
		AutoConnect:    req.AutoConnect,
		Status:         "disconnected",
	}
	if err := s.db.UpsertHost(h); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	hc := config.HostConfig{
		Name:           req.Name,
		Hostname:       req.Hostname,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		PrivateKeyPath: req.PrivateKeyPath,
		Password:       req.Password,
		Tags:           req.Tags,
		AutoConnect:    req.AutoConnect,
	}
	go func() {
		if err := s.sshPool.AddHostConfig(r.Context(), hc); err != nil {
			s.log.Error().Err(err).Str("host", req.Name).Msg("connect new host failed")
		}
		s.ws.BroadcastHostsUpdate()
	}()

	writeJSON(w, 201, sigil.APIResponse{Data: h})
}

// UpdateHost updates an existing host's configuration
func (s *Server) UpdateHost(w http.ResponseWriter, r *http.Request) {
	name := mux.Vars(r)["name"]

	var req struct {
		Hostname       string   `json:"hostname"`
		Port           int      `json:"port"`
		User           string   `json:"user"`
		AuthMethod     string   `json:"auth_method"`
		PrivateKeyPath string   `json:"private_key_path"`
		Password       string   `json:"password"`
		Tags           []string `json:"tags"`
		AutoConnect    bool     `json:"auto_connect"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	if req.Hostname == "" || req.User == "" {
		writeError(w, 400, "bad_request", "hostname and user are required")
		return
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.AuthMethod == "" {
		req.AuthMethod = "key"
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}

	// Preserve existing private_key_path / password if caller didn't supply them
	// (the API never returns sensitive fields, so the edit form sends them blank)
	if req.PrivateKeyPath == "" || req.Password == "" {
		existing, err := s.db.GetHost(name)
		if err == nil {
			if req.PrivateKeyPath == "" {
				req.PrivateKeyPath = existing.PrivateKeyPath
			}
			if req.Password == "" {
				req.Password = existing.Password
			}
		}
	}

	h := sigil.Host{
		Name:           name,
		Hostname:       req.Hostname,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		PrivateKeyPath: req.PrivateKeyPath,
		Password:       req.Password,
		Tags:           req.Tags,
		AutoConnect:    req.AutoConnect,
		Status:         "disconnected",
	}
	if err := s.db.UpsertHost(h); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	// Reconnect with new config
	_ = s.sshPool.Disconnect(name)
	hc := config.HostConfig{
		Name:           name,
		Hostname:       req.Hostname,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		PrivateKeyPath: req.PrivateKeyPath,
		Password:       req.Password,
		Tags:           req.Tags,
		AutoConnect:    req.AutoConnect,
	}
	go func() {
		if err := s.sshPool.AddHostConfig(r.Context(), hc); err != nil {
			s.log.Error().Err(err).Str("host", name).Msg("reconnect after update failed")
		}
		s.ws.BroadcastHostsUpdate()
	}()

	writeJSON(w, 200, sigil.APIResponse{Data: h})
}

// RemoveHost removes a host, disconnects it, and deletes it from the DB
func (s *Server) RemoveHost(w http.ResponseWriter, r *http.Request) {
	name := mux.Vars(r)["name"]
	_ = s.sshPool.Disconnect(name) // best effort
	if err := s.db.DeleteHost(name); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	s.ws.BroadcastHostsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"deleted": name}})
}

// ConnectHost connects to a host
func (s *Server) ConnectHost(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	if err := s.sshPool.Connect(r.Context(), name); err != nil {
		writeError(w, 500, "connect_error", err.Error())
		return
	}

	s.ws.BroadcastHostsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "connected"}})
}

// DisconnectHost disconnects from a host
func (s *Server) DisconnectHost(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	if err := s.sshPool.Disconnect(name); err != nil {
		writeError(w, 500, "disconnect_error", err.Error())
		return
	}

	s.ws.BroadcastHostsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "disconnected"}})
}

// GetSessions returns all sessions, optionally filtered by host
func (s *Server) GetSessions(w http.ResponseWriter, r *http.Request) {
	hostFilter := r.URL.Query().Get("host")
	sessions, err := s.db.GetSessions(hostFilter)
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	for i := range sessions {
		sessions[i].Activity = s.sessions.ActivityFor(sessions[i].ID)
		if q, kind, since := s.sessions.SignalFor(sessions[i].ID); q != "" {
			sessions[i].Question, sessions[i].SignalKind, sessions[i].WaitingSince = q, kind, since
		}
	}
	writeJSON(w, 200, sigil.APIResponse{Data: sessions, Meta: &sigil.APIMeta{Total: len(sessions)}})
}

// SignalSession records the authoritative await signal from an agent's Notification
// hook (or clears it via Stop). Body: {"kind":"permission|question|done","question":"..."}.
// This is what makes sigil's "waiting" state truth instead of a pane-scrape guess.
func (s *Server) SignalSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var body struct {
		Kind     string `json:"kind"`
		Question string `json:"question"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Kind == "" {
		body.Kind = "question"
	}
	if len(body.Question) > 2000 {
		body.Question = body.Question[:2000]
	}
	s.sessions.SetSignal(id, body.Kind, body.Question)
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]any{"id": id, "kind": body.Kind, "ok": true}})
}

// SendKeysToSession injects text (an answer/approval) into a waiting session's pane
// — the close-the-loop side of the needs-you pipeline. Body: {"text":"...","enter":true}.
func (s *Server) SendKeysToSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var body struct {
		Text  string `json:"text"`
		Enter *bool  `json:"enter"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	enter := true
	if body.Enter != nil {
		enter = *body.Enter
	}
	if err := s.sessions.SendKeys(id, body.Text, enter); err != nil {
		writeError(w, 500, "send_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]any{"id": id, "ok": true}})
}

// CreateSession creates a new tmux session
func (s *Server) CreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HostName string `json:"host_name"`
		Name     string `json:"name"`
		StartDir string `json:"start_dir"`
		StartCmd string `json:"start_cmd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if body.HostName == "" || body.Name == "" {
		writeError(w, 400, "bad_request", "host_name and name are required")
		return
	}

	if err := s.sessions.CreateSession(body.HostName, body.Name, body.StartDir, body.StartCmd); err != nil {
		writeError(w, 500, "create_error", err.Error())
		return
	}

	// Persist start_dir / start_cmd so they survive restarts and round-trip
	// back to the UI. Discovery upserts won't overwrite these fields.
	_ = s.db.UpsertSession(sigil.Session{
		ID:       body.HostName + ":" + body.Name,
		HostName: body.HostName,
		Name:     body.Name,
		StartDir: body.StartDir,
		StartCmd: body.StartCmd,
		Status:   "active",
	})

	// Trigger discovery to pick up new session.
	// Use context.Background() — r.Context() is already cancelled once
	// writeJSON below returns, which would cause the goroutine to bail
	// before the WS broadcast fires.
	go func() {
		_ = s.sessions.DiscoverHost(context.Background(), body.HostName)
		s.ws.BroadcastSessionsUpdate()
	}()

	writeJSON(w, 201, sigil.APIResponse{Data: map[string]string{
		"id":        body.HostName + ":" + body.Name,
		"host_name": body.HostName,
		"name":      body.Name,
	}})
}

// DeleteSession destroys a tmux session
func (s *Server) DeleteSession(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	sessions, err := s.db.GetSessions("")
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	var target *sigil.Session
	for i := range sessions {
		if sessions[i].ID == id {
			target = &sessions[i]
			break
		}
	}
	if target == nil {
		writeError(w, 404, "not_found", "session not found")
		return
	}

	if err := s.sessions.DestroySession(target.HostName, target.Name); err != nil {
		// Session may already be gone on the remote — log and continue so the
		// DB record is still cleaned up.
		s.log.Warn().Err(err).Str("session", id).Msg("destroy session on host failed (may already be gone)")
	}

	if err := s.db.DeleteSession(id); err != nil {
		s.log.Error().Err(err).Str("session", id).Msg("delete session from db failed")
	}

	s.ws.BroadcastSessionsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "deleted"}})
}

// AdoptSession registers an externally-started tmux session as a first-class
// tracked session, immediately and deterministically.
//
// Honest scoping note: discovery already auto-tracks EVERY tmux session on a
// connected host within one discovery tick (there are no name filters), so
// this endpoint is not the only way an external session becomes tracked. What
// it adds is (a) a synchronous guarantee — when the call returns 2xx the
// session row exists, durable pipe-pane logging has been kicked off, and the
// WS sessions.update has fired, which automation (e.g. a caller that just ran
// `tmux new-session` over its own SSH connection and wants to attach through
// sigil right away) can rely on without racing the discovery loop; and (b) a
// crisp 404 when the named tmux session doesn't actually exist.
//
// Idempotent: adopting an already-tracked live session returns 200 with the
// existing row. A tracked row whose tmux session is gone returns 404 (use
// /resurrect for that). 201 is returned only when the row is newly created.
func (s *Server) AdoptSession(w http.ResponseWriter, r *http.Request) {
	hostName := mux.Vars(r)["name"]

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if body.Name == "" {
		writeError(w, 400, "bad_request", "name is required")
		return
	}

	if _, err := s.db.GetHost(hostName); err != nil {
		writeError(w, 404, "not_found", "host not found")
		return
	}

	alive, err := s.sessions.SessionExists(hostName, body.Name)
	if err != nil {
		writeError(w, 502, "probe_error", err.Error())
		return
	}
	if !alive {
		writeError(w, 404, "not_found", "tmux session not found on host")
		return
	}

	sessionID := hostName + ":" + body.Name
	existing, err := s.db.GetSessions(hostName)
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	alreadyTracked := false
	for i := range existing {
		if existing[i].ID == sessionID {
			alreadyTracked = true
			break
		}
	}

	// Synchronous discovery so the row (metadata, windows, cwd) exists before
	// we answer — and it kicks off the SIGIL-1 pipe-pane log capture for the
	// new session as a side effect.
	dCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.sessions.DiscoverHost(dCtx, hostName); err != nil {
		writeError(w, 502, "discovery_error", err.Error())
		return
	}
	s.ws.BroadcastSessionsUpdate()

	rows, err := s.db.GetSessions(hostName)
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	for i := range rows {
		if rows[i].ID == sessionID {
			status := 201
			if alreadyTracked {
				status = 200
			}
			writeJSON(w, status, sigil.APIResponse{Data: rows[i]})
			return
		}
	}
	// tmux said the session exists but discovery didn't surface it — should
	// not happen; report rather than pretend.
	writeError(w, 500, "adopt_error", "session alive on host but discovery did not register it")
}

// ResurrectSession recreates a tmux session on its host using the stored
// start_dir / start_cmd (or an override supplied in the request body), so the
// user can hop back into a "session closed" zombie row without manually
// SSHing and re-launching tmux. If a session with that name is already alive
// on the host this is a no-op success (idempotent).
func (s *Server) ResurrectSession(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	var body struct {
		StartDir string `json:"start_dir"`
		StartCmd string `json:"start_cmd"`
	}
	// Body is optional — ignore decode errors on empty body.
	_ = json.NewDecoder(r.Body).Decode(&body)

	sessions, err := s.db.GetSessions("")
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	var target *sigil.Session
	for i := range sessions {
		if sessions[i].ID == id {
			target = &sessions[i]
			break
		}
	}
	if target == nil {
		writeError(w, 404, "not_found", "session not found")
		return
	}

	startDir := body.StartDir
	if startDir == "" {
		startDir = target.StartDir
	}
	startCmd := body.StartCmd
	if startCmd == "" {
		startCmd = target.StartCmd
	}

	created, err := s.sessions.EnsureSession(target.HostName, target.Name, startDir, startCmd)
	if err != nil {
		writeError(w, 500, "resurrect_error", err.Error())
		return
	}
	if created {
		s.log.Info().Str("session", id).Str("cwd", startDir).Msg("resurrected session")
	} else {
		s.log.Info().Str("session", id).Msg("resurrect found session already alive")
	}

	// Backfill start_dir/start_cmd on the row if the user supplied an override
	// (or if the stored row was empty and we just used the captured cwd). The
	// upsert's CASE clause will only fill empty fields, so this is safe.
	if startDir != "" || startCmd != "" {
		updated := *target
		updated.StartDir = startDir
		updated.StartCmd = startCmd
		updated.Status = "active"
		_ = s.db.UpsertSession(updated)
	}

	go func() {
		_ = s.sessions.DiscoverHost(context.Background(), target.HostName)
		s.ws.BroadcastSessionsUpdate()
	}()

	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{
		"id":        target.ID,
		"host_name": target.HostName,
		"name":      target.Name,
		"start_dir": startDir,
		"start_cmd": startCmd,
		"status":    "resurrected",
	}})
}

// UpdateSession renames a tmux session
func (s *Server) UpdateSession(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}

	sessions, err := s.db.GetSessions("")
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	var target *sigil.Session
	for i := range sessions {
		if sessions[i].ID == id {
			target = &sessions[i]
			break
		}
	}
	if target == nil {
		writeError(w, 404, "not_found", "session not found")
		return
	}

	if body.Name != "" && body.Name != target.Name {
		if err := s.sessions.RenameSession(target.HostName, target.Name, body.Name); err != nil {
			writeError(w, 500, "rename_error", err.Error())
			return
		}
		go func() {
			_ = s.sessions.DiscoverHost(r.Context(), target.HostName)
			s.ws.BroadcastSessionsUpdate()
		}()
	}

	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "updated"}})
}

// GetScrollback returns scrollback chunks for a session
func (s *Server) GetScrollback(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sessionID := vars["id"]

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 {
		limit = 100
	}

	chunks, err := s.db.GetScrollback(sessionID, limit, offset)
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{
		Data: chunks,
		Meta: &sigil.APIMeta{Total: len(chunks), Limit: limit, Offset: offset},
	})
}

// GetCapture returns tmux capture-pane output for a session — rendered terminal
// lines with SGR color codes only, suitable for ANSI-to-HTML conversion in the
// browser. Unlike GetScrollback (raw PTY bytes), this contains no cursor
// positioning sequences and renders correctly.
func (s *Server) GetCapture(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sessionID := vars["id"]

	// Look up host + session name from DB
	sessions, err := s.db.GetSessions("")
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	var hostName, sessionName string
	for _, sess := range sessions {
		if sess.ID == sessionID {
			hostName = sess.HostName
			sessionName = sess.Name
			break
		}
	}
	if hostName == "" {
		writeError(w, 404, "not_found", "session not found")
		return
	}

	text, altOn, err := s.sessions.CapturePane(hostName, sessionName)
	writeCaptureResult(w, text, altOn, err)
}

// writeCaptureResult turns a session.CapturePane result into the HTTP answer.
//
// The status codes are deliberate. Mission Control polls /capture for every
// registered session on a loop, so the response has to separate "this session
// is gone" from "this session is alive, I just couldn't read it this instant".
// A wedged a Linux host pipe-pane used to answer a blanket 500 for the latter, and
// (until the client was hardened) a poller could read that 500 as "this live
// worker failed". The split gives pollers a clean, non-alarming signal:
//
//	404 session_gone    — tmux says the session (or its server) is gone; stop polling.
//	200 available:false — alive but momentarily uncapturable (ssh hiccup, host
//	                      briefly unreachable, pipe-pane not seeded / wedged);
//	                      keep polling, nothing is wrong.
//	500 capture_error   — a genuine internal failure, i.e. a real bug worth paging on.
//
// `available` is additive: a healthy capture keeps its existing {text, alt_on}
// payload and merely gains available:true, so existing clients are unaffected.
func writeCaptureResult(w http.ResponseWriter, text string, altOn bool, err error) {
	switch {
	case errors.Is(err, session.ErrSessionGone):
		writeError(w, 404, "session_gone", "tmux session no longer exists on host")
	case errors.Is(err, session.ErrCaptureUnavailable):
		writeJSON(w, 200, sigil.APIResponse{
			Data: map[string]any{"text": "", "alt_on": false, "available": false},
		})
	case err != nil:
		// CapturePane classifies every failure it knows about, so anything
		// unwrapped that reaches here is a programming error — keep the 500.
		writeError(w, 500, "capture_error", err.Error())
	default:
		writeJSON(w, 200, sigil.APIResponse{
			Data: map[string]any{"text": text, "alt_on": altOn, "available": true},
		})
	}
}

// GetPipedCapture returns the pipe-pane log for a session — clean SGR-only ANSI
// text captured directly from the tmux pane, safe for ansi-to-html conversion.
// Unlike GetCapture (tmux capture-pane), this file grows continuously and is not
// limited by tmux's history-limit; it persists for the lifetime of the session.
func (s *Server) GetPipedCapture(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sessionID := vars["id"]

	sessions, err := s.db.GetSessions("")
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	var hostName, sessionName string
	for _, sess := range sessions {
		if sess.ID == sessionID {
			hostName = sess.HostName
			sessionName = sess.Name
			break
		}
	}
	if hostName == "" {
		writeError(w, 404, "not_found", "session not found")
		return
	}

	// Incremental mode: `?offset=N` returns only the bytes appended since offset N
	// (base64), plus the next offset and a reset flag if the log rotated. This is
	// the O(new-bytes) source for the client's offscreen-terminal scrollback tap.
	// Without offset, behaves as before (whole log as text) for existing callers.
	if raw := r.URL.Query().Get("offset"); raw != "" {
		// Negative offset = seed from the last |offset| bytes (bounded cold start).
		offset, _ := strconv.ParseInt(raw, 10, 64)
		data, next, reset, err := s.sessions.GetPipedScrollbackFrom(hostName, sessionName, offset)
		if err != nil {
			writeError(w, 500, "pipe_error", err.Error())
			return
		}
		writeJSON(w, 200, sigil.APIResponse{
			Data: map[string]any{
				"data":        base64.StdEncoding.EncodeToString(data),
				"next_offset": next,
				"reset":       reset,
			},
		})
		return
	}

	text, err := s.sessions.GetPipedScrollback(hostName, sessionName)
	if err != nil {
		writeError(w, 500, "pipe_error", err.Error())
		return
	}

	writeJSON(w, 200, sigil.APIResponse{
		Data: map[string]string{"text": text},
	})
}

// Search performs FTS5 search on scrollback
func (s *Server) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		writeError(w, 400, "bad_request", "q parameter is required")
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 {
		limit = 50
	}

	results, err := s.db.SearchScrollback(q, sessionID, limit, offset)
	if err != nil {
		writeError(w, 500, "search_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{
		Data: results,
		Meta: &sigil.APIMeta{Total: len(results), Limit: limit, Offset: offset},
	})
}

// GetEvents returns recent events
func (s *Server) GetEvents(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}

	evts, err := s.db.GetEvents(limit)
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: evts, Meta: &sigil.APIMeta{Total: len(evts)}})
}

// GetTriggers returns all triggers
func (s *Server) GetTriggers(w http.ResponseWriter, r *http.Request) {
	triggers, err := s.db.GetTriggers()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: triggers, Meta: &sigil.APIMeta{Total: len(triggers)}})
}

// CreateTrigger creates a new trigger
func (s *Server) CreateTrigger(w http.ResponseWriter, r *http.Request) {
	var t sigil.Trigger
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if t.Name == "" || t.Pattern == "" || t.Action == "" {
		writeError(w, 400, "bad_request", "name, pattern, action are required")
		return
	}
	if t.ID == "" {
		t.ID = uuid.New().String()
	}
	if t.Config == nil {
		t.Config = map[string]interface{}{}
	}

	if err := s.db.InsertTrigger(t); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	s.events.LoadTriggers()
	writeJSON(w, 201, sigil.APIResponse{Data: t})
}

// UpdateTrigger updates an existing trigger
func (s *Server) UpdateTrigger(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	var t sigil.Trigger
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	t.ID = id

	if err := s.db.UpdateTrigger(t); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	s.events.LoadTriggers()
	writeJSON(w, 200, sigil.APIResponse{Data: t})
}

// DeleteTrigger removes a trigger
func (s *Server) DeleteTrigger(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	if err := s.db.DeleteTrigger(id); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}

	s.events.LoadTriggers()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "deleted"}})
}

// GetWorkspaces returns all workspaces
func (s *Server) GetWorkspaces(w http.ResponseWriter, r *http.Request) {
	workspaces, err := s.db.GetWorkspaces()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: workspaces, Meta: &sigil.APIMeta{Total: len(workspaces)}})
}

// SaveWorkspace creates or updates a workspace and broadcasts to other clients
func (s *Server) SaveWorkspace(w http.ResponseWriter, r *http.Request) {
	var ws sigil.Workspace
	if err := json.NewDecoder(r.Body).Decode(&ws); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if ws.Name == "" {
		writeError(w, 400, "bad_request", "name is required")
		return
	}
	if ws.ID == "" {
		ws.ID = uuid.New().String()
	}
	if err := s.db.SaveWorkspace(ws); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	go s.ws.BroadcastWorkspaceUpdate(ws)
	writeJSON(w, 200, sigil.APIResponse{Data: ws})
}

// DeleteWorkspace removes a workspace
func (s *Server) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	if err := s.db.DeleteWorkspace(id); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "deleted"}})
}

// GetPrefs returns the shared per-host / per-session accent colours.
func (s *Server) GetPrefs(w http.ResponseWriter, r *http.Request) {
	hosts, sessions, err := s.db.GetColorPrefs()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	all, _ := s.db.GetAllPrefs()
	images, _ := s.db.ListAssetScopes()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]any{
		"hosts": hosts, "sessions": sessions, "all": all, "images": images,
	}})
}

// SetPrefColor sets (or clears, when color=="") one host/session accent colour,
// then broadcasts prefs.update so every client — desktop or mobile — stays in sync.
func (s *Server) SetPrefColor(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind    string `json:"kind"`
		Host    string `json:"host"`
		Session string `json:"session"`
		Color   string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	var key string
	switch body.Kind {
	case "host":
		if body.Host == "" {
			writeError(w, 400, "bad_request", "host is required")
			return
		}
		key = "h:" + body.Host
	case "session":
		if body.Host == "" || body.Session == "" {
			writeError(w, 400, "bad_request", "host and session are required")
			return
		}
		key = "s:" + body.Host + "::" + body.Session
	default:
		writeError(w, 400, "bad_request", "kind must be host or session")
		return
	}
	if err := s.db.SetColorPref(key, body.Color); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	go s.ws.BroadcastPrefsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "ok"}})
}

// GetLayouts returns all saved layouts
func (s *Server) GetLayouts(w http.ResponseWriter, r *http.Request) {
	layouts, err := s.db.GetLayouts()
	if err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: layouts, Meta: &sigil.APIMeta{Total: len(layouts)}})
}

// SaveLayout saves a layout
func (s *Server) SaveLayout(w http.ResponseWriter, r *http.Request) {
	var l sigil.Layout
	if err := json.NewDecoder(r.Body).Decode(&l); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if l.Name == "" {
		writeError(w, 400, "bad_request", "name is required")
		return
	}
	if l.ID == "" {
		l.ID = uuid.New().String()
	}
	if l.CreatedAt.IsZero() {
		l.CreatedAt = time.Now()
	}

	if err := s.db.SaveLayout(l); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 201, sigil.APIResponse{Data: l})
}

// DeleteLayout removes a layout
func (s *Server) DeleteLayout(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	if err := s.db.DeleteLayout(id); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "deleted"}})
}

// GetFiles reads a file or lists a directory on a remote host via SSH.
// Query params:
//
//	path  – remote path (may start with ~/)
//	browse=1 – list directory instead of reading file
func (s *Server) GetFiles(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	hostName := vars["name"]
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "~"
	}

	if r.URL.Query().Get("browse") == "1" {
		listing, err := s.sessions.ListDir(hostName, path)
		if err != nil {
			writeError(w, 500, "list_error", err.Error())
			return
		}
		writeJSON(w, 200, sigil.APIResponse{Data: listing})
	} else {
		fc, err := s.sessions.ReadFile(hostName, path)
		if err != nil {
			writeError(w, 500, "read_error", err.Error())
			return
		}
		writeJSON(w, 200, sigil.APIResponse{Data: fc})
	}
}

// PushPreview broadcasts a preview.open WebSocket event to all connected clients.
// Called by agents (e.g. via the sigil-view shell script) to push a file to the UI.
func (s *Server) PushPreview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostName string `json:"host_name"`
		Path     string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	if req.HostName == "" || req.Path == "" {
		writeError(w, 400, "bad_request", "host_name and path are required")
		return
	}
	s.ws.BroadcastPreviewOpen(req.HostName, req.Path)
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "ok"}})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, sigil.APIResponse{Error: &sigil.APIError{Code: code, Message: message}})
}
