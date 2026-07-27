package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"sigil.dev/sigil/internal/session"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// capture runs writeCaptureResult and decodes the envelope it wrote.
func capture(t *testing.T, text string, altOn bool, err error) (int, map[string]any, *sigil.APIError) {
	t.Helper()
	rec := httptest.NewRecorder()
	writeCaptureResult(rec, text, altOn, err)

	var resp struct {
		Data  map[string]any  `json:"data"`
		Error *sigil.APIError `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return rec.Code, resp.Data, resp.Error
}

func TestWriteCaptureResultHealthy(t *testing.T) {
	code, data, apiErr := capture(t, "$ ls\nfile.txt\n", true, nil)
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	if apiErr != nil {
		t.Fatalf("unexpected error payload: %+v", apiErr)
	}
	if data["text"] != "$ ls\nfile.txt\n" {
		t.Errorf("text = %q, want the real pane text", data["text"])
	}
	if data["alt_on"] != true {
		t.Errorf("alt_on = %v, want true", data["alt_on"])
	}
	if data["available"] != true {
		t.Errorf("available = %v, want true", data["available"])
	}
}

func TestWriteCaptureResultSessionGone(t *testing.T) {
	err := fmt.Errorf("%w: can't find session: dev", session.ErrSessionGone)
	code, _, apiErr := capture(t, "", true, err)
	if code != 404 {
		t.Fatalf("status = %d, want 404", code)
	}
	if apiErr == nil || apiErr.Code != "session_gone" {
		t.Fatalf("error code = %+v, want session_gone", apiErr)
	}
}

func TestWriteCaptureResultUnavailable(t *testing.T) {
	// A wedged pipe-pane / ssh hiccup: the session lives, we just can't read it.
	err := fmt.Errorf("%w: empty capture output", session.ErrCaptureUnavailable)
	code, data, apiErr := capture(t, "", true, err)
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	if apiErr != nil {
		t.Fatalf("unexpected error payload: %+v", apiErr)
	}
	if data["text"] != "" {
		t.Errorf("text = %q, want empty", data["text"])
	}
	if data["alt_on"] != false {
		t.Errorf("alt_on = %v, want false", data["alt_on"])
	}
	if data["available"] != false {
		t.Errorf("available = %v, want false", data["available"])
	}
}

func TestWriteCaptureResultInternalError(t *testing.T) {
	// An unclassified failure is a real bug and keeps its 500.
	code, _, apiErr := capture(t, "", true, errors.New("boom"))
	if code != 500 {
		t.Fatalf("status = %d, want 500", code)
	}
	if apiErr == nil || apiErr.Code != "capture_error" {
		t.Fatalf("error code = %+v, want capture_error", apiErr)
	}
}
