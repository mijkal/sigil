package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"golang.org/x/crypto/ssh"

	"sigil.dev/sigil/internal/db"
	"sigil.dev/sigil/internal/replay"
	sshpool "sigil.dev/sigil/internal/ssh"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// OutputChunk is one burst of PTY output plus its replay-buffer cursor: Seq is
// the byte offset AFTER this chunk in the session's replay stream (0 when the
// chunk was not recorded, e.g. from a non-feeder channel).
type OutputChunk struct {
	Data []byte
	Seq  uint64
}

// Channel is ONE VIEWER's attachment to a tmux session — a pane tab in a browser,
// a TUI, an API caller. Every viewer gets its own Channel (its own ID, its own
// Output queue, its own requested size), but viewers of the SAME tmux target
// share a single backing *tmuxClient, so N viewers cost exactly one SSH session
// and one tmux client.
//
// Sharing matters because tmux sizes a window from its CLIENTS: with a client per
// viewer, whichever attached last won the size and every other viewer got the
// dotted filler tmux paints outside the window. One client per target means there
// is nothing left to disagree with — see tmuxClient.applySizeLocked.
type Channel struct {
	ID        string
	SessionID string
	HostName  string
	Output    chan OutputChunk
	Closed    bool

	client *tmuxClient // shared backend (SSH session + stdin + readers)
	// This viewer's requested grid. The backend pty is sized to the smallest
	// request across live viewers so no viewer is ever shown a window bigger
	// than it can draw.
	rows, cols uint16
	// ghost marks a viewer whose WS client has gone but whose channel is kept
	// briefly as a replay feeder (see DetachAfter). A ghost has no screen to
	// draw, so it must NOT constrain the grid — otherwise a closed tab or a
	// refresh pins the pane to its old size for the whole 3-minute grace, and a
	// still-open taller viewer keeps unpaintable rows for that entire time.
	ghost bool
	// Grid carries the EFFECTIVE pty geometry (rows, cols) whenever it changes.
	// A viewer needs this because the shared pty may be smaller than the viewer's
	// own terminal: tmux then paints only the top `rows` lines and everything
	// below is whatever that grid held before — stale text nothing ever clears.
	// Told the real size, a client can shrink its own terminal to match and show
	// honest empty space instead. Buffered + coalescing: only the latest matters.
	Grid chan [2]uint16

	mu        sync.Mutex
	closeOnce sync.Once
}

// notifyGrid publishes the effective geometry to this viewer, dropping the
// update if one is already queued (the newest supersedes it anyway).
func (c *Channel) notifyGrid(rows, cols uint16) {
	if c.Grid == nil {
		return
	}
	select {
	case c.Grid <- [2]uint16{rows, cols}:
	default:
		select { // make room, then post the fresher value
		case <-c.Grid:
		default:
		}
		select {
		case c.Grid <- [2]uint16{rows, cols}:
		default:
		}
	}
}

// closeOutput closes this viewer's Output queue exactly once. Both the shared
// backend's reader-closer (session ended) and an explicit Detach can reach it.
func (c *Channel) closeOutput() {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.Closed = true
		c.mu.Unlock()
		close(c.Output)
	})
}

// tmuxClient is the shared backend behind one or more Channels: a single SSH
// session running `tmux attach-session`, i.e. exactly one tmux client. Keyed by
// (host, session, window) so every viewer of the same target reuses it.
type tmuxClient struct {
	id        string // opaque id used as the replay/trigger feeder token
	key       string
	hostName  string
	sessName  string
	sessionID string

	sess  *ssh.Session
	stdin io.WriteCloser

	mu     sync.Mutex
	subs   map[*Channel]struct{}
	closed bool
	// Grid currently applied to the pty — the min over subs, so a resize is only
	// pushed to the host when the effective size actually moves.
	rows, cols uint16
}

// clientKey identifies a tmux attach target. Viewers that share a key share a
// tmux client. windowIndex is part of the key because `-t sess:N` and `-t sess`
// (current window) are genuinely different attach targets.
func clientKey(hostName, sessionName string, windowIndex int) string {
	return hostName + "\x00" + sessionName + "\x00" + strconv.Itoa(windowIndex)
}

// addSub registers a viewer. Returns false if the backend died in the meantime,
// in which case the caller must build a fresh one.
func (tc *tmuxClient) addSub(ch *Channel) bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if tc.closed {
		return false
	}
	tc.subs[ch] = struct{}{}
	tc.applySizeLocked()
	return true
}

// removeSub unregisters a viewer and reports whether that was the last one (the
// caller then tears the SSH session down). A departing viewer also lets the grid
// grow back if it was the one holding it small.
func (tc *tmuxClient) removeSub(ch *Channel) (last bool) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	delete(tc.subs, ch)
	if len(tc.subs) == 0 {
		return true
	}
	tc.applySizeLocked()
	return false
}

// applySizeLocked recomputes the effective grid — the SMALLEST rows and cols any
// live viewer asked for — and pushes it to the pty when it changed.
//
// Smallest, not largest: tmux draws one window for its single client, so a
// viewer whose viewport is narrower than the window simply cannot see the right
// edge. Sizing down means every viewer can render the whole window; the larger
// viewers get clean empty space beside it instead of a truncated or dot-filled
// pane. (This is the same rule as tmux's own `window-size smallest`.)
func (tc *tmuxClient) applySizeLocked() {
	if tc.closed {
		return
	}
	rows, cols := smallestGrid(tc.subs)
	if rows == 0 || cols == 0 || (rows == tc.rows && cols == tc.cols) {
		return
	}
	tc.rows, tc.cols = rows, cols
	if tc.sess != nil {
		// Best-effort: a dead session just means the readers are about to close.
		_ = tc.sess.WindowChange(int(rows), int(cols))
	}
	// Tell every viewer what the pty ACTUALLY is now, so a viewer whose own
	// terminal is larger can shrink to match rather than keep rows tmux will
	// never paint. This is the fix for the stale-text artifact: the dead region
	// stops existing instead of being left to hold an old frame forever.
	for sub := range tc.subs {
		sub.notifyGrid(rows, cols)
	}
}

// smallestGrid returns the per-axis minimum over the viewers that stated a size.
// Rows and cols are minimised INDEPENDENTLY: a tall-narrow viewer and a
// short-wide one together yield the intersection both can draw. Zero means no
// viewer stated that axis, and the caller leaves the pty alone.
//
// GHOSTS ARE EXCLUDED. A ghost has no screen; letting its last requested size
// count meant a closed tab held the pane at its old geometry for the entire
// 3-minute detach grace (measured: 182s before a pane grew back). Only if every
// remaining viewer is a ghost do we fall back to counting them, so the pty keeps
// a sane size instead of collapsing to zero.
func smallestGrid(subs map[*Channel]struct{}) (rows, cols uint16) {
	rows, cols = gridOver(subs, false)
	if rows == 0 || cols == 0 {
		// All ghosts (or none sized): fall back to counting ghosts too.
		grows, gcols := gridOver(subs, true)
		if rows == 0 {
			rows = grows
		}
		if cols == 0 {
			cols = gcols
		}
	}
	return rows, cols
}

// gridOver is smallestGrid's inner loop; inclGhosts selects whether channels
// parked as replay feeders participate.
func gridOver(subs map[*Channel]struct{}, inclGhosts bool) (rows, cols uint16) {
	for sub := range subs {
		if sub.ghost && !inclGhosts {
			continue
		}
		if sub.rows > 0 && (rows == 0 || sub.rows < rows) {
			rows = sub.rows
		}
		if sub.cols > 0 && (cols == 0 || sub.cols < cols) {
			cols = sub.cols
		}
	}
	return rows, cols
}

// broadcast fans one output burst out to every viewer. Non-blocking per viewer,
// exactly as the single-viewer path was: a client that is not draining does not
// stall the reader, and the bytes are already durable in the replay ring.
func (tc *tmuxClient) broadcast(chunk OutputChunk) {
	tc.mu.Lock()
	subs := make([]*Channel, 0, len(tc.subs))
	for sub := range tc.subs {
		subs = append(subs, sub)
	}
	tc.mu.Unlock()
	for _, sub := range subs {
		select {
		case sub.Output <- chunk:
		default:
		}
	}
}

// shutdown marks the backend dead and closes every viewer's queue. Called when
// the readers hit EOF (tmux detached / session died).
func (tc *tmuxClient) shutdown() {
	tc.mu.Lock()
	tc.closed = true
	subs := make([]*Channel, 0, len(tc.subs))
	for sub := range tc.subs {
		subs = append(subs, sub)
	}
	tc.subs = map[*Channel]struct{}{}
	tc.mu.Unlock()
	for _, sub := range subs {
		sub.closeOutput()
	}
}

