package session

import (
	"bufio"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/crypto/ssh"
	sshpool "sigil.dev/sigil/internal/ssh"
)

// ControlClient holds a persistent tmux control-mode (-C) SSH connection to one
// host. It parses tmux event notifications and calls onChange whenever sessions
// or windows change so that sigild can push live updates to clients instead of
// waiting for the polling interval.
type ControlClient struct {
	hostName string
	pool     *sshpool.Pool
	log      zerolog.Logger
	onChange func(hostName string) // called (debounced) on any session/window change

	stopOnce sync.Once
	stopCh   chan struct{}

	sessMu   sync.Mutex
	currSess *ssh.Session

	debounceMu sync.Mutex
	debounce   *time.Timer
}

func newControlClient(hostName string, pool *sshpool.Pool, log zerolog.Logger, onChange func(string)) *ControlClient {
	return &ControlClient{
		hostName: hostName,
		pool:     pool,
		log:      log,
		onChange: onChange,
		stopCh:   make(chan struct{}),
	}
}

func (c *ControlClient) start() { go c.run() }

func (c *ControlClient) stop() {
	c.stopOnce.Do(func() {
		close(c.stopCh)
		// Interrupt any blocked scanner by closing the current SSH session
		c.sessMu.Lock()
		if c.currSess != nil {
			_ = c.currSess.Close()
		}
		c.sessMu.Unlock()
	})
}

// run retries the control-mode connection with exponential backoff.
func (c *ControlClient) run() {
	backoff := 3 * time.Second
	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		start := time.Now()
		if err := c.connect(); err != nil {
			c.log.Debug().Err(err).Str("host", c.hostName).
				Dur("retry_in", backoff).Msg("tmux control mode error")
		} else {
			c.log.Debug().Str("host", c.hostName).Msg("tmux control mode disconnected")
		}

		select {
		case <-c.stopCh:
			return
		case <-time.After(backoff):
		}

		// Reset backoff after a long-lived connection; keep it short otherwise
		if time.Since(start) > 60*time.Second {
			backoff = 3 * time.Second
		} else if backoff < 60*time.Second {
			backoff = min(backoff*2, 60*time.Second)
		}
	}
}

// connect opens one tmux control-mode session and reads notifications until the
// session closes or stop() is called.
func (c *ControlClient) connect() error {
	sess, err := c.pool.NewSession(c.hostName)
	if err != nil {
		return err
	}

	// Register session so stop() can interrupt a blocked Read
	c.sessMu.Lock()
	c.currSess = sess
	c.sessMu.Unlock()
	defer func() {
		c.sessMu.Lock()
		c.currSess = nil
		c.sessMu.Unlock()
		_ = sess.Close()
	}()

	stdout, err := sess.StdoutPipe()
	if err != nil {
		return err
	}
	// Discard stderr — tmux may emit warnings there on older versions
	sess.Stderr = nil

	// tmux -C attach-session: enter control mode on the most-recently-used session.
	// Exits immediately if no sessions exist — we'll retry after backoff.
	if err := sess.Start("tmux -C attach-session 2>/dev/null"); err != nil {
		return err
	}

	c.log.Debug().Str("host", c.hostName).Msg("tmux control mode connected, listening for events")

	// Trigger an immediate discovery once we're connected
	c.triggerChange()

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		select {
		case <-c.stopCh:
			return nil
		default:
		}

		line := scanner.Text()
		if !strings.HasPrefix(line, "%") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}

		switch fields[0] {
		// Any of these mean sessions or windows changed
		case "%sessions-changed",
			"%session-created", "%session-closed", "%session-renamed",
			"%window-add", "%window-close", "%window-renamed",
			"%pane-exited", "%unlinked-window-close":
			c.log.Debug().Str("host", c.hostName).Str("event", fields[0]).Msg("tmux control event")
			c.triggerChange()
		}
	}

	_ = sess.Wait()
	return scanner.Err()
}

// triggerChange debounces onChange calls so a burst of events triggers only one
// discovery round.
func (c *ControlClient) triggerChange() {
	c.debounceMu.Lock()
	defer c.debounceMu.Unlock()
	if c.debounce != nil {
		c.debounce.Stop()
	}
	c.debounce = time.AfterFunc(400*time.Millisecond, func() {
		c.onChange(c.hostName)
	})
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
