package config

import (
	"os"

	"github.com/pelletier/go-toml/v2"
)

// TLSConfig holds TLS configuration
type TLSConfig struct {
	Enabled  bool   `toml:"enabled"`
	CertFile string `toml:"cert_file"`
	KeyFile  string `toml:"key_file"`
}

// AuthConfig holds authentication configuration
type AuthConfig struct {
	Method string   `toml:"method"` // "token" or "none"
	Tokens []string `toml:"tokens"`
}

// ScrollbackConfig holds scrollback capture configuration
type ScrollbackConfig struct {
	CaptureEnabled  bool `toml:"capture_enabled"`
	FlushIntervalMs int  `toml:"flush_interval_ms"`
	MaxChunkLines   int  `toml:"max_chunk_lines"`
	RetentionDays   int  `toml:"retention_days"`
	// MaxBytesPerSession is the hard ceiling on retained scrollback per session
	// (raw_data bytes). Unlike RetentionDays (which never bounds a busy session
	// inside the window), this deterministically caps total DB size at roughly
	// sessions × MaxBytesPerSession. 0 disables the byte cap.
	MaxBytesPerSession int64 `toml:"max_bytes_per_session"`
}

// DiscoveryConfig holds session discovery configuration
type DiscoveryConfig struct {
	IntervalSeconds int `toml:"interval_seconds"`
}

// SessionsConfig holds session-lifecycle policy.
type SessionsConfig struct {
	// EphemeralPatterns are globs (filepath.Match, matched against the whole
	// session name) for sessions that are single-shot by nature and must NOT be
	// recreated by auto-resurrect.
	//
	// WHY THIS EXISTS: an orchestrator that spawns one tmux session per command
	// (Drydock uses `hostsh-<id>` and `mctask-<id>`) creates, reads and deletes
	// them. Both its paths do delete correctly. The zombie factory was
	// auto-resurrect: when a tmux server restarts, sigild recreates EVERY
	// detached DB row — including ephemerals whose owning run ended long ago.
	// The replacement is owned by nobody and deleted by nobody, so it survives
	// forever and gets resurrected again on the next restart. One tmux restart
	// resurrected 42 at once. jupiter reached 50 rows, which then exhausted the
	// host's SSH MaxSessions and got real sessions pruned as collateral (see
	// internal/session/attachguard.go).
	//
	// Not resurrecting is enough — the existing miss-threshold prune reclaims the
	// row. There is deliberately NO delete path here: sigild does not own these
	// sessions and must not race their owner.
	//
	// An explicitly empty list restores the pre-policy behaviour (resurrect
	// everything). A malformed glob is ignored rather than matching everything.
	EphemeralPatterns []string `toml:"ephemeral_patterns"`
}

// WebhooksConfig holds webhook configuration
type WebhooksConfig struct {
	Enabled bool `toml:"enabled"`
}

// MetricsConfig holds per-host resource-metrics collection configuration.
type MetricsConfig struct {
	Enabled         bool `toml:"enabled"`
	IntervalSeconds int  `toml:"interval_seconds"`
}

// HubConfig holds hub-level configuration
type HubConfig struct {
	ListenAddr string           `toml:"listen_addr"`
	DataDir    string           `toml:"data_dir"`
	LogLevel   string           `toml:"log_level"`
	TLS        TLSConfig        `toml:"tls"`
	Auth       AuthConfig       `toml:"auth"`
	Scrollback ScrollbackConfig `toml:"scrollback"`
	Discovery  DiscoveryConfig  `toml:"discovery"`
	Sessions   SessionsConfig   `toml:"sessions"`
	Webhooks   WebhooksConfig   `toml:"webhooks"`
	Metrics    MetricsConfig    `toml:"metrics"`

	// HostKeyMode controls SSH host-key verification against KnownHostsPath:
	//   "tofu"     — trust-on-first-use: record unknown keys, reject CHANGED
	//                keys (MITM). Fails open on file I/O errors. (default)
	//   "strict"   — reject any host not already in known_hosts.
	//   "insecure" — accept any key (the old ssh.InsecureIgnoreHostKey behaviour).
	HostKeyMode    string `toml:"host_key_mode"`
	KnownHostsPath string `toml:"known_hosts_path"` // default ~/.ssh/known_hosts

	// AllowedOrigins is the WebSocket Origin allowlist (patterns, e.g.
	// "sigil.example.com", "*.example.com"). Empty = keep the permissive
	// behaviour (any origin may connect; a bearer token is still required).
	// Set this in production to close cross-site WebSocket connection attempts.
	AllowedOrigins []string `toml:"allowed_origins"`
}

