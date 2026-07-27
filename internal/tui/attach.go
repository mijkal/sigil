package tui

import (
	"strconv"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// attachArgs builds the argv for attaching to a tmux session on a host over SSH.
//
// It is a pure function — no shell, no live ssh — so it is unit-testable. The
// result is a full argv (element 0 is "ssh") suitable for exec.Command and
// tea.ExecProcess. Because the pieces are passed as distinct argv elements
// there is no shell to escape against; a session name with spaces or colons is
// carried verbatim as a single element.
//
// Shape: ssh -t [-p <port>] <user>@<hostname> tmux attach -t <session>
//   - "-p" is only added when the port is set and not the SSH default (22).
//   - "<user>@" is only prefixed when the host carries a user.
func attachArgs(host sigil.Host, session string) []string {
	args := []string{"ssh", "-t"}
	if host.Port != 0 && host.Port != 22 {
		args = append(args, "-p", strconv.Itoa(host.Port))
	}

	target := host.Hostname
	if host.User != "" {
		target = host.User + "@" + host.Hostname
	}
	args = append(args, target, "tmux", "attach", "-t", session)
	return args
}