// Manager manages tmux sessions on remote hosts
type Manager struct {
	pool     *sshpool.Pool
	db       *db.DB
	channels map[string]*Channel
	// One shared tmux client per attach target (see clientKey). Guarded by mu
	// together with channels so attach/detach can't race a half-torn-down entry.
	clients map[string]*tmuxClient
	mu      sync.RWMutex
	events  chan<- sigil.Event
	log     zerolog.Logger

	// Per-session live activity signal ("working"/"attention"/""), recomputed each
	// discovery from the active pane command + output recency. NOT persisted —
	// merged into the session list at broadcast time. See sigil.Session.Activity.
	activityBySession map[string]string
	// Last-seen pipe-log size per session — the delta between discoveries is the
	// reliable "produced output recently" signal (tmux session_activity does NOT
	// track pane output for detached sessions).
	logSizeBySession map[string]int64
	// Last time a session's pipe log grew (produced output). Drives a stable
	// signal: within workingGrace of it → "working" (so a bursty stream doesn't
	// flap), then until attentionTTL → "attention" (stopped — likely needs you),
	// then idle. A session that never grew is idle (never flagged).
	lastGrewAt map[string]time.Time
	// AUTHORITATIVE signal from the agent's Notification/Stop hook (permission or
	// idle prompt) via SetSignal → wins over the output-growth heuristic and the
	// refineAttention tail-scrape. Keyed by session ID. Cleared on a "done" signal
	// or after ttl (a crashed hook can't pin "waiting" forever). Guarded by activityMu.
	signalBySession map[string]*hookSignal
	activityMu      sync.RWMutex

	// Control-mode clients (one per connected host)
	controls  map[string]*ControlClient
	controlMu sync.RWMutex
	// Called after DiscoverHost completes — used by callers to broadcast updates
	onDiscovery func(hostName string)

	// pipe-pane capture: tracks which sessions are actively being piped so we
	// don't accidentally toggle piping off by calling pipe-pane a second time.
	pipedSessions map[string]bool
	pipedMu       sync.Mutex

	// replay holds the per-session in-memory output ring used for
	// replay-then-live on (re)attach. See internal/replay.
	replay *replay.Store

	// missCounts tracks how many consecutive discoveries have failed to see a
	// given session. Prune only fires after pruneMissThreshold misses — this
	// keeps a single flaky tmux query (or a partial restore where one session
	// just came back) from wiping out zombie rows the user may still want.
	// Keyed by session ID (host:name).
	missCounts map[string]int
	missMu     sync.Mutex

	// hostTmuxUp[host] is true once we've confirmed the tmux server is reachable
	// on that host (via `tmux show-options -s`). The false→true transition
	// triggers auto-resurrect of every detached DB row for the host, so a tmux
	// restart on the target brings back all the user's named sessions at their
	// last-known cwd without manual intervention. The true→false transition
	// freezes pruning so rows survive until tmux comes back.
	hostTmuxUp map[string]bool
	// lastResurrectAt[host] caps how often we re-attempt auto-resurrect while
	// tmux is *still* down. EnsureSession will (re)start the tmux server as a
	// side effect of creating a session, so periodic retry from the down state
	// is what makes restore zero-click after a target reboot — but unbounded
	// retry would hammer SSH on hosts where the user genuinely wants tmux off.
	lastResurrectAt map[string]time.Time
	// resurrectInFlight[host] counts the auto-resurrect goroutines currently
	// running for a host. While it is > 0, pruning is suppressed for that host.
	// This is the fix for a recovery race: a multi-session restore runs async and
	// can span many discovery ticks, and each session it recreates fires a
	// control-mode discovery — so without this guard the not-yet-restored
	// sessions look "orphaned", blow the miss threshold within seconds, and get
	// deleted mid-restore (observed eating a named session after a tmux crash).
	resurrectInFlight map[string]int
	tmuxStMu          sync.Mutex

	// triggerFeed line-buffers the feeder stream for the event bus's trigger
	// matcher. triggerGate is a cheap predicate ("are any output triggers
	// configured?") checked before any per-line work, so the default no-trigger
	// posture adds zero overhead to the PTY hot path. Set via SetTriggerGate.
	triggerFeed *triggerFeed
	triggerGate func() bool
}

// downResurrectInterval is the minimum time between auto-resurrect attempts on
// a host whose tmux server is down. Short enough that visiting sigil-web after
// a reboot feels instant; long enough to avoid SSH-storming a target that's
// genuinely meant to be tmux-free.
const downResurrectInterval = 30 * time.Second

// pruneMissThreshold is the number of consecutive discoveries that must miss
// a session before its DB row is pruned. At the default 5s discovery interval
// this gives ~15s of grace, enough to ride out a tmux restart on the target.
const pruneMissThreshold = 3

// New creates a new session manager
func New(pool *sshpool.Pool, d *db.DB, events chan<- sigil.Event) *Manager {
	return &Manager{
		pool:              pool,
		db:                d,
		channels:          make(map[string]*Channel),
		clients:           make(map[string]*tmuxClient),
		activityBySession: make(map[string]string),
		signalBySession:   make(map[string]*hookSignal),
		logSizeBySession:  make(map[string]int64),
		lastGrewAt:        make(map[string]time.Time),
		controls:          make(map[string]*ControlClient),
		pipedSessions:     make(map[string]bool),
		missCounts:        make(map[string]int),
		hostTmuxUp:        make(map[string]bool),
		lastResurrectAt:   make(map[string]time.Time),
		resurrectInFlight: make(map[string]int),
		replay:            replay.NewStore(),
		events:            events,
		triggerFeed:       newTriggerFeed(),
		triggerGate:       func() bool { return false },
		log:               zerolog.Nop(),
	}
}

// SetTriggerGate installs a predicate that reports whether any output-matching
// triggers are configured. When it returns false the PTY reader skips all
// line-buffering/emission, so triggers cost nothing until the user defines one.
func (m *Manager) SetTriggerGate(fn func() bool) {
	if fn != nil {
		m.triggerGate = fn
	}
}

// feedTriggers offers feeder-channel bytes to the trigger matcher: for each
// complete line it publishes an ephemeral session.output event to the bus. It
// is a no-op unless output triggers exist and this channel is the session's
// feeder, so concurrent attachments never double-fire and the idle path is free.
func (m *Manager) feedTriggers(sessionID, channelID string, data []byte) {
	if !m.triggerGate() || !m.replay.IsFeeder(sessionID, channelID) {
		return
	}
	m.triggerFeed.feed(sessionID, data, func(line string) {
		select {
		case m.events <- sigil.Event{
			Type: "session.output",
			Data: map[string]interface{}{"session": sessionID, "output": line},
		}:
		default:
			// Bus channel full — drop. Triggers are best-effort; the scrollback
			// path (the source of truth) is unaffected.
		}
	})
}

// ReplayStore exposes the per-session output ring so the WS layer can serve
// replay-then-live on attach.
func (m *Manager) ReplayStore() *replay.Store {
	return m.replay
}

// SetOnDiscovery sets a callback invoked after each DiscoverHost run.
// Typically used by the WS server to broadcast sessions.update.
func (m *Manager) SetOnDiscovery(fn func(hostName string)) {
	m.onDiscovery = fn
}

// StartControl starts a tmux control-mode client for the named host.
// Idempotent — calling it again for an already-running host is a no-op.
func (m *Manager) StartControl(ctx context.Context, hostName string) {
	m.controlMu.Lock()
	defer m.controlMu.Unlock()
	if _, exists := m.controls[hostName]; exists {
		return
	}
	cc := newControlClient(hostName, m.pool, m.log.With().Str("component", "tmux-control").Logger(),
		func(h string) {
			// Control-mode triggered: re-discover and notify
			dCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := m.DiscoverHost(dCtx, h); err != nil {
				m.log.Warn().Err(err).Str("host", h).Msg("control-triggered discovery failed")
			}
		})
	m.controls[hostName] = cc
	cc.start()
	m.log.Info().Str("host", hostName).Msg("tmux control mode started")
}

// StopControl stops the control-mode client for the named host.
func (m *Manager) StopControl(hostName string) {
	m.controlMu.Lock()
	cc, ok := m.controls[hostName]
	if ok {
		delete(m.controls, hostName)
	}
	m.controlMu.Unlock()
	if ok {
		cc.stop()
	}
}

// SetLogger sets the logger
func (m *Manager) SetLogger(log zerolog.Logger) {
	m.log = log
}

// DiscoverAll runs discovery on all connected hosts
func (m *Manager) DiscoverAll(ctx context.Context) {
	hosts := m.pool.GetConnectedHosts()
	var wg sync.WaitGroup
	for _, h := range hosts {
		h := h
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.DiscoverHost(ctx, h); err != nil {
				m.log.Error().Err(err).Str("host", h).Msg("discovery failed")
			}
		}()
	}
	wg.Wait()
}

