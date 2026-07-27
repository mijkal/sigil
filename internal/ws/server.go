package ws

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"sigil.dev/sigil/internal/config"
	"sigil.dev/sigil/internal/db"
	"sigil.dev/sigil/internal/events"
	"sigil.dev/sigil/internal/scrollback"
	"sigil.dev/sigil/internal/session"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// Client represents a connected WebSocket client
type Client struct {
	ID         string
	conn       *websocket.Conn
	authed     bool
	binary     atomic.Bool // client wants binary channel.output/input frames (live-togglable)
	subscribes map[string]bool
	channels   map[string]bool        // channel_id -> subscribed
	pause      map[string]*pauseState // channel_id -> flow-control state
	send       chan outFrame
	mu         sync.Mutex
}

// outFrame is one queued write: a JSON control/output message, OR a raw binary
// frame (channel.output for binary-capable clients).
type outFrame struct {
	msg  *Message
	data []byte
}

// pauseState is per-attach flow control. `paused` is checked by the output pump;
// `resume` wakes it when the client drops below its low watermark.
type pauseState struct {
	paused atomic.Bool
	resume chan struct{}
}

// getPause returns the pause state for a channel (nil if none/detached).
func (c *Client) getPause(channelID string) *pauseState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pause[channelID]
}

// Server manages WebSocket connections
type Server struct {
	clients    map[string]*Client
	mu         sync.RWMutex
	sessions   *session.Manager
	scrollback *scrollback.Engine
	eventBus   *events.Bus
	db         *db.DB
	cfg        *config.Config
	log        zerolog.Logger

	// Highest replay seq already persisted to scrollback, per session. Viewers of
	// one session each run their own relay goroutine and all see the same chunk,
	// so without this the pane text is stored once PER VIEWER.
	sbSeqMu sync.Mutex
	sbSeq   map[string]uint64
}

// recordScrollback persists a chunk to the session's scrollback exactly once,
// however many viewers relayed it. Chunks with no replay seq (Seq == 0 — not
// recorded in the ring) can't be deduped, so they're written as they arrive.
func (s *Server) recordScrollback(sessionID string, chunk session.OutputChunk) {
	if chunk.Seq != 0 {
		s.sbSeqMu.Lock()
		if chunk.Seq <= s.sbSeq[sessionID] {
			s.sbSeqMu.Unlock()
			return
		}
		s.sbSeq[sessionID] = chunk.Seq
		s.sbSeqMu.Unlock()
	}
	s.scrollback.Write(sessionID, chunk.Data)
}

// New creates a new WebSocket server
func New(
	sess *session.Manager,
	sb *scrollback.Engine,
	bus *events.Bus,
	d *db.DB,
	cfg *config.Config,
) *Server {
	srv := &Server{
		clients:    make(map[string]*Client),
		sbSeq:      make(map[string]uint64),
		sessions:   sess,
		scrollback: sb,
		eventBus:   bus,
		db:         d,
		cfg:        cfg,
		log:        zerolog.Nop(),
	}

	// Subscribe to events
	bus.Subscribe(func(e sigil.Event) {
		srv.broadcastEvent(e)
	})

	return srv
}

// SetLogger sets the logger
func (s *Server) SetLogger(log zerolog.Logger) {
	s.log = log
}

