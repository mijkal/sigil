package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"sigil.dev/sigil/pkg/sigil"
)

// Client downscales to a 256px square (WebP), so blobs are tiny; this is the hard
// server cap so nothing pathological lands in the DB or slows sync.
const maxImageBytes = 220 * 1024

// Images handles custom identity images (avatars/sigils) for a host/session scope,
// stored server-side so every client/device shares the same mark.
//   GET  /api/v1/images            → { scopes: [...] } (which scopes have an image)
//   GET  /api/v1/images?scope=…     → the raw image bytes (usable as <img src>, token via ?token=)
//   PUT  /api/v1/images?scope=…     → store the request body (Content-Type = mime), size-capped
//   DELETE /api/v1/images?scope=…   → remove it
func (s *Server) Images(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	switch r.Method {
	case http.MethodGet:
		if scope == "" {
			scopes, err := s.db.ListAssetScopes()
			if err != nil {
				writeError(w, 500, "db_error", err.Error())
				return
			}
			writeJSON(w, 200, sigil.APIResponse{Data: map[string]any{"scopes": scopes}})
			return
		}
		mime, data, err := s.db.GetAsset(scope)
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, 404, "not_found", "no image for scope")
			return
		}
		if err != nil {
			writeError(w, 500, "db_error", err.Error())
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		_, _ = w.Write(data)

	case http.MethodPut:
		if scope == "" {
			writeError(w, 400, "bad_request", "scope is required")
			return
		}
		mime := r.Header.Get("Content-Type")
		if mime == "" {
			mime = "image/webp"
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, maxImageBytes+1))
		if err != nil {
			writeError(w, 400, "bad_request", err.Error())
			return
		}
		if len(data) == 0 {
			writeError(w, 400, "bad_request", "empty body")
			return
		}
		if len(data) > maxImageBytes {
			writeError(w, 413, "too_large", "image exceeds the size cap (downscale further)")
			return
		}
		if err := s.db.SetAsset(scope, mime, data); err != nil {
			writeError(w, 500, "db_error", err.Error())
			return
		}
		go s.ws.BroadcastPrefsUpdate()
		writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "ok"}})

	case http.MethodDelete:
		if scope == "" {
			writeError(w, 400, "bad_request", "scope is required")
			return
		}
		if err := s.db.DeleteAsset(scope); err != nil {
			writeError(w, 500, "db_error", err.Error())
			return
		}
		go s.ws.BroadcastPrefsUpdate()
		writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "ok"}})

	default:
		writeError(w, 405, "method_not_allowed", "")
	}
}

// SetPref upserts any shared pref (icon choice, image adjustments) and broadcasts
// so every client re-hydrates. Colours keep their own typed endpoint.
func (s *Server) SetPref(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if body.Key == "" {
		writeError(w, 400, "bad_request", "key is required")
		return
	}
	if err := s.db.SetPref(body.Key, body.Value); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	go s.ws.BroadcastPrefsUpdate()
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]string{"status": "ok"}})
}
