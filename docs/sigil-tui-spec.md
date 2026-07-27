# Spec: `sigil-tui` — a terminal client for Sigil

## Goal
A fast **launcher / navigator** for Sigil that runs in the terminal. It lists hosts
and their tmux sessions from a running sigild, lets you fuzzy-find one, and drops you
straight into it. It is **not** a re-implementation of the web app's terminal — for
the actual session it hands the terminal over to native `ssh -t … tmux attach`, so
you get real tmux with zero rendering work on our side.

Think: "the quick way to hop into the right tmux session on the right host, from a
shell, across the whole fleet."

## Non-goals
- No in-TUI terminal emulation / xterm / scrollback rendering (attach to real tmux instead).
- No widgets, metrics dashboards, or the web app's pane/split model.
- No write operations beyond creating / killing a session (and those are stretch, below).
- No changes to existing web/backend behavior. **No deploy.**

## Where it lives
- New command: `cmd/sigil-tui/` (its own `main.go` + supporting files in the same package or a small `internal/tui` package — implementer's choice, keep it cohesive).
- Talks to sigild over its existing HTTP API (same surface the web app uses), so it needs a **server URL** and a **bearer token**. Reuse `pkg/sigil` types (`Host`, `Session`) for JSON decoding rather than redeclaring them.
- Add a `Makefile` target `build-tui` (`go build -o dist/sigil-tui ./cmd/sigil-tui`) and include it in the umbrella `build` target. Do **not** wire it into `deploy`.

## Tech
- Go (module already `go 1.22`, toolchain 1.24). Use the **Charm stack**: `bubbletea`
  (model/update/view), `lipgloss` (styling), and `bubbles` (list/textinput/spinner) as
  needed. Add them with `go get`; run `go mod tidy` so `go.mod`/`go.sum` are committed.
- Keep the Sigil aesthetic: monospace, muted greys with a single indigo accent, a hex/
  constellation motif in the header if cheap. Match the web app's restraint.

## Configuration (resolution order: flag > env > config file > default)
- `--server` / `SIGIL_SERVER` — base URL, e.g. `http://192.0.2.10:7778` (default `http://127.0.0.1:7778`).
- `--token` / `SIGIL_TOKEN` — bearer token for the API.
- Optional config file `~/.config/sigil/tui.toml` with `server` and `token` keys (nice-to-have; env+flags are sufficient for MVP).
- If no token and the server needs one, show a clear message (not a crash).

## API surface used (all under `/api/v1`, `Authorization: Bearer <token>`)
- `GET /status` — sanity/connectivity + version.
- `GET /hosts` — `[]Host` (name, hostname, port, user, status, tags).
- `GET /sessions` — `[]Session` (host_name, name, windows, status, last_active, …). Group by `host_name`.
- (Stretch) `POST /sessions` to create, `DELETE /sessions/{id}` to kill.

Build a tiny typed client (`internal/tui/client.go` or similar): `NewClient(base, token)`,
`Hosts(ctx)`, `Sessions(ctx)`, `Status(ctx)`. Reuse `pkg/sigil.Host`/`Session`. 8s HTTP timeout.

## Attach behavior (the core feature)
On `enter` over a selected session:
1. Look up the session's host → `pkg/sigil.Host` (user, hostname, port).
2. Build the command: `ssh -t [-p <port>] <user>@<hostname> tmux attach -t <session-name>`
   (only add `-p` when port ≠ 22; if the host is the local hub, `tmux attach -t …` directly is acceptable but ssh is fine too).
3. **Suspend Bubbletea** (`tea.ExecProcess`) so the child `ssh` owns the real terminal;
   when the user detaches (tmux prefix-d) or ssh exits, the TUI resumes at the list.
4. If a specific window is desired later, target `-t <session>:<window>` — MVP attaches to the session.

The **construction of the ssh argv from a Host + session name** must be a pure function
(`attachArgs(host Host, session string) []string`) so it is unit-testable without a live ssh.

## Interaction / keybindings
- List of hosts→sessions (or a flat, host-prefixed session list). Show status dot (connected/detached/error) and window count.
- `↑/↓` or `j/k` navigate · `/` filter (fuzzy) · `enter` attach · `r` refresh · `?` help · `q`/`ctrl-c` quit.
- A slim header (SIGIL + server + connection state) and a footer hint line.
- Graceful states: loading spinner while fetching; a clear error panel if the server is unreachable or the token is rejected (with the status code), not a panic.

## Stretch (only if MVP is solid)
- `n` create session on the highlighted host (prompt for name) → `POST /sessions`.
- `x` kill highlighted session (confirm) → `DELETE /sessions/{id}`.
- Live-ish refresh (poll `/sessions` every ~10s while idle).

## Tests (required — `go test ./...` must pass)
Table-driven unit tests, no network/ssh needed:
1. `attachArgs` — ports (22 omits `-p`, non-22 includes it), user@hostname formatting, session name passthrough, a name needing no shell-escaping vs. one with a space/colon.
2. API client JSON decode — feed captured `/hosts` and `/sessions` JSON payloads (small fixtures) through the decoder and assert the structs populate; assert a 401 body surfaces a typed error, not a panic.
3. Fuzzy filter — given a set of "host/session" labels and a query, assert the expected subset/order.

## Acceptance criteria (Definition of Done)
- `go build ./...` and `go build ./cmd/sigil-tui` succeed; `go vet ./...` clean.
- `go test ./...` passes, including the new tests above.
- `go.mod`/`go.sum` tidy and committed (deps resolved).
- `make build-tui` produces `dist/sigil-tui`.
- Running `dist/sigil-tui --server <url> --token <tok>` against a reachable sigild lists hosts + sessions and, on `enter`, execs the correct `ssh … tmux attach` (verified by the `attachArgs` unit test; live attach is a manual check, not automated).
- A short **README** section (`## sigil-tui`) documents install/usage/keys.
- No modifications to existing runtime behavior of sigild or the web app; **nothing is deployed**.

## Deliverable
A single feature branch containing `cmd/sigil-tui` (+ any `internal/tui`), the Makefile
`build-tui` target, tidied `go.mod`/`go.sum`, tests, and the README section — building
and testing green. Hold for human review; do not merge or deploy.
