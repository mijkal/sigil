package main

// `sigil doctor` — diagnose an installation and say what to DO about it.
//
// This exists because the expensive part of self-hosting Sigil is not running it,
// it is working out which of several plausible things is wrong when a host will
// not connect. Every check therefore carries a `remedy`: the next action, not just
// a verdict.
//
// `--json` makes the whole report machine-readable so an LLM agent helping someone
// set up their instance can read the state and act on it, rather than parsing
// prose or guessing from a stack trace. That is deliberately a plain subcommand
// rather than a service: it needs no protocol, no daemon, and no extra auth
// surface, and it works in any agent that can run a shell.

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	hubcfg "sigil.dev/sigil/internal/config"
	sigil "sigil.dev/sigil/pkg/sigil"
)

// Check statuses. `warn` means "works, but you probably did not mean this";
// `skip` means we could not judge (usually because an earlier check failed), and
// is never counted as success.
const (
	statusPass = "pass"
	statusWarn = "warn"
	statusFail = "fail"
	statusSkip = "skip"
)

type check struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
	Remedy string `json:"remedy,omitempty"`
}

type report struct {
	Version    string         `json:"sigil_version"`
	ConfigPath string         `json:"config_path"`
	Server     string         `json:"server"`
	OK         bool           `json:"ok"`
	Summary    map[string]int `json:"summary"`
	Checks     []check        `json:"checks"`
}

func (r *report) add(c check) { r.Checks = append(r.Checks, c) }

// runDoctor is wired from main() when argv[1] == "doctor".
func runDoctor(args []string) error {
	fs := flag.NewFlagSet("sigil doctor", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "emit a machine-readable report on stdout")
	configPath := fs.String("config", "~/.config/sigil/config.toml", "path to the sigild config")
	server := fs.String("server", "", "hub base URL (env SIGIL_SERVER, default "+defaultServer+")")
	token := fs.String("token", "", "bearer token (env SIGIL_TOKEN)")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "sigil doctor — check an installation and report what to fix")
		fmt.Fprintln(fs.Output(), "\nUsage: sigil doctor [--json] [--config PATH] [--server URL] [--token TOKEN]")
		fmt.Fprintln(fs.Output(), "\nExit code is 0 when nothing FAILED (warnings still exit 0), 1 otherwise.")
		fmt.Fprintln(fs.Output(), "\nFlags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfgPath := expandPath(*configPath)
	resolved := resolveConfig(*server, *token, expandPath("~/.config/sigil/tui.toml"))

	rep := &report{
		Version:    sigil.Version,
		ConfigPath: cfgPath,
		Summary:    map[string]int{statusPass: 0, statusWarn: 0, statusFail: 0, statusSkip: 0},
	}

	cfg := checkConfig(rep, cfgPath)
	// The config is authoritative for where the hub listens; fall back to the
	// launcher's own resolution when it could not be read.
	rep.Server = hubURLFrom(cfg, resolved.Server)
	tok := hubTokenFrom(cfg, resolved.Token)

	checkPorts(rep, cfg)
	checkDataDir(rep, cfg)
	checkHub(rep, rep.Server, tok)
	checkHosts(rep, cfg)
	checkLocalTmux(rep)

	for _, c := range rep.Checks {
		rep.Summary[c.Status]++
	}
	rep.OK = rep.Summary[statusFail] == 0

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			return err
		}
	} else {
		printHuman(rep)
	}
	if !rep.OK {
		os.Exit(1)
	}
	return nil
}

// ── individual checks ───────────────────────────────────────────────────────

func checkConfig(r *report, path string) *hubcfg.Config {
	if _, err := os.Stat(path); err != nil {
		r.add(check{ID: "config.found", Title: "Config file exists", Status: statusFail,
			Detail: fmt.Sprintf("%s: %v", path, err),
			Remedy: "Run `make setup-config`, or copy config.example.toml to " + path})
		return nil
	}
	cfg, err := hubcfg.Load(path)
	if err != nil {
		r.add(check{ID: "config.parse", Title: "Config parses", Status: statusFail,
			Detail: err.Error(),
			Remedy: "Fix the TOML syntax in " + path + "; see docs/CONFIGURATION.md"})
		return nil
	}
	r.add(check{ID: "config.parse", Title: "Config parses", Status: statusPass, Detail: path})

	switch {
	case cfg.Hub.Auth.Method == "none":
		r.add(check{ID: "config.auth", Title: "API authentication enabled", Status: statusWarn,
			Detail: "hub.auth.method = \"none\" — the API is unauthenticated",
			Remedy: "Acceptable ONLY on a loopback bind. A valid request can run commands on " +
				"every configured host, so set method=\"token\" before binding beyond 127.0.0.1."})
	case len(cfg.Hub.Auth.Tokens) == 0:
		r.add(check{ID: "config.auth", Title: "API authentication enabled", Status: statusFail,
			Detail: "auth.method is \"token\" but hub.auth.tokens is empty — every request will be rejected",
			Remedy: "Add a token: `openssl rand -hex 32`, then put it in hub.auth.tokens"})
	default:
		r.add(check{ID: "config.auth", Title: "API authentication enabled", Status: statusPass,
			Detail: fmt.Sprintf("token auth, %d token(s)", len(cfg.Hub.Auth.Tokens))})
	}

	if cfg.Hub.HostKeyMode == "insecure" {
		r.add(check{ID: "config.host_key_mode", Title: "SSH host-key verification", Status: statusWarn,
			Detail: "host_key_mode = \"insecure\" — any host key is accepted, so MITM is undetectable",
			Remedy: "Use \"tofu\" (default) once you have confirmed the keys; \"insecure\" is a " +
				"diagnostic setting, not a resting state."})
	} else {
		r.add(check{ID: "config.host_key_mode", Title: "SSH host-key verification", Status: statusPass,
			Detail: "host_key_mode = " + cfg.Hub.HostKeyMode})
	}
	return cfg
}

