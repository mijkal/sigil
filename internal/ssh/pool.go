package sshpool

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/crypto/ssh"

	"sigil.dev/sigil/internal/config"
	"sigil.dev/sigil/internal/db"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// HostConn represents a connection to a single host
type HostConn struct {
	Client    *ssh.Client
	Host      config.HostConfig
	Connected bool
	Err       error
	// Overflow clients, opened when the primary connection runs out of channels.
	// sshd caps concurrent sessions per CONNECTION (MaxSessions, default 10) and
	// sigil holds several long-lived ones per host: one pipe-pane sink per session
	// (7 on a busy host), the control-mode client, and one per attached viewer. Past
	// that ceiling every new channel is refused with "open failed" — which took out
	// discovery, capture-pane and pipe reads for the whole host while the existing
	// channels kept working, so panes went stale rather than visibly disconnecting.
	// Growing sideways lifts the ceiling without touching remote sshd config.
	overflow []*ssh.Client
	mu       sync.Mutex
}

// Pool manages SSH connections to all configured hosts
type Pool struct {
	mu     sync.RWMutex
	conns  map[string]*HostConn
	config *config.Config
	db     *db.DB
	log    zerolog.Logger
	events chan<- sigil.Event

	hostKeyOnce sync.Once
	hostKeyCb   ssh.HostKeyCallback
}

// hostKeyCallback lazily builds (once) the SSH host-key verifier from config.
// On a build error it logs and falls back to insecure so the hub still runs.
func (p *Pool) hostKeyCallback() ssh.HostKeyCallback {
	p.hostKeyOnce.Do(func() {
		cb, err := buildHostKeyCallback(p.config.Hub.HostKeyMode, p.config.Hub.KnownHostsPath)
		if err != nil {
			p.log.Error().Err(err).Str("mode", p.config.Hub.HostKeyMode).
				Msg("host-key verifier failed to build; falling back to insecure")
			cb = ssh.InsecureIgnoreHostKey()
		}
		p.hostKeyCb = cb
	})
	return p.hostKeyCb
}

// New creates a new SSH connection pool
func New(cfg *config.Config, d *db.DB, events chan<- sigil.Event) *Pool {
	return &Pool{
		conns:  make(map[string]*HostConn),
		config: cfg,
		db:     d,
		log:    zerolog.Nop(),
		events: events,
	}
}

// SetLogger sets the logger for the pool
func (p *Pool) SetLogger(log zerolog.Logger) {
	p.log = log
}

// hostsSnapshot returns a copy of the configured hosts taken under the lock, so
// callers can range over it without racing AddHostConfig's append to the same
// backing slice (concurrent append + range is a data race).
func (p *Pool) hostsSnapshot() []config.HostConfig {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]config.HostConfig, len(p.config.Hosts))
	copy(out, p.config.Hosts)
	return out
}

// ConnectAll connects all auto_connect hosts concurrently
func (p *Pool) ConnectAll(ctx context.Context) {
	var wg sync.WaitGroup
	for _, hc := range p.hostsSnapshot() {
		if !hc.AutoConnect {
			continue
		}
		hc := hc
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := p.Connect(ctx, hc.Name); err != nil {
				p.log.Error().Err(err).Str("host", hc.Name).Msg("failed to connect")
			}
		}()
	}
	wg.Wait()
}

// AddHostConfig registers a new host config in the pool and connects it.
// The caller is responsible for persisting the host to the DB.
func (p *Pool) AddHostConfig(ctx context.Context, hc config.HostConfig) error {
	p.mu.Lock()
	// Add to config.Hosts if not already present
	found := false
	for _, existing := range p.config.Hosts {
		if existing.Name == hc.Name {
			found = true
			break
		}
	}
	if !found {
		p.config.Hosts = append(p.config.Hosts, hc)
	}
	p.mu.Unlock()
	return p.Connect(ctx, hc.Name)
}

