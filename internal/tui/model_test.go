package tui

import (
	"net/http"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// A rejected token must surface a clear error panel with the status code, never
// a panic. Drive the model with a 401 fetch result and render.
func TestErrorPanelShowsStatusCode(t *testing.T) {
	m := New(NewClient("http://127.0.0.1:7778", ""), "http://127.0.0.1:7778")
	next, _ := m.Update(fetchedMsg{err: &StatusError{StatusCode: http.StatusUnauthorized, Code: "unauthorized", Message: "invalid token"}})
	view := next.View()
	if !strings.Contains(view, "401") {
		t.Errorf("error panel should mention the 401 status code, got:\n%s", view)
	}
	if !strings.Contains(view, "token") {
		t.Errorf("error panel should hint about the token, got:\n%s", view)
	}
}

// A successful fetch builds host-sorted rows and never panics on render.
func TestRebuildRowsAndView(t *testing.T) {
	m := New(NewClient("http://x", "t"), "http://x")
	hosts := []sigil.Host{{Name: "host-a", Hostname: "192.0.2.10", Port: 22, User: "cc"}}
	sessions := []sigil.Session{
		{ID: "s2", HostName: "host-a", Name: "web", Windows: 3, Status: "active"},
		{ID: "s1", HostName: "host-a", Name: "api", Windows: 1, Status: "detached"},
	}
	next, _ := m.Update(fetchedMsg{hosts: hosts, sessions: sessions, status: StatusInfo{Version: "0.1.0"}})
	mm := next.(Model)
	if len(mm.visible) != 2 {
		t.Fatalf("expected 2 visible rows, got %d", len(mm.visible))
	}
	// Sorted by session name within host: api before web.
	if mm.visible[0].session.Name != "api" || mm.visible[1].session.Name != "web" {
		t.Errorf("rows not host/name sorted: %q, %q", mm.visible[0].session.Name, mm.visible[1].session.Name)
	}
	// The Sessions view should list the session names.
	mm.view = viewSessions
	if !strings.Contains(mm.View(), "web") {
		t.Errorf("sessions view should list the sessions")
	}
}

// The home view is the default landing screen and must render the branding and
// a live fleet summary without panicking, even before the first fetch.
func TestHomeViewRenders(t *testing.T) {
	m := New(NewClient("http://x", "t"), "http://x")
	m.width, m.height = 80, 24
	hosts := []sigil.Host{
		{Name: "host-a", Status: "connected"},
		{Name: "a Linux host", Status: "disconnected"},
	}
	sessions := []sigil.Session{{ID: "s1", HostName: "host-a", Name: "web", Activity: "working"}}
	next, _ := m.Update(fetchedMsg{hosts: hosts, sessions: sessions, status: StatusInfo{Version: "0.1.0"}})
	mm := next.(Model)
	view := mm.View()
	if !strings.Contains(view, "SIGIL") {
		t.Errorf("home view should show the SIGIL wordmark")
	}
	f := mm.summary()
	if f.hostsConnected != 1 || f.hostsTotal != 2 {
		t.Errorf("summary hosts = %d/%d, want 1/2", f.hostsConnected, f.hostsTotal)
	}
	if f.working != 1 {
		t.Errorf("summary working = %d, want 1", f.working)
	}
}

var _ tea.Model = Model{}