// DiscoverHost discovers tmux sessions and windows on a single host.
// It runs a combined command to fetch both in one SSH round-trip.
func (m *Manager) DiscoverHost(ctx context.Context, hostName string) error {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return fmt.Errorf("new ssh session: %w", err)
	}
	defer sess.Close()

	// Fetch sessions, windows, and panes in a single SSH exec.
	// Lines prefixed with __S__: are sessions; __W__| are windows; __P__| are panes.
	// Note: #S and #W are tmux aliases that expand to the session/window name, so they
	// cannot be used as literal prefixes. We use fixed sentinel strings instead.
	// The pane line gives us pane_current_path so we can resurrect a dead session
	// back into its last known working directory.
	//
	// The trailing `__T__:` line is an explicit server-up probe: `tmux
	// show-options -s` reads server-scoped options and requires a running tmux
	// server. Exit 0 = server up; nonzero = server down (or tmux not installed).
	// We need this signal because the list-sessions block above prints nothing
	// in BOTH "server down" and "server up but zero sessions" — without the
	// explicit probe we cannot tell the difference, and the auto-resurrect /
	// prune logic depends on it.
	// pane_current_command (the active pane's foreground process) lets us detect
	// a running `claude` and record a resume command, so auto-resurrect brings
	// back the conversation, not just a bare shell. It is placed before
	// pane_current_path because the path is the trailing field and may (rarely)
	// contain a literal '|'; keeping it last lets SplitN absorb any stray '|'.
	const cmd = `(tmux list-sessions -F '__S__:#{session_name}:#{session_windows}:#{session_created}:#{session_activity}:#{session_attached}' 2>/dev/null; tmux list-windows -a -F '__W__|#{session_name}|#{window_index}|#{window_id}|#{window_name}|#{window_active}|#{window_panes}' 2>/dev/null; tmux list-panes -a -F '__P__|#{session_name}|#{window_active}|#{pane_active}|#{pane_current_command}|#{pane_current_path}' 2>/dev/null; for f in "$HOME"/.local/share/sigil/logs/*.log; do [ -e "$f" ] && printf '__L__:%s:%s\n' "$(basename "$f" .log)" "$(wc -c < "$f" 2>/dev/null || echo 0)"; done); tmux show-options -s >/dev/null 2>&1 && echo "__T__:up" || echo "__T__:down"; true`
	out, err := sshpool.OutputWithTimeout(sess, cmd, sshpool.DefaultExecTimeout)
	if err != nil {
		return nil // tmux not present or failed — not an error for sigil
	}

	// Parse output into sessions, a window map, and a per-session cwd taken
	// from the active pane in the active window.
	type sessionKey = string // hostName:sessionName
	windowsBySession := map[string][]sigil.TmuxWindow{}
	sessions := map[string]sigil.Session{}
	cwdBySession := map[string]string{}
	// resumeCmdBySession holds a launch-intent command detected from the active
	// pane (currently: claude → "claude --continue"). Only set when we have a
	// positive signal; empty means "no signal, preserve whatever's stored".
	resumeCmdBySession := map[string]string{}
	// Active pane command per session (for the live activity signal).
	paneCmdBySession := map[string]string{}
	// Current pipe-log size keyed by SafeFileName (the log basename).
	logSizeBySafe := map[string]int64{}
	tmuxUp := false

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "__L__:") {
			// __L__:<safeName>:<size>
			rest := line[6:]
			if i := strings.LastIndexByte(rest, ':'); i > 0 {
				safe := rest[:i]
				sz, _ := strconv.ParseInt(rest[i+1:], 10, 64)
				logSizeBySafe[safe] = sz
			}
			continue
		}
		if line == "__T__:up" {
			tmuxUp = true
			continue
		}
		if line == "__T__:down" {
			tmuxUp = false
			continue
		}

		if strings.HasPrefix(line, "__S__:") {
			parts := strings.SplitN(line[6:], ":", 5)
			if len(parts) < 5 {
				continue
			}
			name := parts[0]
			windows, _ := strconv.Atoi(parts[1])
			createdUnix, _ := strconv.ParseInt(parts[2], 10, 64)
			activeUnix, _ := strconv.ParseInt(parts[3], 10, 64)
			attached := parts[4]
			status := "detached"
			if attached != "0" {
				status = "active"
			}
			sessionID := fmt.Sprintf("%s:%s", hostName, name)
			sessions[name] = sigil.Session{
				ID:         sessionID,
				HostName:   hostName,
				Name:       name,
				Windows:    windows,
				Tags:       []string{},
				CreatedAt:  time.Unix(createdUnix, 0),
				LastActive: time.Unix(activeUnix, 0),
				Status:     status,
			}

		} else if strings.HasPrefix(line, "__W__|") {
			parts := strings.SplitN(line[6:], "|", 7)
			if len(parts) < 6 {
				continue
			}
			sessName := parts[0]
			index, _ := strconv.Atoi(parts[1])
			id := parts[2]
			name := parts[3]
			active := parts[4] == "1"
			panes, _ := strconv.Atoi(parts[5])
			windowsBySession[sessName] = append(windowsBySession[sessName], sigil.TmuxWindow{
				ID:     id,
				Index:  index,
				Name:   name,
				Active: active,
				Panes:  panes,
			})

		} else if strings.HasPrefix(line, "__P__|") {
			parts := strings.SplitN(line[6:], "|", 5)
			if len(parts) < 5 {
				continue
			}
			sessName := parts[0]
			windowActive := parts[1] == "1"
			paneActive := parts[2] == "1"
			paneCmd := parts[3]
			path := parts[4]
			if windowActive && paneActive && path != "" {
				cwdBySession[sessName] = path
			}
			if windowActive && paneActive {
				paneCmdBySession[sessName] = paneCmd
			}
			// Record a resume command from the active pane only. We never clear
			// it on a non-claude reading (e.g. the pane sits at a bash prompt, or
			// claude is briefly shelling out for a tool) — the stored value
			// persists so a later death still resurrects the conversation.
			if windowActive && paneActive && resumeCmdForPaneCommand(paneCmd) != "" {
				resumeCmdBySession[sessName] = resumeCmdForPaneCommand(paneCmd)
			}
		}
	}

	// Recompute the live per-session activity signal: the active pane command says
	// whether anything is running (shell ⇒ idle), and the pipe-log growth since the
	// last discovery says whether it produced output (grew ⇒ working, else ⇒
	// attention). Stored in-memory (not the DB) and merged at broadcast.
	// Stable classification via "recently produced output":
	//   command running + grew within workingGrace → working (hysteresis so a
	//     bursty stream, or claude thinking between chunks, doesn't flap to
	//     attention and re-fire its animation)
	//   command running + last grew workingGrace..attentionTTL ago → attention
	//     (it stopped — likely done / waiting for you)
	//   otherwise (shell prompt, or never produced output, or aged out) → idle
	const workingGrace = 20 * time.Second
	const attentionTTL = 5 * time.Minute
	now := time.Now()
	m.activityMu.Lock()
	prefix := hostName + ":"
	prev := map[string]string{}
	for id, a := range m.activityBySession {
		if strings.HasPrefix(id, prefix) {
			prev[id] = a
			delete(m.activityBySession, id)
		}
	}
	var toRefine []string // session names that just entered attention
	for name, s := range sessions {
		size := logSizeBySafe[sigil.SafeFileName(name)]
		prevSize, seen := m.logSizeBySession[s.ID]
		// Only a real increase counts as output — and NOT the first observation
		// (baseline unknown → the whole existing log would look like growth, which
		// after a restart would falsely flag every session).
		grew := seen && size > prevSize
		m.logSizeBySession[s.ID] = size

		if shellCommands[paneCmdBySession[name]] { // idle at a prompt
			delete(m.lastGrewAt, s.ID)
			continue
		}
		if grew {
			m.lastGrewAt[s.ID] = now
		}
		if last, everGrew := m.lastGrewAt[s.ID]; everGrew {
			switch age := now.Sub(last); {
			case age < workingGrace:
				m.activityBySession[s.ID] = "working"
			case age < attentionTTL:
				// Keep an already-refined attention value; otherwise it JUST stopped
				// → mark generic "attention" and classify its tail asynchronously.
				switch prev[s.ID] {
				case "attention", "waiting", "done", "error":
					m.activityBySession[s.ID] = prev[s.ID]
				default:
					m.activityBySession[s.ID] = "attention"
					toRefine = append(toRefine, name)
				}
			default:
				delete(m.lastGrewAt, s.ID) // aged out → idle
			}
		}
	}
	// Authoritative hook signals WIN over the output-growth heuristic: a session the
	// agent reported as awaiting input is "waiting", full stop. Expire stale ones so
	// a crashed hook can't pin it forever.
	nowSig := time.Now()
	for _, s := range sessions {
		if sig, ok := m.signalBySession[s.ID]; ok {
			if nowSig.After(sig.Expires) {
				delete(m.signalBySession, s.ID)
			} else if sig.Kind == "idle" {
				m.activityBySession[s.ID] = "attention"
			} else {
				m.activityBySession[s.ID] = "waiting"
			}
		}
	}
	m.activityMu.Unlock()
	for _, name := range toRefine {
		// Skip the tail-scrape refine when we have an authoritative signal for it.
		if q, _, _ := m.SignalFor(hostName + ":" + name); q != "" {
			continue
		}
		go m.refineAttention(hostName, name, hostName+":"+name)
	}

	// Attach window lists, cwd, and upsert
	for name, s := range sessions {
		if wins, ok := windowsBySession[name]; ok {
			s.WindowList = wins
		}
		if cwd, ok := cwdBySession[name]; ok {
			s.StartDir = cwd
		}
		// A non-empty StartCmd here tells UpsertSession to refresh the stored
		// resume command; empty leaves the existing value untouched.
		if rc, ok := resumeCmdBySession[name]; ok {
			s.StartCmd = rc
		}
		if err := m.db.UpsertSession(s); err != nil {
			m.log.Error().Err(err).Str("session", s.ID).Msg("upsert session failed")
		}
	}

	// Durable per-session output capture: every session tmux just reported gets
	// pipe-pane logging, not only the ones a web client attaches to. This is
	// what makes the log file survive tmux TUI redraws, pane overwrite, and
	// sigild restarts — after a restart the pipedSessions set is empty, so the
	// first discovery re-establishes every pipe (stop+start, see
	// StartPipeCapture). isPiped keeps steady-state ticks free of goroutine
	// churn.
	for name := range sessions {
		if m.isPiped(hostName, name) {
			continue
		}
		name := name
		go func() {
			if err := m.StartPipeCapture(hostName, name); err != nil {
				m.log.Warn().Err(err).Str("host", hostName).Str("session", name).
					Msg("pipe capture start failed (discovery)")
			}
		}()
	}

	// Detect tmux state transition and fire auto-resurrect on the down→up edge.
	// This is the seamless-restore mechanism: after a target reboot (or any
	// event that killed the tmux server), the first discovery that finds tmux
	// back up triggers EnsureSession for every detached DB row, recreating
	// each named session at its last-known cwd. EnsureSession is idempotent,
	// so for hosts where tmux never died this is a cheap no-op on first run.
	m.tmuxStMu.Lock()
	prevUp, seen := m.hostTmuxUp[hostName]
	m.hostTmuxUp[hostName] = tmuxUp
	m.tmuxStMu.Unlock()
	justUp := tmuxUp && (!seen || !prevUp)
	if justUp {
		if m.tryResurrectBegin(hostName) {
			m.log.Info().Str("host", hostName).Msg("tmux came up on host — auto-resurrecting detached sessions")
			go m.autoResurrectHost(hostName)
		} else {
			m.log.Info().Str("host", hostName).Msg("tmux came up on host — auto-resurrect already in flight, not starting another")
		}
	}

	// Reconcile DB rows against what tmux just reported. A session that's
	// missing from this discovery isn't immediately pruned: it must be missed
	// pruneMissThreshold consecutive times. This protects against:
	//   - tmux on the target briefly returning empty (server restart, SSH hiccup)
	//   - partial restores: e.g. resurrecting one zombie out of five — the other
	//     four would otherwise look "orphaned" on the very next discovery tick
	//     and get wiped along with their scrollback.
	// A session that DOES appear in this discovery has its miss counter reset.
	existing, err := m.db.GetSessions(hostName)
	if err != nil {
		m.log.Error().Err(err).Str("host", hostName).Msg("get sessions for pruning failed")
	} else if !tmuxUp {
		// Tmux server is down (explicit probe). All DB rows are protected so
		// that auto-resurrect on the next up-transition can bring them back at
		// their saved cwd. We also clear miss counters so rows mid-prune don't
		// get wiped the moment tmux returns.
		if len(existing) > 0 {
			m.log.Warn().
				Str("host", hostName).
				Int("existing", len(existing)).
				Msg("tmux server down on host — skipping prune, rows preserved for auto-resurrect")
			m.missMu.Lock()
			for _, s := range existing {
				delete(m.missCounts, s.ID)
			}
			m.missMu.Unlock()

			// Zero-click restore: attempt to bring the sessions back even from
			// the down state. EnsureSession's `tmux new-session` will spawn a
			// fresh tmux server on the target as a side effect, so this both
			// starts tmux AND populates it with the user's saved sessions in
			// one round-trip. Throttled to avoid SSH-storming targets where
			// tmux is meant to stay off (e.g., bad start_dir loops).
			m.tmuxStMu.Lock()
			last := m.lastResurrectAt[hostName]
			due := time.Since(last) >= downResurrectInterval
			if due {
				m.lastResurrectAt[hostName] = time.Now()
			}
			m.tmuxStMu.Unlock()
			if due && m.tryResurrectBegin(hostName) {
				m.log.Info().
					Str("host", hostName).
					Int("existing", len(existing)).
					Msg("tmux down with detached rows — attempting auto-resurrect (will start server)")
				go m.autoResurrectHost(hostName)
			}
		}
	} else if justUp {
		// Tmux just came back. Auto-resurrect is in flight asynchronously;
		// skip pruning this cycle so the recreated sessions aren't seen as
		// "missing" before they land.
		m.log.Info().
			Str("host", hostName).
			Int("existing", len(existing)).
			Msg("tmux just came up on host — skipping prune this cycle (auto-resurrect in progress)")
	} else if m.resurrectActive(hostName) {
		// Auto-resurrect from an earlier cycle is still recreating sessions for
		// this host. Suppress pruning entirely until it finishes — otherwise the
		// sessions it hasn't reached yet (and the control-mode discoveries its
		// own session-creates trigger) would drive their miss counts past the
		// threshold and delete them mid-restore.
		m.log.Info().
			Str("host", hostName).
			Int("existing", len(existing)).
			Msg("auto-resurrect still in flight — skipping prune this cycle")
	} else {
		m.missMu.Lock()
		for _, s := range existing {
			if _, live := sessions[s.Name]; live {
				if m.missCounts[s.ID] > 0 {
					delete(m.missCounts, s.ID)
				}
				continue
			}
			m.missCounts[s.ID]++
			if m.missCounts[s.ID] < pruneMissThreshold {
				m.log.Debug().
					Str("session", s.ID).
					Int("miss_count", m.missCounts[s.ID]).
					Int("threshold", pruneMissThreshold).
					Msg("session missing from discovery — holding before prune")
				continue
			}
			m.log.Info().Str("session", s.ID).Msg("pruning orphaned session from db (exceeded miss threshold)")
			if err := m.db.DeleteSession(s.ID); err != nil {
				m.log.Error().Err(err).Str("session", s.ID).Msg("prune orphaned session failed")
			}
			m.replay.Drop(s.ID)
			delete(m.missCounts, s.ID)
		}
		m.missMu.Unlock()
	}

	if m.onDiscovery != nil {
		m.onDiscovery(hostName)
	}
	return nil
}

