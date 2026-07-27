package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	sigil "sigil.dev/sigil/pkg/sigil"

	_ "modernc.org/sqlite"
)

// DB wraps the SQLite database
type DB struct {
	conn *sql.DB
	path string
}

const schema = `
CREATE TABLE IF NOT EXISTS hosts (
    name TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    user TEXT NOT NULL,
    auth_method TEXT DEFAULT 'key',
    tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'disconnected',
    last_seen DATETIME,
    error_msg TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    host_name TEXT NOT NULL,
    name TEXT NOT NULL,
    windows INTEGER DEFAULT 1,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS scrollback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    raw_data BLOB NOT NULL,
    plain_text TEXT NOT NULL DEFAULT '',
    line_count INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS scrollback_fts USING fts5(
    plain_text,
    session_id UNINDEXED,
    content='scrollback',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    action TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    data TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS layouts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_connections (
    id TEXT PRIMARY KEY,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    info TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scrollback_session_id ON scrollback(session_id);
CREATE INDEX IF NOT EXISTS idx_scrollback_timestamp ON scrollback(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_host_name ON sessions(host_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TRIGGER IF NOT EXISTS scrollback_ai AFTER INSERT ON scrollback BEGIN
    INSERT INTO scrollback_fts(rowid, plain_text, session_id) VALUES (new.id, new.plain_text, new.session_id);
END;

CREATE TRIGGER IF NOT EXISTS scrollback_ad AFTER DELETE ON scrollback BEGIN
    INSERT INTO scrollback_fts(scrollback_fts, rowid, plain_text, session_id) VALUES('delete', old.id, old.plain_text, old.session_id);
END;

CREATE TRIGGER IF NOT EXISTS scrollback_au AFTER UPDATE ON scrollback BEGIN
    INSERT INTO scrollback_fts(scrollback_fts, rowid, plain_text, session_id) VALUES('delete', old.id, old.plain_text, old.session_id);
    INSERT INTO scrollback_fts(rowid, plain_text, session_id) VALUES (new.id, new.plain_text, new.session_id);
END;
`

// New opens the SQLite database, enables WAL mode, and runs the schema
func New(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	conn, err := sql.Open("sqlite", path+"?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec("PRAGMA journal_mode=WAL"); err != nil {
		conn.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}

	// Incremental auto-vacuum lets us reclaim freed pages (from scrollback/event
	// pruning) a chunk at a time via PRAGMA incremental_vacuum, without a full
	// locking VACUUM. NOTE: this only takes effect for a FRESH database — SQLite
	// cannot change auto_vacuum mode on an existing file without a one-time full
	// VACUUM. Existing large DBs must be shrunk once manually; new installs
	// self-compact. Best-effort: ignore the error on legacy DBs.
	_, _ = conn.Exec("PRAGMA auto_vacuum=INCREMENTAL")

	if _, err := conn.Exec(schema); err != nil {
		conn.Close()
		return nil, fmt.Errorf("run schema: %w", err)
	}

	// Apply ordered schema migrations, tracked by PRAGMA user_version.
	if err := migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return &DB{conn: conn, path: path}, nil
}

