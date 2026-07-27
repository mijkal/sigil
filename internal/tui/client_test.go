package tui

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Captured payloads shaped exactly like sigild's {"data": …, "meta": …}
// envelope (internal/api writeJSON), so the decode path is exercised end to end.
const hostsFixture = `{
  "data": [
    {"name":"host-a","hostname":"192.0.2.10","port":22,"user":"cc","auth_method":"key","tags":["hub"],"auto_connect":true,"status":"connected"},
    {"name":"a Docker host","hostname":"96.126.98.204","port":2222,"user":"root","auth_method":"key","tags":["prod"],"auto_connect":false,"status":"disconnected"}
  ],
  "meta": {"total": 2}
}`

const sessionsFixture = `{
  "data": [
    {"id":"s1","host_name":"host-a","name":"web","windows":3,"tags":[],"status":"active","activity":"working"},
    {"id":"s2","host_name":"a Docker host","name":"build run","windows":1,"tags":[],"status":"detached"}
  ],
  "meta": {"total": 2}
}`

const unauthorizedFixture = `{"error":{"code":"unauthorized","message":"invalid token"}}`

func TestClientHostsDecode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer tok")
		}
		if r.URL.Path != "/api/v1/hosts" {
			t.Errorf("path = %q, want /api/v1/hosts", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(hostsFixture))
	}))
	defer srv.Close()

	hosts, err := NewClient(srv.URL, "tok").Hosts(context.Background())
	if err != nil {
		t.Fatalf("Hosts: %v", err)
	}
	if len(hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(hosts))
	}
	if hosts[0].Name != "host-a" || hosts[0].Port != 22 || hosts[0].User != "cc" {
		t.Errorf("host[0] mis-decoded: %+v", hosts[0])
	}
	if hosts[1].Port != 2222 || hosts[1].Status != "disconnected" {
		t.Errorf("host[1] mis-decoded: %+v", hosts[1])
	}
}

func TestClientSessionsDecode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sessionsFixture))
	}))
	defer srv.Close()

	sessions, err := NewClient(srv.URL, "tok").Sessions(context.Background())
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}
	if sessions[0].HostName != "host-a" || sessions[0].Name != "web" || sessions[0].Windows != 3 {
		t.Errorf("session[0] mis-decoded: %+v", sessions[0])
	}
	// A name with a space must survive decode intact (it reaches attachArgs raw).
	if sessions[1].Name != "build run" || sessions[1].Status != "detached" {
		t.Errorf("session[1] mis-decoded: %+v", sessions[1])
	}
}

func TestClient401SurfacesTypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(unauthorizedFixture))
	}))
	defer srv.Close()

	_, err := NewClient(srv.URL, "").Hosts(context.Background())
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	var se *StatusError
	if !errors.As(err, &se) {
		t.Fatalf("expected *StatusError, got %T: %v", err, err)
	}
	if se.StatusCode != http.StatusUnauthorized {
		t.Errorf("StatusCode = %d, want 401", se.StatusCode)
	}
	if se.Code != "unauthorized" || se.Message != "invalid token" {
		t.Errorf("typed fields not populated: %+v", se)
	}
}