// HostConfig holds per-host SSH configuration
type HostConfig struct {
	Name           string   `toml:"name"`
	Hostname       string   `toml:"hostname"`
	Port           int      `toml:"port"`
	User           string   `toml:"user"`
	AuthMethod     string   `toml:"auth_method"`
	PrivateKeyPath string   `toml:"private_key_path"`
	Password       string   `toml:"password"`
	Tags           []string `toml:"tags"`
	AutoConnect    bool     `toml:"auto_connect"`
}

// Config is the root configuration structure
type Config struct {
	Hub   HubConfig    `toml:"hub"`
	Hosts []HostConfig `toml:"hosts"`
}

// Load reads a TOML config file and applies defaults
func Load(path string) (*Config, error) {
	cfg := &Config{}
	applyDefaults(cfg)

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Return defaults if file doesn't exist
			return cfg, nil
		}
		return nil, err
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	// Re-apply defaults for zero values
	if cfg.Hub.ListenAddr == "" {
		cfg.Hub.ListenAddr = "0.0.0.0:7777"
	}
	if cfg.Hub.DataDir == "" {
		cfg.Hub.DataDir = "~/.local/share/sigil"
	}
	if cfg.Hub.LogLevel == "" {
		cfg.Hub.LogLevel = "info"
	}
	if cfg.Hub.Scrollback.FlushIntervalMs == 0 {
		cfg.Hub.Scrollback.FlushIntervalMs = 500
	}
	if cfg.Hub.Scrollback.MaxChunkLines == 0 {
		cfg.Hub.Scrollback.MaxChunkLines = 1000
	}
	if cfg.Hub.Scrollback.RetentionDays == 0 {
		cfg.Hub.Scrollback.RetentionDays = 30
	}
	if cfg.Hub.Scrollback.MaxBytesPerSession == 0 {
		cfg.Hub.Scrollback.MaxBytesPerSession = 8 * 1024 * 1024 // 8 MiB/session
	}
	if cfg.Hub.Discovery.IntervalSeconds == 0 {
		cfg.Hub.Discovery.IntervalSeconds = 10
	cfg.Hub.Sessions.EphemeralPatterns = DefaultEphemeralPatterns()
	}
	// nil means the key was absent → apply defaults. An explicitly empty list is
	// a deliberate opt-out and is left alone.
	if cfg.Hub.Sessions.EphemeralPatterns == nil {
		cfg.Hub.Sessions.EphemeralPatterns = DefaultEphemeralPatterns()
	}
	if cfg.Hub.Metrics.IntervalSeconds == 0 {
		cfg.Hub.Metrics.IntervalSeconds = 5
	}
	if cfg.Hub.Auth.Method == "" {
		cfg.Hub.Auth.Method = "token"
	}
	if cfg.Hub.HostKeyMode == "" {
		cfg.Hub.HostKeyMode = "tofu"
	}
	if cfg.Hub.KnownHostsPath == "" {
		cfg.Hub.KnownHostsPath = "~/.ssh/known_hosts"
	}

	// Apply per-host defaults
	for i := range cfg.Hosts {
		if cfg.Hosts[i].Port == 0 {
			cfg.Hosts[i].Port = 22
		}
		if cfg.Hosts[i].AuthMethod == "" {
			cfg.Hosts[i].AuthMethod = "key"
		}
	}

	return cfg, nil
}

func applyDefaults(cfg *Config) {
	cfg.Hub.ListenAddr = "0.0.0.0:7777"
	cfg.Hub.DataDir = "~/.local/share/sigil"
	cfg.Hub.LogLevel = "info"
	cfg.Hub.Auth.Method = "token"
	cfg.Hub.Scrollback.CaptureEnabled = true
	cfg.Hub.Scrollback.FlushIntervalMs = 500
	cfg.Hub.Scrollback.MaxChunkLines = 1000
	cfg.Hub.Scrollback.RetentionDays = 30
	cfg.Hub.Scrollback.MaxBytesPerSession = 8 * 1024 * 1024
	cfg.Hub.Discovery.IntervalSeconds = 10
	cfg.Hub.Webhooks.Enabled = false
	cfg.Hub.Metrics.Enabled = true
	cfg.Hub.Metrics.IntervalSeconds = 5
	cfg.Hub.HostKeyMode = "tofu"
	cfg.Hub.KnownHostsPath = "~/.ssh/known_hosts"
}

// DefaultEphemeralPatterns is the built-in ephemeral-session glob set. Kept as a
// function so callers cannot mutate a shared slice.
func DefaultEphemeralPatterns() []string {
	return []string{"hostsh-*", "mctask-*", "mcclean-*"}
}