// shellCommands are active-pane commands that mean "sitting at a prompt, nothing
// running" → idle (no activity dot).
var shellCommands = map[string]bool{
	"bash": true, "zsh": true, "sh": true, "fish": true, "dash": true, "ksh": true,
	"-bash": true, "-zsh": true, "-sh": true, "-fish": true, "tmux": true, "": true,
}

// ── Granular attention classification ──────────────────────────────────────
// When a session stops (enters "attention"), we read the tail of its pipe log and
// refine the signal into error / waiting / done via these DEFAULT patterns (tuned
// for Claude Code — heuristic and app-specific; the fragile part). Matched against
// the ANSI-stripped tail of the log.
var (
	granularAnsi  = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]`)
	granularError = regexp.MustCompile(`(?i)api error|rate limit|overloaded|usage limit|quota (?:exceeded|reached)|too many requests|\b(?:429|529)\b|connection error|network error|request (?:failed|timed out)|context deadline|blocked`)
	// Confirmation / selection prompts that mean "paused, needs a decision".
	// Claude Code first, then Codex and Antigravity — the earlier pattern set was
	// Claude-only, so a codex session sitting on "Allow Codex to run `…`" matched
	// nothing and fell through to "done": a green tick on a session that was in
	// fact blocked on the operator. Verified against the literal prompt strings in
	// the codex binary.
	granularWaiting = regexp.MustCompile(`(?i)do you want to|would you like|press enter to|waiting for (?:your|input)|\bconfirm\b|\(y/n\)|\[y/n\]|❯\s*\d|\b[123]\.\s+(?:yes|no|allow|deny|always)` +
		`|allow codex to run|allow .{0,20} to run|requires? (?:your )?(?:approval|permission)|awaiting (?:approval|your input)` +
		`|accept (?:this|these) change|apply (?:this|these) (?:patch|change)|approve (?:this|the) `)
	// POSITIVE evidence the agent is mid-task. Without this, "not obviously waiting"
	// was read as "finished".
	granularWorking = regexp.MustCompile(`(?i)esc to interrupt|ctrl\+c to (?:stop|interrupt)|\btokens used\b|thinking…|working…`)
	// POSITIVE evidence a turn genuinely ENDED: Claude Code's idle footer, or the
	// tail resting at a shell prompt (the agent exited).
	granularDone = regexp.MustCompile(`(?i)\? for shortcuts|shift\+tab to cycle|(?m)^\s*[\w.@~/-]*\s*[$#%❯]\s*$`)
)

// classifyGranular refines a stopped session's log tail into error/waiting/done.
// Only the RECENT lines are considered: matching the whole tail would flag a
// question that's ALREADY been answered (its text lingers up-screen while the
// answer's output appears below it). So we match against just the last few
// non-empty lines — enough to catch Claude's multi-line prompt box at the bottom,
// but not stale content higher up. (This is the refinement MC's _detect learned.)
func classifyGranular(tail string) string {
	clean := granularAnsi.ReplaceAllString(tail, "")
	var lines []string
	for _, l := range strings.Split(clean, "\n") {
		if s := strings.TrimSpace(l); s != "" {
			lines = append(lines, s)
		}
	}
	lastN := func(n int) string {
		if len(lines) < n {
			n = len(lines)
		}
		return strings.Join(lines[len(lines)-n:], "\n")
	}
	if granularError.MatchString(lastN(10)) {
		return "error"
	}
	if granularWaiting.MatchString(lastN(6)) {
		return "waiting"
	}
	if granularWorking.MatchString(lastN(4)) {
		return "working"
	}
	// "done" now needs POSITIVE evidence. It used to be the fallback, which meant
	// any agent whose prompts we do not recognise — every CLI but Claude Code —
	// was reported as finished the moment it stopped emitting output, including
	// while blocked on an approval. Unknown is "attention" ("stopped, may need
	// you"): honest, and it still surfaces in the sidebar instead of going green.
	if granularDone.MatchString(lastN(4)) {
		return "done"
	}
	return "attention"
}

// refineAttention reads the tail of a just-stopped session's pipe log, classifies
// it, and pushes the refined signal to the UI. Async so discovery isn't blocked.
func (m *Manager) refineAttention(hostName, sessionName, sessionID string) {
	data, _, _, err := m.GetPipedScrollbackFrom(hostName, sessionName, -4000)
	if err != nil || len(data) == 0 {
		return
	}
	refined := classifyGranular(string(data))
	m.activityMu.Lock()
	// Only apply if the session is still in the attention family (hasn't gone back
	// to working/idle in the meantime).
	switch m.activityBySession[sessionID] {
	case "attention", "waiting", "done", "error":
		m.activityBySession[sessionID] = refined
	}
	m.activityMu.Unlock()
	if m.onDiscovery != nil {
		m.onDiscovery(hostName) // re-broadcast so the dot updates
	}
}

// ActivityFor returns the live activity signal for a session ("working",
// "attention"/"waiting"/"done"/"error", or "" for idle/unknown). Merged into the
// broadcast session list.
func (m *Manager) ActivityFor(sessionID string) string {
	m.activityMu.RLock()
	defer m.activityMu.RUnlock()
	return m.activityBySession[sessionID]
}

// hookSignal is the authoritative await-state pushed by an agent's Notification
// hook: the human (or Zora) must answer Question before the agent proceeds.
type hookSignal struct {
	Kind     string // "permission" | "question"
	Question string
	At       time.Time
	Expires  time.Time
}

const signalTTL = 45 * time.Minute

// SetSignal records (or clears) the authoritative await signal for a session and
// reflects it immediately (no wait for the next discovery tick), then re-broadcasts.
// kind "done"/"" clears it; "permission"/"question" → activity "waiting".
func (m *Manager) SetSignal(sessionID, kind, question string) {
	m.activityMu.Lock()
	if kind == "done" || kind == "" {
		delete(m.signalBySession, sessionID)
		// fall back now; the next discovery reclassifies from real state.
		if a := m.activityBySession[sessionID]; a == "waiting" || a == "attention" {
			delete(m.activityBySession, sessionID)
		}
	} else {
		now := time.Now()
		m.signalBySession[sessionID] = &hookSignal{
			Kind: kind, Question: question, At: now, Expires: now.Add(signalTTL),
		}
		// "idle" (agent done, awaiting your next prompt) is a CALM indicator, not a
		// blocking alert — it maps to "attention" (a quiet diamond) and is NOT
		// escalated. A blocking "permission"/"question" prompt is "waiting" (loud
		// triangle) and drives Zora triage + Telegram.
		if kind == "idle" {
			m.activityBySession[sessionID] = "attention"
		} else {
			m.activityBySession[sessionID] = "waiting"
		}
	}
	m.activityMu.Unlock()
	if m.onDiscovery != nil {
		host, _, _ := strings.Cut(sessionID, ":")
		m.onDiscovery(host) // instant re-broadcast so the indicator updates now
	}
}

// SignalFor returns the pending question + kind + since for a waiting session
// (empty strings when there's no authoritative signal). Merged into the API/WS.
func (m *Manager) SignalFor(sessionID string) (question, kind string, since time.Time) {
	m.activityMu.RLock()
	defer m.activityMu.RUnlock()
	if s, ok := m.signalBySession[sessionID]; ok && time.Now().Before(s.Expires) {
		return s.Question, s.Kind, s.At
	}
	return "", "", time.Time{}
}

// SendKeys types text into a session's active pane (tmux send-keys), optionally
// pressing Enter. The close-the-loop side of the needs-you pipeline: a human's (or
// Zora's) answer/approval is injected into the waiting agent. Also clears the
// authoritative waiting signal — the agent is about to proceed.
func (m *Manager) SendKeys(sessionID, text string, enter bool) error {
	host, name, ok := strings.Cut(sessionID, ":")
	if !ok || host == "" || name == "" {
		return fmt.Errorf("bad session id %q", sessionID)
	}
	sess, err := m.pool.NewSession(host)
	if err != nil {
		return fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	cmd := fmt.Sprintf("tmux send-keys -t %s %s", exactPane(name), shellEscape(text))
	if enter {
		cmd += " Enter"
	}
	if err := sess.Run(cmd); err != nil {
		return err
	}
	m.SetSignal(sessionID, "done", "") // answered → clear waiting
	return nil
}

// StartDiscoveryLoop starts a periodic discovery goroutine
func (m *Manager) StartDiscoveryLoop(ctx context.Context, intervalSec int) {
	go func() {
		m.DiscoverAll(ctx)
		ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.DiscoverAll(ctx)
			}
		}
	}()
}

