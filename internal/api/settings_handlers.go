package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// settingsScopeGlobal is the scope key for hub-wide settings.
const settingsScopeGlobal = "global"

// SettingsDTO is the typed view of the global settings, merged from persisted
// overrides on top of config-file defaults.
type SettingsDTO struct {
	RetentionDays      int   `json:"retention_days"`
	MaxBytesPerSession int64 `json:"max_bytes_per_session"`
	EventKeep          int   `json:"event_keep"`
	AutoVacuum         bool  `json:"auto_vacuum"`
}

const defaultEventKeep = 10000

// effectiveSettings merges persisted global settings over config defaults. It is
// the single source of truth for both the API and the retention loop.
func (s *Server) effectiveSettings() SettingsDTO {
	dto := SettingsDTO{
		RetentionDays:      s.cfg.Hub.Scrollback.RetentionDays,
		MaxBytesPerSession: s.cfg.Hub.Scrollback.MaxBytesPerSession,
		EventKeep:          defaultEventKeep,
		AutoVacuum:         true,
	}
	kv, err := s.db.GetSettings(settingsScopeGlobal)
	if err != nil {
		s.log.Error().Err(err).Msg("read settings failed; using config defaults")
		return dto
	}
	if v, ok := kv["retention_days"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			dto.RetentionDays = n
		}
	}
	if v, ok := kv["max_bytes_per_session"]; ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			dto.MaxBytesPerSession = n
		}
	}
	if v, ok := kv["event_keep"]; ok {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			dto.EventKeep = n
		}
	}
	if v, ok := kv["auto_vacuum"]; ok {
		dto.AutoVacuum = v == "true"
	}
	return dto
}

// EffectiveSettings is the exported accessor used by the retention loop.
func (s *Server) EffectiveSettings() SettingsDTO { return s.effectiveSettings() }

// GetSettings returns the effective global settings.
func (s *Server) GetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, sigil.APIResponse{Data: s.effectiveSettings()})
}

// UpdateSettings persists global settings. Values are clamped to sane ranges so
// a bad input can't disable retention or set an absurd cap. The retention loop
// reads these on its next pass, so changes apply without a restart.
func (s *Server) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var in SettingsDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}
	if in.RetentionDays < 0 {
		in.RetentionDays = 0
	}
	if in.MaxBytesPerSession < 0 {
		in.MaxBytesPerSession = 0
	}
	if in.EventKeep <= 0 {
		in.EventKeep = defaultEventKeep
	}
	kv := map[string]string{
		"retention_days":        strconv.Itoa(in.RetentionDays),
		"max_bytes_per_session": strconv.FormatInt(in.MaxBytesPerSession, 10),
		"event_keep":            strconv.Itoa(in.EventKeep),
		"auto_vacuum":           strconv.FormatBool(in.AutoVacuum),
	}
	if err := s.db.SetSettings(settingsScopeGlobal, kv); err != nil {
		writeError(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: s.effectiveSettings()})
}

// Maintenance runs an on-demand storage operation:
//   - prune:       enforce retention now (scrollback + events)
//   - vacuum:      incremental vacuum (cheap; no-op on legacy DBs)
//   - vacuum_full: full VACUUM — rebuilds the file, reclaiming all free space.
//     Takes a write lock for the duration; operator-triggered only.
func (s *Server) Maintenance(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad_request", "invalid JSON body")
		return
	}

	set := s.effectiveSettings()
	result := map[string]interface{}{"action": body.Action}

	switch body.Action {
	case "prune":
		if err := s.db.PruneScrollback(set.RetentionDays); err != nil {
			writeError(w, 500, "prune_error", err.Error())
			return
		}
		if n, err := s.db.PruneEvents(set.EventKeep); err != nil {
			writeError(w, 500, "prune_error", err.Error())
			return
		} else {
			result["events_deleted"] = n
		}
		_ = s.db.IncrementalVacuum(0)
	case "vacuum":
		if err := s.db.IncrementalVacuum(0); err != nil {
			writeError(w, 500, "vacuum_error", err.Error())
			return
		}
	case "vacuum_full":
		if err := s.db.FullVacuum(); err != nil {
			writeError(w, 500, "vacuum_error", err.Error())
			return
		}
	default:
		writeError(w, 400, "bad_request", "action must be prune, vacuum, or vacuum_full")
		return
	}

	if st, err := s.db.GetStats(); err == nil {
		result["db_size_bytes"] = st["db_size_bytes"]
	}
	writeJSON(w, 200, sigil.APIResponse{Data: result})
}
