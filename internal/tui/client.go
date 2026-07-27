package tui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// httpTimeout bounds every API call — the TUI must never hang on a wedged hub.
const httpTimeout = 8 * time.Second

// Client is a tiny typed client for the sigild HTTP API. It speaks the same
// surface the web app uses (all under /api/v1, bearer-token auth) and decodes
// into the shared pkg/sigil types.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// NewClient returns a client for the given base URL (e.g. http://127.0.0.1:7778)
// and bearer token. A trailing slash on base is tolerated.
func NewClient(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: httpTimeout},
	}
}

// StatusError is returned when the API answers with a non-2xx status. It carries
// the HTTP status code plus any structured error the hub sent, so callers can
// surface "token rejected (401)" rather than panicking on a nil body.
type StatusError struct {
	StatusCode int
	Code       string // hub error code, e.g. "unauthorized"
	Message    string // hub error message
}

func (e *StatusError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%d %s: %s", e.StatusCode, http.StatusText(e.StatusCode), e.Message)
	}
	return fmt.Sprintf("%d %s", e.StatusCode, http.StatusText(e.StatusCode))
}

// StatusInfo is the subset of GET /status the TUI cares about (version banner).
type StatusInfo struct {
	Version   string `json:"version"`
	GitCommit string `json:"git_commit"`
}

// Status returns the hub's version/connectivity snapshot.
func (c *Client) Status(ctx context.Context) (StatusInfo, error) {
	var out StatusInfo
	err := c.get(ctx, "/status", &out)
	return out, err
}

// Hosts returns every configured host.
func (c *Client) Hosts(ctx context.Context) ([]sigil.Host, error) {
	var out []sigil.Host
	err := c.get(ctx, "/hosts", &out)
	return out, err
}

// Sessions returns every tmux session across all hosts.
func (c *Client) Sessions(ctx context.Context) ([]sigil.Session, error) {
	var out []sigil.Session
	err := c.get(ctx, "/sessions", &out)
	return out, err
}

// Metrics returns the latest resource snapshot for every probed host. It is
// best-effort: a hub with metrics disabled answers with an empty list, not an
// error, so the sidebar simply shows nothing rather than blocking.
func (c *Client) Metrics(ctx context.Context) ([]sigil.HostMetrics, error) {
	var out []sigil.HostMetrics
	err := c.get(ctx, "/metrics", &out)
	return out, err
}

// CreateSession starts a new tmux session named name on host.
func (c *Client) CreateSession(ctx context.Context, host, name string) error {
	body := map[string]string{"host_name": host, "name": name}
	return c.send(ctx, http.MethodPost, "/sessions", body)
}

// RenameSession renames the session with the given id (host:name).
func (c *Client) RenameSession(ctx context.Context, id, newName string) error {
	return c.send(ctx, http.MethodPatch, "/sessions/"+pathEscape(id), map[string]string{"name": newName})
}

// KillSession destroys the tmux session with the given id (host:name).
func (c *Client) KillSession(ctx context.Context, id string) error {
	return c.send(ctx, http.MethodDelete, "/sessions/"+pathEscape(id), nil)
}

// ConnectHost (re)connects the named host.
func (c *Client) ConnectHost(ctx context.Context, name string) error {
	return c.send(ctx, http.MethodPost, "/hosts/"+pathEscape(name)+"/connect", nil)
}

// DisconnectHost drops the SSH connection to the named host.
func (c *Client) DisconnectHost(ctx context.Context, name string) error {
	return c.send(ctx, http.MethodPost, "/hosts/"+pathEscape(name)+"/disconnect", nil)
}

// pathEscape encodes a path segment (session ids carry ':' and host names may
// carry odd characters), keeping the URL well-formed.
func pathEscape(s string) string { return url.PathEscape(s) }

// get performs an authenticated GET against /api/v1<path> and decodes the
// standard {"data": …} envelope into out. A non-2xx response is turned into a
// *StatusError (decoding the {"error": …} envelope when present).
func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v1"+path, nil)
	if err != nil {
		return err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeStatusError(resp)
	}

	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode %s response: %w", path, err)
	}
	if len(env.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("decode %s data: %w", path, err)
	}
	return nil
}

// send performs an authenticated write (POST/PATCH/DELETE) against
// /api/v1<path> with an optional JSON body, discarding any success payload. A
// non-2xx response becomes a *StatusError so callers get "409 …" / "500 …"
// rather than a silent failure.
func (c *Client) send(ctx context.Context, method, path string, body any) error {
	var buf *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		buf = bytes.NewReader(b)
	} else {
		buf = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.base+"/api/v1"+path, buf)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeStatusError(resp)
	}
	return nil
}

// decodeStatusError builds a typed error from a non-2xx response, best-effort
// pulling the hub's {"error": {code, message}} envelope out of the body.
func decodeStatusError(resp *http.Response) error {
	e := &StatusError{StatusCode: resp.StatusCode}
	var env struct {
		Error *sigil.APIError `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err == nil && env.Error != nil {
		e.Code = env.Error.Code
		e.Message = env.Error.Message
	}
	return e
}