// Attach returns a Channel — one viewer's attachment to a tmux session (or a
// specific window). windowIndex < 0 means the session's current window; >= 0
// attaches to that specific window index (e.g. 0 = first window).
//
// Viewers of the same target SHARE one tmux client: the second and later callers
// are handed a new Channel bound to the existing backend instead of opening
// another SSH session. That is what stops two browser panes on one session from
// fighting over the tmux window size (the loser used to get a dot-filled pane).
func (m *Manager) Attach(hostName, sessionName string, windowIndex int, rows, cols uint16) (string, *Channel, error) {
	key := clientKey(hostName, sessionName, windowIndex)
	sessionID := fmt.Sprintf("%s:%s", hostName, sessionName)

	// Fast path: an existing backend for this exact target — just add a viewer.
	// Retried in a loop because the backend can be shutting down under us, in
	// which case addSub fails and we fall through to building a fresh one.
	m.mu.Lock()
	existing := m.clients[key]
	m.mu.Unlock()
	if existing != nil {
		ch := &Channel{
			ID:        "ch_" + uuid.New().String(),
			SessionID: sessionID,
			HostName:  hostName,
			Output:    make(chan OutputChunk, 256),
			Grid:      make(chan [2]uint16, 1),
			client:    existing,
			rows:      rows,
			cols:      cols,
		}
		if existing.addSub(ch) {
			m.mu.Lock()
			m.channels[ch.ID] = ch
			m.mu.Unlock()
			m.log.Info().Str("channel", ch.ID).Str("host", hostName).Str("session", sessionName).
				Int("viewers", existing.subCount()).Msg("attached (shared tmux client)")
			return ch.ID, ch, nil
		}
		// Backend died between the lookup and the join — drop the stale entry so
		// the fresh attach below can register in its place.
		m.mu.Lock()
		if m.clients[key] == existing {
			delete(m.clients, key)
		}
		m.mu.Unlock()
	}

	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", nil, fmt.Errorf("new ssh session: %w", err)
	}

	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return "", nil, fmt.Errorf("stdin pipe: %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	if err := sess.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		sess.Close()
		return "", nil, fmt.Errorf("request pty: %w", err)
	}

	outPipe, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return "", nil, fmt.Errorf("stdout pipe: %w", err)
	}

	stderrPipe, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return "", nil, fmt.Errorf("stderr pipe: %w", err)
	}

	var target string
	if windowIndex >= 0 {
		target = fmt.Sprintf("=%s:%d", sessionName, windowIndex)
	} else {
		target = "=" + sessionName
	}
	// While sigil is attached, turn off two tmux behaviours and restore them on
	// detach:
	//   - status bar: sigil shows the same info in its own bar.
	//   - mouse mode: sigil's web UI owns scrollback, so tmux must NOT capture the
	//     mouse wheel into copy-mode (the "orange row" that breaks the pane on a
	//     scroll-back gesture). With mouse off, tmux passes mouse events through,
	//     so real TUI apps (vim/less/claude) still get them and the web client
	//     routes wheel-over-shell to its own history. `set-option -u` on detach
	//     reverts to the user's global setting instead of forcing a value.
	//
	// Third: unpin the WINDOW size. `window-size` is a per-window option, and any
	// past `tmux resize-window` on that window latches it to `manual` FOREVER — the
	// window then keeps its old fixed geometry no matter what size a client attaches
	// at, and tmux paints the client's leftover area with `.` filler. (This is how
	// the a Linux host sessions ended up stuck at 120x40 inside a 122x59 pane after the
	// "resize to seed the pipe log" fix from the blank-sessions incident.) Forcing
	// `latest` for as long as sigil is attached makes the window track OUR pty size;
	// `-u` on detach unsets it back to the global default rather than restoring the
	// stuck `manual`, so an attach permanently heals a latched window.
	//
	// NOTE: `set-option -t` does NOT accept the `=exact` target prefix in tmux
	// 3.5a (it errors "no such session"), even though attach-session/has-session
	// do. So set-option uses the plain, shell-escaped session name (exact match is
	// tmux's first resolution step); only attach-session gets the `=` target.
	sopt := shellEscape(sessionName)
	// Window-option target: the specific window when one was requested, otherwise
	// the session's current window. Same no-`=` rule as above.
	wtarget := sessionName
	if windowIndex >= 0 {
		wtarget = fmt.Sprintf("%s:%d", sessionName, windowIndex)
	}
	wopt := shellEscape(wtarget)
	cmd := fmt.Sprintf(
		"tmux set-option -t %s status off 2>/dev/null; tmux set-option -t %s mouse off 2>/dev/null; "+
			"tmux set-option -w -t %s window-size latest 2>/dev/null; "+
			"tmux attach-session -t %s; "+
			"tmux set-option -t %s status on 2>/dev/null; tmux set-option -u -t %s mouse 2>/dev/null; "+
			"tmux set-option -uw -t %s window-size 2>/dev/null",
		sopt, sopt, wopt, shellEscape(target),
		sopt, sopt, wopt,
	)
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return "", nil, fmt.Errorf("start tmux: %w", err)
	}

	channelID := "ch_" + uuid.New().String()

	tc := &tmuxClient{
		id:        "cl_" + uuid.New().String(),
		key:       key,
		hostName:  hostName,
		sessName:  sessionName,
		sessionID: sessionID,
		sess:      sess,
		stdin:     stdin,
		subs:      make(map[*Channel]struct{}),
		rows:      rows,
		cols:      cols,
	}
	ch := &Channel{
		ID:        channelID,
		SessionID: sessionID,
		HostName:  hostName,
		Output:    make(chan OutputChunk, 256),
		Grid:      make(chan [2]uint16, 1),
		client:    tc,
		rows:      rows,
		cols:      cols,
	}
	tc.subs[ch] = struct{}{}

	// Register the backend. If another Attach for the same target won the race
	// while we were opening SSH, discard OUR session and join theirs — one tmux
	// client per target is the whole point, and a duplicate would immediately
	// start fighting over the window size again.
	m.mu.Lock()
	if winner := m.clients[key]; winner != nil {
		m.mu.Unlock()
		sess.Close()
		ch.client = winner
		if winner.addSub(ch) {
			m.mu.Lock()
			m.channels[channelID] = ch
			m.mu.Unlock()
			return channelID, ch, nil
		}
		return "", nil, fmt.Errorf("attach raced a closing channel for %s", sessionID)
	}
	m.clients[key] = tc
	m.channels[channelID] = ch
	m.mu.Unlock()

	// The newest backend becomes the session's replay feeder — its byte stream is
	// the one recorded for replay-then-live (an older backend for a different
	// window of the same session keeps relaying but stops recording).
	m.replay.ClaimFeeder(sessionID, tc.id)

	// Two reader goroutines (stdout + stderr) feed the SAME viewer fan-out. They
	// must NOT close the viewer queues independently: the original code closed
	// from the stdout reader while the stderr reader could still be mid-send,
	// which panics (send on closed channel) and takes down the daemon. Instead
	// both readers signal a WaitGroup and a single closer shuts the backend down
	// only after BOTH have exited — so no send can ever race the close.
	var readers sync.WaitGroup
	readers.Add(2)

	relay := func(seq uint64, data []byte) {
		// Offer the feeder stream to the trigger matcher (no-op unless triggers
		// exist and this is the feeder backend). Done before the relay send so a
		// slow/absent client drain can't delay matching.
		m.feedTriggers(sessionID, tc.id, data)
		tc.broadcast(OutputChunk{Data: data, Seq: seq})
	}

	// stdout reader. Every chunk is appended to the replay ring FIRST (the ring
	// is the authoritative recent stream — it keeps filling even when no WS
	// client drains its queue, e.g. during the post-disconnect grace window),
	// then fanned out to every viewer for live relay.
	go func() {
		defer readers.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := outPipe.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				relay(m.replay.Append(sessionID, tc.id, data), data)
			}
			if err != nil {
				return
			}
		}
	}()

	// stderr reader (merged into the same stream).
	go func() {
		defer readers.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				relay(m.replay.Append(sessionID, tc.id, data), data)
			}
			if err != nil {
				return
			}
		}
	}()

	// Closer: exactly one shutdown, after both readers are done. Closes EVERY
	// viewer's queue — they each surface it as channel.closed.
	go func() {
		readers.Wait()
		tc.shutdown()
	}()

	// Wait for session to finish
	go func() {
		waitErr := sess.Wait()
		tc.shutdown()

		m.replay.ReleaseFeeder(sessionID, tc.id)
		// Drop this session's partial-line buffer once no feeder owns it (a newer
		// backend that already claimed the slot keeps its buffer intact).
		if m.replay.IsFeeder(sessionID, "") {
			m.triggerFeed.forget(sessionID)
		}

		// Drop the backend and every viewer that was riding it.
		m.mu.Lock()
		if m.clients[key] == tc {
			delete(m.clients, key)
		}
		for id, c := range m.channels {
			if c.client == tc {
				delete(m.channels, id)
			}
		}
		m.mu.Unlock()

		// Log why the channel closed. waitErr is nil for a clean tmux
		// detach/exit and carries the SSH exit/transport error otherwise —
		// this is the only record of *why* a live pane dropped.
		m.log.Info().
			Str("channel", channelID).
			Str("host", hostName).
			Str("session", sessionName).
			AnErr("wait_err", waitErr).
			Msg("channel closed")

		if m.events != nil {
			select {
			case m.events <- sigil.Event{
				ID:        fmt.Sprintf("evt_%d", time.Now().UnixNano()),
				Type:      "channel.closed",
				Timestamp: time.Now(),
				Data: map[string]interface{}{
					"channel_id":   channelID,
					"session_id":   sessionID,
					"host_name":    hostName,
					"session_name": sessionName,
				},
			}:
			default:
			}
		}
	}()

	m.log.Info().Str("channel", channelID).Str("host", hostName).Str("session", sessionName).Msg("attached")

	// Start pipe-pane capture in background — idempotent, won't fire twice for the
	// same session within this process lifetime.
	go func() {
		if err := m.StartPipeCapture(hostName, sessionName); err != nil {
			m.log.Warn().Err(err).Str("host", hostName).Str("session", sessionName).Msg("pipe capture start failed")
		}
	}()

	return channelID, ch, nil
}