// dial opens one SSH connection to a host. Shared by Connect (the primary) and
// NewSession's overflow path, so both use identical auth and host-key policy.
func (p *Pool) dial(hc config.HostConfig) (*ssh.Client, error) {
	authMethods, err := BuildAuthMethods(hc)
	if err != nil {
		return nil, fmt.Errorf("build auth methods: %w", err)
	}
	addr := fmt.Sprintf("%s:%d", hc.Hostname, hc.Port)
	p.log.Info().Str("host", hc.Name).Str("addr", addr).Msg("connecting")
	client, err := ssh.Dial("tcp", addr, &ssh.ClientConfig{
		User:            hc.User,
		Auth:            authMethods,
		HostKeyCallback: p.hostKeyCallback(),
		Timeout:         15 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	return client, nil
}

// Connect establishes the primary SSH connection to the named host
func (p *Pool) Connect(ctx context.Context, hostName string) error {
	p.mu.RLock()
	var hc *config.HostConfig
	for i := range p.config.Hosts {
		if p.config.Hosts[i].Name == hostName {
			hc = &p.config.Hosts[i]
			break
		}
	}
	p.mu.RUnlock()
	if hc == nil {
		return fmt.Errorf("host %q not found in config", hostName)
	}

	client, err := p.dial(*hc)
	if err != nil {
		_ = p.db.UpdateHostStatus(hostName, "error", err.Error())
		return err
	}

	p.mu.Lock()
	p.conns[hostName] = &HostConn{
		Client:    client,
		Host:      *hc,
		Connected: true,
	}
	p.mu.Unlock()

	_ = p.db.UpdateHostStatus(hostName, "connected", "")

	if p.events != nil {
		select {
		case p.events <- sigil.Event{
			ID:        fmt.Sprintf("evt_%d", time.Now().UnixNano()),
			Type:      "host.connected",
			Timestamp: time.Now(),
			Data:      map[string]interface{}{"host": hostName},
		}:
		default:
		}
	}

	p.log.Info().Str("host", hostName).Msg("connected")

	// Start keepalive
	go p.keepalive(ctx, hostName, client)

	return nil
}

// Disconnect closes the SSH connection to the named host
func (p *Pool) Disconnect(hostName string) error {
	p.mu.Lock()
	hc, ok := p.conns[hostName]
	if ok {
		delete(p.conns, hostName)
	}
	p.mu.Unlock()

	if !ok {
		return fmt.Errorf("host %q not connected", hostName)
	}

	hc.mu.Lock()
	defer hc.mu.Unlock()
	hc.Connected = false
	// Overflow connections must go too, or a reconnect leaves the old ones holding
	// channels on the host with nothing referencing them.
	for _, c := range hc.overflow {
		_ = c.Close()
	}
	hc.overflow = nil
	err := hc.Client.Close()
	_ = p.db.UpdateHostStatus(hostName, "disconnected", "")
	return err
}

// GetClient returns the SSH client for the named host
func (p *Pool) GetClient(hostName string) (*ssh.Client, error) {
	p.mu.RLock()
	hc, ok := p.conns[hostName]
	p.mu.RUnlock()
	if !ok || !hc.Connected {
		return nil, fmt.Errorf("host %q not connected", hostName)
	}
	return hc.Client, nil
}

// NewSession opens a new SSH session on the named host.
//
// Falls back to (and then opens) an overflow connection when the current one has
// no channels left. sshd's MaxSessions is per-connection, so multiplexing every
// channel onto a single client makes ~10 the hard ceiling for a host — and sigil
// spends most of that on long-lived channels (a pipe-pane sink per tmux session,
// control mode, one per attached viewer). When a Linux host reached the cap, every
// transient operation — discovery, capture-pane, reading a pipe log — failed with
// "ssh: rejected: connect failed (open failed)" while the established channels
// kept streaming, so the UI showed stale panes instead of an obvious outage.
func (p *Pool) NewSession(hostName string) (*ssh.Session, error) {
	p.mu.RLock()
	hc, ok := p.conns[hostName]
	p.mu.RUnlock()
	if !ok || !hc.Connected {
		return nil, fmt.Errorf("host %q not connected", hostName)
	}

	if sess, err := hc.Client.NewSession(); err == nil {
		return sess, nil
	} else if !isChannelExhausted(err) {
		return nil, err // a real transport failure — let the caller see it
	}

	// Primary is full. Try the overflow clients we already hold, then dial another.
	hc.mu.Lock()
	defer hc.mu.Unlock()
	for _, c := range hc.overflow {
		if sess, err := c.NewSession(); err == nil {
			return sess, nil
		}
	}
	if len(hc.overflow) >= maxOverflowConns {
		return nil, fmt.Errorf(
			"host %q: all %d connections at MaxSessions — too many concurrent channels",
			hostName, len(hc.overflow)+1)
	}
	client, err := p.dial(hc.Host)
	if err != nil {
		return nil, fmt.Errorf("host %q: channels exhausted and overflow dial failed: %w",
			hostName, err)
	}
	hc.overflow = append(hc.overflow, client)
	p.log.Info().Str("host", hostName).Int("conns", len(hc.overflow)+1).
		Msg("ssh channels exhausted — opened an overflow connection")
	return client.NewSession()
}

// maxOverflowConns bounds sideways growth so a channel LEAK shows up as an error
// instead of quietly dialling forever.
const maxOverflowConns = 4

// isChannelExhausted reports whether the error is sshd refusing a new channel
// because the connection is at MaxSessions, rather than a broken transport.
// x/crypto/ssh surfaces this as an OpenChannelError; the string check covers the
// generic wrapping ("ssh: rejected: connect failed (open failed)").
func isChannelExhausted(err error) bool {
	if err == nil {
		return false
	}
	var oce *ssh.OpenChannelError
	if errors.As(err, &oce) {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "open failed") || strings.Contains(s, "administratively prohibited")
}

// IsConnected returns true if the named host is connected
func (p *Pool) IsConnected(hostName string) bool {
	p.mu.RLock()
	hc, ok := p.conns[hostName]
	p.mu.RUnlock()
	return ok && hc.Connected
}

// GetConnectedHosts returns names of currently connected hosts
func (p *Pool) GetConnectedHosts() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	hosts := make([]string, 0, len(p.conns))
	for name, hc := range p.conns {
		if hc.Connected {
			hosts = append(hosts, name)
		}
	}
	return hosts
}

// StartReconnectLoop starts the reconnect goroutine
func (p *Pool) StartReconnectLoop(ctx context.Context) {
	go p.reconnectLoop(ctx)
}

func (p *Pool) reconnectLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	backoff := map[string]time.Duration{}
	nextTry := map[string]time.Time{}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, hc := range p.hostsSnapshot() {
				if !hc.AutoConnect {
					continue
				}
				// PROBE, don't trust the cached flag.
				//
				// This used to `continue` whenever IsConnected() was true — a bool
				// set at dial time and cleared only by the keepalive goroutine. That
				// goroutine returns for good on its first miss and nothing restarts
				// it, so a host can be marked connected in memory, unusable in fact,
				// and never looked at again.
				//
				// 2026-08-15: jupiter sat at status=error("EOF") for 12.5 hours with
				// twelve live tmux sessions on it and sshd answering ssh from this
				// very machine. The loop logs every attempt and logged none, because
				// in memory the host still read as connected. A single manual
				// /connect fixed it instantly — nothing was wrong with the host.
				if p.IsConnected(hc.Name) {
					if p.alive(hc.Name) {
						backoff[hc.Name] = 0
						delete(nextTry, hc.Name)
						continue
					}
					p.log.Warn().Str("host", hc.Name).
						Msg("host reads connected but does not answer — reconnecting")
					p.markDisconnected(hc.Name, fmt.Errorf("liveness probe failed"))
				}

				// Honour the backoff. It was computed and stored here but never
				// waited on, so a genuinely dead host was redialled every 10s
				// forever — the doubling below was decorative.
				if t, ok := nextTry[hc.Name]; ok && time.Now().Before(t) {
					continue
				}

				wait := backoff[hc.Name]
				if wait == 0 {
					wait = time.Second
				}

				p.log.Info().Str("host", hc.Name).Dur("backoff", wait).Msg("reconnecting")

				if err := p.Connect(ctx, hc.Name); err != nil {
					p.log.Error().Err(err).Str("host", hc.Name).Msg("reconnect failed")
					next := wait * 2
					if next > 60*time.Second {
						next = 60 * time.Second
					}
					backoff[hc.Name] = next
					nextTry[hc.Name] = time.Now().Add(next)
				} else {
					backoff[hc.Name] = 0
					delete(nextTry, hc.Name)
				}
			}
		}
	}
}