// ServeHTTP upgrades the connection to WebSocket and handles messages
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Origin policy: if the operator configured allowed_origins, enforce it
	// (rejects cross-site WS connection attempts). Otherwise stay permissive —
	// enforcing same-origin by default would break the reverse-proxied web
	// client, whose Origin and Host differ. A bearer token is still required
	// either way, so the permissive default is not an auth bypass.
	opts := &websocket.AcceptOptions{
		Subprotocols: []string{"sigil.v1"}, // must echo client's requested subprotocol
	}
	if origins := s.cfg.Hub.AllowedOrigins; len(origins) > 0 {
		opts.OriginPatterns = origins
	} else {
		opts.InsecureSkipVerify = true
	}

	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		s.log.Error().Err(err).Msg("ws accept failed")
		return
	}

	conn.SetReadLimit(1 * 1024 * 1024) // 1MB

	clientID := "ws_" + uuid.New().String()
	client := &Client{
		ID:         clientID,
		conn:       conn,
		authed:     false,
		subscribes: make(map[string]bool),
		channels:   make(map[string]bool),
		pause:      make(map[string]*pauseState),
		send:       make(chan outFrame, 256),
	}

	// Check for bearer token auth in header
	if token := extractBearerToken(r); token != "" {
		if s.isValidToken(token) {
			client.authed = true
		}
	}

	s.mu.Lock()
	s.clients[clientID] = client
	s.mu.Unlock()

	s.log.Info().Str("client", clientID).Bool("pre-authed", client.authed).Msg("ws client connected")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Start write loop
	go s.writeLoop(ctx, client)

	// Read loop (blocks)
	s.readLoop(ctx, client)

	s.mu.Lock()
	delete(s.clients, clientID)
	s.mu.Unlock()

	conn.Close(websocket.StatusNormalClosure, "")
	s.log.Info().Str("client", clientID).Msg("ws client disconnected")
}

func (s *Server) readLoop(ctx context.Context, client *Client) {
	for {
		typ, data, err := client.conn.Read(ctx)
		if err != nil {
			break
		}
		if typ == websocket.MessageBinary {
			// Binary channel.input frame (only from binary-capable, authed clients).
			client.mu.Lock()
			authed := client.authed
			client.mu.Unlock()
			if !authed {
				continue
			}
			if channelID, payload, ok := DecodeInputFrame(data); ok {
				_ = s.sessions.SendInput(channelID, payload)
			}
			continue
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		msg.Timestamp = time.Now()
		s.handleMessage(ctx, client, msg)
	}
}

func (s *Server) writeLoop(ctx context.Context, client *Client) {
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-client.send:
			if !ok {
				return
			}
			var err error
			if f.data != nil {
				err = client.conn.Write(ctx, websocket.MessageBinary, f.data)
			} else {
				err = wsjson.Write(ctx, client.conn, *f.msg)
			}
			if err != nil {
				s.log.Error().Err(err).Str("client", client.ID).Msg("ws write failed")
				return
			}
		}
	}
}

func (s *Server) handleMessage(ctx context.Context, client *Client, msg Message) {
	// Auth check for non-auth messages
	if msg.Type != MsgAuth && msg.Type != MsgPing {
		client.mu.Lock()
		authed := client.authed
		client.mu.Unlock()
		if !authed {
			s.sendToClient(client, s.makeMsg(MsgChannelError, map[string]string{"error": "not authenticated"}))
			return
		}
	}

	switch msg.Type {
	case MsgAuth:
		s.handleAuth(client, msg)
	case MsgChannelAttach:
		s.handleAttach(ctx, client, msg)
	case MsgChannelInput:
		s.handleInput(client, msg)
	case MsgChannelResize:
		s.handleResize(client, msg)
	case MsgChannelDetach:
		s.handleDetach(client, msg)
	case MsgChannelPause:
		if ps := client.getPause(msg.ChannelID); ps != nil {
			ps.paused.Store(true)
		}
	case MsgChannelResume:
		if ps := client.getPause(msg.ChannelID); ps != nil {
			ps.paused.Store(false)
			select {
			case ps.resume <- struct{}{}:
			default:
			}
		}
	case MsgClientBinary:
		var p struct {
			On bool `json:"on"`
		}
		_ = json.Unmarshal(msg.Payload, &p)
		client.binary.Store(p.On)
	case MsgSnapshotRequest:
		s.handleSnapshot(client, msg)
	case MsgEventsSubscribe:
		s.handleEventsSubscribe(client, msg)
	case MsgPing:
		s.sendToClient(client, Message{Type: MsgPong, Timestamp: time.Now()})
	default:
		s.log.Warn().Str("type", msg.Type).Msg("unknown message type")
	}
}