// Detach removes ONE viewer. The underlying tmux client is torn down only when
// the last viewer leaves; while others remain, the pty is merely resized (a
// departing small viewer lets the grid grow back for those still watching).
func (m *Manager) Detach(channelID string) error {
	m.mu.Lock()
	ch, ok := m.channels[channelID]
	if ok {
		delete(m.channels, channelID)
	}
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("channel %q not found", channelID)
	}

	ch.closeOutput()

	tc := ch.client
	if tc == nil {
		return nil
	}
	if !tc.removeSub(ch) {
		// Other viewers still watching — keep the tmux client alive.
		return nil
	}

	m.mu.Lock()
	if m.clients[tc.key] == tc {
		delete(m.clients, tc.key)
	}
	m.mu.Unlock()

	tc.mu.Lock()
	tc.closed = true
	tc.mu.Unlock()
	return tc.sess.Close()
}

// DetachAfter detaches a channel after a grace period if it is still open.
// Used when a WS client vanishes without an explicit detach (tab close,
// network drop): the lingering "ghost" channel keeps draining pane output into
// the replay ring so a quickly-returning client replays the gap instead of
// losing it. The ghost is just one more viewer on the shared tmux client, so it
// costs no extra SSH session or tmux client. It is detached unconditionally when
// the grace expires — a returning client gets a fresh viewer on the same backend.
//
// The channel is marked a ghost IMMEDIATELY (not when the grace expires) and the
// grid re-applied at once, so a departed viewer stops constraining the pty the
// moment its socket drops. Previously its last requested size counted for the
// whole grace: closing a small tab left every remaining taller viewer with dead,
// never-repainted rows for three minutes.
func (m *Manager) DetachAfter(channelID string, grace time.Duration) {
	if ch, ok := m.GetChannel(channelID); ok && ch.client != nil {
		tc := ch.client
		tc.mu.Lock()
		ch.ghost = true
		tc.applySizeLocked()
		tc.mu.Unlock()
	}
	go func() {
		time.Sleep(grace)
		if _, ok := m.GetChannel(channelID); ok {
			m.log.Info().Str("channel", channelID).Dur("grace", grace).
				Msg("detaching ghost channel after grace period")
			_ = m.Detach(channelID)
		}
	}()
}

// SendInput sends input bytes to the shared tmux client's stdin. Any viewer may
// type; they are all driving the same tmux client, exactly as two people sharing
// a tmux session do.
func (m *Manager) SendInput(channelID string, data []byte) error {
	ch, ok := m.GetChannel(channelID)
	if !ok {
		return fmt.Errorf("channel %q not found", channelID)
	}
	tc := ch.client
	if tc == nil {
		return fmt.Errorf("channel %q has no backend", channelID)
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if tc.closed {
		return fmt.Errorf("channel %q is closed", channelID)
	}
	_, err := tc.stdin.Write(data)
	return err
}

// Resize records THIS viewer's requested grid and re-applies the effective size
// (the smallest request across live viewers) to the shared pty. A viewer asking
// for a bigger grid than a co-viewer can draw no longer wins — see
// tmuxClient.applySizeLocked.
func (m *Manager) Resize(channelID string, rows, cols uint16) error {
	ch, ok := m.GetChannel(channelID)
	if !ok {
		return fmt.Errorf("channel %q not found", channelID)
	}
	tc := ch.client
	if tc == nil {
		return fmt.Errorf("channel %q has no backend", channelID)
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if tc.closed {
		return fmt.Errorf("channel %q is closed", channelID)
	}
	ch.rows, ch.cols = rows, cols
	tc.applySizeLocked()
	return nil
}

// EffectiveGrid reports the geometry the shared pty is ACTUALLY at for this
// channel's backend — which is not necessarily what this viewer requested, since
// the pty is sized to the smallest live viewer. Zero,zero when unknown.
func (m *Manager) EffectiveGrid(channelID string) (rows, cols uint16) {
	ch, ok := m.GetChannel(channelID)
	if !ok || ch.client == nil {
		return 0, 0
	}
	tc := ch.client
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return tc.rows, tc.cols
}

// subCount reports how many viewers share this tmux client.
func (tc *tmuxClient) subCount() int {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return len(tc.subs)
}

// tryResurrectBegin marks that an auto-resurrect goroutine is starting for a
// host, unless one is already in flight — two concurrent passes (the down-state
// retry and the down→up edge fire within the same second) race their
// EnsureSession probes and spray "duplicate session" errors, so only the first
// wins. Must be called synchronously *before* `go m.autoResurrectHost(...)` so
// the guard is set before any subsequent discovery tick can race ahead and
// prune. Returns false when a pass is already running for the host.
func (m *Manager) tryResurrectBegin(hostName string) bool {
	m.tmuxStMu.Lock()
	defer m.tmuxStMu.Unlock()
	if m.resurrectInFlight[hostName] > 0 {
		return false
	}
	m.resurrectInFlight[hostName]++
	return true
}

// resurrectDone is deferred inside autoResurrectHost to clear the guard once the
// restore loop has finished (or bailed). A counter, not a bool, because two
// resurrect passes (the down→up edge and a down-state retry) can overlap.
func (m *Manager) resurrectDone(hostName string) {
	m.tmuxStMu.Lock()
	if m.resurrectInFlight[hostName] > 0 {
		m.resurrectInFlight[hostName]--
	}
	m.tmuxStMu.Unlock()
}

// resurrectActive reports whether any auto-resurrect is in flight for the host.
func (m *Manager) resurrectActive(hostName string) bool {
	m.tmuxStMu.Lock()
	defer m.tmuxStMu.Unlock()
	return m.resurrectInFlight[hostName] > 0
}

// autoResurrectHost is invoked when discovery detects that the tmux server on
// hostName has transitioned from down → up. It calls EnsureSession for every
// detached DB row belonging to the host, recreating any session not already
// alive at its last-known start_dir / start_cmd. Each call is idempotent, so
// rows whose live tmux session is already running are no-ops.
//
// Failures (e.g. a stored start_dir that no longer exists on the target) are
// logged but do not abort the loop — one bad row should not block restoring
// the others.
func (m *Manager) autoResurrectHost(hostName string) {
	defer m.resurrectDone(hostName)
	rows, err := m.db.GetSessions(hostName)
	if err != nil {
		m.log.Error().Err(err).Str("host", hostName).Msg("auto-resurrect: get sessions failed")
		return
	}
	var revived, alive, failed int
	// Don't trust the row's Status field — when tmux dies the in-DB status
	// stays "active" until discovery updates it, so skipping based on Status
	// would miss exactly the rows that need restoring. EnsureSession's probe
	// is the source of truth; one extra SSH round-trip per row is cheap and
	// only runs on transitions / throttled down-state retries.
	for _, s := range rows {
		created, err := m.EnsureSession(hostName, s.Name, s.StartDir, s.StartCmd)
		if err != nil {
			failed++
			m.log.Warn().Err(err).Str("session", s.ID).Str("cwd", s.StartDir).
				Msg("auto-resurrect: ensure session failed")
			continue
		}
		if created {
			revived++
			m.log.Info().Str("session", s.ID).Str("cwd", s.StartDir).Msg("auto-resurrected session")
		} else {
			alive++
		}
	}
	m.log.Info().
		Str("host", hostName).
		Int("revived", revived).
		Int("already_alive", alive).
		Int("failed", failed).
		Msg("auto-resurrect host complete")
}

// EnsureSession creates a tmux session on a host if and only if no session
// with that name is already alive. Used by the resurrect endpoint so that
// repeated "hop back in" clicks are safe — a live session is left as-is.
// Returns (created=true) when a new session was actually created.
func (m *Manager) EnsureSession(hostName, name, startDir, startCmd string) (created bool, err error) {
	alive, err := m.SessionExists(hostName, name)
	if err != nil {
		return false, err
	}
	if alive {
		return false, nil
	}
	if err := m.CreateSession(hostName, name, startDir, startCmd); err != nil {
		return false, err
	}
	return true, nil
}

// SessionExists reports whether a tmux session with exactly this name is
// alive on the host right now (exact `=` target — no prefix matching).
func (m *Manager) SessionExists(hostName, name string) (bool, error) {
	probe, err := m.pool.NewSession(hostName)
	if err != nil {
		return false, fmt.Errorf("new ssh session: %w", err)
	}
	defer probe.Close()
	// has-session exits 0 if the session exists, 1 otherwise.
	if perr := probe.Run(fmt.Sprintf("tmux has-session -t %s 2>/dev/null", exactSession(name))); perr == nil {
		return true, nil
	}
	return false, nil
}

// CreateSession creates a new detached tmux session on a host.
// If startDir is non-empty the session starts in that directory (-c flag).
// If startCmd is non-empty it is sent to the first pane after creation.
func (m *Manager) CreateSession(hostName, name, startDir, startCmd string) error {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return fmt.Errorf("new ssh session: %w", err)
	}
	defer sess.Close()

	cmd := fmt.Sprintf("tmux new-session -d -s %s", shellEscape(name))
	if startDir != "" {
		cmd += " -c " + shellEscape(startDir)
	}
	if err := sess.Run(cmd); err != nil {
		return err
	}

	if startCmd != "" {
		// Send the start command to the first pane of the new session
		sendCmd := fmt.Sprintf("tmux send-keys -t %s %s Enter", exactPane(name), shellEscape(startCmd))
		sess2, err := m.pool.NewSession(hostName)
		if err != nil {
			return fmt.Errorf("send-keys ssh session: %w", err)
		}
		defer sess2.Close()
		_ = sess2.Run(sendCmd)
	}

	// Start durable output capture immediately — don't wait for the next
	// discovery tick, so the log file exists from the session's first output.
	go func() {
		if err := m.StartPipeCapture(hostName, name); err != nil {
			m.log.Warn().Err(err).Str("host", hostName).Str("session", name).
				Msg("pipe capture start failed (create)")
		}
	}()

	return nil
}

// DestroySession kills a tmux session on a host
func (m *Manager) DestroySession(hostName, sessionName string) error {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return fmt.Errorf("new ssh session: %w", err)
	}
	defer sess.Close()

	cmd := fmt.Sprintf("tmux kill-session -t %s", exactSession(sessionName))
	err = sess.Run(cmd)

	// Clean up pipe log + replay ring regardless of kill result (best effort)
	go m.StopPipeCapture(hostName, sessionName)
	m.replay.Drop(hostName + ":" + sessionName)

	return err
}

