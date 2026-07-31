package session

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Reaping abandoned ephemeral sessions.
//
// Ephemeral sessions (`hostsh-*`, `mctask-*`) are created, read and deleted by an
// orchestrator. When that delete does not happen the tmux session lives forever:
// on one host 33 had accumulated, the oldest 21 hours old, every one of them a
// bare idle shell with no process running.
//
// They leaked because DELETE used to 404 whenever the DB row was missing,
// WITHOUT touching the host — and a separate discovery bug was pruning rows out
// from under live sessions. Owner sends DELETE, gets 404, session is orphaned.
// The evidence is unmissable: the host with the pruning had 33 orphans, the host
// without it had 0. DeleteSession is now authoritative against the host, which
// removes the cause.
//
// This is the second half: an owner can also die (a container restart) and never
// send DELETE at all. Nothing else would ever clean that up, so sigild does —
// but ONLY on positive evidence that the session is finished, because the
// standing rule for ephemerals is that sigild must not race their owner:
//
//   - the name matches an ephemeral pattern (never a human's work session)
//   - the pane's process has NO children — the command is over, not merely quiet
//   - nobody is attached — a human looking at it outranks a timer
//   - it has been idle longer than the TTL
//
// "No children" is the load-bearing test. Idle time alone is not evidence: a
// worker can run for hours with no output and would be killed mid-task. A pane
// whose process tree is empty cannot be doing anything.
//
// Note this deliberately does NOT reap by age. A session that is still working
// is never a candidate no matter how old it gets.

// ephemeralReapTTL is how long a finished ephemeral session is kept before it is
// reclaimed. Generous on purpose: the only cost of waiting is one idle tmux
// session, while reaping too early destroys output an owner has not yet read.
// Owners collect within seconds, so an hour is several orders of margin.
const ephemeralReapTTL = 60 * time.Minute

// reapCandidate is one session considered for reclamation.
type reapCandidate struct {
	name     string
	panePID  string
	idle     time.Duration
	attached bool
	hasKids  bool
}

// shouldReap applies the policy. Split out from all I/O so the decision is
// testable without a host.
func (c reapCandidate) shouldReap(ttl time.Duration) bool {
	if c.attached || c.hasKids {
		return false
	}
	// A pane with no PID is a state we do not understand; leave it alone.
	if c.panePID == "" {
		return false
	}
	return c.idle >= ttl
}

// reapListCmd asks the ephemeral tmux server for every session plus the pane
// data needed to judge it, and dumps every process's parent PID ONCE so child
// detection costs a single process rather than one per session.
const reapListCmd = `tmux -L ` + ephemeralSocket +
	` list-panes -a -F '__E__|#{session_name}|#{session_activity}|#{pane_pid}|#{session_attached}' 2>/dev/null; ` +
	`echo "__NOW__|$(date +%s)"; ` +
	`ps -eo ppid= 2>/dev/null | tr -s " " "\n" | sort -u | sed 's/^/__P__|/'`

// parseReapListing turns the remote dump into candidates. Unparseable lines are
// skipped rather than guessed at — a malformed line must never become a kill.
func parseReapListing(out string, isEphemeral func(string) bool) []reapCandidate {
	var now int64
	parents := map[string]bool{}
	type raw struct {
		activity int64
		panePID  string
		attached bool
	}
	seen := map[string]raw{}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "__NOW__|"):
			now, _ = strconv.ParseInt(line[8:], 10, 64)
		case strings.HasPrefix(line, "__P__|"):
			if p := strings.TrimSpace(line[6:]); p != "" && p != "0" {
				parents[p] = true
			}
		case strings.HasPrefix(line, "__E__|"):
			f := strings.Split(line[6:], "|")
			if len(f) < 4 {
				continue
			}
			name := f[0]
			if name == "" || !isEphemeral(name) {
				continue
			}
			act, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil {
				continue
			}
			// A session with several panes is judged on its most recent
			// activity and is protected if ANY pane has children.
			prev, ok := seen[name]
			if !ok || act > prev.activity {
				prev.activity = act
			}
			if f[2] != "" {
				prev.panePID = f[2]
			}
			if f[3] != "" && f[3] != "0" {
				prev.attached = true
			}
			seen[name] = prev
		}
	}

	// Without a clock reading we cannot compute idle time, and treating that as
	// "idle forever" would reap the whole server.
	if now == 0 {
		return nil
	}

	out2 := make([]reapCandidate, 0, len(seen))
	for name, r := range seen {
		idle := time.Duration(now-r.activity) * time.Second
		if idle < 0 {
			idle = 0
		}
		out2 = append(out2, reapCandidate{
			name:     name,
			panePID:  r.panePID,
			idle:     idle,
			attached: r.attached,
			hasKids:  r.panePID != "" && parents[r.panePID],
		})
	}
	return out2
}

// ReapEphemeralSessions reclaims finished, abandoned ephemeral sessions on one
// host. Returns the names it killed.
func (m *Manager) ReapEphemeralSessions(ctx context.Context, hostName string, ttl time.Duration) ([]string, error) {
	if m.ephemeral == nil || len(m.ephemeral.list()) == 0 {
		return nil, nil // no policy configured — nothing is ephemeral by definition
	}
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return nil, fmt.Errorf("new ssh session: %w", err)
	}
	out, err := sess.Output(reapListCmd)
	sess.Close()
	if err != nil {
		return nil, fmt.Errorf("list ephemeral sessions: %w", err)
	}

	var killed []string
	for _, c := range parseReapListing(string(out), m.IsEphemeralName) {
		if !c.shouldReap(ttl) {
			continue
		}
		// DestroySession also stops pipe capture and drops the replay ring, so
		// the log stops growing for a session that no longer exists.
		if err := m.DestroySession(hostName, c.name); err != nil {
			m.log.Warn().Err(err).Str("host", hostName).Str("session", c.name).
				Msg("ephemeral reap: kill failed")
			continue
		}
		if err := m.db.DeleteSession(hostName + ":" + c.name); err != nil {
			m.log.Debug().Err(err).Str("session", c.name).Msg("ephemeral reap: db row already gone")
		}
		m.log.Info().Str("host", hostName).Str("session", c.name).
			Dur("idle", c.idle).Msg("reaped abandoned ephemeral session (finished, no owner)")
		killed = append(killed, c.name)
	}
	return killed, nil
}

// StartEphemeralReapLoop runs the reaper periodically across connected hosts.
// The interval is coarse on purpose: this reclaims debris, and debris is not
// urgent. Running it often would add SSH load to fix a problem measured in
// sessions per day.
func (m *Manager) StartEphemeralReapLoop(ctx context.Context, intervalSec int, ttl time.Duration) {
	if intervalSec <= 0 {
		intervalSec = 600
	}
	if ttl <= 0 {
		ttl = ephemeralReapTTL
	}
	go func() {
		t := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				for _, h := range m.pool.GetConnectedHosts() {
					if _, err := m.ReapEphemeralSessions(ctx, h, ttl); err != nil {
						m.log.Debug().Err(err).Str("host", h).Msg("ephemeral reap pass failed")
					}
				}
			}
		}
	}()
}
