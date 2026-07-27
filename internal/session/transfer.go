package session

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

// File transfer over SSH exec sessions (no sftp dependency — consistent with
// files.go). Paths may begin with ~/ — resolvePath expands them on the host.

// resolvePath expands ~ / globs to an absolute path on the host. Uses the same
// `eval echo` trick as ReadFile: the outer shell strips the quotes, then eval
// re-parses with the ~ unquoted so it expands. Works for not-yet-existing
// destinations too (echo doesn't require the path to exist).
func (m *Manager) resolvePath(hostName, path string) (string, error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	// Safe ~ expansion (no eval — see expandTildeSh). Concatenated as a plain
	// string so a '%' in the path stays data.
	out, err := sess.Output(expandTildeSh(path) + `; printf '%s\n' "$_P"`)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	p := strings.TrimSpace(string(out))
	if p == "" {
		return "", fmt.Errorf("could not resolve path %q", path)
	}
	return p, nil
}

// pathExists reports whether an (already-resolved) path exists on the host.
func (m *Manager) pathExists(hostName, resolved string) (bool, error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return false, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	out, err := sess.Output(fmt.Sprintf("[ -e %s ] && echo EXISTS || echo NO", shellEscape(resolved)))
	if err != nil {
		return false, fmt.Errorf("stat: %w", err)
	}
	return strings.TrimSpace(string(out)) == "EXISTS", nil
}

// StatRemote resolves a path and returns its size and whether it's a directory.
func (m *Manager) StatRemote(hostName, path string) (resolved string, size int64, isDir bool, err error) {
	resolved, err = m.resolvePath(hostName, path)
	if err != nil {
		return "", 0, false, err
	}
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", 0, false, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	// Print "<size>\t<d|f>" — `stat` size then a type flag.
	cmd := fmt.Sprintf(
		`if [ -d %s ]; then printf "0\td\n"; elif [ -e %s ]; then printf "%%s\tf\n" "$(stat -c %%s %s 2>/dev/null || stat -f %%z %s)"; else echo MISSING; fi`,
		shellEscape(resolved), shellEscape(resolved), shellEscape(resolved), shellEscape(resolved),
	)
	out, err := sess.Output(cmd)
	if err != nil {
		return "", 0, false, fmt.Errorf("stat: %w", err)
	}
	s := strings.TrimSpace(string(out))
	if s == "MISSING" {
		return "", 0, false, fmt.Errorf("no such file: %s", resolved)
	}
	parts := strings.SplitN(s, "\t", 2)
	if len(parts) == 2 {
		size, _ = strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		isDir = strings.TrimSpace(parts[1]) == "d"
	}
	return resolved, size, isDir, nil
}

