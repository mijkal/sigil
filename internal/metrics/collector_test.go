package metrics

import (
	"testing"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// Fixtures are verbatim probe output captured live from real hosts.

const linuxStaticFixture = `OS=linux
OSPRETTY=Debian GNU/Linux 13 (trixie)
KERNEL=6.12.95+deb13-cloud-amd64
ARCH=x86_64
CORES=8
CPU=Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz
MEMTOTAL=14662094848
DISKTOTAL=211157901312
HASPSI=1
`

const linuxDynamicFixture = `T=1784084197
LOAD=0.62 1.05 1.04
PSICPU=1.39
PSIMEM=0.00
MEM=14662094848 6765125632
SWAP=4294963200 77373440
DISK=211157901312 145407668224
NET=4737533 1681049
PROCS:
200 0.0 ps
48.9 4.3 claude
48.8 3.9 claude
32.9 4.2 claude
22.1 2.8 syncthing
16.6 0.0 sh
`

const darwinDynamicFixture = `T=1784084218
LOAD=3.91 4.27 4.43
MEM=34359738368 20961636352
SWAP=8589934592 7131627520
DISK=1000240963584 11267719168
NET=365912273393 5770742364466
PROCS:
47.4 0.3 WindowServer
37.3 80.4 VBoxHeadless
15.3 0.2 Firefox
`

func TestParseInfo(t *testing.T) {
	info := parseInfo(linuxStaticFixture)
	if info.OS != "linux" {
		t.Errorf("OS = %q, want linux", info.OS)
	}
	if info.Cores != 8 {
		t.Errorf("Cores = %d, want 8", info.Cores)
	}
	if info.MemTotal != 14662094848 {
		t.Errorf("MemTotal = %d", info.MemTotal)
	}
	if !info.HasPSI {
		t.Error("HasPSI = false, want true")
	}
	if info.CPUModel == "" {
		t.Error("CPUModel empty")
	}
	if info.OSPretty != "Debian GNU/Linux 13 (trixie)" {
		t.Errorf("OSPretty = %q", info.OSPretty)
	}
}

func TestParseDynamicLinux(t *testing.T) {
	s, procs := parseDynamic(linuxDynamicFixture)
	if s.Load1 != 0.62 {
		t.Errorf("Load1 = %v, want 0.62", s.Load1)
	}
	if s.PSICPU != 1.39 || s.PSIMem != 0.0 {
		t.Errorf("PSI = %v/%v", s.PSICPU, s.PSIMem)
	}
	if s.MemUsed != 6765125632 || s.MemTotal != 14662094848 {
		t.Errorf("mem = %d/%d", s.MemUsed, s.MemTotal)
	}
	if s.NetRx != 4737533 || s.NetTx != 1681049 {
		t.Errorf("net = %d/%d", s.NetRx, s.NetTx)
	}
	// ps/sh sampling artifacts must be filtered; real procs kept.
	for _, p := range procs {
		if procSkip[p.Name] {
			t.Errorf("proc %q should have been filtered", p.Name)
		}
	}
	if len(procs) == 0 || procs[0].Name != "claude" {
		t.Errorf("top proc = %+v, want claude first", procs)
	}
}

func TestParseDynamicDarwin(t *testing.T) {
	s, procs := parseDynamic(darwinDynamicFixture)
	// macOS has no PSI — parser must leave the sentinel -1.
	if s.PSICPU != -1 || s.PSIMem != -1 {
		t.Errorf("darwin PSI should be -1/-1, got %v/%v", s.PSICPU, s.PSIMem)
	}
	if s.MemUsed != 20961636352 {
		t.Errorf("MemUsed = %d", s.MemUsed)
	}
	if s.SwapUsed != 7131627520 {
		t.Errorf("SwapUsed = %d", s.SwapUsed)
	}
	if len(procs) == 0 || procs[0].Name != "WindowServer" {
		t.Errorf("procs = %+v", procs)
	}
}

func TestComputeHealth(t *testing.T) {
	linux := sigil.HostInfo{Cores: 8, HasPSI: true}
	mac := sigil.HostInfo{Cores: 12, HasPSI: false}

	cases := []struct {
		name string
		info sigil.HostInfo
		s    sigil.MetricSample
		want string
	}{
		{"idle linux", linux, sigil.MetricSample{Load1: 0.6, PSICPU: 1, PSIMem: 0, MemUsed: 6e9, MemTotal: 14e9, DiskUsed: 1, DiskTotal: 10}, sigil.HealthHealthy},
		{"mem pressure warn", linux, sigil.MetricSample{PSIMem: 20, PSICPU: 0, MemTotal: 14e9, MemUsed: 1}, sigil.HealthWarn},
		{"mem pressure err", linux, sigil.MetricSample{PSIMem: 55, PSICPU: 0, MemTotal: 14e9, MemUsed: 1}, sigil.HealthErr},
		{"load err by cores", linux, sigil.MetricSample{Load1: 40, PSIMem: 0, PSICPU: 0}, sigil.HealthErr},
		{"disk full err", linux, sigil.MetricSample{PSIMem: 0, PSICPU: 0, DiskTotal: 100, DiskUsed: 97}, sigil.HealthErr},
		{"mac ignores psi, load ok", mac, sigil.MetricSample{Load1: 4, PSICPU: -1, PSIMem: -1, MemTotal: 34e9, MemUsed: 20e9}, sigil.HealthHealthy},
		{"mac mem warn", mac, sigil.MetricSample{Load1: 4, PSICPU: -1, PSIMem: -1, MemTotal: 34e9, MemUsed: 31e9}, sigil.HealthWarn},
	}
	for _, tc := range cases {
		if got := computeHealth(tc.info, tc.s); got != tc.want {
			t.Errorf("%s: health = %q, want %q", tc.name, got, tc.want)
		}
	}
}
