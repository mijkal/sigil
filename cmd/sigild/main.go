package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"sigil.dev/sigil/internal/api"
	"sigil.dev/sigil/internal/config"
	"sigil.dev/sigil/internal/db"
	"sigil.dev/sigil/internal/events"
	"sigil.dev/sigil/internal/metrics"
	"sigil.dev/sigil/internal/scrollback"
	"sigil.dev/sigil/internal/session"
	sshpool "sigil.dev/sigil/internal/ssh"
	ws "sigil.dev/sigil/internal/ws"
	sigil "sigil.dev/sigil/pkg/sigil"
)

func main() {
	var (
		configPath  = flag.String("config", "~/.config/sigil/config.toml", "path to config file")
		showVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("sigild version %s\n", sigil.Version)
		os.Exit(0)
	}

	// Expand config path
	expandedConfig := expandPath(*configPath)

	// Load config
	cfg, err := config.Load(expandedConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}

	// Setup zerolog
	logger := setupLogger(cfg.Hub.LogLevel)

	logger.Info().Str("version", sigil.Version).Str("config", expandedConfig).Msg("sigild starting")

	// Expand data dir
	dataDir := expandPath(cfg.Hub.DataDir)
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		logger.Fatal().Err(err).Str("path", dataDir).Msg("create data dir failed")
	}

	// Open database
	dbPath := filepath.Join(dataDir, "sigil.db")
	database, err := db.New(dbPath)
	if err != nil {
		logger.Fatal().Err(err).Str("path", dbPath).Msg("open database failed")
	}
	defer database.Close()

	logger.Info().Str("path", dbPath).Msg("database opened")

	// Load hosts from config into DB (config.toml is authoritative for these hosts)
	configHostNames := map[string]bool{}
	for _, hc := range cfg.Hosts {
		configHostNames[hc.Name] = true
		h := sigil.Host{
			Name:           hc.Name,
			Hostname:       hc.Hostname,
			Port:           hc.Port,
			User:           hc.User,
			AuthMethod:     hc.AuthMethod,
			PrivateKeyPath: hc.PrivateKeyPath,
			Tags:           hc.Tags,
			AutoConnect:    hc.AutoConnect,
			Status:         "disconnected",
		}
		if err := database.UpsertHost(h); err != nil {
			logger.Error().Err(err).Str("host", hc.Name).Msg("upsert host failed")
		}
	}

	// Load dynamically-added hosts from DB back into config (so they reconnect on startup)
	if dbHosts, err := database.GetHosts(); err == nil {
		for _, h := range dbHosts {
			if configHostNames[h.Name] {
				continue // already in config
			}
			cfg.Hosts = append(cfg.Hosts, config.HostConfig{
				Name:           h.Name,
				Hostname:       h.Hostname,
				Port:           h.Port,
				User:           h.User,
				AuthMethod:     h.AuthMethod,
				PrivateKeyPath: h.PrivateKeyPath,
				Tags:           h.Tags,
				AutoConnect:    h.AutoConnect,
			})
		}
	}

	// Setup context with graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Event channel
	eventCh := make(chan sigil.Event, 2048)

	// Init SSH pool
	pool := sshpool.New(cfg, database, eventCh)
	pool.SetLogger(logger.With().Str("component", "ssh-pool").Logger())

	// Init session manager
	sessionMgr := session.New(pool, database, eventCh)
	sessionMgr.SetLogger(logger.With().Str("component", "session-mgr").Logger())
	// Ephemeral-session policy: single-shot orchestrator sessions must never be
	// auto-resurrected, or they accumulate forever and exhaust the host's SSH
	// channels. See internal/session/ephemeral.go.
	if dropped := sessionMgr.SetEphemeralPatterns(cfg.Hub.Sessions.EphemeralPatterns); len(dropped) > 0 {
		logger.Warn().Strs("dropped", dropped).
			Msg("ignoring invalid hub.sessions.ephemeral_patterns entries (not valid globs)")
	}
	logger.Info().Strs("ephemeral_patterns", sessionMgr.EphemeralPatterns()).
		Msg("ephemeral session policy active (these are never auto-resurrected)")

	// Init scrollback engine
	sbEngine := scrollback.New(database, cfg.Hub.Scrollback.FlushIntervalMs)
	sbEngine.SetLogger(logger.With().Str("component", "scrollback").Logger())

	// Init event bus
	eventBus := events.New(database)
	eventBus.SetLogger(logger.With().Str("component", "events").Logger())
	eventBus.LoadTriggers()

	// Bridge event channel to bus
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-eventCh:
				if !ok {
					return
				}
				eventBus.Publish(e)
			}
		}
	}()

	// Init WS server
	wsServer := ws.New(sessionMgr, sbEngine, eventBus, database, cfg)
	wsServer.SetLogger(logger.With().Str("component", "ws").Logger())

	// Wire triggers: the manager gates all output line-matching on whether any
	// trigger exists (zero cost otherwise), and fired UI effects (flash / tint /
	// audio / toast) are delivered to web clients over the WS control channel.
	sessionMgr.SetTriggerGate(eventBus.HasOutputTriggers)
	eventBus.SetUIActionHook(wsServer.BroadcastTriggerAction)

	// Init metrics collector — pushes each host's resource stats over WS as it
	// probes. nil when disabled so the API handlers report metrics unavailable.
	var metricsCollector *metrics.Collector
	if cfg.Hub.Metrics.Enabled {
		metricsCollector = metrics.New(pool, func(m sigil.HostMetrics) {
			wsServer.BroadcastHostMetrics(m)
		})
		metricsCollector.SetLogger(logger.With().Str("component", "metrics").Logger())
	}

	// Init API server
	apiServer := api.New(wsServer, sessionMgr, pool, sbEngine, eventBus, database, metricsCollector, cfg)
	apiServer.SetLogger(logger.With().Str("component", "api").Logger())

	// Wire the onDiscovery callback so control-mode events trigger WS broadcasts
	sessionMgr.SetOnDiscovery(func(_ string) {
		wsServer.BroadcastSessionsUpdate()
	})

	// Connect all auto_connect hosts
	logger.Info().Msg("connecting hosts")
	pool.ConnectAll(ctx)
	pool.StartReconnectLoop(ctx)

	// Start tmux control-mode clients for already-connected hosts
	for _, h := range pool.GetConnectedHosts() {
		sessionMgr.StartControl(ctx, h)
	}
	// Start control-mode for hosts that connect later (host.connected event)
	eventBus.Subscribe(func(e sigil.Event) {
		if e.Type == "host.connected" {
			if h, ok := e.Data["host"].(string); ok {
				sessionMgr.StartControl(ctx, h)
			}
		}
	})

	// Start discovery loop (fallback polling — control mode handles fast path)
	sessionMgr.StartDiscoveryLoop(ctx, cfg.Hub.Discovery.IntervalSeconds)

	// Start per-host resource-metrics collection
	if metricsCollector != nil {
		metricsCollector.Start(ctx, cfg.Hub.Metrics.IntervalSeconds)
		logger.Info().Int("interval_s", cfg.Hub.Metrics.IntervalSeconds).Msg("metrics collection started")
	}

	// Periodically truncate remote pipe-pane log files so a noisy session
	// can't fill /tmp on the remote host (typically tmpfs / RAM-backed).
	sessionMgr.StartPipeLogTrimLoop(ctx, 60)

	// Start scrollback flush loop
	sbEngine.StartFlushLoop(ctx)

	// Enforce scrollback retention hourly so the DB stays bounded — capture has
	// no inline cap, so without this the scrollback table grows without limit.
	// Params are pulled live from persisted settings (falling back to config),
	// so changes made in the Storage settings apply on the next pass.
	sbEngine.StartRetentionLoop(ctx, 3600, func() scrollback.RetentionParams {
		set := apiServer.EffectiveSettings()
		return scrollback.RetentionParams{
			MaxBytesPerSession: set.MaxBytesPerSession,
			RetentionDays:      set.RetentionDays,
			EventKeep:          set.EventKeep,
		}
	})

	// Start event bus
	go eventBus.Run(ctx)

	// Start HTTP server (blocks until ctx cancelled)
	logger.Info().Str("addr", cfg.Hub.ListenAddr).Msg("listening")
	if err := apiServer.Start(ctx); err != nil {
		logger.Error().Err(err).Msg("HTTP server error")
	}

	// Flush remaining scrollback
	sbEngine.FlushAll()
	logger.Info().Msg("sigild stopped")
}

func setupLogger(level string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339

	var lvl zerolog.Level
	switch strings.ToLower(level) {
	case "trace":
		lvl = zerolog.TraceLevel
	case "debug":
		lvl = zerolog.DebugLevel
	case "warn", "warning":
		lvl = zerolog.WarnLevel
	case "error":
		lvl = zerolog.ErrorLevel
	default:
		lvl = zerolog.InfoLevel
	}

	// Pretty console output for dev
	output := zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: "15:04:05"}
	logger := zerolog.New(output).With().Timestamp().Logger().Level(lvl)
	log.Logger = logger
	return logger
}

func expandPath(p string) string {
	if strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return p
		}
		return filepath.Join(home, p[2:])
	}
	return p
}
