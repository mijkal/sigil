package events

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"sigil.dev/sigil/internal/db"
	sigil "sigil.dev/sigil/pkg/sigil"
)

func newTestBus(t *testing.T) (*Bus, *db.DB) {
	t.Helper()
	d, err := db.New(filepath.Join(t.TempDir(), "bus.db"))
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return New(d), d
}

func TestHasOutputTriggersGate(t *testing.T) {
	b, d := newTestBus(t)
	b.LoadTriggers()
	if b.HasOutputTriggers() {
		t.Fatal("gate should be closed with no triggers")
	}
	if err := d.InsertTrigger(sigil.Trigger{
		ID: "t1", Name: "err", Pattern: "ERROR", Action: "flash", Enabled: true,
	}); err != nil {
		t.Fatalf("InsertTrigger: %v", err)
	}
	b.LoadTriggers()
	if !b.HasOutputTriggers() {
		t.Fatal("gate should be open after adding an enabled trigger")
	}
}

func TestDisabledTriggerKeepsGateClosed(t *testing.T) {
	b, d := newTestBus(t)
	_ = d.InsertTrigger(sigil.Trigger{ID: "t1", Name: "x", Pattern: "ERROR", Action: "flash", Enabled: false})
	b.LoadTriggers()
	if b.HasOutputTriggers() {
		t.Fatal("disabled trigger must not open the gate")
	}
}

func TestInvalidPatternKeepsGateClosed(t *testing.T) {
	b, d := newTestBus(t)
	_ = d.InsertTrigger(sigil.Trigger{ID: "t1", Name: "x", Pattern: "([", Action: "flash", Enabled: true})
	b.LoadTriggers()
	if b.HasOutputTriggers() {
		t.Fatal("uncompilable pattern must not open the gate")
	}
}

func TestUIActionFiresOnMatch(t *testing.T) {
	b, d := newTestBus(t)
	_ = d.InsertTrigger(sigil.Trigger{
		ID: "t1", Name: "boom", Pattern: "ERROR", Action: "flash", Enabled: true,
		Config: map[string]interface{}{"debounce_ms": float64(0)},
	})
	b.LoadTriggers()

	var mu sync.Mutex
	var got []UIAction
	b.SetUIActionHook(func(a UIAction) {
		mu.Lock()
		got = append(got, a)
		mu.Unlock()
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.Run(ctx)

	b.Publish(sigil.Event{Type: "session.output", Data: map[string]interface{}{"session": "h:s", "output": "boot ok"}})
	b.Publish(sigil.Event{Type: "session.output", Data: map[string]interface{}{"session": "h:s", "output": "fatal ERROR here"}})

	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 1 })

	mu.Lock()
	defer mu.Unlock()
	if got[0].Action != "flash" || got[0].Trigger != "boom" || got[0].SessionID != "h:s" {
		t.Fatalf("unexpected action: %+v", got[0])
	}
	if got[0].Match != "fatal ERROR here" {
		t.Fatalf("match = %q", got[0].Match)
	}
}

func TestDebounceSuppressesRepeat(t *testing.T) {
	b, d := newTestBus(t)
	_ = d.InsertTrigger(sigil.Trigger{
		ID: "t1", Name: "boom", Pattern: "ERROR", Action: "toast", Enabled: true,
		Config: map[string]interface{}{"debounce_ms": float64(10000)},
	})
	b.LoadTriggers()

	var mu sync.Mutex
	n := 0
	b.SetUIActionHook(func(a UIAction) { mu.Lock(); n++; mu.Unlock() })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.Run(ctx)

	for i := 0; i < 5; i++ {
		b.Publish(sigil.Event{Type: "session.output", Data: map[string]interface{}{"session": "h:s", "output": "ERROR x"}})
	}
	// Give the dispatch goroutine time to process all five.
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return n >= 1 })
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if n != 1 {
		t.Fatalf("debounce failed: fired %d times, want 1", n)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}
