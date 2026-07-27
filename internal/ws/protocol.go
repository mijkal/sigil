package ws

import (
	"encoding/binary"
	"encoding/json"
	"time"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// Binary WS frames — the opt-in "binary" client capability. The hot-path
// channel.output / channel.input travel as raw binary WS frames instead of
// base64-in-JSON, cutting ~33% bandwidth + the JSON/base64 encode/parse CPU.
// Everything else stays JSON text frames. A frame's leading byte disambiguates:
//
//	output (server→client): [0x01][seq uint64 BE : 8][idLen : 1][channelID][payload]
//	input  (client→server): [0x02][idLen : 1][channelID][payload]
const (
	FrameOutput byte = 0x01
	FrameInput  byte = 0x02
)

// EncodeOutputFrame builds a binary channel.output frame.
func EncodeOutputFrame(channelID string, seq uint64, payload []byte) []byte {
	id := []byte(channelID)
	buf := make([]byte, 10+len(id)+len(payload))
	buf[0] = FrameOutput
	binary.BigEndian.PutUint64(buf[1:9], seq)
	buf[9] = byte(len(id))
	n := copy(buf[10:], id)
	copy(buf[10+n:], payload)
	return buf
}

// DecodeInputFrame parses a binary channel.input frame.
func DecodeInputFrame(b []byte) (channelID string, payload []byte, ok bool) {
	if len(b) < 2 || b[0] != FrameInput {
		return "", nil, false
	}
	idLen := int(b[1])
	if len(b) < 2+idLen {
		return "", nil, false
	}
	return string(b[2 : 2+idLen]), b[2+idLen:], true
}

// Message is the envelope for all WebSocket messages
type Message struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	ChannelID string          `json:"channel_id,omitempty"`
	Timestamp time.Time       `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Client->Hub payloads
type AuthPayload struct {
	Token      string            `json:"token"`
	ClientInfo map[string]string `json:"client_info,omitempty"`
}

type AttachPayload struct {
	HostName    string `json:"host_name"`
	SessionName string `json:"session_name"`
	WindowIndex int    `json:"window_index"` // -1 = current active window; >= 0 = specific window
	Rows        uint16 `json:"rows"`
	Cols        uint16 `json:"cols"`
	ReadOnly    bool   `json:"read_only"`
	// LastSeq is the replay cursor: the seq of the last channel.output byte
	// the client has consumed for this SESSION (seqs are per-session, not
	// per-channel, so they survive channel churn). nil/absent = no cursor →
	// the hub replays a bounded fresh tail.
	LastSeq *uint64 `json:"last_seq,omitempty"`
}

type InputPayload struct {
	Data string `json:"data"` // base64
}

type ResizePayload struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

type SnapshotRequestPayload struct {
	ChannelID string `json:"channel_id"`
}

type EventsSubscribePayload struct {
	Types []string `json:"types"`
}

// Hub->Client payloads
type AuthResultPayload struct {
	Success  bool   `json:"success"`
	ClientID string `json:"client_id,omitempty"`
	Error    string `json:"error,omitempty"`
}

type ChannelAttachedPayload struct {
	ChannelID   string `json:"channel_id"`
	HostName    string `json:"host_name"`
	SessionName string `json:"session_name"`
	// Effective pty geometry — what the SHARED tmux client is actually sized to,
	// which may be smaller than this viewer asked for when a co-viewer is
	// smaller. Clients must size their terminal to this, not to their own fit(),
	// or the rows tmux never paints keep the previous frame's text.
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

// ChannelGridPayload announces a change to the effective pty geometry after
// attach (a co-viewer joined, left, or resized).
type ChannelGridPayload struct {
	ChannelID string `json:"channel_id"`
	Rows      uint16 `json:"rows"`
	Cols      uint16 `json:"cols"`
}

type ChannelOutputPayload struct {
	Data string `json:"data"` // base64
	// Seq is the session replay cursor after this chunk (byte offset in the
	// session's output stream). 0 = chunk not recorded in the replay ring.
	Seq uint64 `json:"seq,omitempty"`
}

// ChannelReplayPayload carries the buffered tail sent right after
// channel.attached and before any live channel.output: replay-then-live.
type ChannelReplayPayload struct {
	ChannelID string `json:"channel_id"`
	Data      string `json:"data"` // base64
	FromSeq   uint64 `json:"from_seq"`
	NextSeq   uint64 `json:"next_seq"`
	// Truncated means the client's cursor fell behind the ring — bytes were
	// lost from the live view (full history remains in the session log file).
	Truncated bool `json:"truncated"`
}

type ChannelClosedPayload struct {
	ChannelID string `json:"channel_id"`
	Reason    string `json:"reason"`
}

type SessionsUpdatePayload struct {
	Sessions []sigil.Session `json:"sessions"`
}

type HostsUpdatePayload struct {
	Hosts []sigil.Host `json:"hosts"`
}

type MetricsUpdatePayload struct {
	Metrics sigil.HostMetrics `json:"metrics"`
}

type EventFiredPayload struct {
	Event sigil.Event `json:"event"`
}

type PreviewOpenPayload struct {
	HostName string `json:"host_name"`
	Path     string `json:"path"`
}

// TriggerActionPayload carries a fired UI trigger (flash / tint / audio / toast)
// to connected clients. Mirrors events.UIAction.
type TriggerActionPayload struct {
	Action    string                 `json:"action"`
	Trigger   string                 `json:"trigger"`
	SessionID string                 `json:"sessionId,omitempty"`
	Match     string                 `json:"match,omitempty"`
	Config    map[string]interface{} `json:"config,omitempty"`
}

// Message type constants
const (
	MsgAuth            = "auth"
	MsgAuthResult      = "auth.result"
	MsgChannelAttach   = "channel.attach"
	MsgChannelAttached = "channel.attached"
	MsgChannelInput    = "channel.input"
	MsgChannelOutput   = "channel.output"
	MsgChannelResize   = "channel.resize"
	// Hub->client: the effective pty geometry changed (see ChannelGridPayload).
	MsgChannelGrid   = "channel.grid"
	MsgChannelDetach = "channel.detach"
	MsgChannelClosed = "channel.closed"
	MsgChannelError  = "channel.error"
	MsgChannelReplay = "channel.replay"
	// Flow control: the client pauses live output when its terminal parse
	// backlog crosses a high watermark and resumes below a low one. While
	// paused the pump stops relaying (bytes keep landing in the replay ring);
	// on resume it replays the gap from the client's last-sent seq so nothing
	// is lost. Default clients never send these, so the pump is unaffected.
	MsgChannelPause  = "channel.pause"
	MsgChannelResume = "channel.resume"
	// Live toggle of the binary hot-path for an already-connected client.
	MsgClientBinary    = "client.binary"
	MsgSessionsUpdate  = "sessions.update"
	MsgHostsUpdate     = "hosts.update"
	MsgMetricsUpdate   = "metrics.update"
	MsgSnapshotRequest = "snapshot.request"
	MsgSnapshotResult  = "snapshot.result"
	MsgEventsSubscribe = "events.subscribe"
	MsgEventFired      = "event.fired"
	MsgWorkspaceUpdate = "workspace.update"
	MsgPrefsUpdate     = "prefs.update"
	MsgPing            = "ping"
	MsgPong            = "pong"
	MsgPreviewOpen     = "preview.open"
	MsgTriggerAction   = "trigger.action"
)
