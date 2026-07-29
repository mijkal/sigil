package session

import (
	"testing"
	"time"
)

// The behaviour these lock down is the 2026-07-29 incident: a client re-attached
// to a pruned session ~1/sec for 45 minutes, exhausted the host's SSH channels
// (MaxSessions defaults to 10), starved discovery, and got seven healthy sessions
// pruned as collateral. The guard must make that impossible from the hub side no
// matter how badly a client behaves.

func TestAttachGuard_AllowsHealthyTarget(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	for i := 0; i < 50; i++ {
		if ok, _ := g.allow("h:s", now); !ok {
			t.Fatalf("attach %d refused on a target with no failures", i)
		}
	}
}

func TestAttachGuard_TripsAfterBudget(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	for i := 0; i < attachFailBudget-1; i++ {
		if tripped := g.recordFailure("h:s", now); tripped {
			t.Fatalf("tripped early at failure %d (budget %d)", i+1, attachFailBudget)
		}
		if ok, _ := g.allow("h:s", now); !ok {
			t.Fatalf("refused before the budget was spent (failure %d)", i+1)
		}
	}
	if tripped := g.recordFailure("h:s", now); !tripped {
		t.Fatalf("did not trip on failure %d", attachFailBudget)
	}
	ok, retry := g.allow("h:s", now)
	if ok {
		t.Fatal("still allowing attaches after the breaker tripped")
	}
	if retry <= 0 || retry > attachCooldown {
		t.Fatalf("retry hint %v outside (0, %v]", retry, attachCooldown)
	}
}

func TestAttachGuard_CooldownExpiresAndAllowsOneProbe(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	for i := 0; i < attachFailBudget; i++ {
		g.recordFailure("h:s", now)
	}
	if ok, _ := g.allow("h:s", now); ok {
		t.Fatal("expected refusal inside the cooldown")
	}
	// One instant before expiry it is still refused.
	if ok, _ := g.allow("h:s", now.Add(attachCooldown-time.Millisecond)); ok {
		t.Fatal("cooldown expired too early")
	}
	// After the cooldown a single probe is admitted.
	after := now.Add(attachCooldown + time.Millisecond)
	if ok, _ := g.allow("h:s", after); !ok {
		t.Fatal("probe refused after the cooldown served")
	}
	// A dead target fails that probe and must trip again immediately, so the
	// steady-state cost of a permanently dead session is one attach per cooldown
	// — not a storm.
	if tripped := g.recordFailure("h:s", after); !tripped {
		t.Fatal("failed probe did not re-trip the breaker")
	}
	if ok, _ := g.allow("h:s", after); ok {
		t.Fatal("allowing attaches again after the probe failed")
	}
}

func TestAttachGuard_DurableSuccessClearsHistory(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	// Partial failure history, then a channel that stayed up.
	for i := 0; i < attachFailBudget-1; i++ {
		g.recordFailure("h:s", now)
	}
	g.recordSuccess("h:s")
	// Budget must be full again — a transient blip earlier in the day cannot
	// contribute to tripping hours later.
	for i := 0; i < attachFailBudget-1; i++ {
		if tripped := g.recordFailure("h:s", now); tripped {
			t.Fatalf("tripped at failure %d after a durable success reset the budget", i+1)
		}
	}
}

func TestAttachGuard_TargetsAreIndependent(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	for i := 0; i < attachFailBudget; i++ {
		g.recordFailure("h:dead", now)
	}
	if ok, _ := g.allow("h:dead", now); ok {
		t.Fatal("dead target should be tripped")
	}
	if ok, _ := g.allow("h:healthy", now); !ok {
		t.Fatal("a tripped target must not affect a different session")
	}
	if ok, _ := g.allow("other:dead", now); !ok {
		t.Fatal("a tripped target must not affect the same name on another host")
	}
}

func TestAttachGuard_ForgetClearsState(t *testing.T) {
	g := newAttachGuard()
	now := time.Now()
	for i := 0; i < attachFailBudget; i++ {
		g.recordFailure("h:s", now)
	}
	g.forget("h:s")
	if ok, _ := g.allow("h:s", now); !ok {
		t.Fatal("forget did not clear the breaker — a recreated session would stay locked out")
	}
}

func TestErrAttachCoolingDown_MessageIsActionable(t *testing.T) {
	e := &ErrAttachCoolingDown{Target: "jupiter:nextstep", Retry: 42 * time.Second}
	msg := e.Error()
	for _, want := range []string{"jupiter:nextstep", "42s", "no longer exists"} {
		if !contains(msg, want) {
			t.Fatalf("error message %q missing %q — the UI needs to say something true", msg, want)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
