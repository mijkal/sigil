// Command sigil is a terminal launcher/navigator for a running sigild.
//
// It lists hosts and their tmux sessions over the sigild HTTP API, lets you
// fuzzy-find one, and drops you straight into it by handing the terminal to
// `ssh -t … tmux attach`. It is a launcher, not a terminal — the real tmux does
// the rendering.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/pelletier/go-toml/v2"

	"sigil.dev/sigil/internal/tui"
	sigil "sigil.dev/sigil/pkg/sigil"
)

const defaultServer = "http://127.0.0.1:7778"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "sigil: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// Subcommands are dispatched before flag parsing so `sigil doctor --json`
	// reaches doctor's own flag set rather than tripping the launcher's.
	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		return runDoctor(os.Args[2:])
	}

	flags := newFlagSet()
	server := flags.String("server", "", "sigild base URL (env SIGIL_SERVER, default "+defaultServer+")")
	token := flags.String("token", "", "bearer token for the API (env SIGIL_TOKEN)")
	configPath := flags.String("config", "~/.config/sigil/tui.toml", "path to optional TUI config file")
	showVersion := flags.Bool("version", false, "print version and exit")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}

	if *showVersion {
		fmt.Printf("sigil version %s\n", sigil.Version)
		return nil
	}

	resolved := resolveConfig(*server, *token, expandPath(*configPath))

	client := tui.NewClient(resolved.Server, resolved.Token)
	prog := tea.NewProgram(tui.New(client, resolved.Server), tea.WithAltScreen())
	_, err := prog.Run()
	return err
}

// newFlagSet builds the flag set with a usage banner in the sigild idiom.
func newFlagSet() *flag.FlagSet {
	fs := flag.NewFlagSet("sigil", flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "sigil — terminal launcher for Sigil")
		fmt.Fprintln(fs.Output(), "\nUsage: sigil [--server URL] [--token TOKEN]")
		fmt.Fprintln(fs.Output(), "       sigil doctor [--json]   check the installation and report fixes")
		fmt.Fprintln(fs.Output(), "\nFlags:")
		fs.PrintDefaults()
	}
	return fs
}

// config holds the resolved server + token.
type config struct {
	Server string `toml:"server"`
	Token  string `toml:"token"`
}

// resolveConfig applies the precedence flag > env > file > default. Empty flag
// strings mean "unset" (the zero value), so an explicit --server="" still falls
// through — acceptable for a launcher where empty is never a valid server.
func resolveConfig(flagServer, flagToken, filePath string) config {
	var file config
	if b, err := os.ReadFile(filePath); err == nil {
		_ = toml.Unmarshal(b, &file) // best-effort; a malformed file just falls through
	}

	c := config{Server: defaultServer}
	// server: default → file → env → flag
	if file.Server != "" {
		c.Server = file.Server
	}
	if v := os.Getenv("SIGIL_SERVER"); v != "" {
		c.Server = v
	}
	if flagServer != "" {
		c.Server = flagServer
	}
	// token: file → env → flag
	if file.Token != "" {
		c.Token = file.Token
	}
	if v := os.Getenv("SIGIL_TOKEN"); v != "" {
		c.Token = v
	}
	if flagToken != "" {
		c.Token = flagToken
	}
	return c
}

// expandPath expands a leading ~/ to the user's home dir (sigild idiom).
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
