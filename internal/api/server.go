package api

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gorilla/mux"
	"github.com/rs/zerolog"

	"sigil.dev/sigil/internal/config"
	"sigil.dev/sigil/internal/db"
	"sigil.dev/sigil/internal/events"
	"sigil.dev/sigil/internal/metrics"
	"sigil.dev/sigil/internal/scrollback"
	"sigil.dev/sigil/internal/session"
	sshpool "sigil.dev/sigil/internal/ssh"
	ws "sigil.dev/sigil/internal/ws"
)

// Server is the HTTP API server
type Server struct {
	router     *mux.Router
	ws         *ws.Server
	sessions   *session.Manager
	sshPool    *sshpool.Pool
	scrollback *scrollback.Engine
	events     *events.Bus
	db         *db.DB
	metrics    *metrics.Collector
	cfg        *config.Config
	log        zerolog.Logger
	httpSrv    *http.Server
}

// New creates the API server and registers all routes
func New(
	wsServer *ws.Server,
	sess *session.Manager,
	pool *sshpool.Pool,
	sb *scrollback.Engine,
	bus *events.Bus,
	d *db.DB,
	mc *metrics.Collector,
	cfg *config.Config,
) *Server {
	s := &Server{
		router:     mux.NewRouter(),
		ws:         wsServer,
		sessions:   sess,
		sshPool:    pool,
		scrollback: sb,
		events:     bus,
		db:         d,
		metrics:    mc,
		cfg:        cfg,
		log:        zerolog.Nop(),
	}
	s.registerRoutes()
	return s
}

// SetLogger sets the logger
func (s *Server) SetLogger(log zerolog.Logger) {
	s.log = log
}