func (s *Server) handleAuth(client *Client, msg Message) {
	var payload AuthPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		s.sendToClient(client, s.makeMsg(MsgAuthResult, AuthResultPayload{
			Success: false, Error: "invalid payload",
		}))
		return
	}

	if s.isValidToken(payload.Token) {
		client.mu.Lock()
		client.authed = true
		client.mu.Unlock()
		// Opt-in binary hot-path: client advertises `client_info.binary:"true"`.
		client.binary.Store(payload.ClientInfo["binary"] == "true")
		s.sendToClient(client, s.makeMsg(MsgAuthResult, AuthResultPayload{
			Success:  true,
			ClientID: client.ID,
		}))
		s.log.Info().Str("client", client.ID).Msg("authenticated")
	} else {
		s.sendToClient(client, s.makeMsg(MsgAuthResult, AuthResultPayload{
			Success: false, Error: "invalid token",
		}))
	}
}

func (s *Server) handleAttach(ctx context.Context, client *Client, msg Message) {
	var payload AttachPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		s.sendToClient(client, s.makeMsg(MsgChannelError, map[string]string{"error": "invalid payload"}))
		return
	}

	if payload.Rows == 0 {
		payload.Rows = 24
	}
	if payload.Cols == 0 {
		payload.Cols = 80
	}

	channelID, ch, err := s.sessions.Attach(payload.HostName, payload.SessionName, payload.WindowIndex, payload.Rows, payload.Cols)
	if err != nil {
		s.sendToClient(client, s.makeMsg(MsgChannelError, map[string]string{
			"error": err.Error(),
		}))
		return
	}

	ps := &pauseState{resume: make(chan struct{}, 1)}
	client.mu.Lock()
	client.channels[channelID] = true
	client.pause[channelID] = ps
	client.mu.Unlock()

	// Report the EFFECTIVE grid, not what this viewer asked for: when a
	// co-viewer is smaller the shared pty is smaller, and a client that sized
	// its terminal to its own request would keep rows tmux never paints.
	effRows, effCols := s.sessions.EffectiveGrid(channelID)
	attachedMsg := s.makeMsg(MsgChannelAttached, ChannelAttachedPayload{
		ChannelID:   channelID,
		HostName:    payload.HostName,
		SessionName: payload.SessionName,
		Rows:        effRows,
		Cols:        effCols,
	})
	attachedMsg.ChannelID = channelID
	s.sendToClient(client, attachedMsg)

	sessionID := ch.SessionID

	// Replay-then-live: send the buffered tail the client is missing (from
	// its last_seq cursor, or a bounded fresh tail when it has none) BEFORE
	// starting the live relay. client.send is drained in order, so the
	// replay message is guaranteed to precede any live output.
	cursor := int64(-1)
	if payload.LastSeq != nil {
		cursor = int64(*payload.LastSeq)
	}
	rp := s.sessions.ReplayStore().ReplayFrom(sessionID, cursor)
	if len(rp.Data) > 0 {
		replayMsg := s.makeMsg(MsgChannelReplay, ChannelReplayPayload{
			ChannelID: channelID,
			Data:      base64.StdEncoding.EncodeToString(rp.Data),
			FromSeq:   rp.FromSeq,
			NextSeq:   rp.NextSeq,
			Truncated: rp.Truncated,
		})
		replayMsg.ChannelID = channelID
		s.sendToClient(client, replayMsg)
	}
	replayNext := rp.NextSeq

	// Relay output to client.
	//
	// Two termination paths:
	//   1. ch.Output is closed by the manager when the underlying SSH/tmux
	//      session ends — emit channel.closed and return.
	//   2. ctx is cancelled because the WS client disconnected. We stop
	//      relaying (nothing may land in the never-drained client.send
	//      buffer) but detach LAZILY via DetachAfter: the channel lingers as
	//      a ghost for a grace period, draining pane output into the replay
	//      ring, so a quickly-returning client replays the gap instead of
	//      losing it.
	go func() {
		defer func() {
			client.mu.Lock()
			delete(client.channels, channelID)
			delete(client.pause, channelID)
			client.mu.Unlock()
		}()

		// While true, chunks whose bytes were already delivered inside the
		// replay message are skipped (this channel's first reads can land in
		// the ring before ReplayFrom snapshots it). The stream is ordered, so
		// once one chunk passes the boundary the check is retired.
		skipReplayed := len(rp.Data) > 0
		// lastSentSeq = the seq the client is known to have. Used to replay the
		// gap on resume so a flow-control pause never loses live bytes.
		var lastSentSeq uint64
		if replayNext > 0 {
			lastSentSeq = uint64(replayNext)
		}

		for {
			// Flow control: while the client is paused, do NOT drain ch.Output
			// (bytes keep filling the replay ring). On resume, replay everything
			// since lastSentSeq from the ring, then continue live — the existing
			// skip-replayed boundary suppresses any overlap.
			if ps.paused.Load() {
				select {
				case <-ctx.Done():
					s.sessions.DetachAfter(channelID, wsDetachGrace)
					return
				case <-ps.resume:
					rp2 := s.sessions.ReplayStore().ReplayFrom(sessionID, int64(lastSentSeq))
					if len(rp2.Data) > 0 {
						rmsg := s.makeMsg(MsgChannelReplay, ChannelReplayPayload{
							ChannelID: channelID,
							Data:      base64.StdEncoding.EncodeToString(rp2.Data),
							FromSeq:   rp2.FromSeq,
							NextSeq:   rp2.NextSeq,
							Truncated: rp2.Truncated,
						})
						rmsg.ChannelID = channelID
						s.sendToClient(client, rmsg)
						replayNext = rp2.NextSeq
						lastSentSeq = uint64(rp2.NextSeq)
						skipReplayed = true
					}
				}
				continue
			}

			select {
			case <-ctx.Done():
				s.sessions.DetachAfter(channelID, wsDetachGrace)
				return

			case g := <-ch.Grid:
				gm := s.makeMsg(MsgChannelGrid, ChannelGridPayload{
					ChannelID: channelID, Rows: g[0], Cols: g[1],
				})
				gm.ChannelID = channelID
				s.sendToClient(client, gm)
				continue

			case chunk, ok := <-ch.Output:
				if !ok {
					closeMsg := s.makeMsg(MsgChannelClosed, ChannelClosedPayload{
						ChannelID: channelID,
						Reason:    "session closed",
					})
					closeMsg.ChannelID = channelID
					s.sendToClient(client, closeMsg)
					return
				}

				s.recordScrollback(sessionID, chunk)

				if skipReplayed {
					if chunk.Seq != 0 && chunk.Seq <= replayNext {
						continue
					}
					skipReplayed = false
				}

				if client.binary.Load() {
					// Raw binary frame — no base64, no JSON envelope.
					s.sendBinary(client, EncodeOutputFrame(channelID, chunk.Seq, chunk.Data))
				} else {
					encoded := base64.StdEncoding.EncodeToString(chunk.Data)
					outMsg := s.makeMsg(MsgChannelOutput, ChannelOutputPayload{Data: encoded, Seq: chunk.Seq})
					outMsg.ChannelID = channelID
					s.sendToClient(client, outMsg)
				}
				if chunk.Seq != 0 {
					lastSentSeq = chunk.Seq
				}
			}
		}
	}()
}

