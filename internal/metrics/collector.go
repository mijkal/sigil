// Package metrics collects lightweight per-host resource stats (load, memory,
// CPU/memory pressure, disk, network, top processes) over sigild's existing SSH
// connections and exposes them for the REST API and WS push.
//
// Design notes:
//   - One probe = one SSH session running a POSIX-sh script delivered over
//     STDIN (`sh -s`). Stdin delivery avoids the argv-quoting mangling that
//     nested `ssh "sh -c '...'"` inflicts on awk scripts, and forces sh even
//     when the remote login shell is fish/zsh.
//   - Static host info (CPU model, cores, totals, OS) is collected once per
//     host and cached; the periodic probe only gathers the cheap dynamic bits.
//   - A bounded ring buffer per host feeds the UI time-series graphs. Nothing
//     is persisted — this is live telemetry, lost on restart by design.
package metrics

import (
	"bufio"
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	sshpool "sigil.dev/sigil/internal/ssh"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// ringSize caps the per-host history (samples). At a 5s interval, 60 samples ≈
// 5 minutes of graph history.
const ringSize = 60

// procSkip are command names belonging to the probe itself (or its pipeline),
// which otherwise show up at the top of the CPU list as sampling artifacts.
var procSkip = map[string]bool{
	"ps": true, "sh": true, "awk": true, "df": true,
	"vm_stat": true, "netstat": true, "sysctl": true, "sshd-session:": true,
}

type hostState struct {
	info    sigil.HostInfo
	infoOK  bool
	history []sigil.MetricSample
	procs   []sigil.ProcInfo
	health  string
	stale   bool
	lastErr string
}

// Collector periodically probes connected hosts and caches their metrics.
type Collector struct {
	pool *sshpool.Pool
	log  zerolog.Logger
	push func(sigil.HostMetrics) // called after each successful (or failed) probe

	mu    sync.RWMutex
	state map[string]*hostState
}

// New creates a Collector. push may be nil (e.g. in tests); when set it is
// invoked once per host per tick with the freshly-computed metrics.
func New(pool *sshpool.Pool, push func(sigil.HostMetrics)) *Collector {
	return &Collector{
		pool:  pool,
		log:   zerolog.Nop(),
		push:  push,
		state: make(map[string]*hostState),
	}
}

func (c *Collector) SetLogger(l zerolog.Logger) { c.log = l }

// Start runs the collection loop until ctx is cancelled. It probes immediately,
// then every intervalSec seconds.
func (c *Collector) Start(ctx context.Context, intervalSec int) {
	if intervalSec <= 0 {
		intervalSec = 5
	}
	go func() {
		c.collectAll()
		t := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.collectAll()
			}
		}
	}()
}

func (c *Collector) collectAll() {
	for _, host := range c.pool.GetConnectedHosts() {
		go c.collectHost(host)
	}
}

// GetMetrics returns the current metrics snapshot for one host.
func (c *Collector) GetMetrics(host string) (sigil.HostMetrics, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	st, ok := c.state[host]
	if !ok {
		return sigil.HostMetrics{}, false
	}
	return c.snapshotLocked(host, st), true
}

// GetAll returns metrics for every host probed so far.
func (c *Collector) GetAll() []sigil.HostMetrics {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]sigil.HostMetrics, 0, len(c.state))
	for host, st := range c.state {
		out = append(out, c.snapshotLocked(host, st))
	}
	return out
}

func (c *Collector) snapshotLocked(host string, st *hostState) sigil.HostMetrics {
	var cur sigil.MetricSample
	if n := len(st.history); n > 0 {
		cur = st.history[n-1]
	}
	// Copy the ring so callers can't mutate our backing array.
	hist := make([]sigil.MetricSample, len(st.history))
	copy(hist, st.history)
	procs := make([]sigil.ProcInfo, len(st.procs))
	copy(procs, st.procs)
	return sigil.HostMetrics{
		Host:    host,
		Health:  st.health,
		Info:    st.info,
		Current: cur,
		History: hist,
		Procs:   procs,
		Stale:   st.stale,
		Error:   st.lastErr,
	}
}

func (c *Collector) collectHost(host string) {
	c.mu.Lock()
	st := c.state[host]
	if st == nil {
		st = &hostState{health: sigil.HealthUnknown}
		c.state[host] = st
	}
	needInfo := !st.infoOK
	c.mu.Unlock()

	// One-time static info.
	if needInfo {
		if info, err := c.probeInfo(host); err == nil {
			c.mu.Lock()
			st.info = info
			st.infoOK = true
			c.mu.Unlock()
		} else {
			c.log.Debug().Err(err).Str("host", host).Msg("host info probe failed")
		}
	}

	c.mu.RLock()
	isDarwin := st.info.OS == "darwin"
	c.mu.RUnlock()

	sample, procs, err := c.probeDynamic(host, isDarwin)

	c.mu.Lock()
	if err != nil {
		st.stale = true
		st.lastErr = err.Error()
		// Keep prior history/health so the UI shows last-known instead of blanking.
		c.mu.Unlock()
		c.log.Debug().Err(err).Str("host", host).Msg("metrics probe failed")
		if c.push != nil {
			c.mu.RLock()
			snap := c.snapshotLocked(host, st)
			c.mu.RUnlock()
			c.push(snap)
		}
		return
	}
	st.stale = false
	st.lastErr = ""
	st.procs = procs
	st.history = append(st.history, sample)
	if len(st.history) > ringSize {
		st.history = st.history[len(st.history)-ringSize:]
	}
	st.health = computeHealth(st.info, sample)
	snap := c.snapshotLocked(host, st)
	c.mu.Unlock()

	if c.push != nil {
		c.push(snap)
	}
}

