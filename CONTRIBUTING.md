# Contributing to Sigil

Thanks for your interest! Sigil is a Go daemon plus a React/xterm.js web client.
This guide covers local setup and the conventions the codebase follows.

## Prerequisites

- **Go 1.22+**
- **Node 18+** (for the web client)
- **golangci-lint** (for `make lint`)
- Optional: **Docker** (for `make test-integration`)

## Layout

```
cmd/sigild        entry point for the hub daemon
cmd/sigil-web     static web-client server (serves web/dist, proxies API/WS)
internal/
  api             HTTP handlers + routing
  ws              WebSocket server (attach, replay, broadcasts)
  session         tmux attach, discovery, replay ring, files/transfer
  ssh             SSH pool + host-key policy
  scrollback      SQLite capture + retention
  metrics         per-host resource probes
  events          event bus + trigger matching
  db              SQLite access + migrations
  config          TOML config
pkg/sigil         shared types + version vars
web/src
  lib             pure, unit-tested logic (no React/DOM)
  stores          zustand state
  ui              themeable UI kit (Button, Modal, Icons)
  components       feature components
docs              architecture + roadmap
```

## Build & run

```bash
make setup-config                 # create ~/.config/sigil/config.toml from the template
make build-web && make build      # dist/sigild + dist/sigil-web
make dev                          # run sigild locally (API only)
```

## Tests, lint, types — run before every PR

```bash
make test                 # Go unit tests
make lint                 # golangci-lint

cd web
npx tsc --noEmit          # type check
npx vitest run            # frontend unit tests
npm run lint              # eslint + the no-raw-hex colour guard
```

## Conventions

The web client follows a **layered architecture** — put logic where it can be
tested, and keep components thin:

1. **`lib/`** — pure functions with tests. Parsing, validation, formatting,
   effect resolution. No React, no DOM, no side effects.
2. **`stores/`** — zustand stores for state.
3. **`ui/`** — the themeable primitive kit (Button, Modal, Icons).
4. **`components/`** — feature UI, composed from the above.

Other house rules:

- **Theme tokens only.** Colours come from CSS custom properties
  (`var(--color-*)`); a lint guard (`web/scripts/lint-colors.sh`) fails on raw
  hex in themeable components. Support both light and dark.
- **Touch targets** ≥ 44px on mobile.
- **Icons over emoji — always.** UI chrome uses monochrome inline SVGs from
  `components/icons.tsx` (they inherit `currentColor` and size, and render
  identically across platforms). Never ship an emoji as a UI glyph — no 🔔 / 🔗
  / 📁 in buttons, toolbars, or status bars. Add a new icon to `icons.tsx` rather
  than reaching for an emoji. (Plain typographic marks — arrows, ✓, ✕ — are fine.)
- **Migrations are append-only.** Add a new entry to the `migrations` slice in
  `internal/db/db.go`; never edit or reorder an existing one.
- **Match the surrounding code** — comment density, naming, and idiom. Comments
  explain *why*, not *what*.
- Conventional-commit style messages (`feat(...)`, `fix(...)`, `refactor(...)`,
  `docs: ...`).

## Pull requests

Keep PRs focused. Include tests for new `lib/` logic and Go packages. Make sure
type check, both test suites, and both linters pass. Describe the change and,
for anything touching the SSH/PTY hot path, note the safety considerations.