// wsDetachGrace is how long a channel outlives its WS client as a
// replay-ring feeder before being detached (see DetachAfter).
const wsDetachGrace = 3 * time.Minute

func (s *Server) handleInput(client *Client, msg Message) {
	channelID := msg.ChannelID
	if channelID == "" {
		var p map[string]string
		_ = json.Unmarshal(msg.Payload, &p)
		channelID = p["channel_id"]
	}

	var payload InputPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}

	data, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		return
	}

	if err := s.sessions.SendInput(channelID, data); err != nil {
		s.log.Error().Err(err).Str("channel", channelID).Msg("send input failed")
	}
}

func (s *Server) handleResize(client *Client, msg Message) {
	channelID := msg.ChannelID

	var payload ResizePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}

	if err := s.sessions.Resize(channelID, payload.Rows, payload.Cols); err != nil {
		s.log.Error().Err(err).Str("channel", channelID).Msg("resize failed")
	}
}

func (s *Server) handleDetach(client *Client, msg Message) {
	channelID := msg.ChannelID
	if channelID == "" {
		var p map[string]string
		_ = json.Unmarshal(msg.Payload, &p)
		channelID = p["channel_id"]
	}

	if err := s.sessions.Detach(channelID); err != nil {
		s.log.Error().Err(err).Str("channel", channelID).Msg("detach failed")
	}

	client.mu.Lock()
	delete(client.channels, channelID)
	client.mu.Unlock()

	detachMsg := s.makeMsg(MsgChannelClosed, ChannelClosedPayload{
		ChannelID: channelID,
		Reason:    "detached",
	})
	detachMsg.ChannelID = channelID
	s.sendToClient(client, detachMsg)
}