// migrations is the ordered list of schema migrations. The migration at index i
// advances the database to user_version i+1 and runs exactly once. APPEND ONLY —
// never reorder, delete, or edit an existing entry, or DBs already past it will
// diverge. Each migration runs inside a transaction; a failure rolls back and
// aborts startup so the DB is never left half-migrated.
var migrations = []func(*sql.Tx) error{
	// v1 — additive columns introduced after the initial schema. Written to be
	// tolerant of legacy DBs where the pre-versioning ALTER loop already added
	// them (those DBs start at user_version 0 and adopt v1 as a no-op).
	func(tx *sql.Tx) error {
		cols := []struct{ table, col, ddl string }{
			{"hosts", "private_key_path", "TEXT DEFAULT ''"},
			{"hosts", "auto_connect", "INTEGER DEFAULT 0"},
			{"sessions", "windows_json", "TEXT DEFAULT '[]'"},
			{"sessions", "start_dir", "TEXT DEFAULT ''"},
			{"sessions", "start_cmd", "TEXT DEFAULT ''"},
		}
		for _, c := range cols {
			if err := addColumnIfMissing(tx, c.table, c.col, c.ddl); err != nil {
				return err
			}
		}
		return nil
	},
	// v2 — persisted settings. Two-tier by design: scope is "global" or
	// "session:<sessionID>". Values are strings; callers parse per key.
	func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TABLE IF NOT EXISTS settings (
			scope TEXT NOT NULL,
			key   TEXT NOT NULL,
			value TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (scope, key)
		)`)
		return err
	},
	// v3 — custom identity images (avatars/sigils) for a host or session, stored
	// server-side so every client/device sees the same mark. Small, downscaled
	// blobs (the client re-encodes to a 256px square; the API caps the size).
	func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TABLE IF NOT EXISTS assets (
			scope      TEXT PRIMARY KEY,
			mime       TEXT NOT NULL,
			data       BLOB NOT NULL,
			updated_at TEXT NOT NULL DEFAULT ''
		)`)
		return err
	},
}

// migrate applies every migration whose version is above the DB's current
// user_version, each in its own transaction, bumping user_version as it goes.
func migrate(conn *sql.DB) error {
	var version int
	if err := conn.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	for i := version; i < len(migrations); i++ {
		tx, err := conn.Begin()
		if err != nil {
			return err
		}
		if err := migrations[i](tx); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration v%d: %w", i+1, err)
		}
		// user_version participates in the transaction (it writes the DB header)
		// and rolls back with it. It takes no bind parameters; i+1 is a trusted int.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version=%d", i+1)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("bump user_version to %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration v%d: %w", i+1, err)
		}
	}
	return nil
}

// addColumnIfMissing runs ALTER TABLE ADD COLUMN only when the column is absent,
// so a migration is safe on both fresh DBs and legacy DBs that already have it.
// table/col/ddl come only from the compile-time migrations list (no user input),
// so string interpolation here carries no injection risk.
func addColumnIfMissing(tx *sql.Tx, table, col, ddl string) error {
	rows, err := tx.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == col {
			return nil // already present
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = tx.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, col, ddl))
	return err
}

// Close closes the database connection
func (d *DB) Close() error {
	return d.conn.Close()
}

// UpsertHost inserts or updates a host record
func (d *DB) UpsertHost(h sigil.Host) error {
	tags, _ := json.Marshal(h.Tags)
	autoConnect := 0
	if h.AutoConnect {
		autoConnect = 1
	}
	_, err := d.conn.Exec(`
		INSERT INTO hosts (name, hostname, port, user, auth_method, tags, status, error_msg, private_key_path, auto_connect)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			hostname=excluded.hostname,
			port=excluded.port,
			user=excluded.user,
			auth_method=excluded.auth_method,
			tags=excluded.tags,
			status=excluded.status,
			error_msg=excluded.error_msg,
			private_key_path=excluded.private_key_path,
			auto_connect=excluded.auto_connect
	`, h.Name, h.Hostname, h.Port, h.User, h.AuthMethod, string(tags), h.Status, h.Error, h.PrivateKeyPath, autoConnect)
	return err
}

