package session

import (
	"sync"
	"testing"
)

// newTestClient builds a tmuxClient with no SSH session behind it. applySizeLocked
// skips the WindowChange when sess is nil, so the sizing/fan-out logic is testable
// without a host.
func newTestClient() *tmuxClient {
	return &tmuxClient{
		id:        "cl_test",
		key:       clientKey("h", "s", -1),
		hostName:  "h",
		sessName:  "s",
		sessionID: "h:s",
		subs:      make(map[*Channel]struct{}),
	}
}

func newTestViewer(rows, cols uint16) *Channel {
	return &Channel{
		ID:        "ch_test",
		SessionID: "h:s",
		HostName:  "h",
		Output:    make(chan OutputChunk, 8),
		rows:      rows,
		cols:      cols,
	}
}

func TestClientKeyDistinguishesTarget(t *testing.T) {
	same := clientKey("a Linux host", "Dodecki", -1)
	if got := clientKey("a Linux host", "Dodecki", -1); got != same {
		t.Errorf("same target produced different keys: %q vs %q", got, same)
	}
	for _, other := range []string{
		clientKey("host-a", "Dodecki", -1), // different host
		clientKey("a Linux host", "bridge", -1), // different session
		clientKey("a Linux host", "Dodecki", 0), // explicit window 0 != current window
		clientKey("a Linux host", "Dodecki", 1), // different window
	} {
		if other == same {
			t.Errorf("distinct targets collided on key %q", other)
		}
	}
	// Separator must not let a session name forge another target's key.
	if clientKey("h", "a\x00b", -1) == clientKey("h", "a", -1)+"\x00b" {
		t.Error("session name can forge a key")
	}
}

func TestSharedClientSizesToSmallestViewer(t *testing.T) {
	tc := newTestClient()

	big := newTestViewer(59, 122)
	if !tc.addSub(big) {
		t.Fatal("addSub on a live client returned false")
	}
	if tc.rows != 59 || tc.cols != 122 {
		t.Fatalf("single viewer: got %dx%d, want 59x122", tc.rows, tc.cols)
	}

	// A second, smaller viewer must pull the grid DOWN — otherwise it cannot
	// draw the whole window and tmux fills its pane with dots.
	small := newTestViewer(45, 112)
	tc.addSub(small)
	if tc.rows != 45 || tc.cols != 112 {
		t.Fatalf("two viewers: got %dx%d, want 45x112 (smallest)", tc.rows, tc.cols)
	}

	// Axes are minimised independently.
	tall := newTestViewer(80, 90)
	tc.addSub(tall)
	if tc.rows != 45 || tc.cols != 90 {
		t.Fatalf("three viewers: got %dx%d, want 45x90", tc.rows, tc.cols)
	}

	// When the small viewer leaves, the grid grows back for those still watching.
	if last := tc.removeSub(small); last {
		t.Fatal("removeSub reported last viewer while two remain")
	}
	if tc.rows != 59 || tc.cols != 90 {
		t.Fatalf("after small left: got %dx%d, want 59x90", tc.rows, tc.cols)
	}

	tc.removeSub(tall)
	if last := tc.removeSub(big); !last {
		t.Error("removeSub did not report the final viewer as last")
	}
}

func TestResizeOfOneViewerRecomputesEffectiveSize(t *testing.T) {
	tc := newTestClient()
	a, b := newTestViewer(50, 100), newTestViewer(40, 80)
	tc.addSub(a)
	tc.addSub(b)
	if tc.rows != 40 || tc.cols != 80 {
		t.Fatalf("got %dx%d, want 40x80", tc.rows, tc.cols)
	}

	// b's pane grew: the shared grid follows up to a's ceiling, not past it.
	tc.mu.Lock()
	b.rows, b.cols = 70, 200
	tc.applySizeLocked()
	tc.mu.Unlock()
	if tc.rows != 50 || tc.cols != 100 {
		t.Fatalf("after b grew: got %dx%d, want 50x100", tc.rows, tc.cols)
	}
}

func TestViewerWithNoStatedSizeIsIgnored(t *testing.T) {
	tc := newTestClient()
	sized := newTestViewer(30, 90)
	tc.addSub(sized)
	// A viewer that never stated a size (0x0) must not collapse the grid.
	tc.addSub(newTestViewer(0, 0))
	if tc.rows != 30 || tc.cols != 90 {
		t.Fatalf("got %dx%d, want 30x90", tc.rows, tc.cols)
	}
}

func TestBroadcastReachesEveryViewer(t *testing.T) {
	tc := newTestClient()
	a, b := newTestViewer(24, 80), newTestViewer(24, 80)
	tc.addSub(a)
	tc.addSub(b)

	tc.broadcast(OutputChunk{Data: []byte("hello"), Seq: 7})
	for name, ch := range map[string]*Channel{"a": a, "b": b} {
		select {
		case chunk := <-ch.Output:
			if string(chunk.Data) != "hello" || chunk.Seq != 7 {
				t.Errorf("viewer %s got %q/%d, want \"hello\"/7", name, chunk.Data, chunk.Seq)
			}
		default:
			t.Errorf("viewer %s received nothing", name)
		}
	}
}

func TestBroadcastDoesNotBlockOnAStalledViewer(t *testing.T) {
	tc := newTestClient()
	stalled := &Channel{Output: make(chan OutputChunk)} // unbuffered, never drained
	live := newTestViewer(24, 80)
	tc.addSub(stalled)
	tc.addSub(live)

	done := make(chan struct{})
	go func() {
		tc.broadcast(OutputChunk{Data: []byte("x"), Seq: 1})
		close(done)
	}()
	select {
	case <-done:
	case <-make(chan struct{}):
	}
	<-done // would deadlock the test (and the daemon) if broadcast blocked

	if len(live.Output) != 1 {
		t.Error("a stalled viewer starved a live one")
	}
}

func TestShutdownClosesEveryViewerExactlyOnce(t *testing.T) {
	tc := newTestClient()
	a, b := newTestViewer(24, 80), newTestViewer(24, 80)
	tc.addSub(a)
	tc.addSub(b)

	tc.shutdown()
	for name, ch := range map[string]*Channel{"a": a, "b": b} {
		if _, open := <-ch.Output; open {
			t.Errorf("viewer %s queue still open after shutdown", name)
		}
		if !ch.Closed {
			t.Errorf("viewer %s not marked closed", name)
		}
	}

	// Both the reader-closer and sess.Wait() call shutdown, and an explicit
	// Detach closes a viewer too — none of it may double-close.
	tc.shutdown()
	a.closeOutput()

	if !tc.closed {
		t.Error("client not marked closed")
	}
	// A late join must be refused so the caller opens a fresh backend.
	if tc.addSub(newTestViewer(24, 80)) {
		t.Error("addSub succeeded on a closed client")
	}
}

func TestConcurrentViewerChurnIsRaceFree(t *testing.T) {
	tc := newTestClient()
	keep := newTestViewer(40, 100)
	tc.addSub(keep)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := newTestViewer(uint16(30+i), uint16(90+i))
			if tc.addSub(v) {
				tc.broadcast(OutputChunk{Data: []byte("tick"), Seq: uint64(i)})
				tc.removeSub(v)
			}
		}(i)
	}
	wg.Wait()

	if got := tc.subCount(); got != 1 {
		t.Errorf("subCount = %d, want 1 (only the keeper remains)", got)
	}
	if tc.rows != 40 || tc.cols != 100 {
		t.Errorf("grid = %dx%d, want the keeper's 40x100 after churn", tc.rows, tc.cols)
	}
}