// RenameSession renames a tmux session on a host
func (m *Manager) RenameSession(hostName, oldName, newName string) error {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return fmt.Errorf("new ssh session: %w", err)
	}
	defer sess.Close()

	cmd := fmt.Sprintf("tmux rename-session -t %s %s", exactSession(oldName), shellEscape(newName))
	return sess.Run(cmd)
}

// CapturePane returns the rendered scrollback history for a tmux session as a
// plain string with SGR (color/style) escape sequences only — no cursor
// positioning codes. This is the correct input for ANSI-to-HTML converters.
//
// It also reports whether the pane is currently in the ALTERNATE screen
// (#{alternate_on}) — i.e. a full-screen TUI like vim/less/claude is active. The
// web client uses this to decide whether the live tail may be reflowed as
// per-client soft-wrapped logical lines (shell prompt, alternate off) or must be
// shown on the shared fixed-width grid (TUI, alternate on). altOn defaults to
// TRUE on any ambiguity so we never reflow — and thus never mangle — a TUI.
//
// captureHistoryLines bounds how many scrollback lines a capture returns to the
// client — i.e. the working set the browser tab holds in memory. Generous enough
// to scroll back meaningfully, small enough that a long chatty session can't OOM
// the tab. The durable pipe log keeps the full history for deep recall.
const captureHistoryLines = 8000

// A capture can fail in two very different ways, and callers need to tell them
// apart: Mission Control polls /capture for every registered session on a loop,
// so "the session is GONE" and "the session is ALIVE, I just couldn't read it
// this instant" must not collapse into one opaque error. They used to, and a
// wedged pipe-pane on a Linux host answered a blanket 500 — which (until the client
// was hardened) could falsely mark a live worker failed. CapturePane therefore
// wraps every failure in one of these sentinels; see writeCaptureResult in
// internal/api for how they map onto 404 / 200-unavailable / 500.
var (
	// ErrSessionGone reports that tmux itself says the session — or the whole
	// tmux server — no longer exists on the host. It is not coming back; a
	// poller should stop asking.
	ErrSessionGone = errors.New("tmux session gone")

	// ErrCaptureUnavailable reports that the session is alive as far as we know
	// but its pane could not be read this instant: a transient ssh hiccup, a
	// host briefly unreachable, or a pipe-pane that is not seeded yet / wedged.
	// Retrying on the next poll is expected to work.
	ErrCaptureUnavailable = errors.New("pane capture unavailable")
)

// tmux's wording for "that session isn't here" varies with the tmux version and
// with whether the session or the whole server is missing. Matched
// case-insensitively against the status line only — never against pane text.
var sessionGoneMarkers = []string{
	"no server",          // "no server running on /tmp/tmux-1000/default"
	"can't find session", // tmux 3.x
	"session not found",
	"no such session", // older tmux / some subcommands
	"lost server",
}

// tmux capture-pane renders the terminal internally, so what you get is the
// actual visible history, not raw PTY bytes (which contain cursor movement,
// screen erase, etc. that no browser converter can interpret correctly).
//
// On failure the returned error always wraps ErrSessionGone or
// ErrCaptureUnavailable.
func (m *Manager) CapturePane(hostName, sessionName string) (text string, altOn bool, err error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		// Couldn't even reach the host — says nothing about the session itself.
		return "", true, fmt.Errorf("%w: new ssh session: %v", ErrCaptureUnavailable, err)
	}
	defer sess.Close()

	// One round-trip: print #{alternate_on} as the FIRST line, then the capture.
	//   -p  print to stdout
	//   -e  include SGR color/style escape sequences (but NOT cursor positioning)
	//   -J  join wrapped lines into LOGICAL lines: a shell line that tmux wrapped
	//       at the pane width comes back as one line, not several. This is what
	//       lets the web UI reflow scrollback to any viewport and copy without a
	//       spurious newline at every visual wrap. (TUI apps that write real
	//       newlines are unaffected — those are genuine line breaks.)
	//   -S -N start N lines back from the top of the screen — a BOUNDED window, not
	//         the whole 50k-line history. The client rebuilds its in-memory
	//         scrollback from this every capture, so an unbounded window let a
	//         long-lived, chatty session grow the browser tab until it OOM'd.
	//         The full history still lives in the durable pipe log for deep recall.
	//   -t  target session (first pane, pane 0 implied)
	//
	// display-message keeps its stderr (`2>&1`, clipped to one line) so a missing
	// session arrives as tmux's own message on the status line we already parse —
	// ssh.Session.Output only hands back stdout, so this is how the diagnosis
	// makes it home. capture-pane still discards stderr: nothing may leak into
	// the pane text.
	pane := exactPane(sessionName)
	cmd := fmt.Sprintf("tmux display-message -p -t %s '#{alternate_on}' 2>&1 | head -1; tmux capture-pane -peJ -S -%d -t %s 2>/dev/null; true", pane, captureHistoryLines, pane)
	out, err := sshpool.OutputWithTimeout(sess, cmd, sshpool.DefaultExecTimeout)
	if err != nil {
		// Transport-level: the command never completed. The session may well be fine.
		return "", true, fmt.Errorf("%w: tmux capture-pane: %v", ErrCaptureUnavailable, err)
	}
	return parseCaptureOutput(string(out))
}

// parseCaptureOutput splits the single-round-trip capture output into its
// leading #{alternate_on} status line and the pane text below it, classifying
// the status line when it carries a tmux error message instead of the flag.
//
// Only an explicit "0" enables soft-wrap; anything else keeps altOn=true so we
// never reflow — and thus never mangle — a TUI.
func parseCaptureOutput(out string) (text string, altOn bool, err error) {
	nl := strings.IndexByte(out, '\n')
	if nl < 0 {
		// Not even a status line: the remote command ran but produced nothing
		// usable (wedged pane, truncated output). Alive-but-unreadable, not gone.
		return "", true, fmt.Errorf("%w: empty capture output", ErrCaptureUnavailable)
	}

	status := strings.TrimSpace(out[:nl])
	switch status {
	case "0":
		return out[nl+1:], false, nil
	case "1":
		return out[nl+1:], true, nil
	}

	// Not the flag, so it's tmux (or the remote shell) complaining.
	low := strings.ToLower(status)
	for _, marker := range sessionGoneMarkers {
		if strings.Contains(low, marker) {
			return "", true, fmt.Errorf("%w: %s", ErrSessionGone, status)
		}
	}
	return "", true, fmt.Errorf("%w: %s", ErrCaptureUnavailable, status)
}

// GetChannel returns a channel by ID
func (m *Manager) GetChannel(id string) (*Channel, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ch, ok := m.channels[id]
	return ch, ok
}

// shellEscape wraps a string in single quotes for safe shell use
// ── Pipe-pane capture ─────────────────────────────────────────────────────────

// pipeLogShellPath returns the remote log path in a form that expands on the
// TARGET host: `"$HOME/.local/share/sigil/logs/<safe>.log"` (double-quoted, so
// it can be embedded directly into a remote shell command). The filename part
// is sanitised to [A-Za-z0-9_-] so no further escaping is needed.
func pipeLogShellPath(sessionName string) string {
	return `"$HOME/.local/share/sigil/logs/` + sigil.SafeFileName(sessionName) + `.log"`
}

// legacyPipeLogShellPath is the pre-durable-logs location (/tmp, typically
// tmpfs). StartPipeCapture migrates any existing legacy log into the new
// durable file so history isn't lost on upgrade.
func legacyPipeLogShellPath(hostName, sessionName string) string {
	return fmt.Sprintf("/tmp/sigil-pipe-%s-%s.log",
		sigil.SafeFileName(hostName), sigil.SafeFileName(sessionName))
}

// isPiped reports whether pipe capture has already been established for the
// session within this process lifetime (cheap check used by discovery to
// avoid spawning a goroutine per session per tick).
func (m *Manager) isPiped(hostName, sessionName string) bool {
	m.pipedMu.Lock()
	defer m.pipedMu.Unlock()
	return m.pipedSessions[hostName+":"+sessionName]
}

// StartPipeCapture enables tmux pipe-pane for a session, appending clean SGR
// terminal output to a durable log file on the remote host
// (~/.local/share/sigil/logs/<session>.log — advertised as Session.LogPath and
// readable back through the /files endpoint). It also bumps the tmux
// history-limit so tmux capture-pane (raw mode) can reach further back too.
//
// Idempotent per process lifetime via the pipedSessions set. Across restarts
// it is also safe: the command below first closes any existing pipe
// unconditionally (`pipe-pane` with no command), then opens ours with -o —
// per tmux semantics -o only opens when no pipe exists, so the stop+start
// pair always converges on exactly one pipe writing to our path.
func (m *Manager) StartPipeCapture(hostName, sessionName string) error {
	id := hostName + ":" + sessionName

	m.pipedMu.Lock()
	if m.pipedSessions[id] {
		m.pipedMu.Unlock()
		return nil
	}
	m.pipedSessions[id] = true
	m.pipedMu.Unlock()

	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		m.pipedMu.Lock()
		delete(m.pipedSessions, id)
		m.pipedMu.Unlock()
		return fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	logPath := pipeLogShellPath(sessionName)
	legacyPath := legacyPipeLogShellPath(hostName, sessionName)

	// Run everything in a single SSH session (a session can only execute one
	// command). The sequence:
	//   1. Ensure the durable log dir exists
	//   2. Migrate any legacy /tmp log into the durable file (one-time)
	//   3. Boost history-limit so raw capture-pane also reaches further back
	//   4. Stop any stale pipe-pane from a previous sigil process
	//   5. Start pipe-pane, appending SGR output to the log file. The command
	//      string is single-quoted so $HOME expands on the tmux server's
	//      shell, not here.
	// -o captures output only; keystrokes are echoed in the output stream anyway.
	cmd := fmt.Sprintf(
		`mkdir -p "$HOME/.local/share/sigil/logs" 2>/dev/null; `+
			`if [ -f %[1]s ]; then cat %[1]s >> %[2]s 2>/dev/null && rm -f %[1]s; fi; `+
			"tmux set-option -t %[3]s history-limit 50000 2>/dev/null; "+
			"tmux pipe-pane -t %[4]s 2>/dev/null; "+
			"tmux pipe-pane -o -t %[4]s 'cat >> %[5]s' 2>/dev/null; true",
		legacyPath, logPath,
		exactSession(sessionName), exactPane(sessionName),
		// Inside the single-quoted pipe-pane command the double-quoted
		// $HOME form is passed through verbatim and expanded by the tmux
		// server's shell.
		logPath)
	if err := sess.Run(cmd); err != nil {
		m.pipedMu.Lock()
		delete(m.pipedSessions, id)
		m.pipedMu.Unlock()
		return fmt.Errorf("pipe-pane start: %w", err)
	}

	m.log.Debug().Str("host", hostName).Str("session", sessionName).
		Str("log", sigil.SessionLogPath(sessionName)).Msg("pipe capture started")
	return nil
}