func (s *Server) handleSnapshot(client *Client, msg Message) {
	var payload SnapshotRequestPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}

	channelID := payload.ChannelID
	ch, ok := s.sessions.GetChannel(channelID)
	if !ok {
		return
	}

	chunks, err := s.db.GetScrollback(ch.SessionID, 100, 0)
	if err != nil {
		s.log.Error().Err(err).Msg("get scrollback failed")
		return
	}

	// Concatenate raw data
	var all []byte
	for _, c := range chunks {
		all = append(all, c.Data...)
	}

	encoded := base64.StdEncoding.EncodeToString(all)
	outMsg := s.makeMsg(MsgSnapshotResult, ChannelOutputPayload{Data: encoded})
	outMsg.ChannelID = channelID
	s.sendToClient(client, outMsg)
}

func (s *Server) handleEventsSubscribe(client *Client, msg Message) {
	var payload EventsSubscribePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}

	client.mu.Lock()
	for _, t := range payload.Types {
		client.subscribes[t] = true
	}
	client.mu.Unlock()
}

// BroadcastSessionsUpdate sends sessions.update to all authenticated clients
func (s *Server) BroadcastSessionsUpdate() {
	sessions, err := s.db.GetSessions("")
	for i := range sessions {
		sessions[i].Activity = s.sessions.ActivityFor(sessions[i].ID)
		if q, kind, since := s.sessions.SignalFor(sessions[i].ID); q != "" {
			sessions[i].Question, sessions[i].SignalKind, sessions[i].WaitingSince = q, kind, since
		}
	}
	if err != nil {
		s.log.Error().Err(err).Msg("get sessions for broadcast failed")
		return
	}

	msg := s.makeMsg(MsgSessionsUpdate, SessionsUpdatePayload{Sessions: sessions})
	s.broadcastToAuthed(msg)
}

// BroadcastWorkspaceUpdate sends workspace.update to all authenticated clients
func (s *Server) BroadcastWorkspaceUpdate(w sigil.Workspace) {
	msg := s.makeMsg(MsgWorkspaceUpdate, w)
	s.broadcastToAuthed(msg)
}

// BroadcastPrefsUpdate sends the shared host/session accent colours to every
// authenticated client so a colour set on one device shows on all of them.
func (s *Server) BroadcastPrefsUpdate() {
	hosts, sessions, err := s.db.GetColorPrefs()
	if err != nil {
		s.log.Error().Err(err).Msg("get colour prefs for broadcast failed")
		return
	}
	s.broadcastToAuthed(s.makeMsg(MsgPrefsUpdate, map[string]any{"hosts": hosts, "sessions": sessions}))
}

