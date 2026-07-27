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