// GetHosts retrieves all hosts from the database
func (d *DB) GetHosts() ([]sigil.Host, error) {
	rows, err := d.conn.Query(`
		SELECT name, hostname, port, user, auth_method, tags, status,
		       COALESCE(error_msg, ''), COALESCE(private_key_path, ''), COALESCE(auto_connect, 0)
		FROM hosts ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hosts []sigil.Host
	for rows.Next() {
		var h sigil.Host
		var tagsJSON string
		var autoConnect int
		if err := rows.Scan(&h.Name, &h.Hostname, &h.Port, &h.User, &h.AuthMethod,
			&tagsJSON, &h.Status, &h.Error, &h.PrivateKeyPath, &autoConnect); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &h.Tags)
		if h.Tags == nil {
			h.Tags = []string{}
		}
		h.AutoConnect = autoConnect != 0
		hosts = append(hosts, h)
	}
	if hosts == nil {
		hosts = []sigil.Host{}
	}
	return hosts, rows.Err()
}

// GetHost retrieves a single host by name (including sensitive fields)
func (d *DB) GetHost(name string) (sigil.Host, error) {
	var h sigil.Host
	var tagsJSON string
	var autoConnect int
	err := d.conn.QueryRow(`
		SELECT name, hostname, port, user, auth_method, tags, status,
		       COALESCE(error_msg, ''), COALESCE(private_key_path, ''), COALESCE(auto_connect, 0)
		FROM hosts WHERE name = ?
	`, name).Scan(&h.Name, &h.Hostname, &h.Port, &h.User, &h.AuthMethod,
		&tagsJSON, &h.Status, &h.Error, &h.PrivateKeyPath, &autoConnect)
	if err != nil {
		return h, err
	}
	_ = json.Unmarshal([]byte(tagsJSON), &h.Tags)
	if h.Tags == nil {
		h.Tags = []string{}
	}
	h.AutoConnect = autoConnect != 0
	return h, nil
}

// DeleteHost removes a host record from the database
func (d *DB) DeleteHost(name string) error {
	_, err := d.conn.Exec(`DELETE FROM hosts WHERE name = ?`, name)
	return err
}

// UpdateHostStatus updates the status and error message for a host
func (d *DB) UpdateHostStatus(name, status, errMsg string) error {
	_, err := d.conn.Exec(`
		UPDATE hosts SET status=?, error_msg=?, last_seen=? WHERE name=?
	`, status, errMsg, time.Now().UTC(), name)
	return err
}

// UpsertSession inserts or updates a session record.
// start_dir tracks the session's most-recent cwd: discovery sets it on every
// tick from `pane_current_path`, and the upsert here overwrites the stored
// value whenever the new one is non-empty. An empty new start_dir is treated
// as "no signal" (tmux unreachable, no active pane) and never clobbers a
// known-good path. This is what makes "resurrect" land you back where you
// were when the session died, rather than at the dir you first launched in.
// start_cmd is the launch-intent replayed on resurrect. It is seeded by
// CreateSession and refreshed by discovery only when the active pane yields a
// positive signal (e.g. a running `claude` → "claude --continue"); an empty
// new start_cmd is treated as "no signal" and never clobbers a stored value,
// so a session that has since dropped to a bash prompt still resurrects its
// conversation.
func (d *DB) UpsertSession(s sigil.Session) error {
	tags, _ := json.Marshal(s.Tags)
	windowsJSON, _ := json.Marshal(s.WindowList)
	_, err := d.conn.Exec(`
		INSERT INTO sessions (id, host_name, name, windows, windows_json, tags, created_at, last_active, status, start_dir, start_cmd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			host_name=excluded.host_name,
			name=excluded.name,
			windows=excluded.windows,
			windows_json=excluded.windows_json,
			tags=excluded.tags,
			last_active=excluded.last_active,
			status=excluded.status,
			start_dir=CASE
				WHEN COALESCE(excluded.start_dir,'')<>'' THEN excluded.start_dir
				ELSE sessions.start_dir
			END,
			start_cmd=CASE
				WHEN COALESCE(excluded.start_cmd,'')<>'' THEN excluded.start_cmd
				ELSE sessions.start_cmd
			END
	`, s.ID, s.HostName, s.Name, s.Windows, string(windowsJSON), string(tags), s.CreatedAt.UTC(), s.LastActive.UTC(), s.Status, s.StartDir, s.StartCmd)
	return err
}

// GetSessions retrieves sessions, optionally filtered by host
func (d *DB) GetSessions(hostFilter string) ([]sigil.Session, error) {
	var rows *sql.Rows
	var err error
	if hostFilter != "" {
		rows, err = d.conn.Query(`
			SELECT id, host_name, name, windows, COALESCE(windows_json,'[]'), tags, created_at, last_active, status,
			       COALESCE(start_dir,''), COALESCE(start_cmd,'')
			FROM sessions WHERE host_name=? ORDER BY last_active DESC
		`, hostFilter)
	} else {
		rows, err = d.conn.Query(`
			SELECT id, host_name, name, windows, COALESCE(windows_json,'[]'), tags, created_at, last_active, status,
			       COALESCE(start_dir,''), COALESCE(start_cmd,'')
			FROM sessions ORDER BY last_active DESC
		`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []sigil.Session
	for rows.Next() {
		var s sigil.Session
		var tagsJSON, windowsJSON string
		var createdAt, lastActive string
		if err := rows.Scan(&s.ID, &s.HostName, &s.Name, &s.Windows, &windowsJSON, &tagsJSON, &createdAt, &lastActive, &s.Status, &s.StartDir, &s.StartCmd); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tagsJSON), &s.Tags)
		if s.Tags == nil {
			s.Tags = []string{}
		}
		_ = json.Unmarshal([]byte(windowsJSON), &s.WindowList)
		if s.WindowList == nil {
			s.WindowList = []sigil.TmuxWindow{}
		}
		s.CreatedAt = parseDBTime(createdAt)
		s.LastActive = parseDBTime(lastActive)
		// LogPath is derived from the naming convention, not stored — populated
		// here so every consumer (REST, WS broadcasts) advertises it uniformly.
		s.LogPath = sigil.SessionLogPath(s.Name)
		sessions = append(sessions, s)
	}
	if sessions == nil {
		sessions = []sigil.Session{}
	}
	return sessions, rows.Err()
}

// parseDBTime decodes a timestamp string read from SQLite into a time.Time.
// Historically the write path stored times in Go's time.Time.String() layout
// ("2006-01-02 15:04:05 -0700 MST"), but the read path parsed the zone-less
// "2006-01-02 15:04:05" and silently discarded the mismatch error — collapsing
// every timestamp to the zero value (0001-01-01), which the web UI rendered as
// "739811d ago". Try the layouts we may have written, newest first; on failure
// return the zero time (which the API/UI now treat as "unknown").
func parseDBTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{
		"2006-01-02 15:04:05 -0700 MST", // Go time.Time.String() — what's on disk today
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00", // mattn/go-sqlite3 default
		"2006-01-02 15:04:05",                 // legacy zone-less
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// DeleteSession removes a session and its scrollback from the database.
// The scrollback row carries an ON DELETE CASCADE FK, but SQLite ships with
// foreign_keys=OFF by default so the cascade never fires — we delete scrollback
// explicitly here, otherwise a pruned session leaks its scrollback forever.
func (d *DB) DeleteSession(id string) error {
	if _, err := d.conn.Exec(`DELETE FROM scrollback WHERE session_id=?`, id); err != nil {
		return err
	}
	_, err := d.conn.Exec(`DELETE FROM sessions WHERE id=?`, id)
	return err
}

// TrimScrollback enforces scrollback retention and returns the number of rows
// deleted. It applies, in order: (1) orphans — scrollback for session_ids no
// longer present in the sessions table; (2) age — rows older than retentionDays
// (skipped when <= 0); (3) a per-session byte ceiling — keeping only the newest
// rows whose cumulative raw_data stays within maxBytesPerSession (skipped when
// <= 0). The DELETEs fire the scrollback_ad trigger, so the FTS index stays in
// sync. Disk is not reclaimed here (no VACUUM) — freed pages are reused by
// subsequent inserts, which keeps the file bounded without locking the DB.
func (d *DB) TrimScrollback(maxBytesPerSession int64, retentionDays int) (int64, error) {
	var total int64

	res, err := d.conn.Exec(`DELETE FROM scrollback WHERE session_id NOT IN (SELECT id FROM sessions)`)
	if err != nil {
		return total, fmt.Errorf("trim orphans: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil {
		total += n
	}

	if retentionDays > 0 {
		res, err := d.conn.Exec(
			`DELETE FROM scrollback WHERE timestamp < datetime('now', ?)`,
			fmt.Sprintf("-%d days", retentionDays),
		)
		if err != nil {
			return total, fmt.Errorf("trim by age: %w", err)
		}
		if n, err := res.RowsAffected(); err == nil {
			total += n
		}
	}

	if maxBytesPerSession > 0 {
		// Window the cumulative byte size newest-first per session; delete rows
		// once the running total exceeds the cap. length() on a BLOB is its
		// byte length, matching how the cap is expressed.
		res, err := d.conn.Exec(`
			DELETE FROM scrollback WHERE id IN (
				SELECT id FROM (
					SELECT id, SUM(length(raw_data)) OVER (
						PARTITION BY session_id ORDER BY id DESC
						ROWS UNBOUNDED PRECEDING
					) AS cum
					FROM scrollback
				) WHERE cum > ?
			)`, maxBytesPerSession)
		if err != nil {
			return total, fmt.Errorf("trim by bytes: %w", err)
		}
		if n, err := res.RowsAffected(); err == nil {
			total += n
		}
	}

	return total, nil
}

// InsertScrollback inserts a scrollback chunk
func (d *DB) InsertScrollback(chunk sigil.ScrollbackChunk) error {
	_, err := d.conn.Exec(`
		INSERT INTO scrollback (session_id, sequence, timestamp, raw_data, plain_text, line_count)
		VALUES (?, ?, ?, ?, ?, ?)
	`, chunk.SessionID, chunk.Sequence, chunk.Timestamp.UTC(), chunk.Data, chunk.PlainText, chunk.LineCount)
	return err
}

// GetScrollback retrieves scrollback chunks for a session
func (d *DB) GetScrollback(sessionID string, limit, offset int) ([]sigil.ScrollbackChunk, error) {
	rows, err := d.conn.Query(`
		SELECT id, session_id, sequence, timestamp, raw_data, plain_text, line_count
		FROM scrollback WHERE session_id=?
		ORDER BY sequence ASC
		LIMIT ? OFFSET ?
	`, sessionID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chunks []sigil.ScrollbackChunk
	for rows.Next() {
		var c sigil.ScrollbackChunk
		var ts string
		if err := rows.Scan(&c.ID, &c.SessionID, &c.Sequence, &ts, &c.Data, &c.PlainText, &c.LineCount); err != nil {
			return nil, err
		}
		c.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		chunks = append(chunks, c)
	}
	if chunks == nil {
		chunks = []sigil.ScrollbackChunk{}
	}
	return chunks, rows.Err()
}

// SearchScrollback performs FTS5 search on scrollback
func (d *DB) SearchScrollback(query, sessionID string, limit, offset int) ([]sigil.SearchResult, error) {
	var rows *sql.Rows
	var err error

	if sessionID != "" {
		rows, err = d.conn.Query(`
			SELECT s.session_id, se.host_name, se.name,
				   snippet(scrollback_fts, 0, '<mark>', '</mark>', '...', 20),
				   sc.timestamp
			FROM scrollback_fts s
			JOIN scrollback sc ON sc.id = s.rowid
			JOIN sessions se ON se.id = s.session_id
			WHERE scrollback_fts MATCH ? AND s.session_id = ?
			ORDER BY sc.timestamp DESC
			LIMIT ? OFFSET ?
		`, query, sessionID, limit, offset)
	} else {
		rows, err = d.conn.Query(`
			SELECT s.session_id, se.host_name, se.name,
				   snippet(scrollback_fts, 0, '<mark>', '</mark>', '...', 20),
				   sc.timestamp
			FROM scrollback_fts s
			JOIN scrollback sc ON sc.id = s.rowid
			JOIN sessions se ON se.id = s.session_id
			WHERE scrollback_fts MATCH ?
			ORDER BY sc.timestamp DESC
			LIMIT ? OFFSET ?
		`, query, limit, offset)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []sigil.SearchResult
	for rows.Next() {
		var r sigil.SearchResult
		var ts string
		if err := rows.Scan(&r.SessionID, &r.HostName, &r.SessionName, &r.Snippet, &ts); err != nil {
			return nil, err
		}
		r.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		results = append(results, r)
	}
	if results == nil {
		results = []sigil.SearchResult{}
	}
	return results, rows.Err()
}

// PruneScrollback removes scrollback older than retentionDays
func (d *DB) PruneScrollback(retentionDays int) error {
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays)
	_, err := d.conn.Exec(`DELETE FROM scrollback WHERE timestamp < ?`, cutoff.Format("2006-01-02 15:04:05"))
	return err
}

// GetTriggers retrieves all triggers
func (d *DB) GetTriggers() ([]sigil.Trigger, error) {
	rows, err := d.conn.Query(`
		SELECT id, name, pattern, action, config, enabled FROM triggers ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var triggers []sigil.Trigger
	for rows.Next() {
		var t sigil.Trigger
		var configJSON string
		var enabled int
		if err := rows.Scan(&t.ID, &t.Name, &t.Pattern, &t.Action, &configJSON, &enabled); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(configJSON), &t.Config)
		if t.Config == nil {
			t.Config = map[string]interface{}{}
		}
		t.Enabled = enabled != 0
		triggers = append(triggers, t)
	}
	if triggers == nil {
		triggers = []sigil.Trigger{}
	}
	return triggers, rows.Err()
}

// InsertTrigger inserts a new trigger
func (d *DB) InsertTrigger(t sigil.Trigger) error {
	cfg, _ := json.Marshal(t.Config)
	enabled := 0
	if t.Enabled {
		enabled = 1
	}
	_, err := d.conn.Exec(`
		INSERT INTO triggers (id, name, pattern, action, config, enabled)
		VALUES (?, ?, ?, ?, ?, ?)
	`, t.ID, t.Name, t.Pattern, t.Action, string(cfg), enabled)
	return err
}

// UpdateTrigger updates an existing trigger
func (d *DB) UpdateTrigger(t sigil.Trigger) error {
	cfg, _ := json.Marshal(t.Config)
	enabled := 0
	if t.Enabled {
		enabled = 1
	}
	_, err := d.conn.Exec(`
		UPDATE triggers SET name=?, pattern=?, action=?, config=?, enabled=? WHERE id=?
	`, t.Name, t.Pattern, t.Action, string(cfg), enabled, t.ID)
	return err
}

// DeleteTrigger removes a trigger
func (d *DB) DeleteTrigger(id string) error {
	_, err := d.conn.Exec(`DELETE FROM triggers WHERE id=?`, id)
	return err
}

// LogEvent inserts an event record
func (d *DB) LogEvent(e sigil.Event) error {
	data, _ := json.Marshal(e.Data)
	_, err := d.conn.Exec(`
		INSERT INTO events (id, type, timestamp, data)
		VALUES (?, ?, ?, ?)
	`, e.ID, e.Type, e.Timestamp.UTC(), string(data))
	return err
}

// PruneEvents keeps only the most recent `keep` events and deletes the rest.
// The events table previously had no pruning at all — it grew without bound.
// Returns the number of rows deleted.
func (d *DB) PruneEvents(keep int) (int64, error) {
	if keep <= 0 {
		keep = 10000
	}
	res, err := d.conn.Exec(`
		DELETE FROM events WHERE id NOT IN (
			SELECT id FROM events ORDER BY timestamp DESC LIMIT ?
		)`, keep)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// IncrementalVacuum reclaims up to `pages` freed pages (0 = all available)
// without a full locking VACUUM. It is a no-op on databases not created with
// auto_vacuum=INCREMENTAL (legacy files), so it is always safe to call.
func (d *DB) IncrementalVacuum(pages int) error {
	if pages > 0 {
		_, err := d.conn.Exec(fmt.Sprintf("PRAGMA incremental_vacuum(%d)", pages))
		return err
	}
	_, err := d.conn.Exec("PRAGMA incremental_vacuum")
	return err
}

// FullVacuum runs a full VACUUM: rebuilds the database file, reclaiming all free
// space to disk. This takes a write lock for the duration and can be slow on a
// large file, so it is only ever invoked explicitly by the operator (never on a
// timer). Running it once also converts a legacy file to the auto_vacuum mode
// set by PRAGMA at open, enabling cheap incremental vacuums thereafter.
func (d *DB) FullVacuum() error {
	_, err := d.conn.Exec("VACUUM")
	return err
}

// GetSettings returns all key/value pairs stored under a scope ("global" or
// "session:<id>"). Missing scope yields an empty map, not an error.
func (d *DB) GetSettings(scope string) (map[string]string, error) {
	rows, err := d.conn.Query(`SELECT key, value FROM settings WHERE scope = ?`, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// SetSettings upserts each key/value under a scope in one transaction. An empty
// value deletes the key (so callers can clear a per-session override to fall
// back to the global default).
func (d *DB) SetSettings(scope string, kv map[string]string) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	for k, v := range kv {
		if v == "" {
			if _, err := tx.Exec(`DELETE FROM settings WHERE scope = ? AND key = ?`, scope, k); err != nil {
				_ = tx.Rollback()
				return err
			}
			continue
		}
		if _, err := tx.Exec(`
			INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
			ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, scope, k, v); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// prefsScope holds the shared per-host / per-session accent colours (keys
// h:<host> and s:<host>::<session>), so every client sees the same colours.
const prefsScope = "prefs"

// GetColorPrefs returns the host and session accent-colour maps from the shared
// "prefs" settings scope, split by key prefix.
func (d *DB) GetColorPrefs() (hosts, sessions map[string]string, err error) {
	kv, err := d.GetSettings(prefsScope)
	if err != nil {
		return nil, nil, err
	}
	hosts = map[string]string{}
	sessions = map[string]string{}
	for k, v := range kv {
		if len(k) > 2 && k[:2] == "h:" {
			hosts[k[2:]] = v
		} else if len(k) > 2 && k[:2] == "s:" {
			sessions[k[2:]] = v
		}
	}
	return hosts, sessions, nil
}

// SetColorPref upserts (or clears, when colour=="") one host/session colour.
func (d *DB) SetColorPref(key, colour string) error {
	return d.SetSettings(prefsScope, map[string]string{key: colour})
}

// GetAllPrefs returns the whole shared prefs KV (colours, icon choices, image
// adjustments — all keyed by prefix), so a client can hydrate every customization
// in one round-trip.
func (d *DB) GetAllPrefs() (map[string]string, error) {
	return d.GetSettings(prefsScope)
}

// SetPref upserts (or clears, when value=="") any shared pref key.
func (d *DB) SetPref(key, value string) error {
	return d.SetSettings(prefsScope, map[string]string{key: value})
}

// ---- custom identity images (avatars/sigils) ----------------------------------

// SetAsset stores (or replaces) the image blob for a scope. Callers cap the size.
func (d *DB) SetAsset(scope, mime string, data []byte) error {
	_, err := d.conn.Exec(
		`INSERT INTO assets (scope, mime, data, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(scope) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at`,
		scope, mime, data, time.Now().UTC().Format(time.RFC3339))
	return err
}

// GetAsset returns the image blob + mime for a scope (sql.ErrNoRows if absent).
func (d *DB) GetAsset(scope string) (mime string, data []byte, err error) {
	err = d.conn.QueryRow(`SELECT mime, data FROM assets WHERE scope = ?`, scope).Scan(&mime, &data)
	return mime, data, err
}

// DeleteAsset removes the image for a scope.
func (d *DB) DeleteAsset(scope string) error {
	_, err := d.conn.Exec(`DELETE FROM assets WHERE scope = ?`, scope)
	return err
}

// ListAssetScopes returns the scopes that have a custom image (no blobs — cheap).
func (d *DB) ListAssetScopes() ([]string, error) {
	rows, err := d.conn.Query(`SELECT scope FROM assets ORDER BY scope`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if out == nil {
		out = []string{}
	}
	return out, rows.Err()
}

// GetEvents retrieves recent events
func (d *DB) GetEvents(limit int) ([]sigil.Event, error) {
	rows, err := d.conn.Query(`
		SELECT id, type, timestamp, data FROM events ORDER BY timestamp DESC LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []sigil.Event
	for rows.Next() {
		var e sigil.Event
		var ts, dataJSON string
		if err := rows.Scan(&e.ID, &e.Type, &ts, &dataJSON); err != nil {
			return nil, err
		}
		e.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		_ = json.Unmarshal([]byte(dataJSON), &e.Data)
		if e.Data == nil {
			e.Data = map[string]interface{}{}
		}
		events = append(events, e)
	}
	if events == nil {
		events = []sigil.Event{}
	}
	return events, rows.Err()
}

// GetLayouts retrieves all layouts
func (d *DB) GetLayouts() ([]sigil.Layout, error) {
	rows, err := d.conn.Query(`
		SELECT id, name, config, created_at FROM layouts ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var layouts []sigil.Layout
	for rows.Next() {
		var l sigil.Layout
		var ts string
		if err := rows.Scan(&l.ID, &l.Name, &l.Config, &ts); err != nil {
			return nil, err
		}
		l.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", ts)
		layouts = append(layouts, l)
	}
	if layouts == nil {
		layouts = []sigil.Layout{}
	}
	return layouts, rows.Err()
}

// SaveLayout inserts or updates a layout
func (d *DB) SaveLayout(l sigil.Layout) error {
	_, err := d.conn.Exec(`
		INSERT INTO layouts (id, name, config, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config
	`, l.ID, l.Name, l.Config, l.CreatedAt.UTC())
	return err
}

// DeleteLayout removes a layout
func (d *DB) DeleteLayout(id string) error {
	_, err := d.conn.Exec(`DELETE FROM layouts WHERE id=?`, id)
	return err
}

// GetWorkspaces retrieves all workspaces
func (d *DB) GetWorkspaces() ([]sigil.Workspace, error) {
	rows, err := d.conn.Query(`SELECT id, name, config, created_at, updated_at FROM workspaces ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ws []sigil.Workspace
	for rows.Next() {
		var w sigil.Workspace
		var created, updated string
		if err := rows.Scan(&w.ID, &w.Name, &w.Config, &created, &updated); err != nil {
			return nil, err
		}
		w.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", created)
		w.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updated)
		ws = append(ws, w)
	}
	if ws == nil {
		ws = []sigil.Workspace{}
	}
	return ws, rows.Err()
}

// SaveWorkspace inserts or updates a workspace
func (d *DB) SaveWorkspace(w sigil.Workspace) error {
	now := time.Now().UTC()
	_, err := d.conn.Exec(`
		INSERT INTO workspaces (id, name, config, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config, updated_at=excluded.updated_at
	`, w.ID, w.Name, w.Config, now, now)
	return err
}

// DeleteWorkspace removes a workspace
func (d *DB) DeleteWorkspace(id string) error {
	_, err := d.conn.Exec(`DELETE FROM workspaces WHERE id=?`, id)
	return err
}

// GetStats returns aggregate statistics
func (d *DB) GetStats() (map[string]interface{}, error) {
	stats := map[string]interface{}{}

	var hostCount int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM hosts`).Scan(&hostCount); err != nil {
		return nil, err
	}
	stats["host_count"] = hostCount

	var sessionCount int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessionCount); err != nil {
		return nil, err
	}
	stats["session_count"] = sessionCount

	var scrollbackChunks int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM scrollback`).Scan(&scrollbackChunks); err != nil {
		return nil, err
	}
	stats["scrollback_chunks"] = scrollbackChunks

	fi, err := os.Stat(d.path)
	if err == nil {
		stats["db_size_bytes"] = fi.Size()
	} else {
		stats["db_size_bytes"] = int64(0)
	}

	return stats, nil
}
