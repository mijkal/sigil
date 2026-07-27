package session

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	sshpool "sigil.dev/sigil/internal/ssh"
	sigil "sigil.dev/sigil/pkg/sigil"
)

const maxFileBytes = 512 * 1024 // 512 KB

// ReadFile reads a remote file via SSH and returns its content (up to 512 KB).
// Path may begin with "~/" — the shell on the remote host expands it.
func (m *Manager) ReadFile(hostName, path string) (sigil.FileContent, error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return sigil.FileContent{}, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	// Expand path (handles ~/…) without eval, reject directories, read up to
	// maxFileBytes+1 bytes. The prologue is concatenated as a plain string (it
	// already contains the shell-escaped path); only the suffix is a format.
	cmd := expandTildeSh(path) + fmt.Sprintf(
		` && printf '%%s\n' "$_P" && `+
			`{ [ ! -d "$_P" ] || { printf 'IS_A_DIRECTORY\n'; exit 1; }; } && `+
			`cat -- "$_P" 2>/dev/null | head -c %d`,
		maxFileBytes+1)

	out, err := sshpool.OutputWithTimeout(sess, cmd, sshpool.DefaultExecTimeout)
	if err != nil {
		return sigil.FileContent{}, fmt.Errorf("read file: %w", err)
	}

	// First line is the resolved path; rest is content.
	idx := strings.Index(string(out), "\n")
	if idx < 0 {
		return sigil.FileContent{Path: path}, nil
	}
	resolvedPath := strings.TrimSpace(string(out[:idx]))
	content := string(out[idx+1:])

	truncated := len(content) > maxFileBytes
	if truncated {
		content = content[:maxFileBytes]
	}

	return sigil.FileContent{
		Path:      resolvedPath,
		Content:   content,
		Truncated: truncated,
	}, nil
}

// ListDir lists a remote directory via SSH.
// Path may begin with "~/" — the shell on the remote host expands it.
// Returns up to 1000 entries, directories sorted before files.
func (m *Manager) ListDir(hostName, path string) (sigil.DirListing, error) {
	sess, err := m.pool.NewSession(hostName)
	if err != nil {
		return sigil.DirListing{}, fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	// Expand path, reject non-directories, print resolved path, then list entries.
	// find -printf outputs: type TAB size TAB filename
	cmd := expandTildeSh(path) + fmt.Sprintf(
		` && printf '%%s\n' "$_P" && `+
			`{ [ -d "$_P" ] || { printf 'NOT_A_DIRECTORY\n'; exit 1; }; } && `+
			`find "$_P" -maxdepth 1 -mindepth 1 \( -type f -o -type d -o -type l \) `+
			`-printf '%%y\t%%s\t%%f\n' 2>/dev/null | head -1000`)

	out, err := sshpool.OutputWithTimeout(sess, cmd, sshpool.DefaultExecTimeout)
	if err != nil {
		return sigil.DirListing{}, fmt.Errorf("list dir: %w", err)
	}

	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) == 0 {
		return sigil.DirListing{Path: path}, nil
	}

	resolvedPath := strings.TrimSpace(lines[0])
	entries := make([]sigil.DirEntry, 0, len(lines)-1)
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		isDir := parts[0] == "d"
		size, _ := strconv.ParseInt(parts[1], 10, 64)
		name := parts[2]
		if name == "" || name == "." || name == ".." {
			continue
		}
		entries = append(entries, sigil.DirEntry{
			Name:  name,
			IsDir: isDir,
			Size:  size,
		})
	}

	// Dirs first, then files; each group alphabetical.
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	return sigil.DirListing{Path: resolvedPath, Entries: entries}, nil
}
