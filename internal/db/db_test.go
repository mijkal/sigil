package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func userVersion(t *testing.T, path string) int {
	t.Helper()
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()
	var v int
	if err := conn.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return v
}

func hasColumn(t *testing.T, conn *sql.DB, table, col string) bool {
	t.Helper()
	rows, err := conn.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == col {
			return true
		}
	}
	return false
}

// A fresh DB should end up at the latest schema version with all added columns.
func TestMigrateFreshDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.db")
	d, err := New(path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer d.Close()

	if got := userVersion(t, path); got != len(migrations) {
		t.Fatalf("user_version = %d, want %d", got, len(migrations))
	}
	for _, c := range []struct{ table, col string }{
		{"hosts", "private_key_path"},
		{"hosts", "auto_connect"},
		{"sessions", "windows_json"},
		{"sessions", "start_dir"},
		{"sessions", "start_cmd"},
	} {
		if !hasColumn(t, d.conn, c.table, c.col) {
			t.Errorf("missing column %s.%s after migration", c.table, c.col)
		}
	}
}

// Settings CRUD: upsert, read-back per scope, empty-value delete.
func TestSettingsCRUD(t *testing.T) {
	d, err := New(filepath.Join(t.TempDir(), "settings.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer d.Close()

	if err := d.SetSettings("global", map[string]string{"retention_days": "14", "auto_vacuum": "true"}); err != nil {
		t.Fatalf("SetSettings: %v", err)
	}
	got, err := d.GetSettings("global")
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if got["retention_days"] != "14" || got["auto_vacuum"] != "true" {
		t.Fatalf("unexpected settings: %v", got)
	}

	// Different scope is isolated.
	if s, _ := d.GetSettings("session:x"); len(s) != 0 {
		t.Fatalf("expected empty session scope, got %v", s)
	}

	// Empty value deletes the key.
	if err := d.SetSettings("global", map[string]string{"auto_vacuum": ""}); err != nil {
		t.Fatalf("SetSettings delete: %v", err)
	}
	got, _ = d.GetSettings("global")
	if _, ok := got["auto_vacuum"]; ok {
		t.Fatalf("auto_vacuum should have been deleted: %v", got)
	}
	if got["retention_days"] != "14" {
		t.Fatalf("retention_days should survive: %v", got)
	}
}

// Re-opening an already-migrated DB must be a clean no-op (no re-run, no error).
func TestMigrateIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "idem.db")
	d1, err := New(path)
	if err != nil {
		t.Fatalf("New #1: %v", err)
	}
	d1.Close()
	v1 := userVersion(t, path)

	d2, err := New(path)
	if err != nil {
		t.Fatalf("New #2: %v", err)
	}
	defer d2.Close()
	if v2 := userVersion(t, path); v2 != v1 {
		t.Fatalf("user_version changed on reopen: %d -> %d", v1, v2)
	}
}

// A legacy DB (columns already added by the old ignore-error ALTER loop, but
// user_version still 0) must adopt versioning without a duplicate-column error.
func TestMigrateLegacyAdoption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")

	// Simulate the pre-versioning state: base schema + columns already present,
	// user_version left at 0.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	if _, err := raw.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for _, stmt := range []string{
		`ALTER TABLE hosts ADD COLUMN private_key_path TEXT DEFAULT ''`,
		`ALTER TABLE hosts ADD COLUMN auto_connect INTEGER DEFAULT 0`,
		`ALTER TABLE sessions ADD COLUMN windows_json TEXT DEFAULT '[]'`,
		`ALTER TABLE sessions ADD COLUMN start_dir TEXT DEFAULT ''`,
		`ALTER TABLE sessions ADD COLUMN start_cmd TEXT DEFAULT ''`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("legacy ALTER: %v", err)
		}
	}
	raw.Close()

	if got := userVersion(t, path); got != 0 {
		t.Fatalf("precondition: legacy user_version = %d, want 0", got)
	}

	d, err := New(path)
	if err != nil {
		t.Fatalf("New on legacy DB: %v", err)
	}
	defer d.Close()

	if got := userVersion(t, path); got != len(migrations) {
		t.Fatalf("legacy DB user_version = %d, want %d", got, len(migrations))
	}
}