// checkPorts catches the single most common first-run failure: the hub and the
// web client both defaulting to 7777, so whichever starts second dies with
// "address already in use".
func checkPorts(r *report, cfg *hubcfg.Config) {
	if cfg == nil {
		r.add(check{ID: "config.ports", Title: "Hub and web-client ports differ", Status: statusSkip,
			Detail: "config unreadable"})
		return
	}
	_, port, err := net.SplitHostPort(cfg.Hub.ListenAddr)
	if err != nil {
		r.add(check{ID: "config.ports", Title: "Hub and web-client ports differ", Status: statusWarn,
			Detail: "could not parse hub.listen_addr: " + cfg.Hub.ListenAddr,
			Remedy: "Use host:port form, e.g. 0.0.0.0:7778"})
		return
	}
	if port == "7777" {
		r.add(check{ID: "config.ports", Title: "Hub and web-client ports differ", Status: statusFail,
			Detail: "hub.listen_addr is on :7777, which is also sigil-web's default",
			Remedy: "Set hub.listen_addr = \"0.0.0.0:7778\" and point sigil-web at " +
				"-backend http://127.0.0.1:7778"})
		return
	}
	r.add(check{ID: "config.ports", Title: "Hub and web-client ports differ", Status: statusPass,
		Detail: "hub on :" + port + ", web client on :7777"})
}

func checkDataDir(r *report, cfg *hubcfg.Config) {
	if cfg == nil {
		r.add(check{ID: "data_dir.writable", Title: "Data directory writable", Status: statusSkip})
		return
	}
	dir := expandPath(cfg.Hub.DataDir)
	if dir == "" {
		dir = expandPath("~/.local/share/sigil")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		r.add(check{ID: "data_dir.writable", Title: "Data directory writable", Status: statusFail,
			Detail: fmt.Sprintf("%s: %v", dir, err),
			Remedy: "Create it and give the user sigild runs as ownership. Under systemd that " +
				"is often NOT your login user."})
		return
	}
	probe := filepath.Join(dir, ".sigil-doctor-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		r.add(check{ID: "data_dir.writable", Title: "Data directory writable", Status: statusFail,
			Detail: fmt.Sprintf("%s: %v", dir, err),
			Remedy: "Fix ownership/permissions on " + dir})
		return
	}
	_ = os.Remove(probe)
	r.add(check{ID: "data_dir.writable", Title: "Data directory writable", Status: statusPass, Detail: dir})
}