// WriteFile streams r into destPath on the host (creating parent dirs). When
// overwrite is false it fails if the destination already exists. Returns the
// resolved absolute path written.
func (m *Manager) WriteFile(hostName, destPath string, r io.Reader, overwrite bool) (string, error) {
	resolved, err := m.resolvePath(hostName, destPath)
	if err != nil {
		return "", err
	}
	if !overwrite {
		exists, err := m.pathExists(hostName, resolved)
		if err != nil {
			return "", err
		}
		if exists {
			return "", fmt.Errorf("file exists: %s", resolved)
		}
	}
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	stdin, err := sess.StdinPipe()
	if err != nil {
		return "", fmt.Errorf("stdin pipe: %w", err)
	}
	cmd := fmt.Sprintf(`mkdir -p "$(dirname %s)" && cat > %s`, shellEscape(resolved), shellEscape(resolved))
	if err := sess.Start(cmd); err != nil {
		return "", fmt.Errorf("start write: %w", err)
	}
	_, copyErr := io.Copy(stdin, r)
	closeErr := stdin.Close()
	waitErr := sess.Wait()
	if copyErr != nil {
		return "", fmt.Errorf("stream upload: %w", copyErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close stdin: %w", closeErr)
	}
	if waitErr != nil {
		return "", fmt.Errorf("remote write failed: %w", waitErr)
	}
	return resolved, nil
}

// StreamFile writes the contents of an already-resolved file path to w.
func (m *Manager) StreamFile(hostName, resolvedPath string, w io.Writer) error {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	if err := sess.Start(fmt.Sprintf("cat -- %s", shellEscape(resolvedPath))); err != nil {
		return fmt.Errorf("start read: %w", err)
	}
	if _, err := io.Copy(w, stdout); err != nil {
		return fmt.Errorf("stream download: %w", err)
	}
	return sess.Wait()
}

// MovePath / CopyPath operate within a single host. Both src and dst are
// resolved first (so ~ expands), then mv/cp run on the absolute paths.
func (m *Manager) MovePath(hostName, src, dst string, overwrite bool) (string, error) {
	return m.relocate(hostName, src, dst, overwrite, "mv --")
}

func (m *Manager) CopyPath(hostName, src, dst string, overwrite bool) (string, error) {
	return m.relocate(hostName, src, dst, overwrite, "cp -r --")
}

func (m *Manager) relocate(hostName, src, dst string, overwrite bool, op string) (string, error) {
	srcResolved, err := m.resolvePath(hostName, src)
	if err != nil {
		return "", fmt.Errorf("resolve source: %w", err)
	}
	dstResolved, err := m.resolvePath(hostName, dst)
	if err != nil {
		return "", fmt.Errorf("resolve dest: %w", err)
	}
	if !overwrite {
		exists, err := m.pathExists(hostName, dstResolved)
		if err != nil {
			return "", err
		}
		if exists {
			return "", fmt.Errorf("destination exists: %s", dstResolved)
		}
	}
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	cmd := fmt.Sprintf(`mkdir -p "$(dirname %s)" && %s %s %s`,
		shellEscape(dstResolved), op, shellEscape(srcResolved), shellEscape(dstResolved))
	if out, err := sess.CombinedOutput(cmd); err != nil {
		return "", fmt.Errorf("%s: %s", strings.Fields(op)[0], strings.TrimSpace(string(out)))
	}
	return dstResolved, nil
}

// TransferBetweenHosts streams a file from one host to another through the hub.
func (m *Manager) TransferBetweenHosts(srcHost, srcPath, dstHost, dstPath string, overwrite bool) (string, error) {
	srcResolved, _, isDir, err := m.StatRemote(srcHost, srcPath)
	if err != nil {
		return "", fmt.Errorf("source: %w", err)
	}
	if isDir {
		return "", fmt.Errorf("source is a directory (host-to-host transfer supports files only)")
	}
	dstResolved, err := m.resolvePath(dstHost, dstPath)
	if err != nil {
		return "", fmt.Errorf("resolve dest: %w", err)
	}
	if !overwrite {
		exists, err := m.pathExists(dstHost, dstResolved)
		if err != nil {
			return "", err
		}
		if exists {
			return "", fmt.Errorf("destination exists: %s", dstResolved)
		}
	}

	readSess, err := m.pool.NewSession(srcHost)
	if err != nil {
		return "", fmt.Errorf("source ssh: %w", err)
	}
	defer readSess.Close()
	writeSess, err := m.pool.NewSession(dstHost)
	if err != nil {
		return "", fmt.Errorf("dest ssh: %w", err)
	}
	defer writeSess.Close()

	srcOut, err := readSess.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("source stdout: %w", err)
	}
	dstIn, err := writeSess.StdinPipe()
	if err != nil {
		return "", fmt.Errorf("dest stdin: %w", err)
	}

	if err := writeSess.Start(fmt.Sprintf(`mkdir -p "$(dirname %s)" && cat > %s`, shellEscape(dstResolved), shellEscape(dstResolved))); err != nil {
		return "", fmt.Errorf("start dest write: %w", err)
	}
	if err := readSess.Start(fmt.Sprintf("cat -- %s", shellEscape(srcResolved))); err != nil {
		return "", fmt.Errorf("start source read: %w", err)
	}

	_, copyErr := io.Copy(dstIn, srcOut)
	dstIn.Close()
	readErr := readSess.Wait()
	writeErr := writeSess.Wait()
	if copyErr != nil {
		return "", fmt.Errorf("relay: %w", copyErr)
	}
	if readErr != nil {
		return "", fmt.Errorf("source read failed: %w", readErr)
	}
	if writeErr != nil {
		return "", fmt.Errorf("dest write failed: %w", writeErr)
	}
	return dstResolved, nil
}