// runProbe executes a POSIX-sh script on host via stdin and returns stdout.
func (c *Collector) runProbe(host, script string) (string, error) {
	sess, err := c.pool.NewSession(host)
	if err != nil {
		return "", err
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(script)
	out, err := sshpool.OutputWithTimeout(sess, "sh -s", sshpool.DefaultExecTimeout)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (c *Collector) probeInfo(host string) (sigil.HostInfo, error) {
	// Probe OS first via the tiny cross-platform static script; it branches
	// internally so one round-trip works for both Linux and macOS.
	out, err := c.runProbe(host, staticProbe)
	if err != nil {
		return sigil.HostInfo{}, err
	}
	return parseInfo(out), nil
}

func (c *Collector) probeDynamic(host string, darwin bool) (sigil.MetricSample, []sigil.ProcInfo, error) {
	script := linuxDynamic
	if darwin {
		script = darwinDynamic
	}
	out, err := c.runProbe(host, script)
	if err != nil {
		return sigil.MetricSample{}, nil, err
	}
	s, procs := parseDynamic(out)
	return s, procs, nil
}

// ── parsing ──────────────────────────────────────────────────────────────

func parseInfo(out string) sigil.HostInfo {
	var info sigil.HostInfo
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "OS":
			info.OS = v
		case "OSPRETTY":
			info.OSPretty = v
		case "KERNEL":
			info.Kernel = v
		case "ARCH":
			info.Arch = v
		case "CPU":
			info.CPUModel = v
		case "CORES":
			info.Cores = atoiSafe(v)
		case "MEMTOTAL":
			info.MemTotal = atoi64Safe(v)
		case "DISKTOTAL":
			info.DiskTotal = atoi64Safe(v)
		case "HASPSI":
			info.HasPSI = v == "1"
		}
	}
	return info
}

func parseDynamic(out string) (sigil.MetricSample, []sigil.ProcInfo) {
	s := sigil.MetricSample{PSICPU: -1, PSIMem: -1}
	var procs []sigil.ProcInfo
	inProcs := false
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if line == "PROCS:" {
			inProcs = true
			continue
		}
		if inProcs {
			f := strings.Fields(line)
			if len(f) < 3 {
				continue
			}
			name := f[2]
			if procSkip[name] {
				continue
			}
			procs = append(procs, sigil.ProcInfo{
				CPU:  atofSafe(f[0]),
				Mem:  atofSafe(f[1]),
				Name: name,
			})
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		switch k {
		case "T":
			s.T = atoi64Safe(v)
		case "LOAD":
			if len(f) >= 3 {
				s.Load1, s.Load5, s.Load15 = atofSafe(f[0]), atofSafe(f[1]), atofSafe(f[2])
			}
		case "PSICPU":
			s.PSICPU = atofSafe(v)
		case "PSIMEM":
			s.PSIMem = atofSafe(v)
		case "MEM":
			if len(f) >= 2 {
				s.MemTotal, s.MemUsed = atoi64Safe(f[0]), atoi64Safe(f[1])
			}
		case "SWAP":
			if len(f) >= 2 {
				s.SwapTotal, s.SwapUsed = atoi64Safe(f[0]), atoi64Safe(f[1])
			}
		case "DISK":
			if len(f) >= 2 {
				s.DiskTotal, s.DiskUsed = atoi64Safe(f[0]), atoi64Safe(f[1])
			}
		case "NET":
			if len(f) >= 2 {
				s.NetRx, s.NetTx = atoi64Safe(f[0]), atoi64Safe(f[1])
			}
		}
	}
	// Cap the process list.
	if len(procs) > 5 {
		procs = procs[:5]
	}
	return s, procs
}

// computeHealth maps a sample onto healthy/warn/err using the worst of several
// signals. On Linux the PSI signals dominate (they detect stall before load
// spikes); macOS falls back to load-per-core, memory% and disk%.
func computeHealth(info sigil.HostInfo, s sigil.MetricSample) string {
	score := 0 // 0 healthy, 1 warn, 2 err
	bump := func(warn, err bool) {
		if err && score < 2 {
			score = 2
		} else if warn && score < 1 {
			score = 1
		}
	}
	if info.HasPSI {
		if s.PSIMem >= 0 {
			bump(s.PSIMem > 15, s.PSIMem > 40)
		}
		if s.PSICPU >= 0 {
			bump(s.PSICPU > 25, s.PSICPU > 60)
		}
	}
	if info.Cores > 0 {
		lpc := s.Load1 / float64(info.Cores)
		bump(lpc > 2, lpc > 4)
	}
	if s.MemTotal > 0 {
		mp := float64(s.MemUsed) / float64(s.MemTotal) * 100
		bump(mp > 85, mp > 95)
	}
	if s.DiskTotal > 0 {
		dp := float64(s.DiskUsed) / float64(s.DiskTotal) * 100
		bump(dp > 85, dp > 95)
	}
	switch score {
	case 2:
		return sigil.HealthErr
	case 1:
		return sigil.HealthWarn
	default:
		return sigil.HealthHealthy
	}
}

func atoiSafe(s string) int { n, _ := strconv.Atoi(strings.TrimSpace(s)); return n }
func atoi64Safe(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(strings.Fields(s + " ")[0]), 10, 64)
	return n
}
func atofSafe(s string) float64 { f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return f }