func (s *Server) registerRoutes() {
	r := s.router

	// CORS middleware
	r.Use(corsMiddleware)

	// WebSocket
	r.Handle("/ws", s.ws)

	// API routes with auth middleware
	api := r.PathPrefix("/api/v1").Subrouter()
	api.Use(s.authMiddleware)

	api.HandleFunc("/status", s.GetStatus).Methods(http.MethodGet)
	api.HandleFunc("/hosts", s.GetHosts).Methods(http.MethodGet)
	api.HandleFunc("/hosts", s.AddHost).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}", s.UpdateHost).Methods(http.MethodPatch)
	api.HandleFunc("/hosts/{name}", s.RemoveHost).Methods(http.MethodDelete)
	api.HandleFunc("/hosts/{name}/connect", s.ConnectHost).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/disconnect", s.DisconnectHost).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/adopt", s.AdoptSession).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/metrics", s.GetHostMetrics).Methods(http.MethodGet)
	api.HandleFunc("/metrics", s.GetAllMetrics).Methods(http.MethodGet)
	api.HandleFunc("/sessions", s.GetSessions).Methods(http.MethodGet)
	api.HandleFunc("/sessions", s.CreateSession).Methods(http.MethodPost)
	api.HandleFunc("/sessions/{id}", s.DeleteSession).Methods(http.MethodDelete)
	api.HandleFunc("/sessions/{id}", s.UpdateSession).Methods(http.MethodPatch)
	api.HandleFunc("/sessions/{id}/resurrect", s.ResurrectSession).Methods(http.MethodPost)
	api.HandleFunc("/sessions/{id}/scrollback", s.GetScrollback).Methods(http.MethodGet)
	api.HandleFunc("/sessions/{id}/capture", s.GetCapture).Methods(http.MethodGet)
	api.HandleFunc("/sessions/{id}/pipe", s.GetPipedCapture).Methods(http.MethodGet)
	api.HandleFunc("/sessions/{id}/signal", s.SignalSession).Methods(http.MethodPost)
	api.HandleFunc("/sessions/{id}/keys", s.SendKeysToSession).Methods(http.MethodPost)
	api.HandleFunc("/search", s.Search).Methods(http.MethodGet)
	api.HandleFunc("/proxy", s.ProxyURL).Methods(http.MethodGet)
	api.HandleFunc("/events", s.GetEvents).Methods(http.MethodGet)
	api.HandleFunc("/settings", s.GetSettings).Methods(http.MethodGet)
	api.HandleFunc("/settings", s.UpdateSettings).Methods(http.MethodPut)
	api.HandleFunc("/maintenance", s.Maintenance).Methods(http.MethodPost)
	api.HandleFunc("/triggers", s.GetTriggers).Methods(http.MethodGet)
	api.HandleFunc("/triggers", s.CreateTrigger).Methods(http.MethodPost)
	api.HandleFunc("/triggers/{id}", s.UpdateTrigger).Methods(http.MethodPatch)
	api.HandleFunc("/triggers/{id}", s.DeleteTrigger).Methods(http.MethodDelete)
	api.HandleFunc("/workspaces", s.GetWorkspaces).Methods(http.MethodGet)
	api.HandleFunc("/workspaces", s.SaveWorkspace).Methods(http.MethodPost)
	api.HandleFunc("/workspaces/{id}", s.SaveWorkspace).Methods(http.MethodPatch)
	api.HandleFunc("/workspaces/{id}", s.DeleteWorkspace).Methods(http.MethodDelete)
	api.HandleFunc("/prefs", s.GetPrefs).Methods(http.MethodGet)
	api.HandleFunc("/prefs/color", s.SetPrefColor).Methods(http.MethodPost)
	api.HandleFunc("/prefs/set", s.SetPref).Methods(http.MethodPost)
	api.HandleFunc("/images", s.Images).Methods(http.MethodGet, http.MethodPut, http.MethodDelete)
	api.HandleFunc("/layouts", s.GetLayouts).Methods(http.MethodGet)
	api.HandleFunc("/layouts", s.SaveLayout).Methods(http.MethodPost)
	api.HandleFunc("/layouts/{id}", s.DeleteLayout).Methods(http.MethodDelete)
	api.HandleFunc("/hosts/{name}/files", s.GetFiles).Methods(http.MethodGet)
	api.HandleFunc("/hosts/{name}/files", s.UploadFiles).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/files/move", s.MoveFile).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/files/copy", s.CopyFile).Methods(http.MethodPost)
	api.HandleFunc("/hosts/{name}/download", s.DownloadFile).Methods(http.MethodGet)
	api.HandleFunc("/transfer", s.Transfer).Methods(http.MethodPost)
	api.HandleFunc("/preview", s.PushPreview).Methods(http.MethodPost)
	api.HandleFunc("/agent-usage", s.AgentUsage).Methods(http.MethodGet)
	api.HandleFunc("/exec", s.Exec).Methods(http.MethodGet)

}

// Start starts the HTTP server
func (s *Server) Start(ctx context.Context) error {
	s.httpSrv = &http.Server{
		Addr:    s.cfg.Hub.ListenAddr,
		Handler: s.router,
	}

	s.log.Info().Str("addr", s.cfg.Hub.ListenAddr).Msg("starting HTTP server")

	errCh := make(chan error, 1)
	go func() {
		if err := s.httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		s.log.Info().Msg("shutting down HTTP server")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*1000*1000*1000) // 10s
		defer cancel()
		return s.httpSrv.Shutdown(shutCtx)
	}
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Hub.Auth.Method == "none" {
			next.ServeHTTP(w, r)
			return
		}

		token := extractBearerTokenHTTP(r)
		if token == "" {
			writeError(w, 401, "unauthorized", "missing authorization header")
			return
		}

		valid := false
		for _, t := range s.cfg.Hub.Auth.Tokens {
			// Constant-time compare so response timing can't be used as an
			// oracle to recover the token byte-by-byte.
			if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
				valid = true
			}
		}

		if !valid {
			writeError(w, 401, "unauthorized", "invalid token")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Cache-Control", "no-store")

		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func extractBearerTokenHTTP(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return auth[7:]
	}
	// Browser-context GETs (iframe src, downloads) can't set headers — accept the
	// token in a query param for those. Same secret, alternate transport.
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}
