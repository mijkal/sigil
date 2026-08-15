package sshpool

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/crypto/ssh"
)

// isChannelExhausted decides whether NewSession grows the pool sideways or
// surfaces the error. Getting it wrong in either direction is bad: a false
// negative reproduces the outage it exists to fix (a host wedged at MaxSessions
// with discovery and capture-pane failing while established channels keep
// streaming, so panes go stale instead of visibly disconnecting), and a false
// positive dials a new connection on every unrelated transport error.
func TestIsChannelExhausted(t *testing.T) {
	exhausted := []error{
		// What x/crypto/ssh surfaces when sshd refuses the channel.
		&ssh.OpenChannelError{Reason: ssh.Prohibited, Message: "open failed"},
		// The wrapped/stringified form seen in the sigild logs during the incident.
		errors.New("ssh: rejected: connect failed (open failed)"),
		fmt.Errorf("new ssh session: %w",
			errors.New("ssh: rejected: connect failed (open failed)")),
		errors.New("ssh: rejected: administratively prohibited (open failed)"),
	}
	for _, err := range exhausted {
		if !isChannelExhausted(err) {
			t.Errorf("should be treated as channel exhaustion: %v", err)
		}
	}

	notExhausted := []error{
		nil,
		errors.New("ssh: handshake failed: no supported methods remain"),
		errors.New("dial tcp 192.0.2.1:22: connect: connection refused"),
		errors.New("ssh: unexpected packet in response to channel open"),
		errors.New("use of closed network connection"),
		errors.New("host \"a Linux host\" not connected"),
	}
	for _, err := range notExhausted {
		if isChannelExhausted(err) {
			t.Errorf("should NOT be treated as channel exhaustion: %v", err)
		}
	}
}

func TestNewSessionRejectsUnknownHost(t *testing.T) {
	p := &Pool{conns: map[string]*HostConn{}}
	if _, err := p.NewSession("nope"); err == nil {
		t.Fatal("expected an error for an unconnected host")
	}
}

func TestNewSessionRejectsDisconnectedHost(t *testing.T) {
	p := &Pool{conns: map[string]*HostConn{
		"h": {Connected: false},
	}}
	if _, err := p.NewSession("h"); err == nil {
		t.Fatal("expected an error for a host marked disconnected")
	}
}

func TestOverflowIsBounded(t *testing.T) {
	// The cap is what turns a channel LEAK into a visible error instead of an
	// unbounded dial loop against the host.
	if maxOverflowConns < 1 || maxOverflowConns > 16 {
		t.Errorf("maxOverflowConns = %d, want a small positive bound", maxOverflowConns)
	}
}

// A host can be marked connected in memory and be unusable in fact.
//
// On 2026-08-15 jupiter sat at status=error("EOF") for 12.5 hours with twelve
// live tmux sessions on it and sshd answering ssh from the sigild host itself.
// The reconnect loop logs every attempt and logged none in that window, because
// it skipped on IsConnected() — a bool set at dial time and cleared only by the
// keepalive goroutine, which returns for good on its first miss and is never
// restarted. One manual /connect fixed it instantly; nothing was wrong with the
// host. These pin the two halves of that.

func TestAliveIsFalseWithoutAClient(t *testing.T) {
	// The probe must never report a host healthy on the strength of a struct
	// existing — that is the same mistake as trusting Connected.
	p := &Pool{conns: map[string]*HostConn{"h": {Connected: true}}}
	if p.alive("h") {
		t.Fatal("alive() must be false when there is no client to ask")
	}
	if p.alive("missing") {
		t.Fatal("alive() must be false for an unknown host")
	}
}

func TestMarkDisconnectedClearsTheFlagAndRecordsWhy(t *testing.T) {
	// The reconnect loop reads the flag; the API reads the DB. If only one is
	// updated they disagree, which is precisely the 12.5-hour stall.
	p := &Pool{conns: map[string]*HostConn{"h": {Connected: true}}}
	cause := errors.New("liveness probe failed")
	p.markDisconnected("h", cause)
	if p.conns["h"].Connected {
		t.Fatal("markDisconnected must clear the in-memory flag")
	}
	if p.conns["h"].Err == nil {
		t.Fatal("markDisconnected must record the cause")
	}
	if p.IsConnected("h") {
		t.Fatal("IsConnected must follow markDisconnected")
	}
}

func TestMarkDisconnectedIsSafeForAnUnknownHost(t *testing.T) {
	// Called from the reconnect loop, which iterates config — a host in config
	// but never dialled has no conns entry, and a panic there would take the
	// loop down for every other host too.
	p := &Pool{conns: map[string]*HostConn{}}
	p.markDisconnected("never-dialled", errors.New("x"))
}
