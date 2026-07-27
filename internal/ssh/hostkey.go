package sshpool

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// buildHostKeyCallback returns an ssh.HostKeyCallback for the configured mode.
//
//	insecure — accept any key (the legacy ssh.InsecureIgnoreHostKey behaviour).
//	strict   — accept only keys already recorded in known_hosts; reject the rest.
//	tofu     — trust-on-first-use: record an unknown host's key and accept it,
//	           but reject a host whose key has CHANGED (the MITM signal). Fails
//	           OPEN on file I/O errors so a transient filesystem problem can
//	           never disconnect the whole fleet — only a genuine key change
//	           (mismatch against a recorded key) is ever rejected.
func buildHostKeyCallback(mode, knownHostsPath string) (ssh.HostKeyCallback, error) {
	if mode == "insecure" {
		return ssh.InsecureIgnoreHostKey(), nil
	}

	path := expandHome(knownHostsPath)
	// knownhosts.New errors if the file is missing — create an empty one.
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if mkErr := os.MkdirAll(filepath.Dir(path), 0o700); mkErr == nil {
			_ = os.WriteFile(path, nil, 0o600)
		}
	}

	base, err := knownhosts.New(path)
	if err != nil {
		if mode == "strict" {
			return nil, fmt.Errorf("load known_hosts %q: %w", path, err)
		}
		// tofu: can't read known_hosts → fail open (accept). Better an
		// unverified connection than a hub that can't reach any host.
		return ssh.InsecureIgnoreHostKey(), nil
	}
	if mode == "strict" {
		return base, nil
	}

	// tofu
	var mu sync.Mutex
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if err := base(hostname, remote, key); err != nil {
			var ke *knownhosts.KeyError
			if errors.As(err, &ke) {
				if len(ke.Want) > 0 {
					// Recorded key exists and DOES NOT match → possible MITM.
					return fmt.Errorf("host key mismatch for %s (possible MITM; refusing): %w", hostname, err)
				}
				// Unknown host → record it and accept (trust on first use).
				mu.Lock()
				_ = appendKnownHost(path, hostname, remote, key)
				mu.Unlock()
				return nil
			}
			// Any non-KeyError (parse/IO) → fail open.
			return nil
		}
		return nil
	}, nil
}

func appendKnownHost(path, hostname string, remote net.Addr, key ssh.PublicKey) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	addrs := []string{knownhosts.Normalize(hostname)}
	if remote != nil {
		if rn := knownhosts.Normalize(remote.String()); rn != addrs[0] {
			addrs = append(addrs, rn)
		}
	}
	_, err = f.WriteString(knownhosts.Line(addrs, key) + "\n")
	return err
}

// DefaultExecTimeout bounds a single remote command. The ssh.ClientConfig
// Timeout only covers the initial dial, so without this a host that accepts the
// connection but stalls in-exec pins the calling goroutine forever.
const DefaultExecTimeout = 20 * time.Second

// OutputWithTimeout runs sess.Output(cmd) but abandons it after `timeout`,
// closing the session (which unblocks the underlying read) and returning a
// timeout error. The caller still owns sess and should defer sess.Close().
func OutputWithTimeout(sess *ssh.Session, cmd string, timeout time.Duration) ([]byte, error) {
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() { out, err := sess.Output(cmd); done <- result{out, err} }()
	select {
	case r := <-done:
		return r.out, r.err
	case <-time.After(timeout):
		_ = sess.Close()
		return nil, fmt.Errorf("ssh exec timed out after %s", timeout)
	}
}