// BroadcastHostsUpdate sends hosts.update to all authenticated clients
func (s *Server) BroadcastHostsUpdate() {
	hosts, err := s.db.GetHosts()
	if err != nil {
		s.log.Error().Err(err).Msg("get hosts for broadcast failed")
		return
	}

	msg := s.makeMsg(MsgHostsUpdate, HostsUpdatePayload{Hosts: hosts})
	s.broadcastToAuthed(msg)
}

// BroadcastHostMetrics pushes a single host's resource metrics to all authed clients.
func (s *Server) BroadcastHostMetrics(m sigil.HostMetrics) {
	msg := s.makeMsg(MsgMetricsUpdate, MetricsUpdatePayload{Metrics: m})
	s.broadcastToAuthed(msg)
}

// BroadcastPreviewOpen tells all connected clients to open a file in the preview panel.
func (s *Server) BroadcastPreviewOpen(hostName, path string) {
	msg := s.makeMsg(MsgPreviewOpen, PreviewOpenPayload{HostName: hostName, Path: path})
	s.broadcastToAuthed(msg)
}

// BroadcastTriggerAction pushes a fired UI trigger effect to all authed clients.
func (s *Server) BroadcastTriggerAction(a events.UIAction) {
	msg := s.makeMsg(MsgTriggerAction, TriggerActionPayload{
		Action:    a.Action,
		Trigger:   a.Trigger,
		SessionID: a.SessionID,
		Match:     a.Match,
		Config:    a.Config,
	})
	s.broadcastToAuthed(msg)
}

// SendOutputToSubscribers sends channel output to subscribed clients
func (s *Server) SendOutputToSubscribers(channelID string, data []byte) {
	encoded := base64.StdEncoding.EncodeToString(data)
	msg := s.makeMsg(MsgChannelOutput, ChannelOutputPayload{Data: encoded})
	msg.ChannelID = channelID

	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, client := range s.clients {
		client.mu.Lock()
		subscribed := client.channels[channelID]
		client.mu.Unlock()
		if subscribed {
			s.sendToClient(client, msg)
		}
	}
}

func (s *Server) broadcastEvent(e sigil.Event) {
	msg := s.makeMsg(MsgEventFired, EventFiredPayload{Event: e})

	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, client := range s.clients {
		client.mu.Lock()
		authed := client.authed
		subscribed := len(client.subscribes) == 0 || client.subscribes[e.Type] || client.subscribes["*"]
		client.mu.Unlock()

		if authed && subscribed {
			s.sendToClient(client, msg)
		}
	}
}

func (s *Server) broadcastToAuthed(msg Message) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, client := range s.clients {
		client.mu.Lock()
		authed := client.authed
		client.mu.Unlock()
		if authed {
			s.sendToClient(client, msg)
		}
	}
}

func (s *Server) sendToClient(client *Client, msg Message) {
	select {
	case client.send <- outFrame{msg: &msg}:
	default:
		s.log.Warn().Str("client", client.ID).Msg("client send buffer full")
	}
}

// sendBinary queues a raw binary frame (used for channel.output to binary-capable
// clients). Same non-blocking / drop-if-full semantics as sendToClient.
func (s *Server) sendBinary(client *Client, data []byte) {
	select {
	case client.send <- outFrame{data: data}:
	default:
		s.log.Warn().Str("client", client.ID).Msg("client send buffer full")
	}
}

func (s *Server) makeMsg(msgType string, payload interface{}) Message {
	data, _ := json.Marshal(payload)
	return Message{
		Type:      msgType,
		Timestamp: time.Now(),
		Payload:   json.RawMessage(data),
	}
}

func (s *Server) isValidToken(token string) bool {
	if s.cfg.Hub.Auth.Method == "none" {
		return true
	}
	valid := false
	for _, t := range s.cfg.Hub.Auth.Tokens {
		// Constant-time compare (no early return) to avoid a timing oracle.
		if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
			valid = true
		}
	}
	return valid
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if len(auth) > 7 && auth[:7] == "Bearer " {
		return auth[7:]
	}
	return ""
}
