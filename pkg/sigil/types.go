package sigil

import (
	"strings"
	"time"
)

// Version and build metadata. These are vars (not consts) so a release build
// can inject real values via `-ldflags -X` — the Go linker can only set string
// VARIABLES, so the previous `const Version` silently ignored the ldflag.
var (
	Version   = "0.1.11"
	GitCommit = "dev"     // short git SHA, injected at build time
	BuildDate = "unknown" // RFC3339 UTC, injected at build time
)

// SessionLogDir is the directory on each TARGET host where per-session
// pipe-pane logs live. Kept under ~/.local/share/sigil to match the hub's own
// data-dir convention and to survive reboots (unlike the previous /tmp
// location, which was tmpfs on most targets).
const SessionLogDir = "~/.local/share/sigil/logs"

// SessionLogPath returns the durable pipe-pane log path for a session on its
// target host. The "~/" form is intentional: it is what the
// /api/v1/hosts/{host}/files endpoint accepts (the remote shell expands it),
// and the hub does not know the remote user's home directory ahead of time.
// The filename is sanitised to [A-Za-z0-9_-] so it is always shell-safe.
func SessionLogPath(sessionName string) string {
	return SessionLogDir + "/" + SafeFileName(sessionName) + ".log"
}

// SafeFileName maps an arbitrary session name onto a shell-safe filename
// fragment: every rune outside [A-Za-z0-9_-] becomes '_'.
func SafeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	return b.String()
}

// Host represents a configured SSH host
type Host struct {
	Name        string   `json:"name"`
	Hostname    string   `json:"hostname"`
	Port        int      `json:"port"`
	User        string   `json:"user"`
	AuthMethod  string   `json:"auth_method"`
	Tags        []string `json:"tags"`
	AutoConnect bool     `json:"auto_connect"`
	Status      string   `json:"status"`
	Error       string   `json:"error,omitempty"`

	// Internal — never serialised to clients
	PrivateKeyPath string `json:"-"`
	Password       string `json:"-"`
}

// TmuxWindow represents a single tmux window within a session
type TmuxWindow struct {
	ID     string `json:"id"`    // tmux window ID, e.g. "@1"
	Index  int    `json:"index"` // 0-based window index
	Name   string `json:"name"`
	Active bool   `json:"active"` // currently active window in tmux
	Panes  int    `json:"panes"`
}

// Session represents a tmux session on a remote host
type Session struct {
	ID         string       `json:"id"`
	HostName   string       `json:"host_name"`
	Name       string       `json:"name"`
	Windows    int          `json:"windows"`
	WindowList []TmuxWindow `json:"window_list,omitempty"`
	Tags       []string     `json:"tags"`
	CreatedAt  time.Time    `json:"created_at"`
	LastActive time.Time    `json:"last_active"`
	Status     string       `json:"status"`
	// Activity is a live, non-persisted UX signal derived from the active pane's
	// command + recency of output: "working" (command running, output flowing),
	// "attention" (command running but gone quiet — likely done/waiting for you),
	// or "" (idle at a shell prompt / unknown). Merged in at broadcast time; not
	// stored in the DB. The granular layer later refines "attention" into
	// waiting/done/error via output triggers.
	Activity string `json:"activity,omitempty"`
	// Question is the pending prompt when Activity == "waiting", set AUTHORITATIVELY
	// by the agent's Notification hook (permission/idle prompt) via POST
	// /sessions/{id}/signal — not scraped. Carries the actual text the human (or
	// Zora) must answer. Empty otherwise. WaitingSince is when it entered waiting.
	Question     string    `json:"question,omitempty"`
	SignalKind   string    `json:"signal_kind,omitempty"` // "permission" | "question"
	WaitingSince time.Time `json:"waiting_since,omitempty"`
	StartDir     string    `json:"start_dir,omitempty"`
	StartCmd     string    `json:"start_cmd,omitempty"`
	// LogPath is the durable pipe-pane log file for this session ON THE TARGET
	// HOST ("~/" relative to the target user's home). Derived, not stored:
	// readable back via GET /api/v1/hosts/{host}/files?path=<log_path>.
	LogPath string `json:"log_path,omitempty"`
}

// ScrollbackChunk is a chunk of PTY output stored in DB
type ScrollbackChunk struct {
	ID        int64     `json:"id"`
	SessionID string    `json:"session_id"`
	Sequence  int64     `json:"sequence"`
	Timestamp time.Time `json:"timestamp"`
	Data      []byte    `json:"data"` // base64-encoded by encoding/json automatically
	LineCount int       `json:"line_count"`

	// Internal — used for FTS indexing, not sent to clients
	PlainText string `json:"-"`
}

// SearchResult is a FTS5 search result
type SearchResult struct {
	SessionID   string    `json:"session_id"`
	HostName    string    `json:"host_name"`
	SessionName string    `json:"session_name"`
	Snippet     string    `json:"snippet"`
	Timestamp   time.Time `json:"timestamp"`
	LineNumber  int       `json:"line_number"`
}

// Event is an event fired by the event bus
type Event struct {
	ID        string                 `json:"id"`
	Type      string                 `json:"type"`
	Timestamp time.Time              `json:"timestamp"`
	Data      map[string]interface{} `json:"data"`
}

// Trigger is a configured event trigger
type Trigger struct {
	ID      string                 `json:"id"`
	Name    string                 `json:"name"`
	Pattern string                 `json:"pattern"`
	Action  string                 `json:"action"`
	Config  map[string]interface{} `json:"config"`
	Enabled bool                   `json:"enabled"`
}

// Layout is a saved tile layout
type Layout struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Config    string    `json:"config"`
	CreatedAt time.Time `json:"created_at"`
}

// Workspace is a named, persistable pane+layout configuration
type Workspace struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Config    string    `json:"config"` // JSON blob: {panes, layout}
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// APIResponse is the standard response envelope
type APIResponse struct {
	Data  interface{} `json:"data,omitempty"`
	Error *APIError   `json:"error,omitempty"`
	Meta  *APIMeta    `json:"meta,omitempty"`
}

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type APIMeta struct {
	Total  int `json:"total,omitempty"`
	Offset int `json:"offset,omitempty"`
	Limit  int `json:"limit,omitempty"`
}

// DirEntry is a single entry returned by a remote directory listing.
type DirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

// FileContent is the content of a remote file, limited to 512 KB.
type FileContent struct {
	Path      string `json:"path"` // resolved (absolute) path
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

// DirListing is a resolved directory path plus its entries.
type DirListing struct {
	Path    string     `json:"path"` // resolved (absolute) path
	Entries []DirEntry `json:"entries"`
}
