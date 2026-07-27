package main

import (
	"os"
	"path/filepath"
	"testing"

	hubcfg "sigil.dev/sigil/internal/config"
)

func statusOf(r *report, id string) string {
	for _, c := range r.Checks {
		if c.ID == id {
			return c.Status
		}
	}
	return "<missing>"
}

// The port collision is the most common first-run failure, so it is the check
// most worth pinning: hub on 7777 must FAIL, because sigil-web defaults there.
func TestCheckPorts(t *testing.T) {
	cases := []struct {
		name, addr, want string
	}{
		{"collides with sigil-web", "0.0.0.0:7777", statusFail},
		{"documented pairing", "0.0.0.0:7778", statusPass},
		{"loopback, distinct port", "127.0.0.1:9000", statusPass},
		{"unparseable", "not-a-host-port", statusWarn},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &report{}
			checkPorts(r, &hubcfg.Config{Hub: hubcfg.HubConfig{ListenAddr: c.addr}})
			if got := statusOf(r, "config.ports"); got != c.want {
				t.Errorf("addr %q: got %s, want %s", c.addr, got, c.want)
			}
		})
	}
}

// A nil config means an earlier check already failed. Nothing downstream may
// report `pass` on the strength of missing information — it must skip.
func TestNilConfigSkipsRatherThanPasses(t *testing.T) {
	r := &report{}
	checkPorts(r, nil)
	checkDataDir(r, nil)
	checkHosts(r, nil)
	for _, c := range r.Checks {
		if c.Status == statusPass {
			t.Errorf("check %q reported pass with no config", c.ID)
		}
	}
}

func TestCheckConfigAuth(t *testing.T) {
	dir := t.TempDir()
	write := func(body string) string {
		p := filepath.Join(dir, "c.toml")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct{ name, body, want string }{
		{"token auth with a token",
			"[hub]\nlisten_addr=\"0.0.0.0:7778\"\n[hub.auth]\nmethod=\"token\"\ntokens=[\"abc\"]\n", statusPass},
		{"token auth with no tokens — every request would 401",
			"[hub]\nlisten_addr=\"0.0.0.0:7778\"\n[hub.auth]\nmethod=\"token\"\ntokens=[]\n", statusFail},
		{"auth disabled entirely",
			"[hub]\nlisten_addr=\"0.0.0.0:7778\"\n[hub.auth]\nmethod=\"none\"\n", statusWarn},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &report{}
			if cfg := checkConfig(r, write(c.body)); cfg == nil {
				t.Fatal("config failed to load")
			}
			if got := statusOf(r, "config.auth"); got != c.want {
				t.Errorf("got %s, want %s", got, c.want)
			}
		})
	}
}

func TestCheckConfigMissingFile(t *testing.T) {
	r := &report{}
	if cfg := checkConfig(r, filepath.Join(t.TempDir(), "absent.toml")); cfg != nil {
		t.Fatal("expected nil config for a missing file")
	}
	if got := statusOf(r, "config.found"); got != statusFail {
		t.Errorf("got %s, want fail", got)
	}
	if r.Checks[0].Remedy == "" {
		t.Error("a failing check must carry a remedy — that is the point of doctor")
	}
}

// A wildcard bind is not dialable; doctor must probe it over loopback or every
// check downstream of "hub reachable" fails for the wrong reason.
func TestHubURLFrom(t *testing.T) {
	cases := []struct{ addr, want string }{
		{"0.0.0.0:7778", "http://127.0.0.1:7778"},
		{"::;bad", "fallback"},
		{"127.0.0.1:9000", "http://127.0.0.1:9000"},
		{"192.0.2.10:7778", "http://192.0.2.10:7778"},
	}
	for _, c := range cases {
		got := hubURLFrom(&hubcfg.Config{Hub: hubcfg.HubConfig{ListenAddr: c.addr}}, "fallback")
		if got != c.want {
			t.Errorf("addr %q: got %q, want %q", c.addr, got, c.want)
		}
	}
	if got := hubURLFrom(nil, "fallback"); got != "fallback" {
		t.Errorf("nil config: got %q", got)
	}
}

func TestHubTokenFromPrefersExplicit(t *testing.T) {
	cfg := &hubcfg.Config{Hub: hubcfg.HubConfig{Auth: hubcfg.AuthConfig{Tokens: []string{"from-config"}}}}
	if got := hubTokenFrom(cfg, "explicit"); got != "explicit" {
		t.Errorf("an explicit --token must win, got %q", got)
	}
	if got := hubTokenFrom(cfg, ""); got != "from-config" {
		t.Errorf("should fall back to the config token, got %q", got)
	}
	if got := hubTokenFrom(nil, ""); got != "" {
		t.Errorf("no config and no flag should yield empty, got %q", got)
	}
}