// alive reports whether the host's primary connection still answers.
//
// Deliberately a keepalive REQUEST rather than opening a session: a host at
// sshd's MaxSessions cannot open one, and that is a busy host, not a dead one —
// tearing down a working connection because it is fully subscribed would be a
// worse outage than the one this exists to fix.
func (p *Pool) alive(hostName string) bool {
	p.mu.RLock()
	hc, ok := p.conns[hostName]
	p.mu.RUnlock()
	if !ok || hc.Client == nil {
		return false
	}
	_, _, err := hc.Client.SendRequest("keepalive@openssh.com", true, nil)
	return err == nil
}

// markDisconnected clears the in-memory flag and records why, so the reconnect
// loop and the API agree about what happened.
func (p *Pool) markDisconnected(hostName string, cause error) {
	p.mu.Lock()
	if hc, ok := p.conns[hostName]; ok {
		hc.Connected = false
		hc.Err = cause
	}
	p.mu.Unlock()
	// Nil-guarded: this runs inside the shared reconnect goroutine, so a panic
	// here would stop monitoring for EVERY host, not just this one.
	if p.db != nil {
		_ = p.db.UpdateHostStatus(hostName, "error", cause.Error())
	}
}

func (p *Pool) keepalive(ctx context.Context, hostName string, client *ssh.Client) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Stop only when THIS client is no longer the host's connection.
			//
			// The check used to be `if !p.IsConnected(hostName) { return }`, which
			// also fired on a host merely marked disconnected — so a blip retired
			// the only thing watching that host, and a later reconnect that reused
			// the same client left it unmonitored for good. Comparing identity ends
			// the goroutine exactly when it is superseded, and not before.
			p.mu.RLock()
			hc, ok := p.conns[hostName]
			current := ok && hc.Client == client
			p.mu.RUnlock()
			if !current {
				return
			}
			if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				p.log.Warn().Err(err).Str("host", hostName).
					Msg("keepalive failed, marking disconnected")
				p.markDisconnected(hostName, err)
				return
			}
		}
	}
}