func checkHub(r *report, base, token string) {
	client := &http.Client{Timeout: 5 * time.Second}
	statusURL := strings.TrimRight(base, "/") + "/api/v1/status"

	req, err := http.NewRequest(http.MethodGet, statusURL, nil)
	if err != nil {
		r.add(check{ID: "hub.reachable", Title: "Hub reachable", Status: statusFail, Detail: err.Error()})
		return
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		r.add(check{ID: "hub.reachable", Title: "Hub reachable", Status: statusFail,
			Detail: fmt.Sprintf("%s: %v", statusURL, err),
			Remedy: "Start it: `sigild --config ~/.config/sigil/config.toml`. If it is running, " +
				"check that hub.listen_addr matches the URL you are probing."})
		r.add(check{ID: "hub.auth", Title: "Token accepted", Status: statusSkip, Detail: "hub unreachable"})
		return
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()

	r.add(check{ID: "hub.reachable", Title: "Hub reachable", Status: statusPass, Detail: base})

	switch resp.StatusCode {
	case http.StatusOK:
		r.add(check{ID: "hub.auth", Title: "Token accepted", Status: statusPass})
	case http.StatusUnauthorized, http.StatusForbidden:
		detail := "no token supplied"
		if token != "" {
			detail = "the hub rejected this token"
		}
		r.add(check{ID: "hub.auth", Title: "Token accepted", Status: statusFail, Detail: detail,
			Remedy: "Pass --token, set SIGIL_TOKEN, or check the value against hub.auth.tokens. " +
				"Tokens compare byte-for-byte, so a trailing newline is enough to fail."})
	default:
		r.add(check{ID: "hub.auth", Title: "Token accepted", Status: statusWarn,
			Detail: fmt.Sprintf("unexpected status %d from %s", resp.StatusCode, statusURL)})
	}
}

// checkHosts validates what can be judged locally: a host needs a name, a
// hostname, and — for key auth — a key file that actually exists as the user
// running this command.
func checkHosts(r *report, cfg *hubcfg.Config) {
	if cfg == nil {
		r.add(check{ID: "hosts.configured", Title: "Hosts configured", Status: statusSkip})
		return
	}
	if len(cfg.Hosts) == 0 {
		r.add(check{ID: "hosts.configured", Title: "Hosts configured", Status: statusWarn,
			Detail: "no [[hosts]] entries",
			Remedy: "Add a [[hosts]] block, or add one from the web UI. See docs/SETUP.md"})
		return
	}
	r.add(check{ID: "hosts.configured", Title: "Hosts configured", Status: statusPass,
		Detail: fmt.Sprintf("%d host(s)", len(cfg.Hosts))})

	for _, h := range cfg.Hosts {
		id := "host." + h.Name
		switch {
		case h.Name == "" || h.Hostname == "":
			r.add(check{ID: id, Title: "Host " + h.Name + " is complete", Status: statusFail,
				Detail: "name and hostname are both required",
				Remedy: "Give every [[hosts]] block a unique name and a hostname"})
		case h.AuthMethod == "key":
			p := expandPath(h.PrivateKeyPath)
			if p == "" {
				r.add(check{ID: id, Title: "Host " + h.Name + " key", Status: statusFail,
					Detail: "auth_method is \"key\" but private_key_path is empty",
					Remedy: "Set private_key_path, e.g. ~/.ssh/id_ed25519"})
			} else if _, err := os.Stat(p); err != nil {
				r.add(check{ID: id, Title: "Host " + h.Name + " key", Status: statusFail,
					Detail: fmt.Sprintf("%s: %v", p, err),
					Remedy: "The path is resolved as the user sigild runs as, which under systemd " +
						"is often not your login user. Point it at a key that user can read."})
			} else {
				r.add(check{ID: id, Title: "Host " + h.Name + " key", Status: statusPass, Detail: p})
			}
		case h.AuthMethod == "password":
			r.add(check{ID: id, Title: "Host " + h.Name + " auth", Status: statusWarn,
				Detail: "password auth — the password is stored in plaintext in the config",
				Remedy: "Prefer auth_method = \"key\""})
		default:
			r.add(check{ID: id, Title: "Host " + h.Name + " auth", Status: statusWarn,
				Detail: "unrecognised auth_method: " + h.AuthMethod,
				Remedy: "Use \"key\" or \"password\""})
		}
	}
}

// checkLocalTmux is advisory: tmux is required on MANAGED hosts, not on the hub,
// unless the hub also manages itself.
func checkLocalTmux(r *report) {
	if _, err := exec.LookPath("tmux"); err != nil {
		r.add(check{ID: "tmux.local", Title: "tmux present locally", Status: statusWarn,
			Detail: "tmux not found on this machine",
			Remedy: "Only needed if this machine is also a MANAGED host. Sigil requires tmux on " +
				"the hosts it drives, not on the hub."})
		return
	}
	r.add(check{ID: "tmux.local", Title: "tmux present locally", Status: statusPass})
}

// ── output ──────────────────────────────────────────────────────────────────

func printHuman(r *report) {
	mark := map[string]string{statusPass: "✓", statusWarn: "!", statusFail: "✗", statusSkip: "–"}
	fmt.Printf("sigil doctor — version %s\n", r.Version)
	fmt.Printf("config: %s\nhub:    %s\n\n", r.ConfigPath, r.Server)
	for _, c := range r.Checks {
		fmt.Printf("  %s %s\n", mark[c.Status], c.Title)
		if c.Detail != "" {
			fmt.Printf("      %s\n", c.Detail)
		}
		if c.Remedy != "" && (c.Status == statusFail || c.Status == statusWarn) {
			fmt.Printf("      → %s\n", c.Remedy)
		}
	}
	fmt.Printf("\n%d passed, %d warning(s), %d failed", r.Summary[statusPass], r.Summary[statusWarn], r.Summary[statusFail])
	if r.Summary[statusSkip] > 0 {
		fmt.Printf(", %d skipped", r.Summary[statusSkip])
	}
	fmt.Println()
	if !r.OK {
		fmt.Println("\nFix the ✗ items first — the others are often downstream of them.")
	}
}

// hubURLFrom prefers the configured listen address, since that is where the hub
// will actually be, and only falls back to the launcher's default.
func hubURLFrom(cfg *hubcfg.Config, fallback string) string {
	if cfg == nil || cfg.Hub.ListenAddr == "" {
		return fallback
	}
	host, port, err := net.SplitHostPort(cfg.Hub.ListenAddr)
	if err != nil {
		return fallback
	}
	// A wildcard bind is not dialable; probe it over loopback.
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func hubTokenFrom(cfg *hubcfg.Config, fallback string) string {
	if fallback != "" {
		return fallback
	}
	if cfg != nil && len(cfg.Hub.Auth.Tokens) > 0 {
		return cfg.Hub.Auth.Tokens[0]
	}
	return ""
}
