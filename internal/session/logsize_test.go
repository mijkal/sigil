package session

import (
	"strconv"
	"strings"
	"testing"
)

// parseLogSizeLine mirrors the __L__ branch of DiscoverHost's parser. Kept in
// sync by hand; the point of the test is the size-parsing contract, which is
// where a silent failure hid for months.
func parseLogSizeLine(line string) (string, int64, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "__L__:") {
		return "", 0, false
	}
	rest := line[6:]
	i := strings.LastIndexByte(rest, ':')
	if i <= 0 {
		return "", 0, false
	}
	sz, _ := strconv.ParseInt(strings.TrimSpace(rest[i+1:]), 10, 64)
	return rest[:i], sz, true
}

// BSD `wc` right-aligns its count in a fixed-width column, so the size arrives
// padded on macOS. ParseInt rejects " 106" and the error is dropped, which read
// as "this session has produced no output at all" for every log on that host.
func TestLogSizeToleratesPaddedCount(t *testing.T) {
	for _, tc := range []struct {
		line string
		name string
		size int64
	}{
		{"__L__:_pt:106", "_pt", 106},
		{"__L__:_pt:     106", "_pt", 106},          // BSD wc padding
		{"__L__:bridge-eng: 20692465", "bridge-eng", 20692465},
		{"__L__:with space:  4096", "with space", 4096}, // names may contain spaces
		{"__L__:mctask-ab12:0", "mctask-ab12", 0},
	} {
		name, size, ok := parseLogSizeLine(tc.line)
		if !ok {
			t.Errorf("%q: not parsed", tc.line)
			continue
		}
		if name != tc.name || size != tc.size {
			t.Errorf("%q -> (%q, %d), want (%q, %d)", tc.line, name, size, tc.name, tc.size)
		}
	}
}

// The discovery command must not fan out per file. It ran `basename` and `wc`
// in command substitutions for every log, which on a host with 239 of them cost
// ~478 forks per tick and pushed discovery to 12-13.5s against a 20s timeout;
// ticks that overran returned nothing and pruned LIVE sessions after three
// misses. Measured after this change: 0.36s.
func TestLogSizeBlockDoesNotForkPerFile(t *testing.T) {
	if strings.Contains(logSizeBlock, "basename") {
		t.Error("logSizeBlock spawns basename per file — strip the path in awk instead")
	}
	if strings.Contains(logSizeBlock, "for f in") {
		t.Error("logSizeBlock loops per file — pass the whole glob to wc in one call")
	}
	if !strings.Contains(logSizeBlock, "wc -c") || !strings.Contains(logSizeBlock, "awk") {
		t.Errorf("expected a single wc + awk pipeline, got: %s", logSizeBlock)
	}
	// `wc` appends a "total" line for multiple files; emitting it would create a
	// phantom session named "total" in the registry.
	if !strings.Contains(logSizeBlock, `$0=="total"`) {
		t.Error("logSizeBlock must skip wc's trailing total line")
	}
}
