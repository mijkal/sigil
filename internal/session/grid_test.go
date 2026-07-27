package session

import "testing"

// The shared pty is sized to the smallest live viewer. That is deliberate for
// COLS (a narrower viewer simply cannot see the right edge, and the wider one
// gets blank space beside the window). For ROWS it produced the "stuck text"
// bug: tmux paints only `rows` lines and a taller viewer's remaining rows keep
// whatever was drawn there before, forever.
//
// Two things had to hold to fix it:
//   - a GHOST (viewer whose socket dropped, kept only as a replay feeder) must
//     not constrain the grid — it has no screen to draw;
//   - the effective grid must be observable, so a viewer can shrink its own
//     terminal to match instead of keeping rows nothing will ever paint.

func subs(chs ...*Channel) map[*Channel]struct{} {
	m := make(map[*Channel]struct{}, len(chs))
	for _, c := range chs {
		m[c] = struct{}{}
	}
	return m
}

func TestSmallestGridMinimisesPerAxis(t *testing.T) {
	tall := &Channel{rows: 60, cols: 100}
	wide := &Channel{rows: 20, cols: 200}
	rows, cols := smallestGrid(subs(tall, wide))
	if rows != 20 || cols != 100 {
		t.Fatalf("want 20x100 (per-axis intersection), got %dx%d", rows, cols)
	}
}

func TestGhostDoesNotConstrainGrid(t *testing.T) {
	live := &Channel{rows: 60, cols: 200}
	gone := &Channel{rows: 20, cols: 200, ghost: true}
	rows, cols := smallestGrid(subs(live, gone))
	if rows != 60 || cols != 200 {
		t.Fatalf("a departed viewer must not pin the grid: want 60x200, got %dx%d", rows, cols)
	}
}

func TestGhostStillCountsWhenNoLiveViewerRemains(t *testing.T) {
	// Otherwise the grid would collapse to 0 and applySizeLocked would skip the
	// update, leaving the pty at a stale size with nothing driving it.
	g1 := &Channel{rows: 24, cols: 80, ghost: true}
	g2 := &Channel{rows: 40, cols: 120, ghost: true}
	rows, cols := smallestGrid(subs(g1, g2))
	if rows != 24 || cols != 80 {
		t.Fatalf("all-ghost fallback: want 24x80, got %dx%d", rows, cols)
	}
}

func TestUnsizedViewerIsIgnored(t *testing.T) {
	sized := &Channel{rows: 30, cols: 90}
	unsized := &Channel{} // attached but never stated a size
	rows, cols := smallestGrid(subs(sized, unsized))
	if rows != 30 || cols != 90 {
		t.Fatalf("want 30x90, got %dx%d", rows, cols)
	}
}

func TestNotifyGridKeepsOnlyTheNewestValue(t *testing.T) {
	ch := &Channel{Grid: make(chan [2]uint16, 1)}
	ch.notifyGrid(60, 200)
	ch.notifyGrid(20, 200) // supersedes the queued one
	got := <-ch.Grid
	if got != [2]uint16{20, 200} {
		t.Fatalf("want newest 20x200, got %dx%d", got[0], got[1])
	}
	select {
	case extra := <-ch.Grid:
		t.Fatalf("queue should be drained, got extra %dx%d", extra[0], extra[1])
	default:
	}
}

func TestNotifyGridNeverBlocksOnNilOrFullQueue(t *testing.T) {
	(&Channel{}).notifyGrid(24, 80) // nil queue — must be a no-op, not a panic
	ch := &Channel{Grid: make(chan [2]uint16, 1)}
	for i := 0; i < 100; i++ {
		ch.notifyGrid(uint16(i), 80) // never drained; must not block
	}
}

// --- end-to-end through tmuxClient (no SSH: applySizeLocked skips the
// WindowChange when sess is nil, so the sizing + fan-out logic is exercised) ---

func gridViewer(rows, cols uint16) *Channel {
	c := newTestViewer(rows, cols)
	c.Grid = make(chan [2]uint16, 1)
	return c
}

// drain returns the latest grid this viewer was told about, if any.
func drain(c *Channel) ([2]uint16, bool) {
	select {
	case g := <-c.Grid:
		return g, true
	default:
		return [2]uint16{}, false
	}
}

// The taller viewer must be TOLD the pty shrank. That notification is what lets
// it size its own terminal down; without it, it keeps rows tmux never paints and
// they hold the previous frame — the stuck-text bug.
func TestTallViewerIsToldWhenPtyShrinks(t *testing.T) {
	tc := newTestClient()
	tall := gridViewer(60, 200)
	if !tc.addSub(tall) {
		t.Fatal("addSub failed")
	}
	drain(tall) // clear the initial 60x200 notification

	short := gridViewer(20, 200)
	tc.addSub(short)

	got, ok := drain(tall)
	if !ok {
		t.Fatal("tall viewer was never told the grid changed")
	}
	if got != [2]uint16{20, 200} {
		t.Fatalf("tall viewer told %dx%d, want the effective 20x200", got[0], got[1])
	}
}

// A viewer whose socket dropped is parked as a ghost. It must stop constraining
// the grid immediately, and the survivors must be told it grew back — previously
// the old size stuck for the whole 3-minute detach grace (measured: 182s).
func TestGhostReleasesGridImmediately(t *testing.T) {
	tc := newTestClient()
	tall := gridViewer(60, 200)
	short := gridViewer(20, 200)
	tc.addSub(tall)
	tc.addSub(short)

	tc.mu.Lock()
	if tc.rows != 20 {
		tc.mu.Unlock()
		t.Fatalf("precondition: want pty pinned to 20, got %d", tc.rows)
	}
	drain(tall)
	// What DetachAfter now does the moment the socket drops.
	short.ghost = true
	tc.applySizeLocked()
	rows, cols := tc.rows, tc.cols
	tc.mu.Unlock()

	if rows != 60 || cols != 200 {
		t.Fatalf("ghost still pinning the grid: got %dx%d, want 60x200", rows, cols)
	}
	got, ok := drain(tall)
	if !ok || got != [2]uint16{60, 200} {
		t.Fatalf("tall viewer not told about recovery: %v %v", got, ok)
	}
}

// Removing the small viewer entirely must also restore the grid (the path when
// an explicit detach beats the grace timer).
func TestRemovingSmallViewerRestoresGrid(t *testing.T) {
	tc := newTestClient()
	tall := gridViewer(60, 200)
	short := gridViewer(20, 200)
	tc.addSub(tall)
	tc.addSub(short)

	if last := tc.removeSub(short); last {
		t.Fatal("removeSub reported last viewer while one remains")
	}
	tc.mu.Lock()
	rows, cols := tc.rows, tc.cols
	tc.mu.Unlock()
	if rows != 60 || cols != 200 {
		t.Fatalf("grid did not grow back: got %dx%d, want 60x200", rows, cols)
	}
}
