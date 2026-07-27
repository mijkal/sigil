package sigil

// HostInfo is static host information, collected once per connection (it does
// not change while a host stays up). Bytes are absolute, not KiB/MiB.
type HostInfo struct {
	OS        string `json:"os"`         // "linux" | "darwin"
	OSPretty  string `json:"os_pretty"`  // e.g. "Debian GNU/Linux 13 (trixie)", "macOS 15.1"
	Kernel    string `json:"kernel"`     // uname -r
	Arch      string `json:"arch"`       // uname -m
	CPUModel  string `json:"cpu_model"`  // e.g. "Intel(R) Core(TM) i7-8850H"
	Cores     int    `json:"cores"`      // logical cores
	MemTotal  int64  `json:"mem_total"`  // bytes
	DiskTotal int64  `json:"disk_total"` // bytes, filesystem mounted at /
	HasPSI    bool   `json:"has_psi"`    // Linux Pressure Stall Info present (false on macOS)
}

// ProcInfo is one entry in the top-processes list.
type ProcInfo struct {
	CPU  float64 `json:"cpu"`  // percent
	Mem  float64 `json:"mem"`  // percent
	Name string  `json:"name"` // command
}

// MetricSample is a point-in-time resource reading. PSI fields are -1 when the
// host has no Pressure Stall Info (macOS). Network counters are cumulative
// interface totals; the client derives rates by differencing adjacent samples.
type MetricSample struct {
	T         int64   `json:"t"`          // unix seconds
	Load1     float64 `json:"load1"`
	Load5     float64 `json:"load5"`
	Load15    float64 `json:"load15"`
	PSICPU    float64 `json:"psi_cpu"`    // "some" avg10, Linux only (-1 = N/A)
	PSIMem    float64 `json:"psi_mem"`    // "some" avg10, Linux only (-1 = N/A)
	MemUsed   int64   `json:"mem_used"`   // bytes
	MemTotal  int64   `json:"mem_total"`  // bytes
	SwapUsed  int64   `json:"swap_used"`  // bytes
	SwapTotal int64   `json:"swap_total"` // bytes
	DiskUsed  int64   `json:"disk_used"`  // bytes (on /)
	DiskTotal int64   `json:"disk_total"` // bytes (on /)
	NetRx     int64   `json:"net_rx"`     // cumulative bytes received
	NetTx     int64   `json:"net_tx"`     // cumulative bytes transmitted
}

// Health levels for the sidebar badge.
const (
	HealthHealthy = "healthy"
	HealthWarn    = "warn"
	HealthErr     = "err"
	HealthUnknown = "unknown" // host unreachable / never probed
)

// HostMetrics is the full metrics view for one host, served over REST
// (/hosts/{name}/metrics) and pushed over WS (metrics.update).
type HostMetrics struct {
	Host    string         `json:"host"`
	Health  string         `json:"health"`
	Info    HostInfo       `json:"info"`
	Current MetricSample   `json:"current"`
	History []MetricSample `json:"history"` // ring buffer, oldest → newest
	Procs   []ProcInfo     `json:"procs"`
	Stale   bool           `json:"stale"`           // last probe failed; data is prior-good
	Error   string         `json:"error,omitempty"` // last probe error, if any
}