// StopPipeCapture stops pipe-pane for a session and removes its log file
// (current and legacy locations). Called on session destroy; safe to call
// even if capture was never started.
func (m *Manager) StopPipeCapture(hostName, sessionName string) {
	id := hostName + ":" + sessionName
	m.pipedMu.Lock()
	delete(m.pipedSessions, id)
	m.pipedMu.Unlock()

	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return
	}
	defer sess.Close()

	_ = sess.Run(fmt.Sprintf("tmux pipe-pane -t %s 2>/dev/null; rm -f %s %s 2>/dev/null; true",
		exactPane(sessionName), pipeLogShellPath(sessionName),
		legacyPipeLogShellPath(hostName, sessionName)))
}

// pipeLogMaxBytes caps the on-disk size of a per-session pipe-pane log file.
// Keep the most recent N bytes; older scrollback is already persisted into
// sigil.db via the scrollback engine when a client is attached.
const pipeLogMaxBytes = 50 * 1024 * 1024 // 50 MiB

// TrimPipeLogs ensures every active pipe-pane log on every remote host stays
// under pipeLogMaxBytes. Truncation preserves the file inode (the pipe-pane
// `cat >> log` writer holds it open in O_APPEND), keeps the tail (most recent
// scrollback), and is best-effort: any error is logged at debug only.
func (m *Manager) TrimPipeLogs() {
	m.pipedMu.Lock()
	type pair struct{ host, session string }
	pairs := make([]pair, 0, len(m.pipedSessions))
	for id := range m.pipedSessions {
		idx := strings.IndexByte(id, ':')
		if idx <= 0 {
			continue
		}
		pairs = append(pairs, pair{id[:idx], id[idx+1:]})
	}
	m.pipedMu.Unlock()

	for _, p := range pairs {
		go m.trimOnePipeLog(p.host, p.session)
	}
}

// trimOnePipeLog runs the truncation for a single host/session pair.
// Race window: writes that arrive between `tail -c` and the truncating
// `cat tmp > $f` are lost (kilobytes at most). That's acceptable because the
// alternative — letting the file grow unbounded — destabilises the host.
func (m *Manager) trimOnePipeLog(hostName, sessionName string) {
	logPath := pipeLogShellPath(sessionName)
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return
	}
	defer sess.Close()

	// Truncate-in-place. `cat $tmp > $f` opens $f with O_TRUNC and writes the
	// kept tail. The pipe-pane writer's O_APPEND fd survives — subsequent
	// appends land at the new EOF of the same inode.
	cmd := fmt.Sprintf(
		`f=%s; lim=%d; sz=$(stat -c %%s "$f" 2>/dev/null || echo 0); `+
			`if [ "$sz" -gt "$lim" ]; then `+
			`tmp=$(mktemp "${f}.trim.XXXXXX") && `+
			`tail -c "$lim" "$f" > "$tmp" && `+
			`cat "$tmp" > "$f"; `+
			`rm -f "$tmp"; `+
			`fi; true`,
		logPath, pipeLogMaxBytes)
	if err := sess.Run(cmd); err != nil {
		m.log.Debug().Err(err).Str("host", hostName).Str("session", sessionName).Msg("pipe log trim failed")
	}
}

// StartPipeLogTrimLoop runs TrimPipeLogs every intervalSec seconds until ctx
// is cancelled. Default 60s if intervalSec <= 0.
func (m *Manager) StartPipeLogTrimLoop(ctx context.Context, intervalSec int) {
	if intervalSec <= 0 {
		intervalSec = 60
	}
	go func() {
		t := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.TrimPipeLogs()
			}
		}
	}()
}

// GetPipedScrollback reads the pipe-pane log from the remote host and returns
// it as a string.  The content contains only SGR colour codes (no cursor
// positioning) and is safe to pass directly to ansi-to-html.
func (m *Manager) GetPipedScrollback(hostName, sessionName string) (string, error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	// cat returns empty string if the file doesn't exist yet — not an error.
	// Fall back to the legacy /tmp location for sessions whose capture hasn't
	// been (re)started since the durable-log upgrade.
	out, err := sess.Output(fmt.Sprintf("cat %s 2>/dev/null || cat %s 2>/dev/null || true",
		pipeLogShellPath(sessionName), legacyPipeLogShellPath(hostName, sessionName)))
	if err != nil {
		return "", fmt.Errorf("read pipe log: %w", err)
	}
	return string(out), nil
}

// GetPipedScrollbackFrom reads the pipe-pane log from byte `offset` to EOF,
// returning ONLY the new bytes plus the next offset. This is the incremental
// source that feeds the web client's offscreen-terminal scrollback tap: per-poll
// cost is O(new bytes), not O(whole buffer) like capture-pane. If the log has
// shrunk below `offset` (rotated / session cleared), it resets to reading from 0
// and reports reset=true so the client can re-seed its buffer.
//
// The remote command prints a "<size> <effective_offset>\n" header line, then
// the raw bytes from effective_offset to EOF. Raw pane bytes are binary (escape
// sequences), so the caller base64-encodes them for transport.
func (m *Manager) GetPipedScrollbackFrom(hostName, sessionName string, offset int64) (data []byte, nextOffset int64, reset bool, err error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return nil, offset, false, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	// A NEGATIVE offset means "seed from the last N bytes" (bounded cold start so
	// a huge pipe log can't freeze the client replay). Positive = read from that
	// absolute byte. If the log shrank below a positive offset (rotation), reset
	// to 0. The header line reports "<size> <effective_offset>".
	cmd := fmt.Sprintf(
		`f=%s; [ -f "$f" ] || f=%s; sz=$(wc -c < "$f" 2>/dev/null || echo 0); off=%d; `+
			`if [ "$off" -lt 0 ]; then off=$(( sz + off )); [ "$off" -lt 0 ] && off=0; fi; `+
			`[ "$sz" -lt "$off" ] && off=0; printf '%%s %%s\n' "$sz" "$off"; `+
			`tail -c +$((off+1)) "$f" 2>/dev/null || true`,
		pipeLogShellPath(sessionName), legacyPipeLogShellPath(hostName, sessionName), offset)
	out, err := sess.Output(cmd)
	if err != nil {
		return nil, offset, false, fmt.Errorf("read pipe log: %w", err)
	}
	nl := bytes.IndexByte(out, '\n')
	if nl < 0 {
		return nil, offset, false, nil
	}
	var size, effOff int64
	fmt.Sscanf(string(out[:nl]), "%d %d", &size, &effOff)
	body := out[nl+1:]
	return body, effOff + int64(len(body)), effOff == 0 && offset > 0, nil
}

func shellEscape(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// expandTildeSh returns a POSIX-sh fragment that assigns the given path to $_P
// and expands a leading ~ WITHOUT `eval`. The old `eval echo <escaped>` pattern
// was a command-injection hole: `eval` re-parses the string with the quotes
// stripped, so a path like `$(rm -rf ~)` or `; reboot` executed on the target.
// Here the path is a single-quoted literal that is never re-parsed, and ~ is
// expanded via `case` (glob expansion is intentionally dropped — a security
// win, not a loss, for a file browser). The returned fragment leaves the result
// in $_P for the caller to use, quoted, as "$_P".
//
// The escaped path is embedded as a Sprintf arg so a literal '%' in the path is
// data, never a format directive; callers MUST concatenate this fragment as a
// plain string (not as a format string) when appending their own suffix.
func expandTildeSh(path string) string {
	return fmt.Sprintf(`_P=%s; case "$_P" in "~") _P="$HOME";; "~/"*) _P="$HOME/${_P#"~/"}";; esac`, shellEscape(path))
}

// exactSession returns a shell-escaped tmux target-session that matches the
// session name exactly. A bare name is PREFIX-matched by tmux — `has-session
// -t dodecki` happily matches `dodecki-logs` — which made EnsureSession treat
// a sibling session as "already alive" and let discovery prune the real row.
func exactSession(name string) string {
	return shellEscape("=" + name)
}

// exactPane returns a shell-escaped tmux target for pane-scoped commands
// (send-keys, capture-pane, pipe-pane). Pane-target resolution only honours
// the '=' exact marker when the session part is delimited, hence the trailing
// ':' (selects the session's active window/pane, same as the bare-name form).
func exactPane(name string) string {
	return shellEscape("=" + name + ":")
}

// resumeCmdForPaneCommand maps the active pane's foreground command to the
// command that should be replayed when the session is resurrected. The point is
// to bring back the running tool's state, not a bare shell. Today only Claude
// Code is handled: `claude --continue` resumes the most recent conversation in
// the session's cwd, which — after a crash/OOM — is exactly the conversation
// that died (nothing newer ran there). Returns "" for anything we don't resume,
// which leaves the session resurrecting as a plain shell (prior behaviour).
//
// The native claude binary reports a foreground command of "claude"; we also
// accept a "claude"-suffixed path defensively in case a wrapper is in front.
func resumeCmdForPaneCommand(paneCmd string) string {
	c := strings.TrimSpace(paneCmd)
	if c == "claude" || strings.HasSuffix(c, "/claude") {
		// --dangerously-skip-permissions: a resurrected session has nobody at
		// the keyboard to answer permission prompts, so a plain --continue
		// just sits blocked until a human attaches. These are the operator's
		// own long-running sessions on trusted hosts — skip the prompts.
		return "claude --continue --dangerously-skip-permissions"
	}
	return ""
}
